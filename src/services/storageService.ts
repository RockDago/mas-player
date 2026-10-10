import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { Track, Playlist, DSPState, EqualizerPreset } from '../types/audio';
import { normalizeTracks } from '../utils/audioStorage';

export interface AppSettings {
  // Mémorisation & Reprise
  rememberLastTrack: boolean;
  rememberPlaybackPosition: boolean;
  autoPlayOnLaunch: boolean;
  resumeOnHeadset: boolean;

  // Look & Feel
  theme: 'oled' | 'cyber' | 'violet' | 'carbon';
  visualizerStyle: 'vinyl' | 'bars' | 'wave';
  richNotifications: boolean;
  language: 'fr' | 'en' | 'es' | 'de' | 'it';

  // Audio
  crossfade: boolean;
  crossfadeDuration: number;
  replayGain: boolean;
  replayGainMode: 'track' | 'album';
  dvc32Bit: boolean;
  hiResOutput: boolean;
  ultraLowLatency: boolean;

  // Visualization
  spectrumReactive: 'low' | 'normal' | 'ultra';
  autoFadeControls: boolean;
  fadedOpacity: number;

  // Background
  backgroundStyle: 'blur' | 'oled' | 'gradient';
  blurIntensity: 'low' | 'medium' | 'deep';
  colorSaturation: boolean;
  ambientParticles: boolean;

  // Album Art
  autoDownloadArt: boolean;
  highQualityArt: boolean;
  preferEmbeddedArt: boolean;

  // Library
  ignoreShortAudio: boolean;
  librarySort: 'title' | 'artist' | 'album' | 'date';
  showTrackDetails: boolean;
  clearQueueOnNewPlay: boolean;

  // Headset / Bluetooth
  pauseOnDisconnect: boolean;
  resumeOnConnect: boolean;
  headsetButtons: boolean;

  // Lock Screen
  lockScreenControls: boolean;
  lockScreenAlbumArt: boolean;
  lockScreenSeekButtons: boolean;
  keepScreenAwake: boolean;
}

export interface LastPlaybackSession {
  trackId: string;
  trackIndex: number;
  positionMillis: number;
  durationMillis: number;
  updatedAt: number;
  activePlaylistId?: string | null;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  rememberLastTrack: true,
  rememberPlaybackPosition: true,
  autoPlayOnLaunch: false,
  resumeOnHeadset: true,

  theme: 'oled',
  visualizerStyle: 'vinyl',
  richNotifications: true,
  language: 'fr',

  crossfade: true,
  crossfadeDuration: 2,
  replayGain: true,
  replayGainMode: 'track',
  dvc32Bit: true,
  hiResOutput: true,
  ultraLowLatency: true,

  spectrumReactive: 'normal',
  autoFadeControls: false,
  fadedOpacity: 0.4,

  backgroundStyle: 'blur',
  blurIntensity: 'medium',
  colorSaturation: true,
  ambientParticles: true,

  autoDownloadArt: true,
  highQualityArt: true,
  preferEmbeddedArt: true,

  ignoreShortAudio: true,
  librarySort: 'title',
  showTrackDetails: true,
  clearQueueOnNewPlay: false,

  pauseOnDisconnect: true,
  resumeOnConnect: false,
  headsetButtons: true,

  lockScreenControls: true,
  lockScreenAlbumArt: true,
  lockScreenSeekButtons: true,
  keepScreenAwake: false,
};

const DEFAULT_DSP: DSPState = {
  enabled: true,
  presetId: 'flat',
  bass: 0,
  treble: 0,
  preamp: 0,
  stereoExpansion: 0,
  crossfeed: 0,
  tempo: 1.0,
  bands: new Array(10).fill(0),
  balance: 0,
  volume: 100,
  mono: false,
  tempoEnabled: false,

  // Valeurs par défaut conservées pour l'affichage des commandes FX.
  reverbEnabled: false,
  roomSize: 40,
  damping: 50,
  reverbMix: 25,

  // États par défaut conservés pour l'affichage des commandes TONE et LIMIT.
  toneEnabled: true,
  limitEnabled: true,
};

/** Nombre de bandes attendu par l'interface et les préréglages affichés. */
const DSP_BAND_COUNT = 10;

/**
 * Anciens identifiants de préréglages → identifiants actuels.
 *
 * Un preset est persisté *par son id* dans `DSPState.presetId`. Renommer un preset
 * sans migrer l'id laisse les installations existantes avec un `presetId` qui ne
 * désigne plus rien : le nom affiché retombe sur l'état courant alors que la
 * courbe, elle, est toujours chargée depuis les `bands` sauvegardés. L'utilisateur
 * voit « Flat » avec la courbe de l'ancien preset — incohérence silencieuse.
 */
