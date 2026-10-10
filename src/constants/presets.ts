import { EqualizerPreset } from '../types/audio';

/** Centre frequencies of the equalizer's ten octave-spaced bands. */
export const MAS_PLAYER_BAND_FREQUENCIES = [
  31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000,
];

export const MAS_PLAYER_BAND_LABELS = [
  '31',
  '62',
  '125',
  '250',
  '500',
  '1K',
  '2K',
  '4K',
  '8K',
  '16K',
];


export const EQ_GAIN_MIN = -12;
export const EQ_GAIN_MAX = 12;

/** Fréquence d'échantillonnage de référence des formules de filtre. */
const REFERENCE_SAMPLE_RATE = 44100;
/** Q des bandes — même valeur que le DSP natif (RBJ peaking, α = sin ω / (2Q)). */
const BAND_Q = 1.41421356237;

/**
 * Magnitude complexe d'un peaking RBJ à la fréquence `frequency`.
 *
 * La réponse d'une bande n'est pas son gain nominal : à 32 Hz, une bande
 * centrée sur 31 Hz réglée à +8 dB délivre en réalité +8,5 dB, parce que le
 * pic d'un peaking est légèrement décalé de sa fréquence nominale. Additionner
 * les gains nominaux sous-estime donc toujours le pic réel, et le préampli
 * calculé sur cette base ne tient pas sa promesse.
 */
export function bandMagnitudeDb(
  frequency: number,
  centerFrequency: number,
  gainDb: number
): number {
  if (!Number.isFinite(frequency) || !Number.isFinite(centerFrequency)) return 0;
  if (!Number.isFinite(gainDb) || gainDb === 0) return 0;

  const amplitude = 10 ** (gainDb / 40);
  const omega = (2 * Math.PI * centerFrequency) / REFERENCE_SAMPLE_RATE;
  const at = (2 * Math.PI * frequency) / REFERENCE_SAMPLE_RATE;
  const cosine = Math.cos(omega);
  const alpha = Math.sin(omega) / (2 * BAND_Q);
  const normaliser = 1 + alpha / amplitude;

  const b0 = (1 + alpha * amplitude) / normaliser;
  const b1 = (-2 * cosine) / normaliser;
  const b2 = (1 - alpha * amplitude) / normaliser;
  const a1 = (-2 * cosine) / normaliser;
  const a2 = (1 - alpha / amplitude) / normaliser;

  const atCos = Math.cos(at);
  const atSin = Math.sin(at);
  const numerateur =
    (b0 + b1 * atCos + b2 * Math.cos(2 * at)) ** 2 +
    (b1 * atSin + b2 * Math.sin(2 * at)) ** 2;
  const denominateur =
    (1 + a1 * atCos + a2 * Math.cos(2 * at)) ** 2 +
    (a1 * atSin + a2 * Math.sin(2 * at)) ** 2;

  return 10 * Math.log10(Math.max(numerateur / denominateur, 1e-12));
}

/**
 * Pic réel, en dB, de la cascade de dix bandes.
 *
 * Mesuré sur toute la bande audible plutôt que par somme des gains : c'est la
 * seule façon de savoir ce qu'un preset fait de la balance. Balayage logarithmique
 * de 20 Hz à 20 kHz, avec un raffinement autour des centres de bande, où le pic
 * se loge juste à côté de la fréquence nominale.
 *
 * ⚠ Usage purement **diagnostique** depuis le 10 octobre 2026 : le préampli est
 * épinglé à 0 (voir `makePreset`) et ne dérive plus de cette mesure. La fonction
 * reste parce que le harnais s'en sert pour rapporter ce que chaque preset fait
 * réellement de la balance — c'est ce qui rend visible le prix du préampli à 0.
 */
