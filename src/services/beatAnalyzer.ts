/**
 * Détection de rythme — logique pure, sans React ni import de plateforme.
 *
 * Le signal d'entrée change selon la plateforme, et ce n'est pas un détail :
 *   - iOS   : PCM Float32 par canal, via `MTAudioProcessingTap` (expo-audio).
 *   - Web   : time-domain Float32 depuis l'`AnalyserNode` de WebAudioEngine.
 *   - Android: `Visualizer` en mode WAVEFORM, donc des octets non signés
 *             ramenés dans [-1, 1], mono par construction, à une fréquence
 *             d'échantillonnage que la plateforme accorde (souvent 256-1024
 *             échantillons par tampon). Ce n'est pas du PCM, et la résolution
 *             est trop grossière pour tenter une mesure de BPM.
 *
 * D'où `pushPcm` (Float32, BPM tentable) et `pushCoarseWaveform` (octets,
 * énergie seule). Les deux convergent vers le même analyzeur.
 *
 * Trois étapes, volontairement dans cet ordre :
 *   1. accumulation RMS par fenêtre de taille fixe — les tampons natifs ont des
 *      tailles variables (1024 à 4096), or une fenêtre qui glisse avec la taille
 *      des tampons ferait vibrer la détection ;
 *   2. detection d'onset par flux redressé et seuil ADAPTATIF (moyenne mobile),
 *      ce qui suit le morceau : il réagit aussi bien à un titre faible qu'à un
 *      titre fort, et se ré-adapte quand l'utilisateur change le volume ;
 *   3. enveloppe attaque/décomposition temporelle — c'est elle, et non le
 *      drapeau d'onset, qui pilote visuellement le logo.
 */

/** Échantillons par fenêtre d'analyse. 1028 ≈ 21 ms à 48 kHz. */
const ANALYSIS_FRAME = 1024;

/**
 * Nombre de fenêtres conservées pour la moyenne du flux.
 * 43 ≈ 0,9 s à 48 kHz : à 120 BPM cela couvre ~2 temps, assez pour la moyenne
 * sans noyer les variations d'un refrain à l'autre.
 */
const AVG_WINDOW = 43;

/**
 * Multiplicateur du seuil au-dessus de la moyenne mobile.
 * 1,3 double-déclenche sur les charleston ; 2,0+ supprime le pulse sur un ballad
 * peu rythmé. 1,6 est le compromis, à ajuster à l'oreille.
 */
const SENSITIVITY = 1.6;

/**
 * Plancher du seuil, en flux. Sans lui, un silence donne une moyenne ≈ 0 donc un
 * seuil ≈ 0, et chaque bougé du bruit de fond déclencherait un onset.
 */
const THRESHOLD_FLOOR = 0.0015;

/**
 * Période réfractaire entre deux onsets. Plafonne la cadence à ~7,7 pulses/s
 * (≈ 460 BPM) : sans elle, grosse caisse et caisse claire d'un même temps
 * déclenchent chacune et le logo stroboscope.
 */
const REFRACTORY_SECONDS = 0.13;

/**
 * L'attaque de l'enveloppe est *immédiate* — voir `analyzeFrame`, où elle est
 * appliquée à part. Aucune constante de temps ici : l'attaque douce qu'on
 * écrirait spontanément est fausse, l'analyseur ne produisant qu'une valeur
 * par fenêtre de ~21 ms elle ne monterait jamais à 1. Un beat est un instant,
 * pas une montée.
 *
 * Décomposition. 190 ms donne ~5 frames visibles de retombée à 60 Hz.
 */
const RELEASE_SECONDS = 0.19;

/** Constante de temps du suiveur d'énergie « lente », pour le mouvement continu. */
const ENERGY_TAU_SECONDS = 0.12;

/**
 * Garde-fou de pas minimal. Sous congestion du thread JS, les callbacks natifs
 * arrivent par bouffées : sans ce plancher, une rafale de 5 callbacks en un
 * frame produirait une décomposition nonsense.
 */
const MIN_DT_MS = 8;

/** Intervalles inter-onset retenus pour l'estimation de tempo. */
const BPM_HISTORY = 24;

/** Hors de cette plage, l'intervalle n'est pas un temps musical. */
const BPM_MIN_INTERVAL = 0.28; // ≈ 214 BPM
const BPM_MAX_INTERVAL = 1.2; // ≈ 50 BPM

