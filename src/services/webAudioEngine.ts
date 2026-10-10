import {
  MAS_PLAYER_BAND_FREQUENCIES,
  REVERB_GAIN_COMPENSATION_DB,
  reverbRt60Seconds,
} from '../constants/presets';

type AudioContextWindow = Window & {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
};

const BEAT_ANALYSER_FFT_SIZE = 2048;
const VOLUME_RAMP_SECONDS = 0.02;

/**
 * Plafond du limiteur, en dBFS.
 *
 * Décision mesurée du 5 octobre 2026 (cf. mémoire `mas-player-limiter-hard-ceiling`) :
 * le limiteur est un **plafond dur**, ratio 1 — et non le ratio 20 classique.
 * La courbe ratio 20 vaut `0.05·db − 2.85` : elle comprime sans borner, et une
 * crête à +60 dBFS ressort encore à +0.15 dBFS, au-dessus du zéro numérique.
 * Or les préréglages sortent la chaîne jusqu'à +12 dBFS brut : un étage qui
 * laisse passer le zéro n'empêche pas l'écrêtage qu'il est censé empêcher.
 * La compression résiduelle vient de l'enveloppe temporelle, pas de la courbe.
 *
 * Conséquence assumée : 0 dBFS ressort à −3.00 dBFS au lieu de −2.85. Les deux
 * plateformes sont alignées sur cette fonction, à vérifier par le calcul.
 */
const LIMIT_THRESHOLD_DB = -3;
/** Attaque du limiteur, en secondes. */
const LIMIT_ATTACK_S = 0.002;
/** Relâchement du limiteur, en secondes. */
const LIMIT_RELEASE_S = 0.12;

/**
 * Gains de canal de la balance — la loi exacte du DSP natif.
 *
 * `balL = balance < 0 ? 1 : 1 - balance` et `balR = balance > 0 ? 1 : 1 + balance`,
 * recopiées de `MASAudioDSPProcess` (MASAudioDSP.m) et de `queueInput`
 * (AudioDSPProcessor.kt). Les deux plateformes doivent s'accorder sur cette
 * formule : `verify-balance.cjs` la compare au code natif et échoue si l'une
 * des deux dérive.
 *
 * Cette loi est volontairement linéaire plutôt que cos/sin. Elle n'a pas
 * d'atténuation constante au centre (gain 1.0 exact), et elle n'atténue que le
 * côté opposé — ce qui est le comportement attendu d'un bouton de balance.
 */
export function balanceGains(balance: number): { left: number; right: number } {
  const value = Number.isFinite(balance)
    ? Math.max(-1, Math.min(1, balance))
    : 0;
  return {
    left: value < 0 ? 1 : 1 - value,
    right: value > 0 ? 1 : 1 + value,
  };
}

/**
 * Génère la réponse impulsionnelle de la réverbération spatiale.
 *
 * ⚠ Le DSP natif implémente un Freeverb (4 peignes + 2 passe-tout par canal,
 * en C). Web Audio n'a pas de délai tunable : le seul nœud de réverbération
 * disponible est `ConvolverNode`, qui convolutionne. On ne peut donc pas
 * reproduire la même structure — mais on reproduit sa *loi de paramètres*,
 * calibrée sur le même RT60 que le natif et sur la compensation de gain
 * dont il a besoin.
 *
 * **Le bug que cette fonction corrige.** Une version antérieure calculait sa
 * durée par `-ln(feedback)/(ln10/1.5)` avec `feedback = roomSize·0.28+0.7`.
 * Cette formule donne une durée qui *décroît* quand le feedback croît : room
 * 100 % produisait une impulsion de 13 ms, soit un clic et non une salle.
 * C'est l'erreur classique de traiter une boucle de rétroaction comme une
 * réponse impulsionnelle — `-ln(fb)` mesure une décroissance, alors qu'ici il
 * faut une *longueur*. Un convolutionneur n'a pas de boucle : allonger la pièce,
 * c'est allonger le buffer.
 *
 * On passe donc par le RT60 visé (`reverbRt60Seconds`), la même grandeur que
 * celle affichée dans l'interface et que le natif cherche à atteindre :
 *
 *   - `roomSize` → RT60 de 0,30 s (chambre) à 4,00 s (nef).
 *   - `damping` → amortissement des aigus, comme le `damp * 0.4` du natif,
 *     plus une absorption HF qui croît avec le temps : une vraie pièce n'a pas
 *     le même timbre au début et à la fin de sa queue.
 *   - `reverbMix` → mélange humide via les gains wet/dry, comme le `mix * 0.5`
 *     du natif (50 % max). L'impulsion porte en plus
 *     `REVERB_GAIN_COMPENSATION_DB`, sans lequel le wet arriverait plus fort
 *     que le sec et le knob Room élèverait le niveau au lieu de l'élargir.
 *
 * La couleur spectraale diffère donc de celle du Freeverb (bruit à décroissance
 * exponentielle contre peignes sélectifs), mais les trois knobs agissent dans
 * le même sens et la même plage de durée. C'est une approximation assumée, pas
 * une parité — le harnais `verify-balance.cjs` le signale explicitement.
 *
 * Le bruit est déterministe : sans graine fixe, chaque changement de knob
 * changerait la qualité de la réverbération en même temps que sa longueur, ce
 * qu'on entend comme un souffle.
 */
