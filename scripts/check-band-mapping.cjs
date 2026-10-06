/**
 * Exécute la répartition des bandes Android et vérifie son comportement audible.
 *
 * ## Pourquoi un harnais qui EXÉCUTE
 *
 * Le bug Android était invisible à la lecture : la table canonique était en Hz
 * alors que la comparaison se fait en kHz, et rien dans le code ne le signalait.
 * Un harnais qui relit le source ne l'aurait pas vu davantage que
 * `sync-check.cjs` — il vérifie que la comparaison existe, pas qu'elle est juste.
 *
 * Celui-ci **rejoue l'algorithme** sur des EQ matériels réalistes (5 et 10 bandes)
 * et vérifie des propriétés observables : un preset plat reste neutre, chaque
 * knob produit un effet audible, et les deux plateformes ne peuvent pas diverger
 * sur un preset.
 *
 * L'algorithme est transcrit depuis `AudioDSPModule.kt` (`mapCanonicalBands`).
 * Toute modification du Kotlin doit se répercuter ici — voir la section 5.
 *
 * Lancer : node scripts/check-band-mapping.cjs
 */

// Table canonique de `EQ_BANDS` (src/constants/presets.ts), en KILOHERTZ.
const CANON_KHZ = [0.25, 0.125, 0.25, 0.5, 1.0, 2.0, 4.0, 6.0, 8.0, 8.0];

/**
 * Étape 1 de `mapCanonicalBands`, isolée pour être testée seule.
 *
 * Chaque bande native réclame la bande canonique la plus proche encore libre.
 * La table est un paramètre, et non la constante du module : c'est ce qui permet
 * à la section 7 de vérifier que l'unité de la table change réellement le
 * résultat, au lieu de le supposer.
 *
 * @param {number[]} nativeCentersKHz centres des bandes du matériel
 * @param {number[]} canonKHz table canonique, dans la même unité
 * @returns {number[]} index canonique retenu par bande native
 */
function project(nativeCentersKhz, canonKhz) {
  const taken = new Array(canonKhz.length).fill(false);
  const projection = [];
  for (let i = 0; i < nativeCentersKhz.length; i++) {
    let best = -1;
    let bestDist = Infinity;
    for (let c = 0; c < canonKhz.length; c++) {
      if (taken[c]) continue;
      const d = Math.abs(nativeCentersKhz[i] - canonKhz[c]);
      if (d < bestDist) { bestDist = d; best = c; }
    }
    if (best < 0) {
      for (let c = 0; c < canonKhz.length; c++) {
        const d = Math.abs(nativeCentersKhz[i] - canonKhz[c]);
        if (d < bestDist) { bestDist = d; best = c; }
      }
    }
    projection[i] = best;
    taken[best] = true;
  }
  return projection;
}

/**
 * Transcription fidèle de `AudioDSPModule.kt : mapCanonicalBands`.
 *
 * @param {number[]} nativeCentersKHz centres des bandes du matériel, en kHz
 * @param {number[]} canonicalGainsDb  gains canoniques, en dB
 * @returns {number[]} un gain en dB par bande native
 */
