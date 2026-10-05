import { DSPState } from '../types/audio';
import {
  EQ_BANDS,
  EQ_PEAKING_Q,
  EQ_GAIN_MIN,
  EQ_GAIN_MAX,
  BASS_WEIGHTS,
  TREBLE_WEIGHTS,
  computeHeadroom,
  computeReverbGains,
  computeReverbDampingHz,
  computeReverbDelayScale,
  computeReverbLoopGains,
  dbToLinear,
  REVERB_DELAY_L,
  REVERB_DELAY_R,
  REVERB_DAMPING_MAX_HZ,
} from '../constants/presets';

/**
 * Moteur DSP web : Web Audio API.
 *
 * Chaîne du graphe :
 *   MediaElementSource → lowShelf(250Hz) → 8×peaking(125Hz..8kHz)
 *   → highShelf(8kHz) → preamp → Mid/Side → crossfeed → reverbération
 *   → balance → limiter → master → destination
 *
 * L'ordre des filtres n'a pas d'importance pour un EQ (tous linéaires, sans
 * réinjection), mais le préampli DOIT être après l'EQ et avant le limiteur :
 * c'est lui qui réserve la marge anti-écrêtage.
 *
 * La réverbération se place après le crossfeed et avant la balance, et le
 * limiteur reste le tout dernier étage de traitement : c'est lui qui porte la
 * garantie du plafond numérique. Cette chaîne est l'exact équivalent de celle
 * de `AudioDSPEngine.connectGraph` — voir `scripts/sync-check.cjs`.
 *
 * Un seul `HTMLAudioElement` est réutilisé pour toute la session : un
 * `MediaElementAudioSourceNode` ne peut être créé qu'une seule fois par élément,
 * donc les pistes ne doivent pas créer chacune leur `new Audio()`.
 */

/** Constante de lissage : plus petite = transition plus rapide entre deux gains. */
const RAMP_TIME = 0.02;

/**
 * Gain maximal du crossfeed. Doit rester égal à `AudioDSPSpatial.maxCrossfeed` :
 * `verify:sync` compare les deux constantes, sinon web et iOS divergent.
 */
const MAX_CROSSFEED = 0.15;

/**
 * Amplitude max de la largeur stéréo (width = 1 + pct/100 · ce facteur).
 * Doit rester égal à `AudioDSPSpatial.maxWidthExponent`, comme `MAX_CROSSFEED`.
 */
const MAX_WIDTH_EXPONENT = 1.2;

/**
 * Plafond du limiteur, en dBFS. Doit rester égal à
 * `LimiterState.thresholdDb` : `verify:sync` compare les deux, sinon web et iOS
 * divergent. C'est aussi la valeur vers laquelle `applyDSP` revient quand la
 * pastille LIMIT est éteinte — voir la note à cet endroit.
 */
const LIMIT_THRESHOLD_DB = -3;

/** Attaque du limiteur, en secondes. Alignée sur le commentaire de `build()`. */
const LIMIT_ATTACK_S = 0.002;

/** Relâchement du limiteur, en secondes. Aligné sur `LimiterState.releaseSeconds`. */
const LIMIT_RELEASE_S = 0.12;

/**
 * Taille de la FFT de l'analyser de détection de rythme.
 *
 * 2048 échantillons ≈ 43 ms à 48 kHz : assez long pour que la fenêtre RMS soit
 * stable, assez court pour rester sous la durée d'un temps musical. Le tampon
 * fourni à `getTimeDomainData` doit avoir exactement cette longueur.
 */
const BEAT_ANALYSER_FFT_SIZE = 2048;

export class WebAudioEngine {
  private ctx: AudioContext | null = null;
  private element: HTMLAudioElement | null = null;
  private filters: BiquadFilterNode[] = [];
  private preampGain: GainNode | null = null;
  private balancePan: StereoPannerNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private masterGain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private isDestroyed = false;

  // Mid/Side stereo widener & Mono downmix nodes
  private splitter: ChannelSplitterNode | null = null;
  private merger: ChannelMergerNode | null = null;
  private midL: GainNode | null = null;
  private midR: GainNode | null = null;
  private midSum: GainNode | null = null;
  private sideL: GainNode | null = null;
  private sideR: GainNode | null = null;
  private sideGain: GainNode | null = null;
  private sideInvert: GainNode | null = null;

