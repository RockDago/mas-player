import { EqualizerPreset } from '../types/audio';

/**
 * Types de bandes. La casse est celle de l'API Web Audio (`BiquadFilterType`),
 * et les valeurs AVAudioUnitEQ correspondantes sont les mêmes minuscules.
 */
export type EQBandType = 'lowshelf' | 'peaking' | 'highshelf';

export interface EQBandSpec {
  type: EQBandType;
  /** Fréquence centrale réelle en Hz — source de vérité pour l'UI et les moteurs. */
  freq: number;
  label: string;
}

/**
 * Topologie canonique des 10 bandes, partagée par l'UI et les moteurs (web + natif).
 *
 * Les bornes sont des shelves (250 Hz / 8 kHz) et non 31 Hz / 16 kHz : une shelving
 * à 31 Hz est inaudible sur un haut-parleur de téléphone comme sur la plupart des
 * écouteurs, ce qui rendrait le knob BASS sans effet audible. Les bandes intermédiaires
 * couvrent 125 Hz → 8 kHz, là où la correction est réellement perceptible.
 */
export const EQ_BANDS: EQBandSpec[] = [
  { type: 'lowshelf', freq: 250, label: '250Hz' },
  { type: 'peaking', freq: 125, label: '125Hz' },
  { type: 'peaking', freq: 250, label: '250Hz' },
  { type: 'peaking', freq: 500, label: '500Hz' },
  { type: 'peaking', freq: 1000, label: '1kHz' },
  { type: 'peaking', freq: 2000, label: '2kHz' },
  { type: 'peaking', freq: 4000, label: '4kHz' },
  { type: 'peaking', freq: 6000, label: '6kHz' },
  { type: 'peaking', freq: 8000, label: '8kHz' },
  { type: 'highshelf', freq: 8000, label: '8kHz' },
];

/** Labels des bandes, dans l'ordre du tableau `bands[]` de DSPState. */
export const EQ_BAND_LABELS = EQ_BANDS.map((band) => band.label);

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


/**
 * Libellés ISO historiques (31 Hz → 16 kHz). Conservés pour l'EqualizerModal,
 * qui n'est plus monté : la topologie audible est EQ_BANDS ci-dessus, dont les
 * libellés correspondent à la grille 250 Hz / 125 Hz → 8 kHz.
 */
export const EQ_FREQUENCIES = [
  '250Hz',
  '125Hz',
  '250Hz',
  '500Hz',
  '1kHz',
  '2kHz',
  '4kHz',
  '6kHz',
  '8kHz',
  '8kHz',
];

/** Q des bandes peaking : ~1.0 = correction large et musicale (sans cloche aiguë). */
export const EQ_PEAKING_Q = 1.0;

export const EQ_GAIN_MIN = -12;
export const EQ_GAIN_MAX = 12;

/**
 * Préampli anti-écrêtage, en dB (toujours ≤ 0).
 *
 * **Pourquoi la moitié du gain maximal, et non le gain maximal lui-même.**
 *
 * Le recouvrement des bandes voisines est réel mais borné, et surtout *local* :
 * une bande peaking Q≈1 ne déborde que d'une octave environ. Sur « Mega Bass »,
 * les bandes 250 Hz (+9) et 125 Hz (+6) se cumulent à +15.8 dB, pas à +24. Le
 * limiteur en fin de chaîne (seuil -3 dB, ratio 20) absorbe exactement ce
 * reliquat : la sortie y reste à -2.3 dBFS.
 *
 * Réserver le recouvrement *dans le préampli* reviendrait à l'appliquer de façon
 * uniforme sur tout le spectre, donc à l'annuler là où l'utilisateur veut
 * précisément plus de basses. Réserver la totalité du pic (donc -maxGain)
 * reviendrait au même effondrement : Mega Bass ne ferait plus aucun gain
 * audible à 250 Hz. La moitié du gain maximal est le compromis mesuré qui
 * préserve l'effet recherché tout en laissant au limiteur son vrai rôle de
 * filet de sécurité — rôle qu'un préampli uniforme ne peut pas remplir, puisqu'il
 * l'appliquerait au signal entier au lieu de la seule crête.
 *
 * plafonné à -12 dB : au-delà, mieux vaut atteindre le limiteur que d'étouffer
 * complètement la dynamique.
 */
export function computeHeadroom(bands: number[]): number {
  let maxGain = 0;
  for (const gain of bands) {
    if (gain > maxGain) maxGain = gain;
  }
  return -Math.min(12, maxGain / 2);
}

/** Convertit des dB en facteur linéaire (pour un GainNode web ou un AVAudioUnitEQ). */
export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

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
    description: 'Basses profondes et percutantes, idéal pour casques et hip-hop/trap.',
    bass: 9,
    treble: 2,
    preamp: 0,
    bands: [9, 6, 3, 0, 0, 0, 1, 2, 2, 2],
  },
  {
    id: 'rock',
    name: 'Rock & Metal',
    description: 'Courbe en V : basses percutantes, médiums creusés, cymbales précises.',
    bass: 6,
    treble: 5,
    preamp: 0,
    bands: [6, 4, 2, -1, -2, 0, 2, 4, 5, 5],
  },
  {
    id: 'pop',
    name: 'Pop / Modern Hits',
    description: 'Clarté dynamique des voix avec des basses rondes et chaleureuses.',
    bass: 4,
    treble: 4,
    preamp: 0,
    bands: [4, 3, 1, 1, 3, 2, 2, 3, 4, 4],
  },
  {
    id: 'electro',
    name: 'Electro / EDM / Club',
    description: 'Grave profonde et brillance des synthés sans distorsion.',
    bass: 8,
    treble: 7,
    preamp: 0,
    bands: [8, 6, 4, 1, -1, 1, 3, 5, 6, 7],
  },
  {
    id: 'jazz',
    name: 'Jazz & Blues',
    description: 'Chaleur des contrebasses, richesse des médiums et cuivres soyeux.',
    bass: 3,
    treble: 2,
    preamp: 0,
    bands: [3, 3, 1, 2, -1, 0, 1, 2, 2, 2],
  },
  {
    id: 'vocal',
    name: 'Vocal Boost / Clarté',
    description: 'Atténue les grondements et met en avant la présence des voix.',
    // `bass`/`treble` sont des knobs de boost seul (0 → +12 dB, demi-cercle) :
    // la coupe de graves est portée par les bandes 31/62/125 Hz ci-dessous.
    bass: 0,
    treble: 5,
    preamp: 0,
    bands: [-3, -3, -1, 2, 5, 4, 3, 3, 4, 5],
  },
  {
    id: 'acoustic',
    name: 'Acoustique & Classique',
    description: 'Transparence naturelle, cordes cristallines et aération sonore.',
    bass: 2,
    treble: 4,
    preamp: 0,
    bands: [2, 1, 1, 0, 1, 2, 3, 4, 4, 4],
  },
];