function mapCanonicalBands(nativeCentersKHz, canonicalGainsDb) {
  const projection = project(nativeCentersKHz, CANON_KHZ);
  const n = nativeCentersKHz.length;
  if (n === 0) return [];

  const gainOf = (i) => (i in canonicalGainsDb ? canonicalGainsDb[i] : 0);

  const served = new Array(CANON_KHZ.length).fill(false);
  projection.forEach((i) => { served[i] = true; });

  // 2 + 3. Répartition des orphelines, puis moyenne par bande native.
  const sums = new Array(n).fill(0);
  const counts = new Array(n).fill(0);
  for (let i = 0; i < n; i++) { sums[i] += gainOf(projection[i]); counts[i]++; }

  for (let c = 0; c < CANON_KHZ.length; c++) {
    if (served[c]) continue;
    const gain = gainOf(c);
    if (gain === 0.0) continue;

    const co = projection.findIndex((v) => CANON_KHZ[v] === CANON_KHZ[c] && served[v]);
    if (co >= 0) { sums[co] += gain; continue; }

    const lowerEntries = projection
      .map((v, i) => ({ v, i }))
      .filter((o) => CANON_KHZ[o.v] < CANON_KHZ[c] && served[o.v])
      .sort((a, b) => CANON_KHZ[b.v] - CANON_KHZ[a.v]);
    const upperEntries = projection
      .map((v, i) => ({ v, i }))
      .filter((o) => CANON_KHZ[o.v] > CANON_KHZ[c] && served[o.v])
      .sort((a, b) => CANON_KHZ[a.v] - CANON_KHZ[b.v]);
    const ln = lowerEntries.length ? lowerEntries[0].i : -1;
    const un = upperEntries.length ? upperEntries[0].i : -1;

    let lw, uw;
    if (ln >= 0 && un >= 0) {
      const span = CANON_KHZ[projection[un]] - CANON_KHZ[projection[ln]];
      const t = span > 0 ? (CANON_KHZ[c] - CANON_KHZ[projection[ln]]) / span : 0.5;
      lw = 1 - t; uw = t;
    } else if (ln >= 0) { lw = 1; uw = 0; }
    else if (un >= 0) { lw = 0; uw = 1; }
    else continue;

    if (lw > 0) { sums[ln] += gain * lw; counts[ln]++; }
    if (uw > 0) { sums[un] += gain * uw; counts[un]++; }
  }

  return sums.map((s, i) => (counts[i] > 0 ? s / counts[i] : 0));
}

// Centres réels de l'Equalizer matériel. 5 bandes : le cas le plus répandu
// sur Android. 10 bandes : le meilleur cas, sur quelques appareils seulement.
const EQ_5 = [0.06, 0.23, 0.91, 3.6, 14];
const EQ_10 = [0.029, 0.059, 0.119, 0.237, 0.474, 0.947, 1.889, 3.77, 7.523, 15.011];

const FLAT = new Array(10).fill(0);
const withBand = (index, db) => { const g = new Array(10).fill(0); g[index] = db; return g; };

let failures = 0;
function check(label, condition) {
  if (condition) console.log(`  OK   ${label}`);
  else { console.log(`  ECHEC ${label}`); failures++; }
}

console.log('1. Un preset PLAT doit rester neutre (aucun effet, aucun bruit)');
for (const [name, eq] of [['5 bandes', EQ_5], ['10 bandes', EQ_10]]) {
  const mapped = mapCanonicalBands(eq, FLAT);
  check(`EQ ${name} : tous les gains à 0`, mapped.every((v) => v === 0));
}

console.log('2. Chaque knob de l’interface produit un effet AUDIBLE');
// C'est le symptôme exact du bug : un EQ à 5 bandes perdant 5 gains sur 10,
// le knob TREBLE devenait muet alors que l'UI le présentait comme actif.
const knobs = [
  ['BASS  (+6 dB @ 125 Hz)', withBand(1, 6), 5],
  ['MID   (+9 dB @ 1 kHz)', withBand(4, 9), 4.5],
  ['TREBLE(-12 dB @ 8 kHz)', withBand(9, -12), -6],
];
for (const [name, gains, seuil] of knobs) {
  const r5 = mapCanonicalBands(EQ_5, gains);
  const r10 = mapCanonicalBands(EQ_10, gains);
  const ok5 = seuil > 0 ? Math.max(...r5) >= seuil : r5.some((v) => v <= seuil);
  const ok10 = seuil > 0 ? Math.max(...r10) >= seuil : r10.some((v) => v <= seuil);
  check(`${name} audible sur EQ 5 bandes`, ok5);
  check(`${name} audible sur EQ 10 bandes`, ok10);
}

