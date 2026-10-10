export interface Track {
  id: string;
  title: string;
  artist: string;
  album: string;
  duration: number; // in seconds
  uri: string;
  artwork?: string;
  format?: 'FLAC' | 'MP3' | 'WAV' | 'AAC' | 'ALAC';
  sampleRate?: string;
  bitrate?: string;
  year?: string;
  genre?: string;
  isFavorite?: boolean;
  folder?: string;
  folderPath?: string;
  /**
   * Instant d'import, en millisecondes epoch.
   *
   * Ce n'est PAS la date du fichier : rien ici ne lit les métadonnées du
   * disque, et `year` n'est jamais renseigné à l'import. C'est donc le seul
   * sens honnête du tri « Récent » — l'ordre d'arrivée dans la bibliothèque,
   * pas l'ordre d'édition.
   *
   * Absent sur les morceaux importés avant l'existence de ce champ : le tri
   * par date les place alors en fin de liste.
   */
  addedAt?: number;
}

export interface Playlist {
  id: string;
  name: string;
  description?: string;
  trackIds: string[];
  createdAt: number;
  coverUri?: string;
}

export interface EqualizerBand {
  id: string;
  frequencyLabel: string;
  gain: number; // in dB (-12 to +12)
}

export interface EqualizerPreset {
  id: string;
  name: string;
  description: string;
  bass: number; // -12 to +12 dB
  treble: number; // -12 to +12 dB
  preamp: number; // -6 to +6 dB
  bands: number[]; // 10 bands gains in dB
}

export interface DSPState {
  // Equalizer settings are applied to playback; other sound controls remain separate.
  enabled: boolean;
  presetId: string;
  bass: number; // -12 to +12 dB
  treble: number; // -12 to +12 dB
  preamp: number; // -6 to +6 dB
  stereoExpansion: number; // 0 to 100% — élargit l'image stéréo, sans changer le niveau
  crossfeed: number; // 0 to 100% — rapproche les canaux, pour l'écoute casque
  tempo: number; // 0.5x to 2.0x
  bands: number[]; // 10 bands
  balance: number; // -1.0 to +1.0 (-1=L, 0=center, +1=R)
  volume: number; // 0 to 100%
  mono: boolean; // mono downmix toggle
  tempoEnabled: boolean; // tempo button toggle

  // Valeurs de réverbération conservées pour l'interface et le stockage.
  reverbEnabled: boolean;
  roomSize: number;
  damping: number;
  reverbMix: number;

  // États des commandes TONE et LIMIT conservés pour l'interface.
  toneEnabled: boolean;
  limitEnabled: boolean;
}