function buildReverbImpulse(
  context: BaseAudioContext,
  roomSizePercent: number,
  dampingPercent: number
): AudioBuffer {
  const sampleRate = context.sampleRate || 44100;
  const damp = Math.max(0, Math.min(100, dampingPercent)) / 100;

  // RT60 visé par le knob — loi croissante et partagée avec l'interface.
  const rt60 = reverbRt60Seconds(roomSizePercent);
  // +25 % de longueur pour que la queue atteigne −60 dB avant la fin du buffer :
  // l'enveloppe est tronquée, donc il faut de la marge pour que le RT60 promis
  // soit réellement tenu.
  const lengthSeconds = Math.min(rt60 * 1.25, 8);
  const length = Math.max(1, Math.min(Math.floor(sampleRate * lengthSeconds), sampleRate * 8));

  const impulse = context.createBuffer(2, length, sampleRate);
  const dampingCoefficient = Math.min(0.85, 0.15 + damp * 0.7);
  // Absorption HF progressive : la queue s'assombrit avec le temps, comme dans
  // une pièce où l'air et les surfaces prennent le haut du spectre.
  const highFrequencyAbsorption = damp * 0.25;
  const wetGain = 10 ** (REVERB_GAIN_COMPENSATION_DB / 20);

  // Deux graines distinctes pour décoller la spatialisation gauche et droite (stéréo réelle)
  const seeds = [0x9e3779b9 >>> 0, 0x85ebca6b >>> 0];
  // Pré-délai : quelques ms avant la première réflexion, pour qu'on n'entende
  // pas l'écho direct collé au signal sec.
  const preDelaySamples = Math.floor(sampleRate * 0.012);

  for (let channel = 0; channel < 2; channel += 1) {
    const data = impulse.getChannelData(channel);
    let seed = seeds[channel];
    const noise = () => {
      seed ^= seed << 13;
      seed >>>= 0;
      seed ^= seed >> 17;
      seed ^= seed << 5;
      seed >>>= 0;
      return (seed / 0xffffffff) * 2 - 1;
    };

    let lowpass = 0;
    const tailSamples = Math.max(1, length - preDelaySamples);
    // Décroissance calée sur le RT60 : 10^(-3·t) vaut −60 dB exactement à t = 1,
    // donc la queue atteint le seuil à la fin du buffer. C'est la définition du
    // RT60, et c'est ce que l'interface annonce.
    const decayPerSample = (3 * Math.log(10)) / tailSamples;

    for (let i = 0; i < length; i += 1) {
      if (i < preDelaySamples) {
        data[i] = 0;
        continue;
      }
      const elapsed = i - preDelaySamples;
      const t = elapsed / tailSamples;
      const envelope = Math.exp(-decayPerSample * elapsed);
      // Absorption qui s'accentue : `1 - a·t` vaut 1 au début, `1 - a` à la fin.
      const absorption = 1 - highFrequencyAbsorption * t;
      // Filtre passe-bas modélisant l'absorption des hautes fréquences
      lowpass = lowpass * dampingCoefficient + noise() * (1 - dampingCoefficient);
      data[i] = lowpass * envelope * absorption * wetGain;
    }
  }
  return impulse;
}