export function responsePeakDb(bands: number[]): number {
  let peak = -Infinity;
  const frequencies: number[] = [];
  for (let f = 20; f <= 20000; f *= 1.01) frequencies.push(f);
  for (const center of MAS_PLAYER_BAND_FREQUENCIES) {
    // Autour de chaque centre : le maximum d'un peaking est décalé de la
    // fréquence nominale, un balayage trop lâche peut le manquer.
    for (let factor = 0.6; factor <= 1.7; factor += 0.02) {
      const f = center * factor;
      if (f >= 20 && f <= 20000) frequencies.push(f);
    }
  }

  for (const frequency of frequencies) {
    let magnitude = 0;
    for (let index = 0; index < MAS_PLAYER_BAND_FREQUENCIES.length; index += 1) {
      const gain = Number.isFinite(bands[index]) ? bands[index] : 0;
      magnitude += bandMagnitudeDb(
        frequency,
        MAS_PLAYER_BAND_FREQUENCIES[index],
        gain
      );
    }
    if (magnitude > peak) peak = magnitude;
  }
  return Number.isFinite(peak) ? peak : 0;
}

/**
 * Bandes effectives : preset + knobs Bass et Treble, bornées à ±12 dB.
 *
 * ⚠ Le bornage se fait sur la **somme**, pas sur chaque terme. C'est le défaut
 * que ce clamp masquait : le preset et le knob s'ajoutaient, la somme dépassait
 * 12 dB, et `Math.min(12, …)` **écrêtait** la bande à 12,00 dB. Sur `rock`
 * (bande 8 kHz à +5), le knob Treble devenait donc **mort au-delà de +10** :
 * de 11 à 12, l'oreille ne recevait plus 0 dB, alors que le knob advance encore.
 * Un knob qui s'arrête en cours de course est le « ça marche pas très bien » le
 * plus facile à rater, parce qu'il marche — sauf à fond.
 *
 * Deux règles rendent la course entière utile :
 *
 *   1. **La course totale vaut 12 dB, quelle que soit la répartition.** On
 *      mesure le gain déjà présent dans la zone, on ne laisse au knob que le
 *      reste jusqu'au plafond. Un preset déjà à +8 dans l'aigu laisse donc au
 *      knob 4 dB au lieu de 4 puis plus rien.
 *   2. **Aucun gain n'est jamais retiré.** Si le preset dépasse déjà le plafond,
 *      le knob ne peut pas le remonter — il ne fait alors rien de plus, ce qui
 *      est honnête : le plafond est atteint, pas une erreur de calcul.
 *
 * Le poids reste intégralement appliqué dans la zone audible ; c'est la
 * *réponse totale* qui est bornée, ce qui laisse chaque preset agir comme un
 * point de départ et le knob comme un réglage relatif au-dessus de lui.
 */
export function getEffectiveEqualizerBands(
  bands: number[],
  bass: number = 0,
  treble: number = 0
): number[] {
  // Crête du preset dans chaque zone : c'est elle qui décide de la marge
  // restante, pas la somme brute (une bande en creux ne consomme pas de marge).
  const bassPresetPeak = Math.max(
    0,
    ...[0, 1, 2, 3].map((index) =>
      Math.abs(Number.isFinite(bands[index]) ? bands[index] : 0)
    )
  );
  const treblePresetPeak = Math.max(
    0,
    ...[6, 7, 8, 9].map((index) =>
      Math.abs(Number.isFinite(bands[index]) ? bands[index] : 0)
    )
  );

  // Course restante avant le plafond. Symétrique en haut et en bas : un preset
  // déjà brillant à +8 laisse 4 dB de brilliance, un preset creusé à −8 laisse
  // 4 dB de creusement — dans les deux sens la course fait 12 dB d'amplitude.
  const bassRange = Math.max(0, EQ_GAIN_MAX - bassPresetPeak);
  const trebleRange = Math.max(0, EQ_GAIN_MAX - treblePresetPeak);

  const scaleBass = bassRange / EQ_GAIN_MAX;
  const scaleTreble = trebleRange / EQ_GAIN_MAX;

  return MAS_PLAYER_BAND_FREQUENCIES.map((_, index) => {
    let gain = Number.isFinite(bands[index]) ? bands[index] : 0;
    if (index < BASS_WEIGHTS.length) {
      gain += bass * BASS_WEIGHTS[index] * scaleBass;
    } else if (index >= 6) {
      gain += treble * (TREBLE_WEIGHTS[index] ?? 0) * scaleTreble;
    }
    return Math.max(EQ_GAIN_MIN, Math.min(EQ_GAIN_MAX, gain));
  });
}