/** En dessous de ce nombre d'intervalles valides, le BPM n'est pas Estimé. */
const BPM_MIN_SAMPLES = 8;

export type BeatFrame = {
  /** Enveloppe 0..1 : ce qui pilote la pulsation du logo. */
  pulse: number;
  /** Énergie lissée 0..1 : mouvement continu plus discret. */
  energy: number;
  /** Tempo estimé, ou null tant qu'il n'y a pas assez d'historique. */
  bpm: number | null;
  /** Nombre d'onsets détectés depuis le dernier reset. */
  beatCount: number;
};

/**
 * Fréquence d'échantillonnage des octets Android.
 *
 * `Visualizer.getMaxCaptureRate() / 2` vaut typiquement 16000/2 = 8 kHz, mais la
 * valeur exacte dépend de l'appareil. On ne s'en sert QUE pour dimensionner la
 * fenêtre d'analyse, jamais pour un BPM : à 8 kHz la moitié de la spectrum
 * audible est déjà perdue.
 */
const ANDROID_CAPTURE_RATE = 8000;

export class BeatAnalyzer {
  /** Échantillons de la fenêtre en cours, réutilisés d'un tampon à l'autre. */
  private readonly frameBuffer = new Float32Array(ANALYSIS_FRAME);
  private frameCount = 0;
  private sumSquares = 0;

  /** RMS de la fenêtre précédente, pour le flux redressé demi-onde. */
  private previousRms = 0;

  /** Fenêtre glissante du flux, somme maintenance en O(1). */
  private readonly fluxWindow = new Float64Array(AVG_WINDOW);
  private fluxSum = 0;
  private fluxIndex = 0;
  private fluxFilled = 0;

  /** Enveloppe attaque/décomposition et suiveur d'énergie. */
  private pulse = 0;
  private energy = 0;

  /** Historique des intervalles inter-onset, pour le BPM. */
  private readonly intervals: number[] = [];
  private lastOnsetAt = -Infinity;
  private beatCount = 0;

  private lastNowMs = 0;
  private sampleRate: number;
  private hasSamples = false;

  /**
   * @param sampleRate Fréquence connue du PCM. 0 pour les octets Android : on
   *   analyse alors l'énergie sans chercher de tempo.
   */
  constructor(sampleRate: number = 48000) {
    this.sampleRate = sampleRate;
  }

  /** Remet l'analyseur à zéro. À appeler à chaque changement de piste. */
  reset() {
    this.frameCount = 0;
    this.sumSquares = 0;
    this.previousRms = 0;
    this.fluxSum = 0;
    this.fluxIndex = 0;
    this.fluxFilled = 0;
    this.pulse = 0;
    this.energy = 0;
    this.intervals.length = 0;
    this.lastOnsetAt = -Infinity;
    this.beatCount = 0;
    this.lastNowMs = 0;
    this.hasSamples = false;
    this.frameBuffer.fill(0);
    this.fluxWindow.fill(0);
  }

  /**
   * PCM Float32 (iOS, web). Seul le PREMIER canal est lu.
   *
   * expo-audio alloue un tableau Swift par canal et le fait franchir le pont vers
   * JS à chaque tampon (~40 tampons/s × 2 canaux × 2048 flottants). Lire l'autre
   * canal ne coûte rien côté JS mais ne sert à rien : l'oreille jugera la
   * pulsation sur le contenu, pas sur la différence entre canaux.
   */
  pushPcm(frames: ArrayLike<number>): void {
    this.accumulate(frames);
  }

  /**
   * Octets non signés ramenés dans [-1, 1] (Android `Visualizer`, mode
   * WAVEFORM). Mono, basse résolution : l'énergie suffit, le BPM non.
   */
  pushCoarseWaveform(frames: ArrayLike<number>): void {
    if (this.sampleRate !== ANDROID_CAPTURE_RATE) {
      this.sampleRate = ANDROID_CAPTURE_RATE;
    }
    this.accumulate(frames);
  }

  /**
   * Ajoute des échantillons à la fenêtre courante.
   *
   * La boucle par échantillon ne fait QUE `sumSquares += x*x` : c'est le budget
   * JS entier à 48 kHz, on n'y met ni `Date.now()`, ni allocation, ni branche.
   */
  private accumulate(frames: ArrayLike<number>) {
    const buffer = this.frameBuffer;
    let count = this.frameCount;
    let sum = this.sumSquares;

    for (let i = 0; i < frames.length; i++) {
      const x = frames[i];
      sum += x * x;
      buffer[count++] = x;
      if (count === ANALYSIS_FRAME) {
        this.analyzeFrame(buffer, sum);
        count = 0;
        sum = 0;
      }
    }

    this.frameCount = count;
    this.sumSquares = sum;
    this.hasSamples = true;
  }