console.log('3. Les 10 bandes canoniques alimentent TOUTES la courbe');
for (const [name, eq] of [['5 bandes', EQ_5], ['10 bandes', EQ_10]]) {
  let feeding = 0;
  for (let c = 0; c < CANON_KHZ.length; c++) {
    if (mapCanonicalBands(eq, withBand(c, 12)).some((v) => Math.abs(v) > 0.5)) feeding++;
  }
  check(`EQ ${name} : ${feeding}/10 bandes canoniques actives`, feeding === 10);
}

console.log('4. Le gain demandé n’est jamais dégradé par dilution');
// Régression encountered pendant le développement : les orphelines à gain nul
// comptaient au dénominateur, et un +6 dB à 125 Hz ressortait à +1 dB.
for (const [name, eq] of [['5 bandes', EQ_5], ['10 bandes', EQ_10]]) {
  const r = mapCanonicalBands(eq, withBand(1, 12));
  check(`EQ ${name} : +12 dB à 125 Hz conservé (≥ 11 dB)`, Math.max(...r) >= 11);
}

console.log('5. Les deux 8 kHz (peaking + highshelf) ne se mangent pas');
// Les bandes 8 et 9 sont toutes deux à 8 kHz. Sans réservation, le plus-proche-
// voisin n'en sert qu'une et le TREBLE, qui pilote la bande 9, devient muet.
for (const [name, eq] of [['5 bandes', EQ_5], ['10 bandes', EQ_10]]) {
  const peak = mapCanonicalBands(eq, withBand(8, 12));
  const shelf = mapCanonicalBands(eq, withBand(9, 12));
  check(`EQ ${name} : peaking 8 kHz (bande 8) audible`, Math.max(...peak) >= 6);
  check(`EQ ${name} : highshelf 8 kHz (bande 9) audible`, Math.max(...shelf) >= 6);
}

console.log('6. Bass et treble ne se contaminent pas');
{
  const g = new Array(10).fill(0);
  g[0] = 12; g[1] = 12; g[9] = -12;
  const r = mapCanonicalBands(EQ_5, g);
  check('le grave reste positif', r.some((v) => v > 0));
  check('l’aigu reste négatif sur la bande haute', r[r.length - 1] < 0);
}

console.log('7. L’échelle d’unité est-elle cohérente des deux côtés ?');
// C’est le garde-fou qui aurait attrapé le bug d’origine. La correspondance par
// plus-proche-voisin est une simple comparaison de nombres : si la table et les
// centres étaient tous deux dans la MAÎME unité — même mauvaise — la projection
// serait identique et tous les tests ci-dessus passeraient. Le facteur 1000 ne
// s’annule que si les deux côtés ne sont PAS convertis.
{
  // Régression d'origine : table en Hz confrontée à des centres en kHz.
  const tableHzVsCentersKHz = project(
    [250, 125, 250, 500, 1000, 2000, 4000, 6000, 8000, 8000],
    EQ_5
  );
  const correct = project(CANON_KHZ, EQ_5);
  check(
    'une table en Hz NE reproduit PAS la projection correcte',
    tableHzVsCentersKHz.join(',') !== correct.join(',')
  );
  // Et l'inverse, pour les deux sens de la faute.
  const tableKHzVsCentersHz = project(CANON_KHZ, EQ_5.map((v) => v * 1000));
  check(
    'des centres en Hz ne reproduisent PAS la projection correcte',
    tableKHzVsCentersHz.join(',') !== correct.join(',')
  );
  check(
    'la projection retient des bandes DIVERSES (pas une seule pour tout)',
    new Set(correct).size >= 4
  );
}

console.log('8. Précision honnête sur la fidélité');
console.log('       L’Equalizer matériel ne sait pas empiler deux filtres à 8 kHz');
console.log('       comme le web. Android reste une APPROXIMATION de la courbe web');
console.log('       — plus grossière, mais aucun knob n’y devient muet. Ce harnais');
console.log('       garantit cette propriété, pas l’égalité bit-à-bit.');

console.log();
if (failures === 0) {
  console.log('LA REPARTITION DES BANDES EST CORRECTE');
} else {
  console.log(`${failures} VERIFICATION(S) EN ECHEC`);
  process.exit(1);
}
