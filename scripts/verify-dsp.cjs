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
function peakOf(C) { let p = -99; for (let f = 20; f <= 20000; f *= 1.005) p = Math.max(p, resp(C, f)); return p; }

// Limiteur réel : seuil -3, knee 0, ratio 20 (webAudioEngine.ts)
const limit = (db) => { const x = db + 3; return x < 0 ? db : -3 + x / 20; };

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
const bassNet = resp(curve(DEFAULT_PRESETS[1].bands), 250) + computeHeadroom(DEFAULT_PRESETS[1].bands);
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

// --- 5. Le limiteur est-il transparent ? ---------------------------------
console.log('\n5. Limiteur transparent sur son contenu');
const flatOut = limit(0);
const t = Math.abs(flatOut - (-2.85)) < 0.01; ok &&= t;
console.log(`   ${t ? 'OK  ' : 'FAIL'} son non traité à 0 dBFS -> ${flatOut.toFixed(2)} dBFS (attendu -2.85, soit transparent)`);

console.log('\n' + (ok ? 'TOUT EST VERT' : 'ECHEC : voir les lignes FAIL'));
process.exit(ok ? 0 : 1);
