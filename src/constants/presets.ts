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
 * Libellés ISO historiques (31 Hz → 16 kHz), alignés sur `EQ_BANDS`.
 *
 * La topologie audible est celle d'`EQ_BANDS` ci-dessus : grille 250 Hz /
 * 125 Hz → 8 kHz.
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

/* ── Réverbération ────────────────────────────────────────────────────────── */

/**
 * Retards des deux lignes de réverbération, en secondes, à `roomSize = 0`.
 *
 * Rapport 37:58 — irrationnel. Un rapport rationnel simple (1:2, 1:3) ferait
 * ressortir un motif périodique reconnaissable, qui est le défaut le plus audible
 * d'une réverbération bon marché. Les deux lignes étant désaccordées, le retour
 * arrive décalé entre les côtés, ce qui élargit le champ au lieu de le creuser.
 */
export const REVERB_DELAY_L = 0.037;
export const REVERB_DELAY_R = 0.058;

/**
 * Facteur d'échelle maximal du retard : `roomSize = 100` vaut 8 × la base.
 *
 * 8 est choisi pour que la plus grande pièce reste une pièce. Le temps de
 * décroissance vaut `RT60 = -T / ln(gain de boucle)`, et le gain de boucle
 * **symétrique** est `REVERB_FEEDBACK / (1 + couplage) = 0.52` — voir
 * `computeReverbLoopGains`. D'où `-1/ln(0.52) ≈ 1.53` :
 *
 * | roomSize | retard G | RT60 G | RT60 D |
 * |---|---|---|---|
 * | 0   | 37 ms  | 57 ms  — une petite chambre |
 * | 50  | 166 ms | 255 ms — une pièce |
 * | 100 | 296 ms | 453 ms — un plateau |
 *
 * La colonne de droite donne le canal droit, toujours plus long (58 ms de base).
 * Les deux sont volontairement inégales : c'est ce désaccord qui empêche
 * l'oreille d'entendre le motif de la boucle.
 *
 * Au-delà de ~1.2 s, on n'est plus dans une pièce mais dans une caverne, et le
 * knob cesse de répondre à l'attente cohérente de l'utilisateur.
 */
export const REVERB_ROOM_SCALE = 8;

/** Retard maximal, en secondes — borne d'allocation des lignes de retard. */
const REVERB_MAX_DELAY = REVERB_DELAY_R * REVERB_ROOM_SCALE;

/**
 * Retard → facteur multiplicatif, borné à `REVERB_ROOM_SCALE`.
 *
 * Fonction partagée : le web la calcule sur `DelayNode.delayTime`, le natif sur
 * les indices de lecture de ses lignes circulaires. Les deux plateformes
 * l'importent, donc elles ne peuvent pas diverger.
 */
export function computeReverbDelayScale(roomSizePercent: number): number {
  const pct = Math.max(0, Math.min(100, roomSizePercent)) / 100;
  return 1 + pct * (REVERB_ROOM_SCALE - 1);
}

/**
 * Durée de décroissance de la queue, en millisecondes, pour une taille de pièce.
 *
 * Le nombre affiché à côté du knob « Room Size ». Ce n'est pas un ornement : la
 * taille perçue d'une pièce, c'est la longueur de sa queue, pas son retard brut.
 * Sans cette valeur, deux réglages de pièce très différents — 37 ms contre
 * 296 ms de retard — s'afficheraient tous deux « 40 % », et l'utilisateur n'aurait
 * aucun moyen de savoir ce qu'il vient de changer.
 *
 * `RT60 = T / -ln(s)`, où `s` est le gain de boucle symétrique **après**
 * normalisation — voir `computeReverbLoopGains`.
 *
 * Exportée parce que l'UI en a besoin : c'est la seule façon d'avoir un chiffre
 * exact au lieu d'une approximation recopiée dans un composant.
 */
export function reverbDecayMs(roomSizePercent: number): number {
  const scale = computeReverbDelayScale(roomSizePercent);
  const loop = computeReverbLoopGains();
  return (REVERB_DELAY_L * scale * 1000) / -Math.log(loop.self);
}

