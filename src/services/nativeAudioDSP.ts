import { Platform } from 'react-native';
import type { DSPState } from '../types/audio';
import { EQ_BANDS, computeHeadroom } from '../constants/presets';

/**
 * Pont vers le moteur d'égaliseur natif iOS (`modules/expo-audio-dsp`).
 *
 * Le module natif n'existe que dans un build natif (`expo run:ios` / EAS). Dans
 * Expo Go ou sur le Web, ce module n'est pas disponible et tout ce fichier
 * devient un no-op : l'app continue de fonctionner sur le chemin webAudioEngine
 * (Web) ou expo-audio (Go / natif sans module).
 */

/** Surface JS du module Swift, reflétant `AudioDSPModule.swift`. */
export interface AudioDSPNativeModule {
  loadTrackAsync(
    uri: string,
    title?: string,
    artist?: string
  ): Promise<{ duration: number; uri: string; cached: boolean }>;
  playAsync(): Promise<boolean>;
  pauseAsync(): Promise<boolean>;
  stopAsync(): Promise<void>;
  seekAsync(seconds: number): Promise<void>;
  setVolumeAsync(value: number): Promise<void>;
  setDSPAsync(
    bands: number[],
    preamp: number,
    balance: number,
    mono: boolean,
    stereoExpansion: number,
    enabled: boolean
  ): Promise<void>;
  addListener(
    event: 'onProgress',
    listener: (payload: {
      currentTime: number;
      duration: number;
      isPlaying: boolean;
      didFinish: boolean;
    }) => void
  ): { remove(): void };
}

/**
 * Accès au module natif iOS.
 */
function getNativeModule(): AudioDSPNativeModule | null {
  if (Platform.OS !== 'ios') {
    return null;
  }

  const proxy = (
    globalThis as unknown as {
      expo?: { modules?: Record<string, unknown> };
      nativeModuleProxy?: Record<string, unknown>;
    }
  ).expo?.modules;

  const candidate =
    proxy?.AudioDSP ?? (globalThis as { nativeModuleProxy?: Record<string, unknown> }).nativeModuleProxy?.AudioDSP;

  if (!candidate) {
    return null;
  }

  return candidate as AudioDSPNativeModule;
}

/** Vrai si le module natif est présent (build natif iOS, pas Expo Go / Web). */
export function isNativeEQAvailable(): boolean {
  return getNativeModule() !== null;
}

/** Charge une piste (téléchargement local puis ouverture), ou `null` si absent. */
export async function loadNativeTrack(
  uri: string,
  title?: string,
  artist?: string
): Promise<{ duration: number; uri: string } | null> {
  const module = getNativeModule();
  if (!module) return null;
  try {
    return await module.loadTrackAsync(uri, title, artist);
  } catch (err) {
    console.warn('Native AudioDSP loadTrackAsync error:', err);
    return null;
  }
}

/**
 * Abonne la progression du moteur natif.
 *
 * Le module Swift lève déjà un `Timer` 250 ms qui pousse `onProgress` ; c'est la
 * seule source de temps de lecture quand l'AVAudioEngine porte l'audio, donc
 * l'UI doit s'y abonner. Renvoie `null` si le module est absent.
 */
export function addNativeProgressListener(
  listener: (payload: {
    currentTime: number;
    duration: number;
    isPlaying: boolean;
    didFinish: boolean;
  }) => void
): { remove(): void } | null {
  const module = getNativeModule();
  if (!module) return null;
  try {
    return module.addListener('onProgress', listener);
  } catch (err) {
    console.warn('Native AudioDSP addListener error:', err);
    return null;
  }
}

/** Lance la lecture du graphe natif. Renvoie `false` si le module est absent. */
export async function playNative(): Promise<boolean> {
  const module = getNativeModule();
  if (!module) return false;
  try {
    return await module.playAsync();
  } catch (err) {
    console.warn('Native AudioDSP playAsync error:', err);
    return false;
  }
}

/** Met la lecture native en pause. */
export async function pauseNative(): Promise<void> {
  const module = getNativeModule();
  if (!module) return;
  try {
    await module.pauseAsync();
  } catch (err) {
    console.warn('Native AudioDSP pauseAsync error:', err);
  }
}

/** Arrête le graphe natif et libère la piste courante. */
export async function stopNative(): Promise<void> {
  const module = getNativeModule();
  if (!module) return;
  try {
    await module.stopAsync();
  } catch (err) {
    console.warn('Native AudioDSP stopAsync error:', err);
  }
}

/** Positionne la lecture native, en secondes. */
export async function seekNative(seconds: number): Promise<void> {
  const module = getNativeModule();
  if (!module) return;
  try {
    await module.seekAsync(seconds);
  } catch (err) {
    console.warn('Native AudioDSP seekAsync error:', err);
  }
}

/**
 * Pousse l'état DSP vers le moteur natif.
 */
export async function applyNativeDSP(dsp: DSPState): Promise<void> {
  const module = getNativeModule();
  if (!module) return;

  const rawBands = (dsp.bands ?? []).slice(0, EQ_BANDS.length);
  while (rawBands.length < EQ_BANDS.length) rawBands.push(0);

  const bass = dsp.bass ?? 0;
  const treble = dsp.treble ?? 0;
  const bassWeights = [1.0, 0.8, 0.5, 0.25];
  const trebleWeights: { [idx: number]: number } = { 6: 0.25, 7: 0.5, 8: 0.8, 9: 1.0 };

  const bands = rawBands.map((b, index) => {
    let g = b ?? 0;
    if (index < 4) {
      g += bass * bassWeights[index];
    } else if (index >= 6) {
      g += treble * (trebleWeights[index] ?? 0);
    }
    return Math.max(-12, Math.min(12, Math.round(g)));
  });

  const headroom = dsp.enabled ? computeHeadroom(bands) : 0;
  const preamp = Math.min(0, headroom + (dsp.preamp ?? 0));

  try {
    await module.setDSPAsync(
      bands,
      preamp,
      dsp.balance ?? 0,
      dsp.mono ?? false,
      dsp.stereoExpansion ?? 0,
      dsp.enabled
    );
  } catch (err) {
    console.warn('Native AudioDSP setDSPAsync error:', err);
  }
}

/** Volume utilisateur (0-100) → gain linéaire 0-1. */
export async function setNativeVolume(percent: number): Promise<void> {
  const module = getNativeModule();
  if (!module) return;
  try {
    await module.setVolumeAsync(Math.max(0, Math.min(1, percent / 100)));
  } catch (err) {
    console.warn('Native AudioDSP setVolumeAsync error:', err);
  }
}