  // Crossfeed : mélange croisé L→R / R→L, après reconstruction M/S
  private crossfeedSplit: ChannelSplitterNode | null = null;
  private crossfeedMerge: ChannelMergerNode | null = null;
  private crossfeedDirectL: GainNode | null = null;
  private crossfeedDirectR: GainNode | null = null;
  private crossfeedMixL: GainNode | null = null;
  private crossfeedMixR: GainNode | null = null;

  // Réverbération : deux lignes de retard désaccordées en boucle, avec un
  // passe-bas d'amortissement sur le chemin de retour. Voir `applyReverb`.
  private reverbInput: ChannelSplitterNode | null = null;
  private reverbMerge: ChannelMergerNode | null = null;
  private reverbDelayL: DelayNode | null = null;
  private reverbDelayR: DelayNode | null = null;
  private reverbDampL: BiquadFilterNode | null = null;
  private reverbDampR: BiquadFilterNode | null = null;
  private reverbFeedL: GainNode | null = null;
  private reverbFeedR: GainNode | null = null;
  /** Couplage croisé : la ligne G reçoit une part du retour de D, et réciproquement. */
  private reverbCrossL: GainNode | null = null;
  private reverbCrossR: GainNode | null = null;
  private reverbWetL: GainNode | null = null;
  private reverbWetR: GainNode | null = null;
  private reverbDryL: GainNode | null = null;
  private reverbDryR: GainNode | null = null;

  /** Vrai si le moteur tourne sur un navigateur sans Web Audio (repli silencieux). */
  static isSupported(): boolean {
    return (
      typeof window !== 'undefined' &&
      typeof window.AudioContext !== 'undefined'
    );
  }

  constructor(element: HTMLAudioElement) {
    this.element = element;
    this.build();
  }

