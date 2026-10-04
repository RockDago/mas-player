/**
 * Vérifie que le moteur natif iOS et le moteur web restent alignés.
 *
 * Les deux implémentations dupliquent volontairement la table de bandes : le
 * Swift ne peut pas importer le TypeScript. Cette vérification est donc le
 * garde-fou qui détecte une divergence si l'un des deux fichiers est modifié
 * sans l'autre.
 *
 * Lancer : node scripts/sync-check.cjs
 */
const { readFileSync } = require('fs');

const ts = readFileSync('src/constants/presets.ts', 'utf8');
const swift = readFileSync('modules/expo-audio-dsp/ios/AudioDSPEngine.swift', 'utf8');
const web = readFileSync('src/services/webAudioEngine.ts', 'utf8');

let ok = true;
const check = (label, actual, expected) => {
  const good = String(actual) === String(expected);
  ok &&= good;
  console.log(`   ${good ? 'OK  ' : 'FAIL'} ${label.padEnd(34)} ${actual}`);
  if (!good) console.log(`        attendu : ${expected}`);
};

console.log('1. Fréquences des 10 bandes');
const tsFreq = [...ts.matchAll(/freq:\s*(\d+)/g)].map((m) => +m[1]);
// On ne lit que le littéral du tableau, commentaires exclus : sinon les
// repères « bande 0 » / « bandes 1-8 » polluting les nombres extraits.
const swiftBlock = swift.match(/frequencies:\s*\[Float\]\s*=\s*\[([\s\S]*?)\]/)[1];
const swiftFreq = [...swiftBlock.replace(/\/\/[^\n]*/g, '').matchAll(/(\d+)/g)].map((m) => +m[1]);
check('src/constants/presets.ts', tsFreq.join(','), '250,125,250,500,1000,2000,4000,6000,8000,8000');
check('AudioDSPEngine.swift', swiftFreq.join(','), tsFreq.join(','));
check('nombre de bandes', swiftFreq.length, 10);

console.log('\n2. Types de bandes (mapping Web Audio -> AVAudioUnitEQ)');
const tsTypes = [...ts.matchAll(/type:\s*'(\w+)'/g)].map((m) => m[1]);
check('presets.ts', tsTypes.join(','), 'lowshelf,peaking,peaking,peaking,peaking,peaking,peaking,peaking,peaking,highshelf');
const swiftTypeBlock = swift.match(/types:\s*\[AVAudioUnitEQFilterType\]\s*=\s*\[([\s\S]*?)\]/)[1];
const swiftTypes = [...swiftTypeBlock.replace(/\/\/[^\n]*/g, '').matchAll(/\.(\w+)/g)].map((m) => m[1]);
check('AudioDSPEngine.swift', swiftTypes.join(','), 'lowShelf,parametric,parametric,parametric,parametric,parametric,parametric,parametric,parametric,highShelf');

console.log('\n3. Réglages partagés');
const webLimitMatch = /threshold\.value = (-?[\d.]+)/.exec(web);
const swiftLimitMatch = /limiterThreshold:\s*Float\s*=\s*(-?[\d.]+)/.exec(swift);
if (webLimitMatch && swiftLimitMatch) {
  check('limiteur (seuil dB)', swiftLimitMatch[1], webLimitMatch[1]);
} else {
  console.log('   --  limiteur iOS : géré par standard AVAudioMixerNode / headroom');
}

const webQ = /EQ_PEAKING_Q\s*=\s*([\d.]+)/.exec(ts)[1];
const swiftQ = /peakingQ:\s*Float\s*=\s*([\d.]+)/.exec(swift)[1];
check('Q des bandes peaking', swiftQ, webQ);

console.log('\n4. Préampli : calculé au même endroit ?');
const webImport = /import[\s\S]*?computeHeadroom/.test(web);
const bridge = readFileSync('src/services/nativeAudioDSP.ts', 'utf8');
check('web importe computeHeadroom', webImport, 'true');
check('pont natif importe computeHeadroom', /computeHeadroom/.test(bridge), 'true');
const swiftComputesHeadroom = /positiveSum|computeHeadroom/.test(swift);
check('Swift ne recalcule PAS la marge', swiftComputesHeadroom, 'false');

console.log('\n' + (ok ? 'LES DEUX MOTEURS SONT ALIGNÉS' : 'DIVERGENCE ENTRE WEB ET IOS'));
process.exit(ok ? 0 : 1);