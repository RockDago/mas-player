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

  /** PCM Float32 (iOS). Seul le premier canal est lu — voir `BeatAnalyzer`. */
  pushNative(frames: ArrayLike<number>): void {
    this.analyzer.pushPcm(frames);
    this.lastPushAtMs = Date.now();
  }

  /** Octets non signés [-1, 1] (Android `Visualizer`, mode WAVEFORM). */
  pushNativeCoarse(frames: ArrayLike<number>): void {
    this.analyzer.pushCoarseWaveform(frames);
    this.lastPushAtMs = Date.now();
  }

  /** Time-domain Float32 depuis l'`AnalyserNode` de `WebAudioEngine`. */
  pushWeb(frames: Float32Array): void {
    this.analyzer.pushPcm(frames);
    this.lastPushAtMs = Date.now();
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
    this.frame = EMPTY_FRAME;
    this.lastPushAtMs = 0;
  }
}

export const beatStore = new BeatStore();