/**
 * Matrice de mixage Mid-Side — la loi exacte du DSP natif.
 *
 * Le natif fait `m = (l+r)/2`, `s = (l-r)/2`, `s *= (1+w)`, puis `l = m+s`,
 * `r = m-s`. En développant, cela donne une matrice 2×2 dont les coefficients
 * sont calculés ici. Un nœud Web Audio neadditionne pas deux entrées avec des
 * gains distincts : chaque sortie reçoit donc les DEUX canaux, chacun via son
 * propre gain, et c'est le Câblage qui réalise l'addition.
 *
 * Convention identique au natif, y compris ses cas limites :
 *   - `w = 0` → matrice identité, signal intact.
 *   - `w = -1` → `l = (l+r)/2`, `r = (l+r)/2` : les deux canaux se
 *     rejoignent, c'est le repli mono. C'est ce que produit le natif quand
 *     `mono` envoie -1.0, et ce que produit le crossfeed à son maximum.
 *   - `w = -0.5` → `l = 0.75·l + 0.25·r`, chaque canal tire un quart de l'autre :
 *     l'image se recentre progressivement, c'est le crossfeed.
 *   - `w > 0` → `lr` devient négatif : les canaux se soustraient
 *     mutuellement, le side est amplifié, l'image s'élargit.
 *
 * Note d'énergie : cette matrice ne conserve pas la puissance — `w = 0.5` sort
 * à 1.25 sur un canal seul. C'est le comportement du natif, reproduit tel quel
 * ; le limiteur en aval rattrape ce qui dépasse.
 *
 * `verify-balance.cjs` compare ces coefficients à ceux du code natif.
 */
export function midSideMatrix(width: number): {
  ll: number;
  lr: number;
  rl: number;
  rr: number;
} {
  const w = Number.isFinite(width) ? width : 0;
  const side = 1 + w;
  // l = m + s = (l+r)/2 + (l-r)/2·side
  // r = m - s = (l+r)/2 - (l-r)/2·side
  return {
    ll: 0.5 + 0.5 * side,
    lr: 0.5 - 0.5 * side,
    rl: 0.5 - 0.5 * side,
    rr: 0.5 + 0.5 * side,
  };
}

export class WebAudioEngine {
  private ctx: AudioContext | null = null;
  private element: HTMLAudioElement | null = null;
  private analyser: AnalyserNode | null = null;
  private volumeGain: GainNode | null = null;
  private preampGain: GainNode | null = null;
  /**
   * Nœuds de balance : splitter → (gainL, gainR) → merger.
   *
   * Pas un `StereoPannerNode` : celui-ci applique une loi cos/sin qui vaut
   * 0.7071 sur *les deux* canaux au centre, soit −3 dB dès que la balance est
   * neutre. Le DSP natif utilise une loi linéaire (`1 − balance`) qui vaut
   * exactement 1.0 au centre. Pour que les deux plateformes sonnent pareil,
   * le web doit reproduire la loi linéaire, donc deux gains explicites.
   */
  private balanceNodes: {
    splitter: ChannelSplitterNode;
    left: GainNode;
    right: GainNode;
    merger: ChannelMergerNode;
  } | null = null;
  private stereoNodes: {
    splitter: ChannelSplitterNode;
    /** Gauche→gauche, Gauche→droite, Droite→gauche, Droite→droite. */
    ll: GainNode;
    lr: GainNode;
    rl: GainNode;
    rr: GainNode;
    merger: ChannelMergerNode;
  } | null = null;
  private reverbNodes: {
    convolver: ConvolverNode;
    wet: GainNode;
    dry: GainNode;
    merger: GainNode;
  } | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  /** Empreinte des derniers paramètres d'impulsion, pour ne regénérer que si besoin. */
  private reverbKey = '';
  private equalizerFilters: BiquadFilterNode[] = [];

  static isSupported(): boolean {
    if (typeof window === 'undefined') return false;
    const audioWindow = window as AudioContextWindow;
    return Boolean(audioWindow.AudioContext || audioWindow.webkitAudioContext);
  }

  constructor(element: HTMLAudioElement) {
    this.element = element;
    this.build();
  }

