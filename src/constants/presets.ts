import { EqualizerPreset } from '../types/audio';

/** Labels MAS Player courts (10 bandes) */
export const MAS_PLAYER_BAND_LABELS = [
  '250',
  '125',
  '250',
  '500',
  '1K',
  '2K',
  '4K',
  '6K',
  '8K',
  '8K',
];


export const EQ_GAIN_MIN = -12;
export const EQ_GAIN_MAX = 12;

/** Estimation affichée par l'interface; elle n'est pas appliquée au son. */
export function reverbDecayMs(roomSizePercent: number): number {
  const room = Math.max(0, Math.min(100, roomSizePercent)) / 100;
  const delaySeconds = 0.037 * (1 + room * 7);
  const loopGain = 0.78 / 1.5;
  return (delaySeconds * 1000) / -Math.log(loopGain);
}

/**
 * Pondérations utilisées uniquement pour conserver la cohérence des valeurs
 * affichées par les commandes BASS et TREBLE.
 */
export const BASS_WEIGHTS = [0.55, 0.30, 0.0, 0.0];
export const TREBLE_WEIGHTS: { [idx: number]: number } = { 6: 0.25, 7: 0.5, 8: 0.8, 9: 1.0 };

export const DEFAULT_PRESETS: EqualizerPreset[] = [
  {
    id: 'flat',
    name: 'Flat (Neutre Studio)',
    description: 'Réponse linéaire sans coloration, fidélité mastering originale.',
    bass: 0,
    treble: 0,
    preamp: 0,
    bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  },
  {
    id: 'bass-heavy',
    name: 'Mega Bass / Bass Boost',
    description: 'Basses profondes et percutantes, sans lourdeur ni distorsion.',
    bass: 0,
    treble: 0,
    preamp: 0,
    bands: [7.5, 5, 1, 0, 0, 0, 1, 2, 2.5, 2.5],
  },
  {
    id: 'rock',
    name: 'Rock & Metal',
    description: 'Courbe en V : basses percutantes, médiums creusés, cymbales précises.',
    bass: 0,
    treble: 0,
    preamp: 0,
    bands: [6, 4, 2, -1, -2, 0, 2, 4, 5, 5],
  },
  {
    id: 'pop',
    name: 'Pop / Modern Hits',
    description: 'Clarté dynamique des voix avec des basses rondes et chaleureuses.',
    bass: 0,
    treble: 0,
    preamp: 0,
    bands: [4, 3, 1, 1, 3, 2, 2, 3, 4, 4],
  },
  {
    id: 'electro',
    name: 'Electro / EDM / Club',
    description: 'Grave profonde et brillance des synthés sans distorsion.',
    bass: 0,
    treble: 0,
    preamp: 0,
    bands: [8, 6, 4, 1, -1, 1, 3, 5, 6, 7],
  },
  {
    id: 'jazz',
    name: 'Jazz & Blues',
    description: 'Chaleur des contrebasses, richesse des médiums et cuivres soyeux.',
    bass: 0,
    treble: 0,
    preamp: 0,
    bands: [3, 3, 1, 2, -1, 0, 1, 2, 2, 2],
  },
  {
    id: 'vocal',
    name: 'Vocal Boost / Clarté',
    description: 'Atténue les grondements et met en avant la présence des voix.',
    bass: 0,
    treble: 0,
    preamp: 0,
    bands: [-3, -3, -1, 2, 5, 4, 3, 3, 4, 5],
  },
  {
    id: 'acoustic',
    name: 'Acoustique & Classique',
    description: 'Transparence naturelle, cordes cristallines et aération sonore.',
    bass: 0,
    treble: 0,
    preamp: 0,
    bands: [2, 1, 1, 0, 1, 2, 3, 4, 4, 4],
  },

  // --- Préréglages « studio » ---------------------------------------------
  {
    id: 'studio-master',
    name: 'Studio Mastering',
    description: 'Courbe de référence neutre en loudness, transparence maximale.',
    bass: 0,
    treble: 0,
    preamp: 0,
    bands: [-1.5, -1, 0, 0.5, 0.5, 0.5, 0.5, 1, 1.5, 2],
  },
  {
    id: 'warm-vintage',
    name: 'Chaud / Vintage',
    description: 'Graves pleines et chaudes, médiums adoucis, sans agressivité.',
    bass: 0,
    treble: 0,
    preamp: 0,
    bands: [1.5, 1, 0.5, 0, -0.5, -1, -1.5, -1, -0.5, 0],
  },
  {
    id: 'clear-airy',
    name: 'Clair / Aéré',
    description: 'Présence des voix et aération haute fréquence, sans sibilance.',
    bass: 0,
    treble: 0,
    preamp: 0,
    bands: [-0.5, -0.5, -0.5, 0, 0.5, 1, 1, 0.5, 0.5, 3],
  },
  {
    id: 'rnv-latenight',
    name: 'Nuit Calme',
    description: 'Écoute de nuit à faible volume : graves et aigus atténués.',
    bass: 0,
    treble: 0,
    preamp: 0,
    bands: [-4, -3, -2, -1, 0, 0.5, 1, 1, 0.5, 0],
  },
  {
    id: 'wide-cinematic',
    name: 'Large / Cinématique',
    description: 'Image stéréo élargie, présence nette, graves discrets.',
    bass: 0,
    treble: 0,
    preamp: 0,
    bands: [0, 0, 0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 1],
  },
];