  private build() {
    const Ctor =
      (window as any).AudioContext || (window as any).webkitAudioContext;
    const element = this.element;
    if (!Ctor || !element) {
      console.warn('Web Audio API indisponible — EQ désactivé sur ce navigateur.');
      return;
    }

    const ctx: AudioContext = new Ctor();
    this.ctx = ctx;

    // crossOrigin DOIT précéder l'affectation de src, sinon la ressource est
    // marquée « opaque » et le graphe web refuse de la router (silence total).
    element.crossOrigin = 'anonymous';
    element.preload = 'auto';

    const source = ctx.createMediaElementSource(element);

    // --- Les 10 bandes, dans l'ordre canonique EQ_BANDS -----------------
    this.filters = EQ_BANDS.map((spec) => {
      const filter = ctx.createBiquadFilter();
      filter.type = spec.type as BiquadFilterType;
      filter.frequency.value = spec.freq;
      if (spec.type === 'peaking') {
        filter.Q.value = EQ_PEAKING_Q;
      }
      filter.gain.value = 0;
      return filter;
    });

    this.preampGain = ctx.createGain();
    this.preampGain.gain.value = 1;

    // --- Mid / Side Stereo Widener & Mono Matrix ---
    this.splitter = ctx.createChannelSplitter(2);
    this.merger = ctx.createChannelMerger(2);

    this.midL = ctx.createGain();
    this.midL.gain.value = 0.5;
    this.midR = ctx.createGain();
    this.midR.gain.value = 0.5;
    this.midSum = ctx.createGain();
    this.midSum.gain.value = 1.0;

    this.sideL = ctx.createGain();
    this.sideL.gain.value = 0.5;
    this.sideR = ctx.createGain();
    this.sideR.gain.value = -0.5;
    this.sideGain = ctx.createGain();
    this.sideGain.gain.value = 1.0;
    this.sideInvert = ctx.createGain();
    this.sideInvert.gain.value = -1.0;

    // Connect Mid (L + R) / 2
    this.splitter.connect(this.midL, 0);
    this.splitter.connect(this.midR, 1);
    this.midL.connect(this.midSum);
    this.midR.connect(this.midSum);

    // Connect Side (L - R) / 2
    this.splitter.connect(this.sideL, 0);
    this.splitter.connect(this.sideR, 1);
    this.sideL.connect(this.sideGain);
    this.sideR.connect(this.sideGain);
    this.sideGain.connect(this.sideInvert);

    // Recombine into Left & Right
    // Left = Mid + Side * Width
    this.midSum.connect(this.merger, 0, 0);
    this.sideGain.connect(this.merger, 0, 0);

    // Right = Mid - Side * Width
    this.midSum.connect(this.merger, 0, 1);
    this.sideInvert.connect(this.merger, 0, 1);

    // --- Crossfeed ---
    // Placé APRÈS la reconstruction M/S, comme dans AudioDSPSpatial.swift :
    // mélanger les canaux avant de reconstruire l'image ne donnerait pas le
    // même résultat, parce que le Side serait lui-même déjà mélangé.
    // Chaque sortie = 1·(canal direct) + c·(canal opposé), c <= 0.15.
    this.crossfeedSplit = ctx.createChannelSplitter(2);
    this.crossfeedMerge = ctx.createChannelMerger(2);
    this.crossfeedDirectL = ctx.createGain();
    this.crossfeedDirectL.gain.value = 1;
    this.crossfeedDirectR = ctx.createGain();
    this.crossfeedDirectR.gain.value = 1;
    this.crossfeedMixL = ctx.createGain();
    this.crossfeedMixL.gain.value = 0;
    this.crossfeedMixR = ctx.createGain();
    this.crossfeedMixR.gain.value = 0;

    this.merger.connect(this.crossfeedSplit);
    this.crossfeedSplit.connect(this.crossfeedDirectL, 0);
    this.crossfeedSplit.connect(this.crossfeedDirectR, 1);
    this.crossfeedSplit.connect(this.crossfeedMixL, 1);
    this.crossfeedSplit.connect(this.crossfeedMixR, 0);
    this.crossfeedDirectL.connect(this.crossfeedMerge, 0, 0);
    this.crossfeedMixL.connect(this.crossfeedMerge, 0, 0);
    this.crossfeedDirectR.connect(this.crossfeedMerge, 0, 1);
    this.crossfeedMixR.connect(this.crossfeedMerge, 0, 1);

    // --- Réverbération -----------------------------------------------------
    // Schéma, avec le couplage croisé entre les deux lignes :
    //
    //   entrée ─┬──────────────────────────────► dry ─────────┐
    //           └─► delay L ─► passe-bas L ─┬─► ×f ─► ×x ─┐    │
    //                                      │              ├─► wet L ─► sortie G
    //           ┌─► delay D ─► passe-bas D ─┴─► ×f ─► ×x ─┤    │
    //   entrée ─┴──────────────────────────────► dry ─────────┤
    //                                                     └─► wet D ─► sortie D
    //
    // Les deux lignes se réinjectent **mutuellement** (les gains ×f et ×x) :
    // c'est ce qui désaccorde les canaux au fil du temps — le mode croisé
    // décroît ~3 fois plus vite que le mode symétrique, donc l'image s'ouvre au
    // lieu de répéter. Les gains sont normalisés par `1 + couplage` : sans
    // cette normalisation, `f + x` vaudrait 1.17 et la boucle divergerait. Voir
    // `computeReverbLoopGains` dans `presets.ts`.
    //
    // La boucle de retour passe par le passe-bas : c'est ce qui transforme un
    // écho métallique en queue de pièce. Sans lui, chaque passage de la boucle
    // réinjecte les aigus intacts et l'accumulation finit par siffler.
    //
    // Placée APRÈS le crossfeed, jamais avant : appliquée avant, la
    // réverbération se retrouverait elle-même réinjectée dans l'oreille opposée
    // par le crossfeed, et l'effet se doublerait d'une couche.
    this.reverbInput = ctx.createChannelSplitter(2);
    this.reverbMerge = ctx.createChannelMerger(2);
    this.reverbDelayL = ctx.createDelay(1);
    this.reverbDelayR = ctx.createDelay(1);
    this.reverbDampL = ctx.createBiquadFilter();
    this.reverbDampR = ctx.createBiquadFilter();
    this.reverbFeedL = ctx.createGain();
    this.reverbFeedR = ctx.createGain();
    this.reverbCrossL = ctx.createGain();
    this.reverbCrossR = ctx.createGain();
    this.reverbWetL = ctx.createGain();
    this.reverbWetR = ctx.createGain();
    this.reverbDryL = ctx.createGain();
    this.reverbDryR = ctx.createGain();

    for (const damp of [this.reverbDampL, this.reverbDampR]) {
      if (!damp) continue;
      damp.type = 'lowpass';
      damp.frequency.value = REVERB_DAMPING_MAX_HZ;
      damp.Q.value = 0.0001; // passe-bas à un pôle : le plus plat possible
    }
    const loop = computeReverbLoopGains();
    this.reverbFeedL.gain.value = loop.self;
    this.reverbFeedR.gain.value = loop.self;
    this.reverbCrossL.gain.value = loop.cross;
    this.reverbCrossR.gain.value = loop.cross;

    // Gauche : entrée 0 → retard L → amortissement → retour
    this.reverbInput.connect(this.reverbDelayL, 0);
    this.reverbDelayL.connect(this.reverbDampL);
    this.reverbDampL.connect(this.reverbFeedL);
    this.reverbFeedL.connect(this.reverbDelayL); // fermeture de la boucle
    this.reverbDampL.connect(this.reverbCrossL); // part du retour G vers la ligne D
    this.reverbFeedL.connect(this.reverbWetL); // sortie humide

    // Droite : entrée 1 → retard R → amortissement → retour
    this.reverbInput.connect(this.reverbDelayR, 1);
    this.reverbDelayR.connect(this.reverbDampR);
    this.reverbDampR.connect(this.reverbFeedR);
    this.reverbFeedR.connect(this.reverbDelayR);
    this.reverbDampR.connect(this.reverbCrossR); // part du retour D vers la ligne G
    this.reverbFeedR.connect(this.reverbWetR);

    // Le croisement se referme par les retards eux-mêmes : chaque ligne reçoit
    // donc son propre retour (×f) plus la part de l'autre (×x), exactement
    // comme la matrice `[[s, x], [x, s]]` du natif.
    this.reverbCrossL.connect(this.reverbDelayR);
    this.reverbCrossR.connect(this.reverbDelayL);

    // Signal sec, en parallèle et sans passer par la boucle
    this.reverbInput.connect(this.reverbDryL, 0);
    this.reverbInput.connect(this.reverbDryR, 1);

    this.reverbDryL.connect(this.reverbMerge, 0, 0);
    this.reverbWetL.connect(this.reverbMerge, 0, 0);
    this.reverbDryR.connect(this.reverbMerge, 0, 1);
    this.reverbWetR.connect(this.reverbMerge, 0, 1);

    // StereoPanner n'existe pas partout (Safari ancien) : on garde un GainNode
    // de repli pour ne pas casser la construction du graphe.
    const panCtor = (ctx as any).createStereoPanner
      ? () => ctx.createStereoPanner()
      : () => ctx.createGain();
    this.balancePan = panCtor() as StereoPannerNode;

    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = LIMIT_THRESHOLD_DB;
    this.limiter.knee.value = 0;
    /**
     Ratio 1 : le compresseur devient un limiteur au sens strict — la sortie
     atteint le seuil et ne le franchit jamais.

     Ce n'était pas le réglage d'origine (20). La raison du changement est
     mesurée, pas esthétique : avec un ratio 20, la courbe vaut
     `0.05·db − 2.85`, donc une crête à +60 dBFS ressort encore à +0.15 dBFS,
     au-dessus du zéro numérique. Un étage qui laisse passer le zéro numérique
     n'empêche pas l'écrêtage qu'il est censé empêcher — or les préréglages
     d'origine sortent de la chaîne jusqu'à +12.1 dBFS (cf. `verify-dsp.cjs`,
     section 7).

     Ce qui reste de compression vient de l'enveloppe temporelle, pas de la
     courbe statique : attaque de 2 ms, relâchement de 120 ms. C'est la
     définition d'un limiteur.

     Le limiteur natif (`modules/expo-audio-dsp/ios/AudioDSPLimiter.swift`)
     implémente exactement cette fonction, et `scripts/verify-limiter.cjs`
     compare les deux. Un ratio 20 ici ferait diverger les plateformes.
     */
    this.limiter.ratio.value = 1;
    this.limiter.attack.value = LIMIT_ATTACK_S;
    this.limiter.release.value = LIMIT_RELEASE_S;

    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = 1;

    // --- Cablage -------------------------------------------------------
    let node: AudioNode = source;
    for (const filter of this.filters) {
      node.connect(filter);
      node = filter;
    }
    node.connect(this.preampGain);
    this.preampGain.connect(this.splitter);
    // La réverbération se place après la reconstruction M/S et le crossfeed,
    // et avant la balance : voir la note de câblage dans `build()`.
    this.crossfeedMerge.connect(this.reverbInput);
    this.reverbMerge.connect(this.balancePan as any);
    (this.balancePan as any).connect(this.limiter);
    this.limiter.connect(this.masterGain);
    this.masterGain.connect(ctx.destination);

    // --- Prise d'analyse (detection de rythme) -------------------------
    // Branchee sur la sortie du master : c'est donc exactement ce qui est
    // entendu, egalisation et volume compris.
    //
    // La sortie de l'analyser reste DELIBEREMENT non raccordee. Il ne doit
    // surtout pas etre relie a `destination` : `masterGain` y est deja, et le
    // signal y arriverait deux fois (+6 dB). Un AnalyserNode analyse son entree
    // sans que sa sortie ait besoin d'etre consommee.
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = BEAT_ANALYSER_FFT_SIZE;
    // Pas de lissage : la detection d'onset fait son propre moyennage, et un
    // lissage ici retarderait les montees d'energie.
    this.analyser.smoothingTimeConstant = 0;
    this.masterGain.connect(this.analyser);
  }