/**
 * Gain de boucle **symétrique** visé, avant normalisation.
 *
 * Pourquoi c'est un plafond, et pas un simple réglage : le passe-bas placé dans
 * la boucle a un gain de 1 en continu, donc le gain de boucle ne dépend que de
 * `REVERB_FEEDBACK` — **pas de la longueur du retard**. Allonger la pièce ne
 * rapproche donc pas la boucle de l'instabilité.
 *
 * La décroissance suit `feedbackⁿ` : à 0.78, le retour est à −60 dB après 56
 * passages, soit environ 2.4 s à piece moyenne. Au-delà, la quantification en
 * virgule flottante réinjecte plus d'erreur qu'elle n'en absorbe.
 */
export const REVERB_FEEDBACK = 0.78;

/**
 * Croisement entre les deux lignes de réverbération.
 *
 * Chaque ligne renvoie cette fraction du retour de l'autre. C'est ce qui
 * désaccorde les canaux au fil du temps : le mode croisé décroît beaucoup plus
 * vite que le mode symétrique, donc l'image s'ouvre au lieu de répéter.
 */
export const REVERB_CROSS_COUPLING = 0.5;

/**
 * Gains des deux boucles, **normalisés pour rester stables**.
 *
 * ## Le calcul, et pourquoi il est obligatoire
 *
 * Avec le couplage croisé, la boucle est la matrice `[[s, x], [x, s]]` dont les
 * **valeurs propres sont `s + x` et `s − x`**. C'est `s + x` qui borne la
 * stabilité, pas `s`.
 *
 * Branché naïvement — `s = feedback`, `x = feedback · couplage` — on obtient
 * `0.78 + 0.39 = 1.17` : **la boucle diverge**, et le son sature en quelques
 * secondes. C'est l'erreur classique de la réverbération à deux lignes croisées.
 *
 * On divise donc les deux gains par `1 + couplage`, ce qui restitue
 * `s + x = REVERB_FEEDBACK` exactement :
 *
 * | | gain | décroissance |
 * |---|---|---|
 * | mode symétrique `s` | 0.520 | RT60 du tableau de `REVERB_ROOM_SCALE` |
 * | mode croisé `x` | 0.260 | décroît ~3 fois plus vite → l'image s'ouvre |
 *
 * La borne est atteinte **quelle que soit la longueur du retard**, puisqu'elle
 * ne dépend que des gains : allonger la pièce ne peut pas rendre l'étage
 * instable.
 *
 * Fonction partagée — `AudioDSPReverb.swift` reçoit les gains calculés ici, il
 * ne les recalcule pas.
 */
export function computeReverbLoopGains(): { self: number; cross: number } {
  const norm = 1 + REVERB_CROSS_COUPLING;
  return {
    self: REVERB_FEEDBACK / norm,
    cross: (REVERB_FEEDBACK * REVERB_CROSS_COUPLING) / norm,
  };
}

/**
 * Fréquence de coupure du passe-bas de boucle, en Hz, à `damping = 100`.
 *
 * Au-delà de ~4 kHz, la queue conserve les sibilantes et finit par siffler :
 * c'est ce qui distingue une réverbération d'un simple écho.
 */
export const REVERB_DAMPING_MAX_HZ = 3600;

/**
 * Fréquence de coupure du passe-bas de boucle, en Hz, à `damping = 0`.
 *
 * 80 Hz et non 0 : une coupure à 0 Hz est un passe-bas à gain nul, donc une
 * réverbération **muette** au knob à zéro. 80 Hz est inaudible sur une queue et
 * laisse passer tout le signal utile.
 *
 * La loi d'interpolation est **exponentielle**, pas linéaire : la hauteur
 * tonale est perçue logarithmiquement, donc une loi linéaire tasserait
 * l'essentiel du knob dans les deux premiers kilo-hertz.
 */
export const REVERB_DAMPING_MIN_HZ = 80;

