/**
 * Vérification du PONT JS → natif — `node scripts/verify-dsp-bridge.cjs`.
 *
 * Ce que les harnais existants ne couvrent pas, et que ce fichier couvre :
 * la forme et le contenu exacts du payload `setDSPAsync`. `check-native-dsp-wiring`
 * vérifie que le natif *mentionne* ses paramètres ; `verify-dsp` vérifie les
 * constantes de préréglage. Aucun des deux n'exerce `applyNativeDSP`, qui est
 * pourtant l'endroit où les bandes sont remappées, bornées, pondérées par TONE,
 * et où le préampli est replié dans le headroom. Une régression ici — un champ
 * renommé, une bande perdue, un `enabled` écrasé — passe tous les tests verts et
 * laisse l'égaliseur muet sur l'appareil.
 *
 * Le module natif est simulé par un stub qui capture les arguments, donc le test
 * porte sur le code réellement livré, y compris la fourche iOS/Android.
 */
const ts = require('typescript');
const { copyFileSync, writeFileSync, mkdtempSync, mkdirSync, readFileSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');

let failures = 0;
const check = (label, condition, detail = '') => {
  if (condition) {
    console.log(`  OK   ${label}${detail ? ' ' + detail : ''}`);
  } else {
    failures += 1;
    console.log(`  ECHEC ${label}${detail ? ' ' + detail : ''}`);
  }
};

// --- Compilation du code livré ---------------------------------------------
// `nativeAudioDSP.ts` importe `react-native` et `expo-modules-core` : on compile
// avec des stub de modules qui enregistrement les appels, ce qui laisse le vrai
// `applyNativeDSP` s'exécuter sans rien escamoter.
const dir = mkdtempSync(join(tmpdir(), 'eqbridge-'));
mkdirSync(join(dir, 'src', 'services'), { recursive: true });
mkdirSync(join(dir, 'src', 'constants'), { recursive: true });
mkdirSync(join(dir, 'src', 'types'), { recursive: true });

copyFileSync('src/services/nativeAudioDSP.ts', join(dir, 'src', 'services', 'nativeAudioDSP.ts'));
copyFileSync('src/constants/presets.ts', join(dir, 'src', 'constants', 'presets.ts'));
writeFileSync(join(dir, 'src', 'types', 'audio.ts'),
  'export interface EqualizerPreset {\n  id: string; name: string; description: string;\n' +
  '  bass: number; treble: number; preamp: number; bands: number[];\n}\n' +
  'export interface DSPState {\n' +
  '  enabled: boolean; presetId: string; bass: number; treble: number; preamp: number;\n' +
  '  stereoExpansion: number; crossfeed: number; tempo: number; bands: number[];\n' +
  '  balance: number; volume: number; mono: boolean; tempoEnabled: boolean;\n' +
  '  reverbEnabled: boolean; roomSize: number; damping: number; reverbMix: number;\n' +
  '  toneEnabled: boolean; limitEnabled: boolean;\n}\n');

// Déclarations minimales : le compilateur doit accepter les imports des deux
// modules que `nativeAudioDSP.ts` consomme, sans installer quoi que ce soit.
writeFileSync(join(dir, 'stubs.d.ts'),
  'declare module "react-native" { export const Platform: { OS: string }; }\n' +
  'declare module "expo-modules-core" {\n' +
  '  export function requireOptionalNativeModule<T>(name: string): T | null;\n}\n');

// Stub du module natif : enregistre le dernier payload et les derniers args.
writeFileSync(join(dir, 'native-stub.js'), `
const calls = [];
const stub = {
  setDSPAsync: (...args) => { calls.push({ form: Array.isArray(args[0]) ? 'positional' : 'dict', args }); return Promise.resolve(); },
  _calls: calls,
};
globalThis.__MAS_STUB__ = stub;
`);

const program = ts.createProgram(
  [join(dir, 'src', 'services', 'nativeAudioDSP.ts'), join(dir, 'stubs.d.ts')],
  {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.CommonJS,
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
    types: [],
  }
);
const errors = ts.getPreEmitDiagnostics(program)
  .filter((d) => d.category === ts.DiagnosticCategory.Error);
if (errors.length) {
  console.error('nativeAudioDSP.ts ne compile pas :', errors.length, 'erreur(s)');
  errors.slice(0, 5).forEach((e) => console.error('   ', ts.flattenDiagnosticMessageText(e.messageText, ' ')));
  process.exit(1);
}
program.emit();

require(join(dir, 'native-stub.js'));

// `react-native` et `expo-modules-core` sont résolus par les stubs ci-dessous.
const Module = require('module');
const stubRegistry = new Map();
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'react-native') return join(dir, 'rn-stub.js');
  if (request === 'expo-modules-core') return join(dir, 'emc-stub.js');
  return originalResolve.call(this, request, ...rest);
};

writeFileSync(join(dir, 'rn-stub.js'), 'exports.Platform = { OS: "ios" };');
writeFileSync(join(dir, 'emc-stub.js'),
  'exports.requireOptionalNativeModule = () => globalThis.__MAS_STUB__;');

