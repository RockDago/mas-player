import { DSPState } from '../types/audio';
import {
  EQ_BANDS,
  EQ_PEAKING_Q,
  EQ_GAIN_MIN,
  EQ_GAIN_MAX,
  computeHeadroom,
  dbToLinear,
} from '../constants/presets';

/**
 * Moteur DSP web : Web Audio API.
 *
 * Chaîne du graphe :
 *   MediaElementSource → lowShelf(250Hz) → 8×peaking(125Hz..8kHz)
 *   → highShelf(8kHz) → preamp → balance → limiter → master → destination
 *
 * L'ordre des filtres n'a pas d'importance pour un EQ (tous linéaires, sans
 * réinjection), mais le préampli DOIT être après l'EQ et avant le limiteur :
 * c'est lui qui réserve la marge anti-écrêtage.
 *
 * Un seul `HTMLAudioElement` est réutilisé pour toute la session : un
 * `MediaElementAudioSourceNode` ne peut être créé qu'une seule fois par élément,
 * donc les pistes ne doivent pas créer chacune leur `new Audio()`.
 */

/** Constante de lissage : plus petite = transition plus rapide entre deux gains. */
const RAMP_TIME = 0.02;

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

    // StereoPanner n'existe pas partout (Safari ancien) : on garde un GainNode
    // de repli pour ne pas casser la construction du graphe.
    const panCtor = (ctx as any).createStereoPanner
      ? () => ctx.createStereoPanner()
      : () => ctx.createGain();
    this.balancePan = panCtor() as StereoPannerNode;

    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.12;

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
    this.merger.connect(this.balancePan as any);
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

    const bassWeights = [1.0, 0.8, 0.5, 0.25];
    const trebleWeights: { [idx: number]: number } = { 6: 0.25, 7: 0.5, 8: 0.8, 9: 1.0 };

    const effectiveBands = bands.map((b, index) => {
      let g = b ?? 0;
      if (index < 4) {
        g += bass * bassWeights[index];
      } else if (index >= 6) {
        g += treble * (trebleWeights[index] ?? 0);
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

    this.setVolume(dsp.volume ?? 75);
  }

  /**
   * Matrice Mid/Side : width = 1.0 = stéréo d'origine, mono = Side nulé.
   *
   * Point unique de réglage de `sideGain` / `midSum`. Appelé par `applyDSP`
   * (données DSP complètes) et par `setMono` (bascule seule) : les deux chemins
   * convergent ici, donc aucun appel ne peut écraser la largeur de l'autre.
   *
   * Gain unitaire vérifié : à width = 1, (L+R)/2 ± (L-R)/2 redonne L et R
   * exacts — l'insertion de la matrice ne change donc pas le niveau.
   */
  private applyStereo(mono: boolean, expansion: number) {
    if (!this.ctx || !this.sideGain || !this.midSum) return;
    const now = this.ctx.currentTime;
    if (mono) {
      // Side = 0 → les deux sorties valent (L+R)/2.
      this.sideGain.gain.setTargetAtTime(0, now, RAMP_TIME);
    } else {
      const pct = Math.max(0, Math.min(100, expansion));
      const width = 1.0 + (pct / 100) * 1.2;
      // Élargir le Side sans corriger le niveau ferait monter le volume :
      // le reconstructeur (M + S·w, M − S·w) a pour pic exact (1+w)/2, soit
      // +4.1 dB à w = 2.2. On renormalise donc sur le Mid par 1/pic, ce qui
      // rend la largeur sans effet sur le niveau (pic constant à 1.0000) —
      // l'image s'élargit, le volume ne bouge pas.
      const peak = (1 + width) / 2;
      this.sideGain.gain.setTargetAtTime(width, now, RAMP_TIME);
      this.midSum.gain.setTargetAtTime(1 / peak, now, RAMP_TIME);
      return;
    }
    this.midSum.gain.setTargetAtTime(1.0, now, RAMP_TIME);
  }

  /** Volume utilisateur en pourcentage (0-100). */
  setVolume(volumePercent: number) {
    const linear = Math.max(0, Math.min(1, volumePercent / 100));
    if (this.ctx && this.masterGain) {
      this.masterGain.gain.setTargetAtTime(
        linear,
        this.ctx.currentTime,
        RAMP_TIME
      );
    }
    // Filet de sécurité : si le graphe n'existe pas, l'élément porte le volume.
    if (this.element) this.element.volume = linear;
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
  }
}