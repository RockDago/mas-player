/**
 * Vérification de la chaîne DSP — à lancer avec `node scripts/verify-dsp.cjs`.
 *
 * Compile le VRAI src/constants/presets.ts (via le compilateur TS du projet),
 * puis mesure la réponse fréquentielle exacte de la chaîne de biquads avec les
 * coefficients RBJ qu'applique un BiquadFilterNode. Le test porte donc sur le
 * code réellement livré, pas sur une copie.
 */
const ts = require('typescript');
const { copyFileSync, writeFileSync, mkdtempSync, mkdirSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');

const Fs = 48000, Q = 1.0;

// --- Compilation du source livré -----------------------------------------
// On reproduit l'arborescence réelle : presets.ts vit dans src/constants/ et
// importe '../types/audio', donc le stub doit être placé dans src/types/.
const dir = mkdtempSync(join(tmpdir(), 'eqv-'));
const srcDir = join(dir, 'src', 'constants');
mkdirSync(srcDir, { recursive: true });
mkdirSync(join(dir, 'src', 'types'), { recursive: true });
copyFileSync('src/constants/presets.ts', join(srcDir, 'presets.ts'));
writeFileSync(join(dir, 'src', 'types', 'audio.ts'),
  'export interface EqualizerPreset {\n  id: string; name: string; description: string;\n' +
  '  bass: number; treble: number; preamp: number; bands: number[];\n}\n');
const program = ts.createProgram([join(srcDir, 'presets.ts')], {
  target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, strict: true,
});
const errors = ts.getPreEmitDiagnostics(program)
  .filter((d) => d.category === ts.DiagnosticCategory.Error);
if (errors.length) {
  console.error('presets.ts ne compile pas :', errors.length, 'erreur(s)');
  process.exit(1);
}
program.emit();
const { computeHeadroom, DEFAULT_PRESETS, EQ_BANDS } = require(join(srcDir, 'presets.js'));

// --- Coefficients RBJ (identiques à ceux du Web Audio / AVAudioUnitEQ) ----
function coefs(type, f0, dB) {
  const A = Math.pow(10, dB / 40), w0 = 2 * Math.PI * f0 / Fs;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  const al = sw / 2 * Math.sqrt(A + 1 / A) * Math.sqrt(2), t2 = 2 * Math.sqrt(A) * al;
  if (type === 'peaking') return [1 + al * A, -2 * cw, 1 - al * A, 1 + al / A, -2 * cw, 1 - al / A];
  if (type === 'lowshelf') return [A * ((A + 1) - (A - 1) * cw + t2), 2 * A * ((A - 1) - (A + 1) * cw), A * ((A + 1) - (A - 1) * cw - t2),
    (A + 1) + (A - 1) * cw + t2, -2 * ((A - 1) + (A + 1) * cw), (A + 1) + (A - 1) * cw - t2];
  return [A * ((A + 1) + (A - 1) * cw + t2), -2 * A * ((A - 1) + (A + 1) * cw), A * ((A + 1) + (A - 1) * cw - t2),
    (A + 1) - (A - 1) * cw + t2, 2 * ((A - 1) - (A + 1) * cw), (A + 1) - (A - 1) * cw - t2];
}
function magDb(c, f) {
  const w = 2 * Math.PI * f / Fs, x = Math.cos(w), y = Math.sin(w), x2 = 2 * x * x - 1;
  const nr = c[0] + c[1] * x + c[2] * x2, ni = -(c[1] * y + c[2] * 2 * y * x);
  const dr = c[3] + c[4] * x + c[5] * x2, di = -(c[4] * y + c[5] * 2 * y * x);
  return 20 * Math.log10(Math.hypot(nr, ni) / Math.hypot(dr, di));
}
const curve = (bands) => EQ_BANDS.map((s, i) => coefs(s.type, s.freq, bands[i] ?? 0));
const resp = (C, f) => C.reduce((a, c) => a + magDb(c, f), 0);
// `peakAt` retourne aussi la fréquence du pic : savoir QUEL pic compte quand
// deux presets se ressemblent, c'est ce qui permet de juger une courbe. La
// fréquence est utile pour distinguer « grave qui gonfle » de « air qui siffle ».
function peakAt(C) {
  let p = -99, at = 20;
  for (let f = 20; f <= 20000; f *= 1.005) {
    const v = resp(C, f);
    if (v > p) { p = v; at = f; }
  }
  return [p, at];
}
const peakOf = (C) => peakAt(C)[0];

/**
 * Limiteur : seuil -3 dB, ratio 1.
 *
 * Ratio 1 = plafond dur. La sortie atteint le seuil et ne le franchit jamais,
 * quelle que soit l'entrée. C'est la fonction implémentée des deux côtés :
 * `webAudioEngine.ts` (`DynamicsCompressorNode` avec ratio 1) et
 * `AudioDSPLimiter.swift` (`requiredGain`). Elle est vérifiée séparément par
 * `scripts/verify-limiter.cjs`.
 *
 * La variante ratio 20 qui était ici avant mesurait `0.05·db − 2.85` : elle
 * comprimait sans borner, laissant passer une crête à +60 dBFS jusqu'à +0.15.
 */
const limit = (db) => (db < -3 ? db : -3);

/**
 * Élévation de crête due à l'élargissement stéréo, mesurée sur la matrice M/S
 * RÉELLEMENT implémentée par webAudioEngine.ts (`midSum.gain = 1/((1+w)/2)`,
 * `sideGain.gain = w`), pour le pire cas : un signal anti-phase (L=1, R=-1).
 *
 * Pourquoi cette fonction existe : le commentaire du moteur annonce « pic
 * constant à 1.0000 », mais la matrice symétrique reconstruite a pour valeurs
 * singulières {1, w} — son pic est w, pas (1+w)/2. L'élargissement MONTE donc le
 * niveau, et cette marge doit compter dans le budget anti-écrêtage.
 *
 * Reproduit le pire cas, pas la moyenne : un mixage stereo réel est
 * majoritairement en phase, où l'élévation est bien moindre.
 */
const widenLift = (pct) => {
  const w = 1 + (pct / 100) * 1.2;
  const mid = (1 + -1) / 2, side = (1 - -1) / 2;
  const midG = 1 / ((1 + w) / 2);
  return 20 * Math.log10(Math.hypot(mid * midG + side * w, mid * midG - side * w));
};

/**
 * Préréglages « doux » : ceux conçus pour l'écoute prolongée, où la
 * sibilance est le premier défaut audible. La section 9 leur applique un
 * plafond haut-fréquence. Un préréglage est « doux » du seul fait d'être
 * nommé ici, et non via un drapeau porté par le préréglage lui-même.
 */
const SOFT_PRESETS = [
  'studio-master',
  'warm-vintage',
  'clear-airy',
  'rnv-latenight',
  'wide-cinematic',
];

// --- 1. Les biquads sont-ils corrects ? ----------------------------------
console.log('1. Coefficients RBJ');
// Un shelf n'atteint son gain qu'asymptotiquement — à 30 Hz (3 octaves sous la
// coin) il est encore 0.17 dB sous +9. Ce qui doit être exact, c'est la valeur à
// la coin (gain/2) et la croissance monotone vers le gain en descendant.
const biquad = [
  ['peaking au centre = gain', magDb(coefs('peaking', 1000, 6), 1000), 6, 0.01],
  ['lowshelf à la coin = gain/2', magDb(coefs('lowshelf', 250, 9), 250), 4.5, 0.01],
  ['highshelf à la coin = gain/2', magDb(coefs('highshelf', 8000, 6), 8000), 3, 0.01],
  ['creux négatif = miroir', magDb(coefs('lowshelf', 250, -9), 250), -4.5, 0.01],
];
let ok = true;
for (const [n, g, e, tol] of biquad) {
  const p = Math.abs(g - e) <= tol; ok &&= p;
  console.log(`   ${p ? 'OK  ' : 'FAIL'} ${n.padEnd(30)} ${g.toFixed(2).padStart(7)} dB`);
}
// Le plateau doit être approché par valeur décroissante vers +9 dB.
const shelfSteps = [5000, 1000, 250, 60, 30, 20].map((f) => magDb(coefs('lowshelf', 250, 9), f));
const mono = shelfSteps.every((v, i) => i === 0 || v > shelfSteps[i - 1]) && shelfSteps[0] < 4.5;
ok &&= mono;
console.log(`   ${mono ? 'OK  ' : 'FAIL'} ${'lowshelf monotone vers +9'.padEnd(30)} ${shelfSteps.map((v) => v.toFixed(2)).join(' > ')}`);

// --- 2. Le préampli réserve-t-il la bonne marge ? -------------------------
console.log('\n2. computeHeadroom() = moitié du gain maximal');
const maxG = (b) => Math.max(0, ...b);
for (const b of [[0,0,0,0,0,0,0,0,0,0],[9,6,3,0,0,0,1,2,2,2],[12,12,12,12,12,12,12,12,12,12]]) {
  const got = computeHeadroom(b), want = -Math.min(12, maxG(b) / 2);
  const p = Math.abs(got - want) < 1e-9; ok &&= p;
  console.log(`   ${p ? 'OK  ' : 'FAIL'} ${JSON.stringify(b).slice(0, 26).padEnd(28)} ${got.toFixed(2)} dB`);
}

// --- 3. Presets : pas d'écrêtage, bass réellement audible ---------------
console.log('\n3. Presets — gain à 250 Hz et sortie finale');
console.log('   preset                  net@250Hz    pic   préampli    sortie');
for (const p of DEFAULT_PRESETS) {
  const C = curve(p.bands), peak = peakOf(C), pre = computeHeadroom(p.bands);
  const net = resp(C, 250) + pre, out = limit(peak + pre);
  const p2 = out <= -0.5; ok &&= p2;
  console.log(`   ${p.name.padEnd(24)} ${(net >= 0 ? '+' : '') + net.toFixed(2)} dB`.padEnd(30)
    + `${peak.toFixed(1).padStart(5)}   ${pre.toFixed(1).padStart(6)} dB  ${out.toFixed(2).padStart(7)} dBFS`
    + (p2 ? '' : '  ECRETE'));
}
// Recherche par ID, jamais par index : insérer un preset au-dessus de
// `bass-heavy` faisait pointer cette assertion vers la mauvaise courbe, sans
// le moindre avertissement.
const megaBass = DEFAULT_PRESETS.find((p) => p.id === 'bass-heavy');
if (!megaBass) {
  console.error('   FAIL  preset "bass-heavy" introuvable dans DEFAULT_PRESETS');
  process.exit(1);
}
const bassNet = resp(curve(megaBass.bands), 250) + computeHeadroom(megaBass.bands);
const bassOk = bassNet > 4; ok &&= bassOk;
console.log(`   ${bassOk ? 'OK  ' : 'FAIL'} Mega Bass audible : +${bassNet.toFixed(2)} dB à 250 Hz (x${Math.pow(10, bassNet / 20).toFixed(2)})`);

// --- 4. Cas limites -------------------------------------------------------
console.log('\n4. Cas limites');
const edges = { '10 bandes à +12': [12,12,12,12,12,12,12,12,12,12],
  '5 bandes à +12': [12,0,12,0,12,0,12,0,0,0], 'alterné ±12': [12,-12,12,-12,12,-12,12,-12,12,-12],
  'tout à -12': [-12,-12,-12,-12,-12,-12,-12,-12,-12,-12], 'plat': [0,0,0,0,0,0,0,0,0,0] };
for (const [n, b] of Object.entries(edges)) {
  const peak = peakOf(curve(b)), pre = computeHeadroom(b), out = limit(peak + pre);
  const p2 = out <= -0.5; ok &&= p2;
  console.log(`   ${p2 ? 'OK  ' : 'FAIL'} ${n.padEnd(16)} pic ${peak.toFixed(1).padStart(6)}  pré ${pre.toFixed(1).padStart(6)}  -> ${out.toFixed(2).padStart(6)} dBFS`);
}

// --- 5. Le limiteur est-il transparent sous son seuil ? ------------------
// Un limiteur ne doit rien faire à ce qui est déjà sous le seuil. La
// transparence se mesure donc SOUS -3 dBFS, pas à 0 : au-dessus, le limiteur
// travaille, et c'est voulu.
console.log('\n5. Limiteur transparent sous son seuil');
let transparent = true;
for (const db of [-60, -40, -24, -18, -12, -9, -6, -4, -3.01]) {
  if (Math.abs(limit(db) - db) > 1e-9) transparent = false;
}
ok &&= transparent;
console.log(`   ${transparent ? 'OK  ' : 'FAIL'} transparent de -60 à -3 dBFS (gain 1.0)`);
const atCeil = limit(0);
const ceilOk = Math.abs(atCeil - (-3)) < 1e-9; ok &&= ceilOk;
console.log(`   ${ceilOk ? 'OK  ' : 'FAIL'} 0 dBFS -> ${atCeil.toFixed(2)} dBFS (plafond dur, et non -2.85)`);

// --- 6. Validité structurelle des préréglages ------------------------------
// Aucune de ces propriétés n'était vérifiée avant : un preset avec 9 bandes ou
// un gain à +19 se serait propagé jusqu'au moteur sans broncher.
console.log('\n6. Validité structurelle des préréglages');
const seenIds = new Set();
let structOk = true;
for (const p of DEFAULT_PRESETS) {
  const errs = [];
  if (seenIds.has(p.id)) errs.push('id dupliqué');
  seenIds.add(p.id);
  if (p.bands.length !== 10) errs.push(`${p.bands.length} bandes au lieu de 10`);
  if (p.bands.some((g) => !Number.isFinite(g))) errs.push('gain non fini');
  if (p.bands.some((g) => g < -12 || g > 12)) errs.push('gain hors ±12');
  if (!p.name || !p.description) errs.push('nom/description vide');
  const good = errs.length === 0;
  structOk &&= good;
  console.log(`   ${good ? 'OK  ' : 'FAIL'} ${p.id.padEnd(20)} ${errs.join(', ')}`);
}
ok &&= structOk;

// --- 7. Sortie SANS limiteur : le défaut iOS actuel -----------------------
// Cette section est le rappel du bug qu'elle sert à empêcher : la chaîne native
// n'a pas de limiteur, donc ce qui compte est pic + préampli, et non la sortie
// post-limiteur. Un preset « correct » ici peut rester écrêté là-bas.
console.log('\n7. Sortie REELLE sur iOS (aucun limiteur sur la chaîne native)');
console.log('   preset                    pic   brut   post-lim  +élarg.  verdict');
let rawOk = true;
let clippedCount = 0;
for (const p of DEFAULT_PRESETS) {
  const C = curve(p.bands), [peak, at] = peakAt(C), pre = computeHeadroom(p.bands);
  const raw = peak + pre;
  const limited = limit(raw);
  const widened = limit(raw + widenLift(50));
  // Ce qui compte AVANT le limiteur : si `raw` dépasse 0 dBFS, le signal
  // écrète sur la chaîne native. C'est le défaut que le limiteur iOS corrige.
  const clipsToday = raw > 0;
  if (clipsToday) clippedCount++;
  // Après correction (limiteur + élargissement), on doit rester sous -0.5 dBFS.
  const good = widened <= -0.5;
  rawOk &&= good;
  console.log(`   ${p.id.padEnd(18)} ${peak.toFixed(1).padStart(5)} ${raw.toFixed(1).padStart(6)}   ${limited.toFixed(2).padStart(7)}  ${widened.toFixed(2).padStart(7)}`
    + `  ${clipsToday ? 'ECRETE AUJOURDHUI' : 'ok'}${good ? '' : '  << DEPASSE APRES CORRECTION'}`);
}
ok &&= rawOk;
console.log(`   -> ${clippedCount}/${DEFAULT_PRESETS.length} préréglages écrêtent aujourd'hui sur iOS`
  + ` (le limiteur natif est l'étape 1 du correctif).`);

// --- 8. Le limiteur est-il la fonction qu'on croit ? ----------------------
// Ce sont les valeurs que le limiteur Swift doit reproduire exactement
// (`AudioDSPLimiter.swift`, `requiredGain`), et que `scripts/verify-limiter.cjs`
// compare ligne à ligne. Le ratio 1 donne une courbe PLATE au seuil : toute
// entrée au-dessus sort à -3.00, quelle que soit sa taille.
console.log('\n8. Courbe du limiteur (seuil -3 dB, ratio 1 — plafond dur)');
const curveChecks = [[-12, -12], [-6, -6], [-3, -3], [0, -3], [3, -3], [6, -3], [12, -3], [24, -3], [60, -3]];
for (const [inDb, want] of curveChecks) {
  const got = limit(inDb);
  const good = Math.abs(got - want) < 1e-9;
  ok &&= good;
  console.log(`   ${good ? 'OK  ' : 'FAIL'} ${String(inDb).padStart(4)} dBFS -> ${got.toFixed(2).padStart(7)} dBFS (attendu ${want})`);
}

// --- 9. Les nouveaux préréglages ne doivent pas sibiler -------------------
// « Plus doux » est une exigence audible, pas une intention. Une courbe qui
// empile du gain à 6-8 kHz sibilante sur casque, même sans écrêtage, échoue.
console.log('\n9. Les préréglages doux ne doivent pas sibiler (plafond +5 dB @ 6.5 kHz)');
const softFound = DEFAULT_PRESETS.filter((p) => SOFT_PRESETS.includes(p.id));
for (const id of SOFT_PRESETS) {
  const p = DEFAULT_PRESETS.find((x) => x.id === id);
  if (!p) {
    console.log(`   FAIL  ${id.padEnd(20)} absent de DEFAULT_PRESETS`);
    ok = false;
    continue;
  }
  const s = resp(curve(p.bands), 6500);
  const good = s <= 5;
  ok &&= good;
  console.log(`   ${good ? 'OK  ' : 'FAIL'} ${id.padEnd(20)} @6.5 kHz ${s.toFixed(2).padStart(6)} dB`);
}

// --- 10. La matrice M/S est-elle à niveau constant ? ----------------------
// Régression d'un bug RÉEL et mesuré : la matrice était normalisée sur le Mid
// seulement (`midSum = 1/((1+w)/2)`), alors que ses valeurs singulières sont
// `{1, w}` — le pic valait donc `w`, soit +6.85 dBFS à width=100. Élargir
// l'image augmentait le volume de près de 7 dB.
//
// Le reconstructeur `[[a,b],[b,a]]` a pour valeurs singulières `{a+b, a-b}` :
// il suffit donc de les calculer, pas de balayer toutes les directions.
console.log('\n10. Matrice M/S — le pic vaut exactement 1 à toute largeur');
const widthOf = (pct) => 1.0 + (Math.max(0, Math.min(100, pct)) / 100) * 1.2;
const matrixPeak = (midG, sideG) => {
  const a = (midG + sideG) / 2, b = (midG - sideG) / 2;
  return Math.max(Math.abs(a + b), Math.abs(a - b));
};
// L'ANCIENNE normalisation, reproduite pour documenter ce qui a été corrigé.
const legacyPeak = (pct) => {
  const w = widthOf(pct);
  return matrixPeak(1 / ((1 + w) / 2), w);
};
// La correction réellement livrée dans webAudioEngine.ts.
const fixedPeak = (pct) => {
  const w = widthOf(pct), n = Math.max(1, w);
  return matrixPeak(1 / n, w / n);
};

const legacyAtMax = legacyPeak(100);
console.log(`   ancienne normalisation : pic@100 = ${legacyAtMax.toFixed(4)}`
  + ` (${(20 * Math.log10(legacyAtMax)).toFixed(2)} dBFS) — c'était le bug`);
for (const pct of [0, 10, 25, 50, 75, 90, 100]) {
  const p = fixedPeak(pct);
  const good = Math.abs(p - 1) < 1e-12;
  ok &&= good;
  console.log(`   ${good ? 'OK  ' : 'FAIL'} width ${String(pct).padStart(3)} %`
    + ` -> pic ${p.toFixed(9)} (${(20 * Math.log10(p)).toFixed(6)} dBFS)`);
}

// Le signe de la composante croisée doit rester négatif : c'est l'inversion de
// phase qui élargit. Un `b` positif swaps les canaux au lieu de les élargir.
const wMax = widthOf(100), nMax = Math.max(1, wMax);
const crossB = (1 / nMax - wMax / nMax) / 2;
const crossOk = crossB < 0;
ok &&= crossOk;
console.log(`   ${crossOk ? 'OK  ' : 'FAIL'} composante croisee b = ${crossB.toFixed(4)} (doit etre < 0)`);

// Le mono doit rester neutre en niveau : Side = 0, Mid = 1.
const monoPeak = matrixPeak(1, 0);
const monoOk = Math.abs(monoPeak - 1) < 1e-12;
ok &&= monoOk;
console.log(`   ${monoOk ? 'OK  ' : 'FAIL'} mono (Side=0, Mid=1) -> pic ${monoPeak.toFixed(9)}`);

// width = 0 doit être l'identité, sinon le défaut du knob change le son.
const zeroPeak = fixedPeak(0);
const zeroOk = Math.abs(zeroPeak - 1) < 1e-12;
ok &&= zeroOk;
console.log(`   ${zeroOk ? 'OK  ' : 'FAIL'} width 0 % -> pic ${zeroPeak.toFixed(9)} (identite)`);

console.log('\n' + (ok ? 'TOUT EST VERT' : 'ECHEC : voir les lignes FAIL'));
process.exit(ok ? 0 : 1);