const bridge = require(join(dir, 'src', 'services', 'nativeAudioDSP.js'));
const stub = globalThis.__MAS_STUB__;

const baseState = {
  enabled: true, presetId: 'custom', bass: 0, treble: 0, preamp: 0,
  stereoExpansion: 0, crossfeed: 0, tempo: 1.0,
  bands: new Array(10).fill(0), balance: 0, volume: 100, mono: false,
  tempoEnabled: false, reverbEnabled: false, roomSize: 0, damping: 0,
  reverbMix: 0, toneEnabled: true, limitEnabled: true,
};

const lastPayload = () => {
  const call = stub._calls[stub._calls.length - 1];
  if (!call) return null;
  return call.form === 'dict' ? call.args[0] : { bands: call.args[0], preamp: call.args[1] };
};
const argCount = () => {
  const call = stub._calls[stub._calls.length - 1];
  return call ? call.args.length : 0;
};

console.log('\n1. Le module natif est-il trussé comme un module ?');
check('le pont trouve un module', bridge.isNativeEQAvailable() === true);

console.log('\n2. Forme du payload — iOS');
(async () => {
  await bridge.applyNativeDSP({ ...baseState, bands: [12, -12, 0, 0, 0, 0, 0, 0, 0, 12] });
  let call = stub._calls[stub._calls.length - 1];
  check('appel positionnel', call.form === 'positional', `(forme: ${call.form})`);
  check('quatorze arguments', argCount() === 14, `(reçu: ${argCount()})`);

  const p = lastPayload();
  console.log('\n3. Contenu du payload — bandes');
  check('dix bandes', p.bands.length === 10, `(reçu: ${p.bands.length})`);
  check('les gains traversent intacts',
    p.bands[0] === 12 && p.bands[1] === -12 && p.bands[9] === 12,
    `→ [${p.bands.join(',')}]`);
  check('toutes les bandes sont finies', p.bands.every(Number.isFinite));

  console.log('\n4. Contenu du payload — préampli et drapeaux');
  // computeHeadroom(12) = -6, donc preamp = min(0, -6 + 0) = -6.
  // `computeHeadroom` renvoie -min(12, maxGain/2) : à +12 dB sur une bande,
  // la marge vaut -6 et le préampli doit valoir -6 dB exactement. Une assertion
  // du type « <= 0 » passerait même avec un préampli neutralisé à 0 — ce que
  // fait précisément la régression testée ici.
  check('preamp = -6 dB à +12 dB de gain', p.preamp === -6, `→ ${p.preamp} dB`);
  await bridge.applyNativeDSP({ ...baseState, bands: new Array(10).fill(0) });
  check('preamp nul sur un EQ plat', lastPayload().preamp === 0);
  await bridge.applyNativeDSP({ ...baseState, bands: [4, 0, 0, 0, 0, 0, 0, 0, 0, 0] });
  check('preamp suit la moitié du gain max (4 dB → -2 dB)',
    lastPayload().preamp === -2, `→ ${lastPayload().preamp} dB`);

  await bridge.applyNativeDSP({ ...baseState, enabled: false, bands: new Array(10).fill(9) });
  check('enabled=false est transmis tel quel',
    lastPayload().bands.every((b) => b === 9) && lastPayload().bands.length === 10);
  check('enabled=false n\'est pas écrasé par le pont',
    stub._calls[stub._calls.length - 1].args[5] === false,
    `(args[5] = ${stub._calls[stub._calls.length - 1].args[5]})`);

  console.log('\n5. Pondération TONE');
  const tones = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  await bridge.applyNativeDSP({ ...baseState, bass: 12, toneEnabled: false, bands: tones.slice() });
  check('TONE coupé → aucune pente ajoutée',
    lastPayload().bands.every((b) => b === 0), `→ [${lastPayload().bands.join(',')}]`);
  await bridge.applyNativeDSP({ ...baseState, bass: 12, toneEnabled: true, bands: tones.slice() });
  check('TONE actif → pente sur les graves',
    lastPayload().bands[0] > 0, `→ bande 0 = ${lastPayload().bands[0]}`);

  console.log('\n6. Forme du payload — Android');
  // On rejoue en Android pour vérifier la fourche dictionnaire : c'est la forme
  // que `AudioDSPModule.kt:241` consomme réellement.
  const rnStub = join(dir, 'rn-stub.js');
  writeFileSync(rnStub, 'exports.Platform = { OS: "android" };');
  delete require.cache[require.resolve(rnStub)];
  delete require.cache[require.resolve(join(dir, 'src', 'services', 'nativeAudioDSP.js'))];
  const androidBridge = require(join(dir, 'src', 'services', 'nativeAudioDSP.js'));
  await androidBridge.applyNativeDSP({ ...baseState, bands: new Array(10).fill(4) });
  call = globalThis.__MAS_STUB__._calls.slice(-1)[0];
  check('appel par dictionnaire', call.form === 'dict', `(forme: ${call.form})`);
  check('un seul argument', argCount() === 1, `(reçu: ${argCount()})`);
  const dict = call.args[0];
  const requiredKeys = [
    'bands', 'preamp', 'balance', 'mono', 'stereoExpansion', 'enabled', 'crossfeed',
    'reverbEnabled', 'roomSize', 'damping', 'reverbMix', 'reverbWet', 'reverbDry', 'limitEnabled',
  ];
  const missing = requiredKeys.filter((k) => !(k in dict));
  check('les quatorze champs sont présents', missing.length === 0,
    missing.length ? `(manquants: ${missing.join(',')})` : '');
  check('bandes = 10 dans le dictionnaire', Array.isArray(dict.bands) && dict.bands.length === 10);

  console.log('\n7. Trace de diagnostic');
  const diag = androidBridge.getNativeDSPDiagnostics();
  check('les appels sont comptés', diag.callCount > 0, `(callCount: ${diag.callCount})`);
  check('le dernier payload est mémorisé', diag.lastPayload !== null);
  check('aucune erreur sur le chemin heureux', diag.lastError === null,
    diag.lastError ? `(${diag.lastError})` : '');
  check('un envoi réussi est horodaté', diag.lastSuccessAgeMs !== null);

  console.log('\n7 bis. Les VALEURS traversent-elles, ou seulement les clés ?');
  // Une simple vérification de présence des quatorze clés passe au travers d'un
  // pont qui enverrait toujours `false` ou `0`. Ces assertions portent donc sur
  // les valeurs, pas sur la forme — c'est ce qui distingue un harnais utile d'un
  // harnais qui rend toujours vert.
  await androidBridge.applyNativeDSP({
    ...baseState,
    bands: new Array(10).fill(0),
    balance: 0.75,
    mono: true,
    stereoExpansion: 40,
    crossfeed: 60,
    reverbEnabled: true,
    roomSize: 55,
    damping: 33,
    reverbMix: 70,
    toneEnabled: true,
    limitEnabled: true,
  });
  const v = lastPayload();
  check('balance transmise', v.balance === 0.75, `→ ${v.balance}`);
  check('mono transmis', v.mono === true, `→ ${v.mono}`);
  check('stereoExpansion transmise', v.stereoExpansion === 40, `→ ${v.stereoExpansion}`);
  check('crossfeed transmis', v.crossfeed === 60, `→ ${v.crossfeed}`);
  check('reverbEnabled transmis', v.reverbEnabled === true, `→ ${v.reverbEnabled}`);
  check('roomSize transmis', v.roomSize === 55, `→ ${v.roomSize}`);
  check('damping transmis', v.damping === 33, `→ ${v.damping}`);
  check('limitEnabled:true transmis comme vrai', v.limitEnabled === true, `→ ${v.limitEnabled}`);
  check('preamp nul sans gain', v.preamp === 0, `→ ${v.preamp}`);
  // La loi de dosage est `wet = mix * REVERB_WET_CAP` et `dry = 1 - mix` : la
  // somme NE vaut pas 1, et c'est voulu — le plafond de réverbération garde de
  // la place pour le signal sec. `verify:sync` compare cette loi entre les deux
  // plateformes ; ici on vérifie seulement que le pont applique la même formule.
  const mix = 0.7;
  const expectedDry = 1 - mix;
  check('dry = 1 - mix', Math.abs(v.reverbDry - expectedDry) < 1e-6,
    `→ ${v.reverbDry.toFixed(3)} (attendu ${expectedDry})`);
  check('wet plafonné par REVERB_WET_CAP, pas proportionnel',
    v.reverbWet > 0 && v.reverbWet < mix, `→ wet=${v.reverbWet.toFixed(3)} < mix=${mix}`);
  check('wet + dry < 1 (place laissée au signal sec)',
    v.reverbWet + v.reverbDry < 1, `→ ${(v.reverbWet + v.reverbDry).toFixed(3)}`);

  console.log('\n8. Robustesse');
  await androidBridge.applyNativeDSP({ ...baseState, bands: [6, 6] });
  check('bandes courtes complétées à 10', lastPayload().bands.length === 10);
  await androidBridge.applyNativeDSP({ ...baseState, bands: [99, -99, 3, 0, 0, 0, 0, 0, 0, 0] });
  check('gains bornés à ±12',
    lastPayload().bands[0] === 12 && lastPayload().bands[1] === -12,
    `→ [${lastPayload().bands.join(',')}]`);

  // Une panne du natif doit être tracée, pas silencieuse.
  const previous = stub.setDSPAsync;
  stub.setDSPAsync = () => Promise.reject(new Error('boom natif'));
  await androidBridge.applyNativeDSP({ ...baseState });
  const afterFail = androidBridge.getNativeDSPDiagnostics();
  check('un rejet est enregistré dans la trace', afterFail.lastError === 'boom natif',
    `(lastError: ${afterFail.lastError})`);
  check('l\'échec ne casse pas l\'appelant', true);
  stub.setDSPAsync = previous;

  console.log(failures === 0
    ? '\nLE PONT JS -> NATIF EST CONFORME'
    : `\n${failures} VERIFICATION(S) EN ECHEC`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\nLe harnais a threw :', err);
  process.exit(1);
});