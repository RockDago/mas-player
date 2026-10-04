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
  enabled: boolean;
  presetId: string;
  bass: number; // -12 to +12 dB
  treble: number; // -12 to +12 dB
  preamp: number; // -6 to +6 dB
  stereoExpansion: number; // 0 to 100%
  tempo: number; // 0.5x to 2.0x
  bands: number[]; // 10 bands
  balance: number; // -1.0 to +1.0 (-1=L, 0=center, +1=R)
  volume: number; // 0 to 100%
  mono: boolean; // mono downmix toggle
  tempoEnabled: boolean; // tempo button toggle
}
