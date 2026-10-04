import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { Track, Playlist, DSPState, EqualizerPreset } from '../types/audio';

export interface AppSettings {
  rememberLastTrack: boolean;
  rememberPlaybackPosition: boolean;
  autoPlayOnLaunch: boolean;
  crossfade: boolean;
  replayGain: boolean;
}

export interface LastPlaybackSession {
  trackId: string;
  trackIndex: number;
  positionMillis: number;
  durationMillis: number;
  updatedAt: number;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  rememberLastTrack: true,
  rememberPlaybackPosition: true,
  autoPlayOnLaunch: false,
  crossfade: true,
  replayGain: true,
};

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
        return JSON.parse(data) as DSPState;
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
        return JSON.parse(data) as Track[];
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
        return JSON.parse(data) as Track[];
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