  /** Traite une fenêtre complète : RMS, flux, seuil, onset, enveloppe. */
  private analyzeFrame(buffer: Float32Array, sumSquares: number) {
    const nowMs = Date.now();

    // Pas minimal : une rafale de callbacks ne doit pas produire un dt absurde.
    let dt = (nowMs - this.lastNowMs) / 1000;
    this.lastNowMs = nowMs;
    if (!isFinite(dt) || dt < 0) dt = 0;
    if (dt < MIN_DT_MS / 1000) dt = MIN_DT_MS / 1000;

    const rms = Math.sqrt(sumSquares / ANALYSIS_FRAME);

    // Flux redressé demi-onde : une montée d'énergie nette. C'est la fonction
    // de détection d'onset classique, et le redresseur la rend robuste aux
    // passages soutenus.
    const flux = Math.max(0, rms - this.previousRms);
    this.previousRms = rms;

    // Moyenne glissante, maintenue en O(1).
    this.fluxSum += flux - this.fluxWindow[this.fluxIndex];
    this.fluxWindow[this.fluxIndex] = flux;
    this.fluxIndex = (this.fluxIndex + 1) % AVG_WINDOW;
    if (this.fluxFilled < AVG_WINDOW) this.fluxFilled++;

    // Tant que la fenêtre n'est pas pleine, sa moyenne est biaisée vers le bas
    // (les zéros du départ tirent la moyenne) : on ne déclenche rien avant.
    const avg = this.fluxFilled < AVG_WINDOW ? 0 : this.fluxSum / AVG_WINDOW;
    const threshold = avg * SENSITIVITY + THRESHOLD_FLOOR;

    const nowSec = nowMs / 1000;
    const isOnset =
      flux > threshold && nowSec - this.lastOnsetAt > REFRACTORY_SECONDS;

    if (isOnset) {
      if (isFinite(this.lastOnsetAt)) {
        const interval = nowSec - this.lastOnsetAt;
        if (interval >= BPM_MIN_INTERVAL && interval <= BPM_MAX_INTERVAL) {
          this.intervals.push(interval);
          if (this.intervals.length > BPM_HISTORY) this.intervals.shift();
        }
      }
      this.lastOnsetAt = nowSec;
      this.beatCount++;
    }

    // Enveloppe attaque/décomposition. `exp` est calculé une fois par fenêtre
    // (~47/s), jamais par échantillon.
    //
    // L'attaque est instantanée et traitée à part : avec une constante de temps
    // nulle, `exp(-dt / 0)` vaut -Infinity et le coefficient
    // `1 - exp(...)` deviendrait `Infinity`, ce qui corromprait `pulse`.
    if (isOnset) {
      this.pulse = 1;
    } else {
      this.pulse += (0 - this.pulse) * (1 - Math.exp(-dt / RELEASE_SECONDS));
      if (this.pulse < 0.0005) this.pulse = 0;
    }

    // Suiveur d'énergie : sert au mouvement continu, plus doux que le pulse.
    const energyTarget = Math.min(1, rms * 8);
    this.energy += (energyTarget - this.energy) * (1 - Math.exp(-dt / ENERGY_TAU_SECONDS));
  }

  /** Dernier état analysé. Bon marché : appelable depuis une boucle rAF. */
  read(): BeatFrame {
    return {
      pulse: this.pulse,
      energy: this.energy,
      bpm: this.estimateBpm(),
      beatCount: this.beatCount,
    };
  }

  /**
   * Tempo estimé, médian des derniers intervalles.
   *
   * La médiane plutôt que la moyenne : un temps manqué ne l'entraîne pas, ce que
   * la moyenne ne fait pas. Purement décoratif — faux sur du half-time ou du
   * double-time — donc rien ne doit en dépendre.
   */
  private estimateBpm(): number | null {
    if (this.intervals.length < BPM_MIN_SAMPLES) return null;
    const sorted = [...this.intervals].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    return Math.round((60 / median) * 10) / 10;
  }
}