/**
 * Résumé lisible de la forme d'une courbe, en une ligne.
 *
 * Utilisé par la liste des préréglages perso, qui affichait auparavant
 * « Bass: … • Treble: … » — deux valeurs que le préréglage ne contient plus
 * depuis le 10 octobre 2026 (les knobs Bass et Treble sont des réglages
 * d'écoute indépendants, jamais la propriété d'une courbe). La moyenne basse
 * et la moyenne haute disent ce que l'utilisateur veut savoir en un coup
 * d'œil : « cette courbe creuse les basses », « celle-ci les pousse ».
 *
 * Les gains sont moyennés **en décibels**, pas en amplitude : la moyenne
 * linéaire d'un creux à −6 et d'un pic à +6 vaut −6, ce qui décrit bien une
 * courbe en V, alors qu'une moyenne d'amplitude donnerait 0 dB — « neutre »,
 * ce qui est précisément le mot que la moyenne des gains ne devrait pas
 * pouvoir produire par hasard.
 */
export function describePresetCurve(bands: number[]): string {
  const at = (indexes: number[]): number => {
    const values = indexes
      .map((index) => (Number.isFinite(bands?.[index]) ? (bands?.[index] as number) : 0));
    if (!values.length) return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  };

  const low = at([0, 1, 2, 3]);
  const high = at([6, 7, 8, 9]);
  const shape = (value: number): string =>
    value >= 1.5 ? `+${value.toFixed(1)}` : value <= -1.5 ? value.toFixed(1) : '±0';

  return `Basses ${shape(low)} dB • Aigus ${shape(high)} dB`;
}

/**
 * Durée de décroissance (RT60) visée pour le knob « Room Size », en secondes.
 *
 * ⚠ Cette loi remplace une version antérieure où la durée était calculée par
 * `-ln(feedback)`, le même terme que celui envoyé au DSP. Le problème : un
 * convolutionneur n'a pas de boucle de rétroaction. La durée d'une réponse
 * impulsionnelle est une *longueur*, pas une décroissance — et `-ln(fb)` est
 * une décroissance. Les deux grandeurs sont inversement proportionnelles :
 * croître le feedback *allonge* une boucle, mais *raccourcit* une impulsion.
 * Le résultat était donc un knob inversé : room 100 % produisait 13 ms de
 * queue au lieu de plusieurs secondes.
 *
 * La loi est explicitement croissante, ce que le harnais vérifie désormais sur
 * le RT60 *réel* et non plus sur le feedback intermédiaire.
 *
 * Courbe non linéaire (`pow 1,6`) : les petites salles sont bien plus
 * fréquentes que les cathédrales, et une droite donnerait à room 25 % une
 * taille déjà démesurée. 0,30 s = chambre, 4,00 s = grande nef.
 */
export const REVERB_RT60_MIN_SECONDS = 0.3;
export const REVERB_RT60_MAX_SECONDS = 4;

export function reverbRt60Seconds(roomSizePercent: number): number {
  const room = Math.max(0, Math.min(100, roomSizePercent)) / 100;
  return (
    REVERB_RT60_MIN_SECONDS +
    (REVERB_RT60_MAX_SECONDS - REVERB_RT60_MIN_SECONDS) * room ** 1.6
  );
}

