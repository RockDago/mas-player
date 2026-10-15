import { BeatAnalyzer, type BeatFrame } from './beatAnalyzer';

/**
 * Point de passage unique entre la détection de rythme et l'interface.
 *
 * Le signal est lu ~60 fois/s. Le faire transiter par `setState` de React
 * déclencherait 60 reconciliations/s du composant qui le consomme — donc de
 * `App`, qui porte l'essentiel de l'état de l'application. D'où le choix
 * d'un objet *mutable* : `read()` est un accès mémoire, et seul le composant
 * qui anime le logo l'appelle.
 *
 * Les rares changements d'état (source, lecture) passent par `subscribe`, qui
 * est volontairement surgeon : il ne sert qu'à basculer entre le pulse et la
 * respiration au repos.
 */

export type BeatSource = 'none' | 'native' | 'web';

const EMPTY_FRAME: BeatFrame = {
  pulse: 0,
  energy: 0,
  bpm: null,
  beatCount: 0,
};

export interface AudioSpectrumData {
  bass: number;       // Énergie des basses & kicks (0..1)
  vocal: number;      // Énergie de la voix & instruments médiums (0..1)
  treble: number;     // Énergie des aigus & percussions (0..1)
  bins: Float32Array; // 64 bacs spectraux équilibrés (0..1)
}

class BeatStore {
  private analyzer = new BeatAnalyzer();
  private frame: BeatFrame = EMPTY_FRAME;

  /**
   * Horodatage (ms) de la dernière arrivée d'échantillons, 0 si jamais.
   *
   * `isAudioSamplingSupported` vaut `true` en dur sur iOS ET Android, alors que
   * l'installation du tap peut échouer silencieusement (item sans piste audio).
   * Ce compteur est donc le SEUL contrôle fiable : le chien de garde de
   * `playerManager` s'en sert pour basculer en repli.
   */
  lastPushAtMs = 0;

  source: BeatSource = 'none';
  isPlaying = false;

  private listeners = new Set<() => void>();

  /** S'abonne aux changements de `source`/`isPlaying`. Ne déclenche PAS à 60 Hz. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private notify() {
    this.listeners.forEach((listener) => listener());
  }

  /** Bacs d'amplitude audio en temps réel pour visualiseur de spectre (64 bandes). */
  private peakTracker = 0.25;
  private spectrumData: AudioSpectrumData = {
    bass: 0,
    vocal: 0,
    treble: 0,
    bins: new Float32Array(64),
  };

  private updateRawBins(frames: ArrayLike<number>): void {
    const len = frames.length;
    if (len === 0) return;

    // Détection automatique de l'échelle d'entrée (Float32 [-1, 1] ou octets bruts Android [0, 255] / [-128, 127])
    let maxAbs = 0;
    const testCount = Math.min(64, len);
    for (let i = 0; i < testCount; i++) {
      const a = Math.abs(frames[i]);
      if (a > maxAbs) maxAbs = a;
    }
    const scale = maxAbs > 1.8 ? 1 / 128 : 1.0;

    let bassSum = 0;
    let vocalSum = 0;
    let trebleSum = 0;

    let lp = 0;
    let prevSample = 0;

    const binCount = 64;
    const chunkSize = Math.max(1, Math.floor(len / binCount));
    let framePeak = 0.05;

    for (let b = 0; b < binCount; b++) {
      let chunkSum = 0;
      const start = b * chunkSize;
      const end = Math.min(len, start + chunkSize);

      for (let i = start; i < end; i++) {
        const x = frames[i] * scale;
        chunkSum += x * x;

        // Passe-bas (basses profondes < 250 Hz)
        lp += (x - lp) * 0.08;
        bassSum += lp * lp;

        // Passe-bande vocal (~300 Hz - 3.5 kHz)
        const vocalSample = x - lp;
        vocalSum += vocalSample * vocalSample;

        // Passe-haut aigus
        const diff = x - prevSample;
        trebleSum += diff * diff;
        prevSample = x;
      }

      const count = end - start || 1;
      const rms = Math.sqrt(chunkSum / count);
      if (rms > framePeak) framePeak = rms;

      this.spectrumData.bins[b] = this.spectrumData.bins[b] * 0.20 + rms * 0.80;
    }

    // Contrôle automatique de gain (AGC) pour éviter toute saturation au plafond
    this.peakTracker = Math.max(0.06, this.peakTracker * 0.985 + framePeak * 0.015);
    const normFactor = 1 / (this.peakTracker * 1.5);

    for (let b = 0; b < binCount; b++) {
      this.spectrumData.bins[b] = Math.min(1.0, this.spectrumData.bins[b] * normFactor);
    }

    const bRms = Math.sqrt(bassSum / len) * normFactor;
    const vRms = Math.sqrt(vocalSum / len) * normFactor;
    const tRms = Math.sqrt(trebleSum / len) * normFactor;

    this.spectrumData.bass = this.spectrumData.bass * 0.3 + Math.min(1.0, bRms * 1.2) * 0.7;
    this.spectrumData.vocal = this.spectrumData.vocal * 0.3 + Math.min(1.0, vRms * 1.35) * 0.7;
    this.spectrumData.treble = this.spectrumData.treble * 0.3 + Math.min(1.0, tRms * 1.1) * 0.7;
  }

  /** PCM Float32 (iOS). Seul le premier canal est lu — voir `BeatAnalyzer`. */
  pushNative(frames: ArrayLike<number>): void {
    this.analyzer.pushPcm(frames);
    this.updateRawBins(frames);
    this.lastPushAtMs = Date.now();
  }

  /** Octets non signés [-1, 1] (Android `Visualizer`, mode WAVEFORM). */
  pushNativeCoarse(frames: ArrayLike<number>): void {
    this.analyzer.pushCoarseWaveform(frames);
    this.updateRawBins(frames);
    this.lastPushAtMs = Date.now();
  }

  /** Time-domain Float32 depuis l'`AnalyserNode` de `WebAudioEngine`. */
  pushWeb(frames: Float32Array): void {
    this.analyzer.pushPcm(frames);
    this.updateRawBins(frames);
    this.lastPushAtMs = Date.now();
  }

  /** Données spectrales complètes en direct (basses, voix, aigus, bacs). */
  getSpectrumData(): AudioSpectrumData {
    return this.spectrumData;
  }

  /** Bacs d'amplitude en direct pour affichage spectral en temps réel. */
  getRawBins(): Float32Array {
    return this.spectrumData.bins;
  }

  /** Dernier état analysé. Appelé ~60 fois/s : doit rester bon marché. */
  read(): BeatFrame {
    this.frame = this.analyzer.read();
    return this.frame;
  }

  setPlaying(isPlaying: boolean) {
    if (this.isPlaying === isPlaying) return;
    this.isPlaying = isPlaying;
    this.notify();
  }

  setSource(source: BeatSource) {
    if (this.source === source) return;
    this.source = source;
    this.notify();
  }

  /**
   * Remet l'analyseur à zéro entre deux pistes.
   *
   * Sans cela, la décroissance de l'enveloppe de la piste précédente et le
   * bruit du premier tampon silencieux produiraient de faux onsets sur l'intro
   * de la nouvelle. Arme aussi le chien de garde (`lastPushAtMs = 0`).
   */
  reset() {
    this.analyzer.reset();
    this.spectrumData.bins.fill(0);
    this.spectrumData.bass = 0;
    this.spectrumData.vocal = 0;
    this.spectrumData.treble = 0;
    this.peakTracker = 0.25;
    this.frame = EMPTY_FRAME;
    this.lastPushAtMs = 0;
  }
}

export const beatStore = new BeatStore();
