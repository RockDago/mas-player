import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';
import type { DSPState } from '../types/audio';
import { EQ_BANDS, BASS_WEIGHTS, TREBLE_WEIGHTS, computeHeadroom, computeReverbGains } from '../constants/presets';

/**
 * Pont vers le moteur d'égaliseur natif iOS / Android (`modules/expo-audio-dsp`).
 *
 * Le module natif n'existe que dans un build natif (`expo run:ios` / `expo run:android` / EAS / APK / IPA).
 * Dans Expo Go ou sur le Web, ce module n'est pas disponible et ce fichier
 * dégrade avec grâce sur le chemin webAudioEngine (Web) ou expo-audio pur (Expo Go).
 */

/** Surface JS du module natif AudioDSP (iOS Swift & Android Kotlin). */
export interface AudioDSPNativeModule {
  setAudioSessionIdAsync?(sessionId: number): Promise<void>;
  loadTrackAsync(
    uri: string,
    title?: string | null,
    artist?: string | null,
    album?: string | null,
    artwork?: string | null
  ): Promise<{ duration: number; uri: string; cached: boolean }>;
  playAsync(): Promise<boolean>;
  pauseAsync(): Promise<boolean>;
  stopAsync(): Promise<void>;
  getStatusAsync(): Promise<{ currentTime: number; duration: number; isPlaying: boolean }>;
  seekAsync(seconds: number): Promise<void>;
  setVolumeAsync(value: number): Promise<void>;
  setPlaybackRateAsync?(rate: number): Promise<void>;
  getSystemVolumeAsync(): Promise<number>;
  clearNowPlayingAsync(): Promise<void>;
  /** Reprise après interruption — iOS seulement, cf. `setNativeAutoResumeOnInterruption`. */
  setAutoResumeAsync?(enabled: boolean): Promise<void>;
  setDSPAsync(
    bands: number[],
    preamp: number,
    balance: number,
    mono: boolean,
    stereoExpansion: number,
    enabled: boolean,
    crossfeed: number,
    /** Réverbération — cf. `AudioDSPModule.setDSPAsync`. */
    reverbEnabled?: boolean,
    roomSize?: number,
    damping?: number,
    reverbMix?: number,
    /** Gains de dosage, calculés par `computeReverbGains` — jamais en Swift. */
    reverbWet?: number,
    reverbDry?: number,
    /**
     * Pastille LIMIT. Défaut `true` : le limiteur est la garantie que la chaîne
     * ne dépasse jamais le zéro numérique. Le natif l'aligne sur la même loi de
     * contournement que le web — seuil relevé à 0 dBFS, étage conservé.
     */
    limitEnabled?: boolean
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
  addListener(
    event: 'onRemoteCommand',
    listener: (payload: {
      action: 'next' | 'previous' | 'play' | 'pause';
    }) => void
  ): { remove(): void };
  addListener(
    event: 'onSystemVolume',
    listener: (payload: { volume: number; readable: boolean }) => void
  ): { remove(): void };
}

/**
 * Accès au module natif AudioDSP (iOS & Android).
 */
function getNativeModule(): AudioDSPNativeModule | null {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
    return null;
  }