  /**
   * Donnees temporelles pre-remplies, pour la detection de rythme.
   *
   * @param target Buffer fourni par l'appelant, de longueur exactement
   *   `fftSize`. Allouer ici couterait un GC par frame — d'ou l'exigence.
   */
  getTimeDomainData(target: Float32Array): Float32Array | null {
    if (!this.analyser) return null;
    this.analyser.getFloatTimeDomainData(target as any);
    return target;
  }

  /**
   * Applique l'état DSP complet. Appelé à chaque changement de knob/fader :
   * les paramètres sont interpolés (`setTargetAtTime`) pour éviter les clics.
   */
  applyDSP(dsp: DSPState) {
    if (!this.ctx || this.isDestroyed) return;

    const now = this.ctx.currentTime;
    const bands = dsp.bands ?? [];
    const bass = dsp.bass ?? 0;
    const treble = dsp.treble ?? 0;

    const bassWeights = BASS_WEIGHTS;
    const trebleWeights = TREBLE_WEIGHTS;

    /**
     * Contribution bass/treble, indépendante de la pastille TONE.
     *
     * `toneEnabled` à `false` ne retire pas les bandes — celles-ci relèvent de la
     * pastille EQU — il retire seulement la **pente** que bass et treble
     * ajoutent par-dessus. C'est la seule lecture possible du mot « TONE » à
     * côté d'un « EQU » qui régit, lui, le corps de la courbe.
     */
    const tone = dsp.toneEnabled === false ? 0 : 1;

    const effectiveBands = bands.map((b, index) => {
      let g = b ?? 0;
      if (index < 4) {
        g += tone * bass * (bassWeights[index] ?? 0);
      } else if (index >= 6) {
        g += tone * treble * (trebleWeights[index] ?? 0);
      }
      return Math.max(EQ_GAIN_MIN, Math.min(EQ_GAIN_MAX, g));
    });

    this.filters.forEach((filter, index) => {
      const gain = dsp.enabled ? (effectiveBands[index] ?? 0) : 0;
      filter.gain.setTargetAtTime(gain, now, RAMP_TIME);
    });

    // Préampli = marge anti-écrêtage + réglage utilisateur
    const headroom = computeHeadroom(dsp.enabled ? effectiveBands : []);
    const preampDb = Math.min(0, headroom + (dsp.preamp ?? 0));
    this.preampGain?.gain.setTargetAtTime(
      dbToLinear(preampDb),
      now,
      RAMP_TIME
    );

    // Balance stéréo (active indépendamment de l'égaliseur)
    const balance = dsp.balance ?? 0;
    if ('pan' in (this.balancePan as any)) {
      (this.balancePan as StereoPannerNode).pan.setTargetAtTime(
        Math.max(-1, Math.min(1, balance)),
        now,
        RAMP_TIME
      );
    } else {
      // Repli sans StereoPanner
      const level = Math.abs(balance) * 0.5;
      (this.balancePan as any).gain.setTargetAtTime(
        balance === 0 ? 1 : 1 - level,
        now,
        RAMP_TIME
      );
    }

    // Largeur stéréo et mode mono : voir applyStereo, seul point de réglage.
    // playerManager n'appelle plus setMono() en plus de applyDSP(), sinon le
    // second appel écraserait la largeur par 1.0.
    this.applyStereo(!!dsp.mono, dsp.stereoExpansion ?? 0);
    this.applyCrossfeed(dsp.stereoExpansion ?? 0, dsp.crossfeed ?? 0);
    this.applyReverb(
      !!dsp.reverbEnabled,
      dsp.roomSize ?? 0,
      dsp.damping ?? 0,
      dsp.reverbMix ?? 0
    );

    // Limiteur : la pastille LIMIT le commute réellement.
    const limiterOn = dsp.limitEnabled !== false;
    const limiter = this.limiter as DynamicsCompressorNode;
    limiter.threshold.setTargetAtTime(limiterOn ? LIMIT_THRESHOLD_DB : 0, now, RAMP_TIME);
    limiter.attack.setTargetAtTime(limiterOn ? LIMIT_ATTACK_S : 0, now, RAMP_TIME);
    limiter.ratio.setTargetAtTime(limiterOn ? 20 : 1, now, RAMP_TIME);

    // Volume : pas d'appel ici, contrairement au mono juste au-dessus. C'est
    // `playerManager.setVolume` qui fait foi, et `dsp.volume` figure déjà dans
    // le tableau de dépendances de l'effet `setDSP` — cet appel était donc un
    // second passage sans effet, purement redondant.
  }