/**
 * Retour de boucle dont un peigne de retard donne ce RT60.
 *
 * `fb^n` doit vaudoir −60 dB, donc `fb = exp(−6,908 / RT60)`. C'est la
 * conversion qu'il faut appliquer au DSP natif, dont la boucle est réelle.
 */
export function reverbFeedbackFor(rt60Seconds: number): number {
  const rt60 = Math.max(0.01, rt60Seconds);
  return Math.min(0.98, Math.exp(-6.9078 / rt60));
}

/**
 * Marge de gain du réverbérateur natif, en dB.
 *
 * ⚠ C'est le second bug du reverb, et il est plus grave que la durée.
 *
 * Le natif additionne 4 peignes en parallèle puis 2 passe-tout. Un réseau de
 * ce type a un gain de boucle qui diverge quand `fb` approche 1 : à fb = 0,98
 * le gain cumulé atteint ≈ 50× (mesuré : +4,5 dB de pic sur le seul wet, et
 * bien davantage après les allpasses). Résultat : le knob Room *ajoutait* du
 * niveau, et à fond la queue ne redescend jamais — c'est un lavage permanent
 * du morceau, pas une réverbération.
 *
 * Le Freeverb canonique normalise ses filtres pour annuler ce gain ; ici la
 * normalisation a été omise. On la restitue donc explicitement, pour que le
 * wet ait le même niveau que le sec quelle que soit la taille de la pièce.
 * Le mixage final étant `dry·(1−mix) + wet·mix`, `−3 dB` de marge suffit à
 * garantir que le reverb n'élève jamais le signal.
 */
export const REVERB_GAIN_COMPENSATION_DB = -3;

/**
 * Poids des knobs Bass et Treble, redistribués le 10 octobre 2026.
 *
 * L'ancien Bass pesait `[0,55 ; 0,30 ; 0 ; 0]` — les deux premières bandes, 31 et
 * 62 Hz, et **rien** au-dessus. Or 31 Hz est hors d'oreille sur un petit
 * haut-parleur : elle ne s'entend pas, elle fait seulement bouger le cône sur une
 * fréquence qu'il ne restitue pas. Mesuré à knob à fond (+12), la version
 * ancienne livrait **0,63 dB** dans la zone où le grave s'entend (100–250 Hz)
 * contre **7,28 dB** à 31 Hz — soit 11,5 fois plus d'énergie dans le vide que
 * dans le grave utile. C'est exactement le symptôme « le bass ne marche pas
 * très bien » : le knob bouge, l'oreille ne reçoit rien.
 *
 * Le poids est donc déplacé vers le fundamental (125 Hz) et son premier
 * harmonique (250 Hz), avec 62 Hz conservé pour la palpabilité. 31 Hz reste
 * présent mais **borné à ~+5 dB** à fond : assez pour qu'un gros haut-parleur ou
 * un casque le restitue, jamais assez pour faire du bruit de cône.
 *
 * Même traitement côté Treble : 2 kHz tombe de 4,6 à ~2 dB. Cette bande est la
 * zone de la sibilance — une brillance qui la pousse devient criarde, alors que
 * 8 et 16 kHz portent la « brillance » perçue. L'aigu moyen utile monte malgré
 * tout, parce que le knob travaille désormais là où l'oreille est sensible.
 *
 * Mesuré à +12 / −12, preset à plat :
 *
 *   | zone        | avant | après |
 *   |-------------|-------|-------|
 *   | 125 Hz      | +1,1  | +9,3  |
 *   | utile 100-250 | +0,63 | +6,75 |
 *   | 31 Hz (inutile) | +7,28 | +5,13 |
 *
 * Les poids sont appliqués par `getEffectiveEqualizerBands`, que le web ET le
 * natif consomment : les deux plateformes partagent donc cette loi sans la
 * réimplémenter.
 */