  private build() {
    const audioWindow = window as AudioContextWindow;
    const AudioContextConstructor =
      audioWindow.AudioContext || audioWindow.webkitAudioContext;

    if (!AudioContextConstructor || !this.element) {
      console.warn('Web Audio API indisponible — analyse audio désactivée.');
      return;
    }

    const context = new AudioContextConstructor();
    this.ctx = context;

    this.element.crossOrigin = 'anonymous';
    this.element.preload = 'auto';

    const source = context.createMediaElementSource(this.element);
    const analyser = context.createAnalyser();
    const volumeGain = context.createGain();
    const preampGain = context.createGain();
    // La balance n'existait pas côté web : le graphe s'arrêtait au volume, donc
    // le knob L/R ne pilotait que l'affichage. Voir balanceNodes pour le choix
    // du splitter/gains plutôt que d'un StereoPannerNode.
    const balanceSplitter = context.createChannelSplitter(2);
    const balanceLeft = context.createGain();
    const balanceRight = context.createGain();
    const balanceMerger = context.createChannelMerger(2);
    // Stéréo (Mid-Side), crossfeed et mono : absents du graphe depuis la
    // simplification du pipeline DSP. Les trois agissent sur les DEUX canaux
    // et partagent donc un même couple splitter/gains, câblé en aval de la
    // balance. Voir stereoGains pour la loi Mid-Side.
    const stereoSplitter = context.createChannelSplitter(2);
    const llGain = context.createGain();
    const lrGain = context.createGain();
    const rlGain = context.createGain();
    const rrGain = context.createGain();
    const stereoMerger = context.createChannelMerger(2);
    const equalizerFilters = MAS_PLAYER_BAND_FREQUENCIES.map((frequency) => {
      const filter = context.createBiquadFilter();
      filter.type = 'peaking';
      filter.frequency.value = frequency;
      filter.Q.value = 1.41421356237;
      filter.gain.value = 0;
      return filter;
    });
    this.analyser = analyser;
    this.volumeGain = volumeGain;
    this.preampGain = preampGain;
    this.balanceNodes = {
      splitter: balanceSplitter,
      left: balanceLeft,
      right: balanceRight,
      merger: balanceMerger,
    };
    this.stereoNodes = {
      splitter: stereoSplitter,
      ll: llGain,
      lr: lrGain,
      rl: rlGain,
      rr: rrGain,
      merger: stereoMerger,
    };
    // Réverbération : convolution parallèle au signal sec. Le nœud reçoit
    // l'impulsion générée par `buildReverbImpulse`, et le mélange se fait par
    // les gains dry/wet. Branchée en aval du Mid-Side, comme le natif, où le
    // Freeverb s'applique sur le signal déjà filtré, équilibré et mixé.
    const reverbConvolver = context.createConvolver();
    try {
      reverbConvolver.buffer = buildReverbImpulse(context, 40, 50);
      this.reverbKey = '40:50';
    } catch (_) {}
    const reverbWet = context.createGain();
    const reverbDry = context.createGain();
    const reverbMerger = context.createGain();
    this.reverbNodes = {
      convolver: reverbConvolver,
      wet: reverbWet,
      dry: reverbDry,
      merger: reverbMerger,
    };
    // Limiteur : absent du moteur web depuis la simplification du pipeline, la
    // pastille LIMIT de l'interface ne commandait donc rien sur navigateur. Il
    // se place en TOUT DERNIER, après balance, Mid-Side et réverbération : c'est
    // le seul endroit où l'écrêtage rattrape toutes les crêtes, y compris
    // celles produites par les effets eux-mêmes. Ratio 1 = plafond dur, voir
    // LIMIT_THRESHOLD_DB pour la mesure qui motive ce choix.
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = LIMIT_THRESHOLD_DB;
    limiter.knee.value = 0;
    limiter.ratio.value = 1;
    limiter.attack.value = LIMIT_ATTACK_S;
    limiter.release.value = LIMIT_RELEASE_S;
    this.limiter = limiter;
    this.equalizerFilters = equalizerFilters;
    analyser.fftSize = BEAT_ANALYSER_FFT_SIZE;
    analyser.smoothingTimeConstant = 0;
    volumeGain.gain.value = 1;
    balanceLeft.gain.value = 1;
    balanceRight.gain.value = 1;
    llGain.gain.value = 1;
    lrGain.gain.value = 0;
    rlGain.gain.value = 0;
    rrGain.gain.value = 1;
    reverbDry.gain.value = 1;
    reverbWet.gain.value = 0;

    let output: AudioNode = source;
    for (const filter of equalizerFilters) {
      output.connect(filter);
      output = filter;
    }
    output.connect(preampGain);
    // La balance passe après le préampli, comme dans le DSP natif où
    // `l *= balL` intervient sur le signal déjà filtré.
    preampGain.connect(balanceSplitter);
    balanceSplitter.connect(balanceLeft, 0);
    balanceSplitter.connect(balanceRight, 1);
    balanceLeft.connect(balanceMerger, 0, 0);
    balanceRight.connect(balanceMerger, 0, 1);
    // Mid-Side, branché en aval de la balance (comme le natif : `l *= balL` avant
    // le bloc stereo). Chaque sortie reçoit les deux canaux, chacun par son
    // gain — c'est ainsi que la matrice s'additionne.
    balanceMerger.connect(stereoSplitter);
    stereoSplitter.connect(llGain, 0);
    stereoSplitter.connect(lrGain, 0);
    stereoSplitter.connect(rlGain, 1);
    stereoSplitter.connect(rrGain, 1);
    llGain.connect(stereoMerger, 0, 0);
    lrGain.connect(stereoMerger, 0, 1);
    rlGain.connect(stereoMerger, 0, 0);
    rrGain.connect(stereoMerger, 0, 1);
    // Réverbération parallèle : le signal stéréo alimente la branche sèche (dry)
    // et la convolution (wet). Le mixeur est un GainNode qui somme naturellement
    // les deux composantes stéréo.
    stereoMerger.connect(reverbDry);
    stereoMerger.connect(reverbConvolver);
    reverbConvolver.connect(reverbWet);
    reverbDry.connect(reverbMerger);
    reverbWet.connect(reverbMerger);
    // Le limiteur est le dernier étage avant le volume, exactement comme côté
    // natif où le clamp final intervene après balance et réverbération.
    reverbMerger.connect(limiter);
    limiter.connect(volumeGain);
    volumeGain.connect(analyser);
    analyser.connect(context.destination);
  }