  /**
   * Matrice Mid/Side : width = 1.0 = stéréo d'origine, mono = Side nulé.
   *
   * Point unique de réglage de `sideGain` / `midSum`. Appelé par `applyDSP`
   * (données DSP complètes) et par `setMono` (bascule seule) : les deux chemins
   * convergent ici, donc aucun appel ne peut écraser la largeur de l'autre.
   *
   * ## Le niveau, mesuré
   *
   * Le reconstructeur est `L' = M + S·w`, `R' = M - S·w`, ce qui donne la
   * matrice symétrique `[[a,b],[b,a]]` dont les **valeurs singulières sont
   * `{a+b, a-b}`**. Son pic n'est donc pas `(1+w)/2` mais exactement `w`,
   * atteint sur un signal anti-phase (L = 1, R = -1).
   *
   * Avec l'ancien réglage `midSum = 1/((1+w)/2)`, qui ne normalisait que le Mid,
   * le pic vaut `w` :
   *
   * | width | pic | dBFS |
   * |---|---|---|
   * | 50 % | 1.600 | **+4.08** |
   * | 100 % | 2.200 | **+6.85** |
   *
   * Autrement dit, élargir l'image **montait le volume** de près de 7 dB à fond
   * de course. Le commentaire qui affirmait « pic constant à 1.0000 » était faux.
   *
   * ## La correction
   *
   * On normalise les DEUX chemins par `n = max(1, w)`, ce qui donne une matrice
   * de valeurs singulières `{1, 1}` : le pic est **exactement 1, à toute
   * largeur**. L'image s'élargit, le volume ne bouge pas. C'est aussi ce que
   * `scripts/verify-dsp.cjs` (section 10) vérifie.
   *
   * Note : après normalisation `sideGain` vaut exactement 1, mais on garde le
   * nœud paramétrable plutôt que câblé en dur — la matrice reste ainsi ajustable
   * sans retoucher le graphe.
   */
  private applyStereo(mono: boolean, expansion: number) {
    if (!this.ctx || !this.sideGain || !this.midSum) return;
    const now = this.ctx.currentTime;
    const pct = Math.max(0, Math.min(100, expansion));
    const width = 1.0 + (pct / 100) * MAX_WIDTH_EXPONENT;
    // n >= 1 garantit que le pic ne dépasse jamais 1, et que width = 1 (n = 1)
    // laisse passer le signal intact.
    const normaliser = Math.max(1, width);

    // Mono : Side = 0, donc les deux sorties valent (L+R)/2. Le Mid reste à 1,
    // ce qui fait qu'une bascule en mono depuis une largeur > 0 n'amplifie rien.
    this.sideGain.gain.setTargetAtTime(mono ? 0 : width / normaliser, now, RAMP_TIME);
    this.midSum.gain.setTargetAtTime(mono ? 1 : 1 / normaliser, now, RAMP_TIME);
  }

