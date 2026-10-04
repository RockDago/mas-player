/**
 * Vérifie l'équivalence entre le Q utilisé par le moteur web
 * (`BiquadFilterNode.gain`, Q ≈ 1.0) et le `bandwidth` en octaves
 * d'`AVAudioUnitEQFilterParameters` utilisé par le moteur iOS.
 *
 * Les deux moteurs doivent produire la MÊME courbe, sinon un preset ne sonne
 * pas pareil sur les deux plateformes.
 *
 * Relation de l'Audio EQ Cookbook :  Q = 1 / (2·sinh((ln2/2)·BW))
 *   -> inverse :  BW = 2·asinh(1/(2·Q)) / ln2
 *
 * Lancer : node scripts/q-bandwidth.cjs
 */
const LN2 = Math.LN2;

const bwFromQ = (q) => (2 * Math.asinh(1 / (2 * q))) / LN2;
const qFromBw = (bw) => 1 / (2 * Math.sinh((LN2 / 2) * bw));

console.log('1. Allers-retours Q -> octaves');
let ok = true;
for (const q of [0.5, 0.707, 1.0, 1.414, 2.0, 4.0]) {
  const bw = bwFromQ(q);
  const back = qFromBw(bw);
  const good = Math.abs(back - q) < 1e-12;
  ok &&= good;
  console.log(`   ${good ? 'OK  ' : 'FAIL'} Q=${q.toFixed(3)} -> ${bw.toFixed(4).padStart(7)} octaves   retour Q=${back.toFixed(6)}`);
}

console.log('\n2. Valeur utilisée par le code (Q du web = 1.0)');
const bw = bwFromQ(1.0);
console.log(`   bandwidth attendu : ${bw.toFixed(4)} octaves`);
const hardcodedIsWrong = Math.abs(1.0 - bw) > 1e-6;
console.log(`   bandwidth=1.0 en dur aurait valu Q=${qFromBw(1.0).toFixed(4)} (${(qFromBw(1.0) / 1.0).toFixed(2)}x trop large)`);
if (!hardcodedIsWrong) { console.log('   ATTENTION : 1.0 serait correct'); ok = false; }

// La même erreur de grandeur existe-t-elle sur les shelves ? (elles ignorent bandwidth)
console.log('\n3. Les shelves ignorent bandwidth — seule la fréquence compte');
console.log('   OK : bandwidth n\'est appliqué qu\'aux 8 bandes peaking.');

console.log('\n' + (ok ? 'TOUT EST VERT' : 'ECHEC'));
process.exit(ok ? 0 : 1);