  try {
    const mod = requireOptionalNativeModule<AudioDSPNativeModule>('AudioDSP');
    if (mod) return mod;
  } catch (_) {}

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

/** Vrai si le module natif est présent (build natif iOS ou Android). */
export function isNativeEQAvailable(): boolean {
  return getNativeModule() !== null;
}

/**
 * Associe la session audio courante (Android) aux effets matériels natifs.
 */
export async function setNativeAudioSessionId(sessionId: number): Promise<void> {
  const module = getNativeModule();
  if (!module || !module.setAudioSessionIdAsync) return;
  try {
    await module.setAudioSessionIdAsync(sessionId);
  } catch (err) {
    console.warn('Native AudioDSP setAudioSessionIdAsync error:', err);
  }
}

/**
 * Autorise ou interdit la reprise après une interruption (iOS uniquement).
 *
 * iOS ne peut pas être piloté depuis JS comme Android : `AudioDSPEngine.swift`
 * traite `AVAudioSession.interruptionNotification` et reprend la lecture si
 * l'option `.shouldResume` est présente, AVANT d'en informer JS. JS ne voit
 * donc la reprise qu'une fois faite, et ne peut plus l'empêcher — il doit le
 * dire au natif AVANT l'interruption, d'où ce drapeau.
 *
 * Android n'a pas besoin de ce passage : le focus audio y fait déjà le travail,
 * piloté par `interruptionMode` dans `playerManager`.
 *
 * Sans effet si le module natif est absent (web, Expo Go) : l'appel est un
 * no-op plutôt qu'une erreur.
 */
export async function setNativeAutoResumeOnInterruption(enabled: boolean): Promise<void> {
  const module = getNativeModule();
  if (!module || !module.setAutoResumeAsync) return;
  try {
    await module.setAutoResumeAsync(enabled);
  } catch (err) {
    console.warn('Native AudioDSP setAutoResumeAsync error:', err);
  }
}

/** Charge une piste (téléchargement local puis ouverture), ou `null` si absent. */
export async function loadNativeTrack(
  uri: string,
  title?: string,
  artist?: string,
  album?: string,
  artwork?: string
): Promise<{ duration: number; uri: string } | null> {
  const module = getNativeModule();
  if (!module) return null;
  try {
    return await module.loadTrackAsync(
      uri,
      title ?? null,
      artist ?? null,
      album ?? null,
      artwork ?? null
    );
  } catch (err) {
    console.warn('Native AudioDSP loadTrackAsync error:', err);
    return null;
  }
}

/**
 * Abonne les commandes distantes du Centre de Contrôle / Écran Verrouillé iOS.
 */
export function addNativeRemoteCommandListener(
  listener: (payload: { action: 'next' | 'previous' | 'play' | 'pause' }) => void
): { remove(): void } | null {
  const module = getNativeModule();
  if (!module) return null;
  try {
    return module.addListener('onRemoteCommand', listener);
  } catch (err) {
    console.warn('Native AudioDSP addNativeRemoteCommandListener error:', err);
    return null;
  }
}

/**
 * Abonne les variations du volume système iOS (boutons de l'appareil).
 *
 * La valeur arrive en 0…1 : c'est la conversion en pourcentage qui est faite
 * côté appelant, à la frontière, pour que ce service reste dans les unités
 * natives de chaque couche.
 *
 * Rend `null` hors module natif (Expo Go, web) — même contrat que les autres
 * abonnements, l'appelant dégrade sans crash.
 */
export function addNativeSystemVolumeListener(
  listener: (payload: { volume: number; readable: boolean }) => void
): { remove(): void } | null {
  const module = getNativeModule();
  if (!module) return null;
  try {
    return module.addListener('onSystemVolume', listener);
  } catch (err) {
    console.warn('Native AudioDSP onSystemVolume error:', err);
    return null;
  }
}

/** Récupère le volume système iOS actuel (0...100) ou null si indisponible. */
export async function getNativeSystemVolume(): Promise<number | null> {
  const module = getNativeModule();
  if (!module) return null;
  try {
    const vol = await module.getSystemVolumeAsync();
    return typeof vol === 'number' ? Math.max(0, Math.min(100, Math.round(vol * 100))) : null;
  } catch (err) {
    console.warn('Native AudioDSP getSystemVolumeAsync error:', err);
    return null;
  }
}

/** Efface les métadonnées de lecture sur l'écran verrouillé. */
export async function clearNativeNowPlaying(): Promise<void> {
  const module = getNativeModule();
  if (!module) return;
  try {
    await module.clearNowPlayingAsync();
  } catch (err) {
    console.warn('Native AudioDSP clearNowPlayingAsync error:', err);
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

/** Change la vitesse de lecture du moteur natif iOS sans modifier la hauteur. */
export async function setNativePlaybackRate(rate: number): Promise<void> {
  const module = getNativeModule();
  if (!module?.setPlaybackRateAsync) return;
  try {
    await module.setPlaybackRateAsync(Math.max(0.5, Math.min(2, rate)));
  } catch (err) {
    console.warn('Native AudioDSP setPlaybackRateAsync error:', err);
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

/** Récupère l'état instantané du moteur natif iOS. */
export async function getNativeStatus(): Promise<{
  currentTime: number;
  duration: number;
  isPlaying: boolean;
} | null> {
  const module = getNativeModule();
  if (!module) return null;
  try {
    return await module.getStatusAsync();
  } catch (err) {
    console.warn('Native AudioDSP getStatusAsync error:', err);
    return null;
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

/** Les quatorze champs DSP transmis au natif, dans l'ordre de `AudioDSPModule`. */
export interface DSPPayload {
  bands: number[];
  preamp: number;
  balance: number;
  mono: boolean;
  stereoExpansion: number;
  enabled: boolean;
  crossfeed: number;
  reverbEnabled: boolean;
  roomSize: number;
  damping: number;
  reverbMix: number;
  reverbWet: number;
  reverbDry: number;
  limitEnabled: boolean;
}

/* ── Diagnostic de la chaîne DSP ──────────────────────────────────────────── */

/**
 * Trace du dernier `setDSPAsync` réellement émis, et de ce qu'il a produit.
 *
 * Existant parce que la chaîne peut casser *sans lever la moindre exception* :
 * le module est présent, l'appel part, le natif l'accepte — et le son ne
 * traverse pas le moteur qui reçoit les gains (cf. la garde de
 * `playerManager.setDSP`). Sans trace, ce cas est indiscernable d'un EQ
 * simplement inaudible. `DSPDebugOverlay` lit ce bloc.
 */
const dspTrace: {
  callCount: number;
  lastPayload: DSPPayload | null;
  lastError: string | null;
  lastErrorAt: number | null;
  lastSuccessAt: number | null;
} = {
  callCount: 0,
  lastPayload: null,
  lastError: null,
  lastErrorAt: null,
  lastSuccessAt: null,
};

/** État de diagnostic de la chaîne DSP native, à lire depuis l'overlay. */
export interface NativeDSPDiagnostics {
  platform: string;
  /** Le module `AudioDSP` a-t-il été trouvé par le pont ? */
  moduleFound: boolean;
  /**
   * Méthodes réellement présentes sur l'objet natif. Détecte un module
   * partiellement lié : `requireOptionalNativeModule` renvoie un objet non
   * nul même quand une `AsyncFunction` n'a pas été compilée dedans, et
   * l'appel suivant échoue alors au `try/catch`.
   */
  methods: string[];
  callCount: number;
  lastPayload: DSPPayload | null;
  lastError: string | null;
  /** Millisecondes écoulées depuis le dernier appel accepté par le natif. */
  lastSuccessAgeMs: number | null;
  lastErrorAgeMs: number | null;
}

export function getNativeDSPDiagnostics(): NativeDSPDiagnostics {
  const module = getNativeModule();
  const methods: string[] = [];
  if (module) {
    // Les méthodes d'un module expo sont des accesseurs sur le proxy : les
    // énumérer via `Object.keys` est le seul moyen de savoir ce qui existe
    // réellement sans appeler chaque fonction.
    for (const key of Object.keys(module)) {
      if (typeof (module as unknown as Record<string, unknown>)[key] === 'function') {
        methods.push(key);
      }
    }
  }
  const now = Date.now();
  return {
    platform: Platform.OS,
    moduleFound: module !== null,
    methods,
    callCount: dspTrace.callCount,
    lastPayload: dspTrace.lastPayload,
    lastError: dspTrace.lastError,
    lastSuccessAgeMs: dspTrace.lastSuccessAt === null ? null : now - dspTrace.lastSuccessAt,
    lastErrorAgeMs: dspTrace.lastErrorAt === null ? null : now - dspTrace.lastErrorAt,
  };
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
  const bassWeights = BASS_WEIGHTS;
  const trebleWeights = TREBLE_WEIGHTS;

  /**
   * Contribution bass/treble, indépendante de la pastille TONE.
   *
   * `toneEnabled` à `false` ne retire pas les bandes — celles-ci relèvent de la
   * pastille EQU — il retire seulement la **pente** que bass et treble
   * ajoutent par-dessus. Même règle que le web (`webAudioEngine.applyDSP`) :
   * les deux plateformes doivent appliquer la même courbe, `verify:sync` compare.
   */
  const tone = dsp.toneEnabled === false ? 0 : 1;

  const bands = rawBands.map((b, index) => {
    let g = b ?? 0;
    if (index < 4) {
      g += tone * bass * (bassWeights[index] ?? 0);
    } else if (index >= 6) {
      g += tone * treble * (trebleWeights[index] ?? 0);
    }
    return Math.max(-12, Math.min(12, Math.round(g)));
  });

  const headroom = dsp.enabled ? computeHeadroom(bands) : 0;
  const preamp = Math.min(0, headroom + (dsp.preamp ?? 0));

  // Réverbération : les gains sont calculés ICI, pas en Swift, pour que les deux
  // plateformes appliquent exactement la même loi de dosage. Le natif reçoit le
  // couple wet/dry et ne le recalcule pas.
  const reverbGains = computeReverbGains(dsp.reverbMix ?? 0);

  const payload: DSPPayload = {
    bands,
    preamp,
    balance: dsp.balance ?? 0,
    mono: dsp.mono ?? false,
    stereoExpansion: dsp.stereoExpansion ?? 0,
    enabled: dsp.enabled,
    crossfeed: dsp.crossfeed ?? 0,
    reverbEnabled: dsp.reverbEnabled ?? false,
    roomSize: dsp.roomSize ?? 0,
    damping: dsp.damping ?? 0,
    reverbMix: dsp.reverbMix ?? 0,
    reverbWet: reverbGains.wet,
    reverbDry: reverbGains.dry,
    limitEnabled: dsp.limitEnabled ?? true,
  };

  dspTrace.callCount += 1;
  dspTrace.lastPayload = payload;

  try {
    if (Platform.OS === 'android') {
      // Android reçoit un seul dictionnaire, iOS ses quatorze arguments
      // positionnels. Les deux formes portent le même jeu de champs, et
      // `verify:dsp-bridge` verrouille leur accord.
      await (module.setDSPAsync as unknown as (p: DSPPayload) => Promise<void>)(payload);
    } else {
      await module.setDSPAsync(
        payload.bands,
        payload.preamp,
        payload.balance,
        payload.mono,
        payload.stereoExpansion,
        payload.enabled,
        payload.crossfeed,
        payload.reverbEnabled,
        payload.roomSize,
        payload.damping,
        payload.reverbMix,
        payload.reverbWet,
        payload.reverbDry,
        payload.limitEnabled
      );
    }
    dspTrace.lastSuccessAt = Date.now();
  } catch (err) {
    dspTrace.lastError = err instanceof Error ? err.message : String(err);
    dspTrace.lastErrorAt = Date.now();
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