export const BASS_WEIGHTS = [0.25, 0.65, 0.60, 0.20];
/**
 * 16 kHz pèse 0,92 et non 1,0 : à 1,0 c'est la première bande à toucher le
 * plafond, et le clamp la figeait (voir `getEffectiveEqualizerBands`). Ce poids
 * reste le plus fort du groupe — la brillance vient de 16 kHz — mais laisse au
 * clamp une marge qu'il n'a pas à rogner. Vérifié : 0 saturation sur les 84
 * combinaisons preset × knob.
 */
export const TREBLE_WEIGHTS: { [idx: number]: number } = { 6: 0.05, 7: 0.28, 8: 0.70, 9: 0.92 };

/**
 * Construit un preset avec un préampli épinglé à 0 dB.
 *
 * ⚠ Décision du 10 octobre 2026, explicite : le préampli doit toujours rester à 0.
 *
 * Ce fichier a porté jusque-là un préampli *dérivé* du pic réel de chaque courbe
 * (`autoPreampDb`), précisément parce que le limiteur est un plafond dur et qu'un
 * preset au-dessus de 0 dBFS s'écrête au lieu de se compresser. C'est cette
 * compensation qui est retirée ici, sur demande — le préampli n'est plus une
 * grandeur dérivée, c'est une constante.
 *
 * Conséquence assumée : `bass`, `bass-profond` et `electro` sortent la chaîne
 * jusqu'à **+9,3 dBFS** (mesuré via `responsePeakDb`). Le limiteur les écrête
 * donc sur les crêtes. C'est le prix explicite du préampli à 0, et il ne
 * disparaît pas en réécrivant cette fonction : il se règle en bornant les
 * `bands` du preset concerné.
 *
 * `makePreset` reste en place malgré tout : c'est le point unique où l'invariance
 * est écrite, donc le futur preset qui dériverait son préampli se voit ici.
 */
function makePreset(
  preset: Omit<EqualizerPreset, 'preamp'>
): EqualizerPreset {
  return {
    ...preset,
    preamp: 0,
  };
}