/** Fréquence de coupure du passe-bas de boucle, en Hz, pour un knob donné. */
export function computeReverbDampingHz(dampingPercent: number): number {
  const pct = Math.max(0, Math.min(100, dampingPercent)) / 100;
  return (
    REVERB_DAMPING_MIN_HZ *
    Math.pow(REVERB_DAMPING_MAX_HZ / REVERB_DAMPING_MIN_HZ, pct)
  );
}

/**
 * Plafond de dosage : le maximum que peut atteindre le gain du signal
 * reverbéré à `reverbMix = 100`.
 *
 * Sans lui, un mélange à fond ferait monter la sortie au-delà du zéro numérique
 * — et le limiteur, placé après, ne ferait que fabriquer la distorsion qu'on
 * cherche à éviter.
 */
export const REVERB_WET_CAP = 0.6;

/**
 * Convertit le knob de dosage en gains linéaire de mélange.
 *
 * ## La loi, et pourquoi elle ne dépasse jamais 1
 *
 * `wet = mix × cap` et `dry = 1 − mix`, donc la somme vaut
 * `1 + mix × (cap − 1)`, soit **0.600 à mix = 100** avec `cap = 0.6`. Elle est
 * donc **décroissante et toujours ≤ 1** : monter le knob ne peut pas faire monter
 * le niveau, quel que soit le réglage. C’est la propriété qui compte — pas
 * l'égalité à 1, qu'aucun effet parallèle réel ne respecte.
 *
 * Deux lois concurrentes, et pourquoi celle-ci :
 *
 * - `dry = 1 − wet` (somme constante à 1) : à fond de course le signal direct
 *   descend à 0.4, donc **−8 dB** sur la musique. Inacceptable — un effet ne doit
 *   pas atténuer le programme qu'il est censé traiter.
 * - `dry = 1 − mix × (1 − cap)` (loi précédente, fausse malgré mon commentaire)
 *   : la somme **monte** à 1.20. L'étage pousse alors le signal vers le limiteur,
 *   qui ne fait que fabriquer la distorsion qu'on cherche à éviter.
 *
 * La borne numérique reste posée par le limiteur à −3 dBFS en fin de chaîne. Il
 * est seul garant du plafond, et c'est le rôle qu'il doit garder.
 *
 * `reverbMix` est le seul knob de **niveau** : `roomSize` et `damping` ne changent
 * que la forme de la queue, jamais son gain. C'est ce qui permet de monter la
 * taille d'une pièce à fond sans que le morceau paraisse plus fort.
 *
 * Partagée avec le natif : `AudioDSPReverb.swift` reçoit le couple wet/dry calculé
 * ici, il ne le recalcule pas.
 */
/**
 * Poids de contribution du bouton BASS sur les bandes de l'égaliseur.
 *
 * Bande 0 (lowshelf 250Hz) : 0.55 (grave profond, rond et musical sans saturation)
 * Bande 1 (peaking 125Hz)  : 0.30 (impact et punch de la grosse caisse / basse sans saturation)
 * Bande 2 (peaking 250Hz)  : 0.0 (évite l'effet de résonance / carton dans le bas-médium)
 * Bande 3 (peaking 500Hz)  : 0.0 (médium pur : ne doit jamais être épaissi par les basses)
 */
export const BASS_WEIGHTS = [0.55, 0.30, 0.0, 0.0];
export const TREBLE_WEIGHTS: { [idx: number]: number } = { 6: 0.25, 7: 0.5, 8: 0.8, 9: 1.0 };

export function computeReverbGains(mixPercent: number): { wet: number; dry: number } {
  const mix = Math.max(0, Math.min(100, mixPercent)) / 100;
  return { wet: mix * REVERB_WET_CAP, dry: 1 - mix };
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
  // Tous conçus pour le critère « plus doux » : aucune bande ne dépasse +3 dB.
  // Ces courbes-ci laissent au limiteur son vrai rôle de filet, au lieu de le
  // faire travailler en permanence.
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