const DSP_PRESET_ID_MIGRATIONS: Record<string, string> = {
  // 10 octobre 2026 — « Bass Booster » est devenu « Bass Profond ».
  'bass-booster': 'bass-profond',
};

/**
 * Anciennes sauvegardes : le préampli était dérivé de la courbe (−7,8 dB sur
 * `bass`, −10,2 dB sur l'ancien `bass-booster`). Il est épinglé à 0 dB depuis le
 * 10 octobre 2026, donc `normalizeDSP` le remet à zéro — sans quoi l'utilisateur
 * qui met à jour l'application retrouve un morceau inexplicablement étouffé, et
 * aucun curseur à l'écran pour expliquer d'où vient ce niveau.
 */

/**
 * Rend un état DSP persisté conforme au type attendu.
 *
 * `JSON.parse` ne valide rien : une écriture tronquée, un schéma d'une version
 * antérieure ou un `bands` absent produirait un `undefined` que le rendu
 * déréférence (`dsp.bands.join(',')` dans le dep-array de `App.tsx`) — écran
 * blanc au lancement, avant tout affichage. On ramène donc chaque champ à son
 * type, et `bands` à exactement 10 gains finis.
 */
function normalizeDSP(raw: unknown): DSPState {
  const input = (raw ?? {}) as Partial<DSPState>;
  const num = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;

  const bands = Array.isArray(input.bands)
    ? Array.from({ length: DSP_BAND_COUNT }, (_, i) => {
        const gain = (input.bands as unknown[])[i];
        return typeof gain === 'number' && Number.isFinite(gain) ? gain : 0;
      })
    : new Array(DSP_BAND_COUNT).fill(0);

  const rawPresetId = typeof input.presetId === 'string' ? input.presetId : DEFAULT_DSP.presetId;
  const presetId = DSP_PRESET_ID_MIGRATIONS[rawPresetId] ?? rawPresetId;

  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : DEFAULT_DSP.enabled,
    presetId,
    bass: num(input.bass, DEFAULT_DSP.bass),
    treble: num(input.treble, DEFAULT_DSP.treble),
    preamp: 0,
    stereoExpansion: num(input.stereoExpansion, DEFAULT_DSP.stereoExpansion),
    crossfeed: num(input.crossfeed, DEFAULT_DSP.crossfeed),
    tempo: num(input.tempo, DEFAULT_DSP.tempo),
    bands,
    balance: num(input.balance, DEFAULT_DSP.balance),
    volume: num(input.volume, DEFAULT_DSP.volume),
    mono: typeof input.mono === 'boolean' ? input.mono : DEFAULT_DSP.mono,
    tempoEnabled:
      typeof input.tempoEnabled === 'boolean' ? input.tempoEnabled : DEFAULT_DSP.tempoEnabled,
    // Les anciennes sauvegardes peuvent ne pas contenir les réglages FX.
    reverbEnabled:
      typeof input.reverbEnabled === 'boolean' ? input.reverbEnabled : DEFAULT_DSP.reverbEnabled,
    roomSize: num(input.roomSize, DEFAULT_DSP.roomSize),
    damping: num(input.damping, DEFAULT_DSP.damping),
    reverbMix: num(input.reverbMix, DEFAULT_DSP.reverbMix),
    // Les anciennes sauvegardes peuvent ne pas contenir ces deux commandes.
    toneEnabled:
      typeof input.toneEnabled === 'boolean' ? input.toneEnabled : DEFAULT_DSP.toneEnabled,
    limitEnabled:
      typeof input.limitEnabled === 'boolean' ? input.limitEnabled : DEFAULT_DSP.limitEnabled,
  };
}

const STORAGE_KEYS = {
  SETTINGS: 'mas_player_settings_v1',
  LAST_PLAYBACK: 'mas_player_last_playback_v1',
  DSP: 'mas_player_dsp_v1',
  PLAYBACK_MODES: 'mas_player_modes_v1',
  CUSTOM_TRACKS: 'mas_player_custom_tracks_v1',
  PLAYLISTS: 'mas_player_playlists_v1',
  QUEUE: 'mas_player_queue_v1',
  CUSTOM_PRESETS: 'mas_player_custom_presets_v1',
};