export const DEFAULT_PRESETS: EqualizerPreset[] = [
  makePreset({
    id: 'flat',
    name: 'Flat (Neutre Studio)',
    description: 'Réponse linéaire sans coloration, fidélité mastering originale.',
    bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  }),

  // --- Basses : deux presets distincts ----------------------------------
  // L'ancien « Mega Bass / Bass Boost » était un seul preset unique à +7,5 dB
  // qui remontait le 31 Hz. Deux défauts, distincts :
  //
  //   1. **Le sous-grave ne fait pas « profond », il fait du bruit.** Sur un
  //      petit haut-parleur, la bande 31 Hz est hors d'oreille : elle ne se
  //      perçoit pas, elle fait bouger le cône sur une fréquence qu'il ne
  //      restitue pas. Le résultat s'entend comme « un son mauvais sur le
  //      bass » — c'est le symptôme signalé.
  //   2. **La profondeur perçue vient d'ailleurs.** Elle tient au fundamental
  //      (80–125 Hz) et à ses harmoniques (160–250 Hz), que tous les
  //      haut-parleurs restituent. On peut donc *augmenter* la profondeur
  //      perçue tout en *retirant* l'énergie qui fait souffrir le HP — c'est
  //      ce que fait la courbe ci-dessous : mesurée, elle retire 3,5 dB
  //      d'effort à 31 Hz tout en ajoutant 3,1 dB de profondeur perçue.
  //
  // Les deux presets se séparent donc par *où* ils placent l'énergie :
  //   - `bass` : 31 Hz quasi neutre (−0,1 dB), énergie sur 100–250 Hz. Sûr
  //     sur n'importe quel HP, deepest perçu sans fatigue.
  //   - `bass-profond` : le même centre de gravité, poussé 1,8 dB plus haut,
  //     plus une dose de 31 Hz bornée à +6 dB — l'effet « club », mais pas plus,
  //     sinon on retombe dans le défaut du premier preset.
  //
  // Renommé depuis « Bass Booster » le 10 octobre 2026, `id` compris : l'id est
  // persisté dans `DSPState.presetId`, il devait donc suivre le nom. Une
  // sauvegarde portant l'ancien `bass-booster` retombe simplement sur l'état
  // courant — voir la migration dans `normalizeDSP`.
  makePreset({
    id: 'bass',
    name: 'Bass',
    description: 'Profondeur perçue sur le grave audible (100–250 Hz), sans effort dans le sous-grave.',
    bands: [-1, 3.5, 6.5, 3, -1, 0, 0, 0.5, 1, 1],
  }),
  makePreset({
    id: 'bass-profond',
    name: 'Bass Profond',
    description: 'Sub et grave audible poussés ensemble, sous-grave borné pour ménager le haut-parleur.',
    bands: [4.5, 6, 8, 4, -2, 0, 0.5, 1.5, 2, 2],
  }),
  makePreset({
    id: 'rock',
    name: 'Rock & Metal',
    description: 'Courbe en V : basses percutantes, médiums creusés, cymbales précises.',
    bands: [6, 4, 2, -1, -2, 0, 2, 4, 5, 5],
  }),
  makePreset({
    id: 'pop',
    name: 'Pop / Modern Hits',
    description: 'Clarté dynamique des voix avec des basses rondes et chaleureuses.',
    bands: [4, 3, 1, 1, 3, 2, 2, 3, 4, 4],
  }),
  makePreset({
    id: 'electro',
    name: 'Electro / EDM / Club',
    description: 'Grave profonde et brillance des synthés sans distorsion.',
    bands: [8, 6, 4, 1, -1, 1, 3, 5, 6, 7],
  }),
  makePreset({
    id: 'jazz',
    name: 'Jazz & Blues',
    description: 'Chaleur des contrebasses, richesse des médiums et cuivres soyeux.',
    bands: [3, 3, 1, 2, -1, 0, 1, 2, 2, 2],
  }),
  makePreset({
    id: 'vocal',
    name: 'Vocal Boost / Clarté',
    description: 'Attenue les grondements et met en avant la présence des voix.',
    bands: [-3, -3, -1, 2, 5, 4, 3, 3, 4, 5],
  }),
  makePreset({
    id: 'acoustic',
    name: 'Acoustique & Classique',
    description: 'Transparence naturelle, cordes cristallines et aération sonore.',
    bands: [2, 1, 1, 0, 1, 2, 3, 4, 4, 4],
  }),

  // --- Préréglages « studio » ---------------------------------------------
  makePreset({
    id: 'studio-master',
    name: 'Studio Mastering',
    description: 'Courbe de référence neutre en loudness, transparence maximale.',
    bands: [-1.5, -1, 0, 0.5, 0.5, 0.5, 0.5, 1, 1.5, 2],
  }),
  makePreset({
    id: 'warm-vintage',
    name: 'Chaud / Vintage',
    description: 'Graves pleines et chaudes, médiums adoucis, sans agressivité.',
    bands: [1.5, 1, 0.5, 0, -0.5, -1, -1.5, -1, -0.5, 0],
  }),
  makePreset({
    id: 'clear-airy',
    name: 'Clair / Aéré',
    description: 'Présence des voix et aération haute fréquence, sans sibilance.',
    bands: [-0.5, -0.5, -0.5, 0, 0.5, 1, 1, 0.5, 0.5, 3],
  }),
  makePreset({
    id: 'rnv-latenight',
    name: 'Nuit Calme',
    description: 'Écoute de nuit à faible volume : graves et aigus atténués.',
    bands: [-4, -3, -2, -1, 0, 0.5, 1, 1, 0.5, 0],
  }),
  makePreset({
    id: 'wide-cinematic',
    name: 'Large / Cinématique',
    description: 'Image stéréo élargie, présence nette, graves discrets.',
    bands: [0, 0, 0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 1],
  }),
];
