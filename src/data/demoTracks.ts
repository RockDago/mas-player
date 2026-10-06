import { Track } from '../types/audio';

/**
 * Pistes de démonstration de MAS Player (identiques au 1er commit e8fda75).
 * Sources vérifiées et hébergées sur archive.org avec support CORS et CoreAudio natif.
 */
export const INITIAL_TRACKS: Track[] = [
  {
    id: 'demo-cyberpunk',
    title: 'Cyberpunk 2099',
    artist: 'Free Music Archive',
    album: 'Demos',
    duration: 209,
    uri: 'https://archive.org/download/sweet2026-06-17/sweet2026-06-17d01t02.mp3',
    artwork: undefined,
    format: 'MP3',
    sampleRate: '44.1 kHz',
    bitrate: '320 kbps',
    genre: 'Synthwave / Cyber',
    year: '2024',
    folder: 'Démos MAS Player',
    folderPath: '/Music/High-Res FLAC & Demo',
  },
  {
    id: 'demo-sweet-live',
    title: 'Sweet — Live at The Hunt House',
    artist: 'Melissa And Johnny',
    album: 'The Listening Room',
    duration: 180,
    uri: 'https://archive.org/download/sweet2026-06-17/sweet2026-06-17d01t01.mp3',
    artwork: undefined,
    format: 'MP3',
    sampleRate: '44.1 kHz',
    bitrate: '320 kbps',
    genre: 'Acoustic Folk',
    year: '2023',
    folder: 'Démos MAS Player',
    folderPath: '/Music/High-Res FLAC & Demo',
  },
];