  /**
   * Crossfeed : rapproche les canaux pour l'écoute casque.
   *
   * Chaque sortie = canal direct + c·canal opposé. Le plafond de 0.15 est celui
   * de `AudioDSPSpatial.swift` : au-delà, le mono fantôme que la scène sur un
   * casque était censée éviter devient net — le problème disparaît, on l'échange
   * contre un autre.
   *
   * `c` décroît avec la largeur, exactement comme côté natif : sans ce couplage,
   * un utilisateur qui monte les deux knobs en même temps n'entend aucun
   * changement, alors que les deux réglages se neutralisent.
   */
  private applyCrossfeed(expansion: number, crossfeed: number) {
    if (
      !this.ctx ||
      !this.crossfeedMixL ||
      !this.crossfeedMixR ||
      !this.crossfeedDirectL ||
      !this.crossfeedDirectR
    ) {
      return;
    }
    const now = this.ctx.currentTime;
    const widthPct = Math.max(0, Math.min(100, expansion));
    const xPct = Math.max(0, Math.min(100, crossfeed));
    const mix = MAX_CROSSFEED * (xPct / 100) * (1 - widthPct / 100);
    this.crossfeedDirectL.gain.setTargetAtTime(1, now, RAMP_TIME);
    this.crossfeedDirectR.gain.setTargetAtTime(1, now, RAMP_TIME);
    this.crossfeedMixL.gain.setTargetAtTime(mix, now, RAMP_TIME);
    this.crossfeedMixR.gain.setTargetAtTime(mix, now, RAMP_TIME);
  }