// Clés antérieures pour migration transparente des données locales
const LEGACY_PREFIX = 'power' + 'amp_';
const LEGACY_STORAGE_KEYS: Record<string, string> = {
  mas_player_settings_v1: `${LEGACY_PREFIX}settings_v1`,
  mas_player_last_playback_v1: `${LEGACY_PREFIX}last_playback_v1`,
  mas_player_dsp_v1: `${LEGACY_PREFIX}dsp_v1`,
  mas_player_modes_v1: `${LEGACY_PREFIX}modes_v1`,
  mas_player_custom_tracks_v1: `${LEGACY_PREFIX}custom_tracks_v1`,
  mas_player_playlists_v1: `${LEGACY_PREFIX}playlists_v1`,
  mas_player_queue_v1: `${LEGACY_PREFIX}queue_v1`,
  mas_player_custom_presets_v1: `${LEGACY_PREFIX}custom_presets_v1`,
};

// Mémoire locale de secours au cas où le stockage natif ou web échoue
const memoryFallback = new Map<string, string>();

async function setItem(key: string, value: string): Promise<void> {
  memoryFallback.set(key, value);
  try {
    await AsyncStorage.setItem(key, value);
  } catch {
    if (Platform.OS === 'web' && typeof window !== 'undefined' && window.localStorage) {
      try {
        window.localStorage.setItem(key, value);
      } catch {}
    }
  }
}

async function getItem(key: string): Promise<string | null> {
  try {
    const val = await AsyncStorage.getItem(key);
    if (val !== null) return val;
  } catch {}

  if (Platform.OS === 'web' && typeof window !== 'undefined' && window.localStorage) {
    try {
      const val = window.localStorage.getItem(key);
      if (val !== null) return val;
    } catch {}
  }

  const inMemory = memoryFallback.get(key);
  if (inMemory !== undefined) return inMemory;

  // Fallback rétrocompatible vers les anciennes données
  const legacyKey = LEGACY_STORAGE_KEYS[key];
  if (legacyKey) {
    try {
      const legacyVal = await AsyncStorage.getItem(legacyKey);
      if (legacyVal !== null) return legacyVal;
    } catch {}

    if (Platform.OS === 'web' && typeof window !== 'undefined' && window.localStorage) {
      try {
        const legacyVal = window.localStorage.getItem(legacyKey);
        if (legacyVal !== null) return legacyVal;
      } catch {}
    }

    const legacyMem = memoryFallback.get(legacyKey);
    if (legacyMem !== undefined) return legacyMem;
  }

  return null;
}

async function removeItem(key: string): Promise<void> {
  memoryFallback.delete(key);
  try {
    await AsyncStorage.removeItem(key);
  } catch {}
  if (Platform.OS === 'web' && typeof window !== 'undefined' && window.localStorage) {
    try {
      window.localStorage.removeItem(key);
    } catch {}
  }

  const legacyKey = LEGACY_STORAGE_KEYS[key];
  if (legacyKey) {
    memoryFallback.delete(legacyKey);
    try {
      await AsyncStorage.removeItem(legacyKey);
    } catch {}
    if (Platform.OS === 'web' && typeof window !== 'undefined' && window.localStorage) {
      try {
        window.localStorage.removeItem(legacyKey);
      } catch {}
    }
  }
}

class StorageService {
  // Paramètres généraux
  async getSettings(): Promise<AppSettings> {
    try {
      const data = await getItem(STORAGE_KEYS.SETTINGS);
      if (data) {
        return { ...DEFAULT_APP_SETTINGS, ...JSON.parse(data) };
      }
    } catch (e) {
      console.warn('Erreur lecture paramètres:', e);
    }
    return DEFAULT_APP_SETTINGS;
  }