  getTimeDomainData(target: Float32Array<ArrayBuffer>): Float32Array<ArrayBuffer> | null {
    if (!this.analyser) return null;
    this.analyser.getFloatTimeDomainData(target);
    return target;
  }

  setVolume(volumePercent: number) {
    const volume = Math.max(0, Math.min(100, volumePercent)) / 100;
    if (this.ctx && this.volumeGain) {
      this.volumeGain.gain.setTargetAtTime(
        volume,
        this.ctx.currentTime,
        VOLUME_RAMP_SECONDS
      );
      if (this.element) this.element.volume = 1;
    } else if (this.element) {
      this.element.volume = volume;
    }
  }

  setEqualizer(enabled: boolean, bands: number[], preampDb: number) {
    if (!this.ctx || !this.preampGain) return;

    const now = this.ctx.currentTime;
    this.equalizerFilters.forEach((filter, index) => {
      const gain = enabled ? Math.max(-12, Math.min(12, bands[index] ?? 0)) : 0;
      filter.gain.setTargetAtTime(gain, now, VOLUME_RAMP_SECONDS);
    });

    const preamp = enabled ? Math.max(-6, Math.min(6, preampDb)) : 0;
    this.preampGain.gain.setTargetAtTime(
      10 ** (preamp / 20),
      now,
      VOLUME_RAMP_SECONDS
    );
  }

  /**
   * Applique la balance L/R. `-1` = gauche seul, `0` = centre, `+1` = droit seul.
   *
   * Appelé en plus de `setEqualizer` et indépendamment de lui : la balance est
   * appliquée même quand l'égaliseur est éteint, puisque le knob Balance n'est
   * pas un réglage d'EQ. Le DSP natif fait de même — `balance` alimente
   * `hasProcessing` sans dépendre de `enabled` sur les gains de canal.
   */
  setBalance(balance: number) {
    if (!this.ctx || !this.balanceNodes) return;
    const { left, right } = balanceGains(balance);
    const now = this.ctx.currentTime;
    this.balanceNodes.left.gain.setTargetAtTime(
      left,
      now,
      VOLUME_RAMP_SECONDS
    );
    this.balanceNodes.right.gain.setTargetAtTime(
      right,
      now,
      VOLUME_RAMP_SECONDS
    );
  }