  /**
   * Réverbération : deux lignes de retard en boucle, amortissement sur le retour.
   *
   * Les trois knobs n'ont pas le même effet, et c'est délibéré :
   *
   * - `roomSize` allonge le retard, donc la **taille de la pièce**. Il ne touche
   *   à aucun gain : monter la taille ne fait jamais monter le volume.
   * - `damping` monte la coupure du passe-bas de boucle, de `REVERB_MIN_DAMPING`
   *   à `REVERB_DAMPING_HZ`. Comme ce filtre est dans la boucle, il n'affecte que
   *   ce qui revient — le signal direct reste intact, sinon « pièce sourde »
   *   signifierait « audio étouffé ».
   * - `reverbMix` est le seul knob de **niveau**, via `computeReverbGains`.
   *
   * Le Plafond de dosage (`REVERB_WET_CAP`) est calculé dans `presets.ts` et
   * partagé avec le natif : à 100 % de mélange, `wet + dry = 1`, donc l'étage
   * reste à unité au lieu de pousser le signal dans le limiteur.
   *
   * Les retards sont fixes par canal (`REVERB_DELAY_L` / `REVERB_DELAY_R`) et
   * `roomSize` ne fait que les **mettre à l'échelle** autour de leur valeur
   * nominale : le rapport 7:11 entre les deux lignes reste donc irrationnel à
   * toutes les tailles de pièce, et le motif périodique — le défaut le plus
   * audible d'une réverbération bon marché — ne peut pas apparaître.
   *
   * À l'extinction, la réverbération n'est pas court-circuitée mais amenée à zéro
   * par `setTargetAtTime` : une coupure franche d'un signalWet produirait un clic
   * sur les fins de morceau.
   */
  private applyReverb(enabled: boolean, roomSize: number, damping: number, mix: number) {
    const ctx = this.ctx;
    if (
      !ctx ||
      !this.reverbDelayL ||
      !this.reverbDelayR ||
      !this.reverbDampL ||
      !this.reverbDampR ||
      !this.reverbWetL ||
      !this.reverbWetR ||
      !this.reverbDryL ||
      !this.reverbDryR
    ) {
      return;
    }
    const now = ctx.currentTime;

    // --- Taille de la pièce ---------------------------------------------
    // Facteur de 1 (chambre) à 8 (plateau) ; la loi est dans `presets.ts`,
    // partagée avec le natif. Voir le tableau RT60 de cette constante.
    const scale = computeReverbDelayScale(roomSize);
    this.reverbDelayL.delayTime.setTargetAtTime(
      REVERB_DELAY_L * scale,
      now,
      RAMP_TIME
    );
    this.reverbDelayR.delayTime.setTargetAtTime(
      REVERB_DELAY_R * scale,
      now,
      RAMP_TIME
    );

    // --- Amortissement ----------------------------------------------------
    // Interpolation exponentielle, 80 Hz → 3.6 kHz : voir `computeReverbDampingHz`.
    const cutoff = computeReverbDampingHz(damping);
    this.reverbDampL.frequency.setTargetAtTime(cutoff, now, RAMP_TIME);
    this.reverbDampR.frequency.setTargetAtTime(cutoff, now, RAMP_TIME);

    // --- Dosage -----------------------------------------------------------
    const gains = enabled ? computeReverbGains(mix) : { wet: 0, dry: 1 };
    this.reverbWetL.gain.setTargetAtTime(gains.wet, now, RAMP_TIME);
    this.reverbWetR.gain.setTargetAtTime(gains.wet, now, RAMP_TIME);
    this.reverbDryL.gain.setTargetAtTime(gains.dry, now, RAMP_TIME);
    this.reverbDryR.gain.setTargetAtTime(gains.dry, now, RAMP_TIME);
  }