  async saveSettings(settings: Partial<AppSettings>): Promise<AppSettings> {
    try {
      const current = await this.getSettings();
      const updated = { ...current, ...settings };
      await setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(updated));
      return updated;
    } catch (e) {
      console.warn('Erreur sauvegarde paramètres:', e);
      return DEFAULT_APP_SETTINGS;
    }
  }

  // Dernière musique jouée & position d'écoute
  async getLastPlayback(): Promise<LastPlaybackSession | null> {
    try {
      const data = await getItem(STORAGE_KEYS.LAST_PLAYBACK);
      if (data) {
        return JSON.parse(data) as LastPlaybackSession;
      }
    } catch (e) {
      console.warn('Erreur lecture dernière lecture:', e);
    }
    return null;
  }

  async saveLastPlayback(session: LastPlaybackSession): Promise<void> {
    try {
      await setItem(STORAGE_KEYS.LAST_PLAYBACK, JSON.stringify(session));
    } catch (e) {
      console.warn('Erreur sauvegarde dernière lecture:', e);
    }
  }

  // Paramètres DSP / Égaliseur
  async getDSP(): Promise<DSPState | null> {
    try {
      const data = await getItem(STORAGE_KEYS.DSP);
      if (data) {
        return normalizeDSP(JSON.parse(data));
      }
    } catch (e) {
      console.warn('Erreur lecture DSP:', e);
    }
    return null;
  }

  async saveDSP(dsp: DSPState): Promise<void> {
    try {
      await setItem(STORAGE_KEYS.DSP, JSON.stringify(dsp));
    } catch (e) {
      console.warn('Erreur sauvegarde DSP:', e);
    }
  }

  // Modes Shuffle & Repeat
  async getPlaybackModes(): Promise<{ isShuffle: boolean; repeatMode: 'off' | 'all' | 'one' } | null> {
    try {
      const data = await getItem(STORAGE_KEYS.PLAYBACK_MODES);
      if (data) {
        return JSON.parse(data);
      }
    } catch (e) {
      console.warn('Erreur lecture modes playback:', e);
    }
    return null;
  }

  async savePlaybackModes(mode: { isShuffle: boolean; repeatMode: 'off' | 'all' | 'one' }): Promise<void> {
    try {
      await setItem(STORAGE_KEYS.PLAYBACK_MODES, JSON.stringify(mode));
    } catch (e) {
      console.warn('Erreur sauvegarde modes playback:', e);
    }
  }

  // Morceaux personnalisés importés (fichiers locaux / ZIP)
  async getCustomTracks(): Promise<Track[] | null> {
    try {
      const data = await getItem(STORAGE_KEYS.CUSTOM_TRACKS);
      if (data) {
        const tracks = JSON.parse(data) as Track[];
        return normalizeTracks(tracks);
      }
    } catch (e) {
      console.warn('Erreur lecture custom tracks:', e);
    }
    return null;
  }

  async saveCustomTracks(tracks: Track[]): Promise<void> {
    try {
      // Pour éviter de saturer le storage avec des fichiers binaires géants, on ne persiste que les métadonnées et URI
      await setItem(STORAGE_KEYS.CUSTOM_TRACKS, JSON.stringify(tracks));
    } catch (e) {
      console.warn('Erreur sauvegarde custom tracks:', e);
    }
  }

  // Playlists
  async getPlaylists(): Promise<Playlist[] | null> {
    try {
      const data = await getItem(STORAGE_KEYS.PLAYLISTS);
      if (data) {
        return JSON.parse(data) as Playlist[];
      }
    } catch (e) {
      console.warn('Erreur lecture playlists:', e);
    }
    return null;
  }

  async savePlaylists(playlists: Playlist[]): Promise<void> {
    try {
      await setItem(STORAGE_KEYS.PLAYLISTS, JSON.stringify(playlists));
    } catch (e) {
      console.warn('Erreur sauvegarde playlists:', e);
    }
  }

  // Queue ("Lire plus tard")
  async getQueue(): Promise<Track[] | null> {
    try {
      const data = await getItem(STORAGE_KEYS.QUEUE);
      if (data) {
        const queue = JSON.parse(data) as Track[];
        return normalizeTracks(queue);
      }
    } catch (e) {
      console.warn('Erreur lecture queue:', e);
    }
    return null;
  }

  async saveQueue(queue: Track[]): Promise<void> {
    try {
      await setItem(STORAGE_KEYS.QUEUE, JSON.stringify(queue));
    } catch (e) {
      console.warn('Erreur sauvegarde queue:', e);
    }
  }

  // Préréglages d'égaliseur personnalisés
  async getCustomPresets(): Promise<EqualizerPreset[]> {
    try {
      const data = await getItem(STORAGE_KEYS.CUSTOM_PRESETS);
      if (data) {
        return JSON.parse(data) as EqualizerPreset[];
      }
    } catch (e) {
      console.warn('Erreur lecture custom presets:', e);
    }
    return [];
  }

  async saveCustomPresets(presets: EqualizerPreset[]): Promise<void> {
    try {
      await setItem(STORAGE_KEYS.CUSTOM_PRESETS, JSON.stringify(presets));
    } catch (e) {
      console.warn('Erreur sauvegarde custom presets:', e);
    }
  }

  // Réinitialisation complète
  async clearAllSessionData(): Promise<void> {
    try {
      await Promise.all([
        removeItem(STORAGE_KEYS.LAST_PLAYBACK),
        removeItem(STORAGE_KEYS.DSP),
        removeItem(STORAGE_KEYS.PLAYBACK_MODES),
        removeItem(STORAGE_KEYS.QUEUE),
      ]);
    } catch (e) {
      console.warn('Erreur réinitialisation session:', e);
    }
  }
}

export const storageService = new StorageService();