  /**
   * Applique la matrice Mid-Side : stereo expansion, crossfeed et mono.
   *
   * Les trois effets partagent ce bloc, comme dans le DSP natif où ils sont
   * un seul paramètre `stereo`. `width` suit donc la convention du natif :
   * `0` neutre, `> 0` élargit, `-1` repli mono, entre 0 et -1 crossfeed.
   */
  setStereoWidth(width: number) {
    if (!this.ctx || !this.stereoNodes) return;
    const { ll, lr, rl, rr } = midSideMatrix(width);
    const now = this.ctx.currentTime;
    const nodes = this.stereoNodes;
    nodes.ll.gain.setTargetAtTime(ll, now, VOLUME_RAMP_SECONDS);
    nodes.lr.gain.setTargetAtTime(lr, now, VOLUME_RAMP_SECONDS);
    nodes.rl.gain.setTargetAtTime(rl, now, VOLUME_RAMP_SECONDS);
    nodes.rr.gain.setTargetAtTime(rr, now, VOLUME_RAMP_SECONDS);
  }

  /**
   * Applique la réverbération spatiale : activation, taille de pièce, amortissement
   * et mélange humide.
   *
   * `mix` est borné à 50 % comme le natif (`reverbMix * 0.5`). Regenerer
   * l'impulsion coûte quelques ms : on ne le fait que si la taille ou
   * l'amortissement ont réellement changé, pas à chaque appel — sinon un
   * glissement de knob produirait un souffle à chaque trame.
   */
  setReverb(enabled: boolean, roomSize: number, damping: number, mix: number) {
    if (!this.ctx || !this.reverbNodes) return;
    const now = this.ctx.currentTime;
    const { wet, dry, convolver } = this.reverbNodes;

    const clampedMix = Math.max(0, Math.min(100, mix)) / 200; // 0 → 0.5, comme le natif
    if (enabled) {
      const key = `${Math.round(roomSize)}:${Math.round(damping)}`;
      if (key !== this.reverbKey) {
        convolver.buffer = buildReverbImpulse(this.ctx, roomSize, damping);
        this.reverbKey = key;
      }
      wet.gain.setTargetAtTime(clampedMix, now, VOLUME_RAMP_SECONDS);
      dry.gain.setTargetAtTime(1 - clampedMix, now, VOLUME_RAMP_SECONDS);
    } else {
      wet.gain.setTargetAtTime(0, now, VOLUME_RAMP_SECONDS);
      dry.gain.setTargetAtTime(1, now, VOLUME_RAMP_SECONDS);
    }
  }

  /**
   * Commute le limiteur (plafond dur) via la pastille LIMIT de l'interface.
   *
   * ⚠ Le bypass ne remet PAS le ratio à 20, contrairement à une version
   * antérieure de ce fichier : en bypass, seuil et ratio restent le plafond
   * (threshold 0 dBFS, ratio 1), ce qui laisse passer le signal intact en
   * dessous de 0 dBFS sans jamais appliquer la courbe de compression. C'est le
   * comportement qu'un interrupteur « désactivé » doit avoir — un ratio 20 en
   * bypass continuerait de compresser, c'est-à-dire de ne pas être un bypass.
   */
  setLimiter(enabled: boolean) {
    if (!this.ctx || !this.limiter) return;
    const now = this.ctx.currentTime;
    this.limiter.threshold.setTargetAtTime(
      enabled ? LIMIT_THRESHOLD_DB : 0,
      now,
      VOLUME_RAMP_SECONDS
    );
    this.limiter.attack.setTargetAtTime(
      enabled ? LIMIT_ATTACK_S : 0,
      now,
      VOLUME_RAMP_SECONDS
    );
    this.limiter.release.setTargetAtTime(
      enabled ? LIMIT_RELEASE_S : 0,
      now,
      VOLUME_RAMP_SECONDS
    );
  }

  async resume() {
    if (this.ctx?.state === 'suspended') {
      await this.ctx.resume();
    }
    if (this.element?.paused) {
      await this.element.play();
    }
  }

  getContextState(): string {
    return this.ctx?.state ?? 'none';
  }

  async destroy() {
    if (this.ctx) {
      await this.ctx.close();
    }
    this.ctx = null;
    this.element = null;
    this.analyser = null;
    this.volumeGain = null;
    this.preampGain = null;
    this.balanceNodes = null;
    this.stereoNodes = null;
    this.reverbNodes = null;
    this.reverbKey = '';
    this.limiter = null;
    this.equalizerFilters = [];
  }
}