  /** Volume utilisateur en pourcentage (0-100). */  setVolume(volumePercent: number) {
    const linear = Math.max(0, Math.min(1, volumePercent / 100));
    if (this.ctx && this.masterGain) {
      this.masterGain.gain.setTargetAtTime(
        linear,
        this.ctx.currentTime,
        RAMP_TIME
      );
      // L'élément ne doit PAS porter le même gain que `masterGain` : il alimente
      // le graphe (`element → source → … → masterGain → destination`), donc les
      // deux se multipliaient. Résultat, 75 % affichés ne donnaient que 0.5625,
      // soit un quart sous l'étiquette. Tant que le graphe existe il est le seul
      // maître ; l'élément ne sert plus que de filet si la construction a échoué.
      if (this.element) this.element.volume = 1;
    } else if (this.element) {
      // Filet de sécurité : sans Web Audio, l'élément est le seul étage extant.
      this.element.volume = linear;
    }
  }

  /**
   * Downmix mono. `stereoExpansion` est mémorisé pour que leWidth survive à un
   * aller-retour mono → stéréo (il était écrasé à 1.0 par cet ancien code).
   */
  setMono(enabled: boolean, stereoExpansion = 0) {
    this.applyStereo(enabled, stereoExpansion);
    const el = this.element as unknown as {
      channelCount?: number;
      channelCountMode?: string;
    };
    if (el) {
      try {
        el.channelCount = enabled ? 1 : 2;
        el.channelCountMode = 'explicit';
      } catch {}
    }
  }

  /** Doit être appelé depuis un geste utilisateur (politique d'autoplay). */
  async resume() {
    if (this.ctx && this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch {}
    }
    if (this.element && this.element.paused) {
      try {
        await this.element.play();
      } catch {}
    }
  }

  getContextState(): string {
    return this.ctx?.state ?? 'none';
  }

  async destroy() {
    this.isDestroyed = true;
    this.filters = [];
    if (this.ctx) {
      try {
        await this.ctx.close();
      } catch {}
    }
    this.ctx = null;
    this.element = null;
    this.masterGain = null;
    this.analyser = null;
    this.preampGain = null;
    this.balancePan = null;
    this.limiter = null;
    this.splitter = null;
    this.merger = null;
    this.midL = null;
    this.midR = null;
    this.midSum = null;
    this.sideL = null;
    this.sideR = null;
    this.sideGain = null;
    this.sideInvert = null;
    this.crossfeedSplit = null;
    this.crossfeedMerge = null;
    this.crossfeedDirectL = null;
    this.crossfeedDirectR = null;
    this.crossfeedMixL = null;
    this.crossfeedMixR = null;
    this.reverbInput = null;
    this.reverbMerge = null;
    this.reverbDelayL = null;
    this.reverbDelayR = null;
    this.reverbDampL = null;
    this.reverbDampR = null;
    this.reverbFeedL = null;
    this.reverbFeedR = null;
    this.reverbCrossL = null;
    this.reverbCrossR = null;
    this.reverbWetL = null;
    this.reverbWetR = null;
    this.reverbDryL = null;
    this.reverbDryR = null;
  }
}