/**
 * Vérifie que la chaîne DSP native est *câblée*, pas seulement écrite.
 *
 * ## Pourquoi ce harnais existe
 *
 * `sync-check.cjs` compare des constantes entre le web et le Swift. Il a
 * announced « LES DEUX MOTEURS SONT ALIGNÉS » le jour où le commit `eef2172`
 * avait pourtant débranché trois étages du graphe iOS : le limiteur, la largeur
 * stéréo et la réverbération. Les constantes étaient bien présentes — et même
 * appliquées à des états qui n'étaient plus consommés par personne.
 *
 * Un test qui vérifie que du texte existe ne peut pas détecter qu'un étage a été
 * retiré du graphe. Celui-ci vérifie le **câblage** : qu'un étage annoncé comme
 * disponible est bien instancié, attaché, et raccordé dans `connectGraph`.
 *
 * L'autre moitié — la répartition des bandes sur Android — est vérifiée par
 * `check-band-mapping.cjs`, qui exécute l'algorithme plutôt que de le relire.
 *
 * Lancer : node scripts/check-native-dsp-wiring.cjs
 */
const { readFileSync } = require('fs');

const swiftEngine = readFileSync('modules/expo-audio-dsp/ios/AudioDSPEngine.swift', 'utf8');
const kotlin = readFileSync(
  'modules/expo-audio-dsp/android/src/main/java/expo/modules/audiodsp/AudioDSPModule.kt',
  'utf8'
);

let failures = 0;
function check(label, condition) {
  if (condition) {
    console.log(`  OK   ${label}`);
  } else {
    console.log(`  ECHEC ${label}`);
    failures++;
  }
}

console.log('1. iOS : chaque étage DSP est-il INSTANCIÉ ?');
// Un étage ne peut être « disponible » que si l'unité d'effet a été créée.
// C'est exactement le mensonge de `eef2172` : les trois drapeaux à `false`
// déclaraient le graphe amputé tout en laissant les états alimentés.
for (const [flag, effect] of [
  ['limiterAvailable', 'limiterUnit = effect'],
  ['spatialAvailable', 'spatialUnit = effect'],
  ['reverbAvailable', 'reverbUnit = effect'],
]) {
  const assigns = new RegExp(`${flag} = true`).test(swiftEngine);
  const attaches = new RegExp(`install\\w+RenderBlock\\(\\)`).test(swiftEngine);
  check(`${flag} est mis à true par une instanciation réelle`, assigns && attaches);
}

console.log('2. iOS : les trois blocs de rendu sont-ils installés ?');
for (const fn of [
  'installLimiterRenderBlock',
  'installSpatialRenderBlock',
  'installReverbRenderBlock',
]) {
  // Présence de la fonction ET de son appel : une fonction orpheline ne fait rien.
  const defined = new RegExp(`private func ${fn}\\(\\)`).test(swiftEngine);
  const called = new RegExp(`${fn}\\(\\)`).test(swiftEngine);
  check(`${fn} existe et est appelée`, defined && called);
}

console.log('3. iOS : chaque unité d’effet est-elle ATTACHÉE au moteur ?');
const attachCount = (swiftEngine.match(/engine\.attach\(effect\)/g) || []).length;
check(`engine.attach(effect) présent pour les 3 unités (trouvé ${attachCount})`, attachCount === 3);

console.log('4. iOS : chaque étage est-il RACCORDÉ dans le graphe ?');
// Un étage instancié et attaché mais non connecté passe au travers : c'est le
// symptôme « aucun effet audible alors que tout semble configuré ».
for (const [flag, unit] of [
  ['spatialAvailable', 'spatial'],
  ['reverbAvailable', 'reverb'],
  ['limiterAvailable', 'limiter'],
]) {
  const wired = new RegExp(`${flag}, let ${unit} = ${unit}Unit`).test(swiftEngine);
  check(`${unit}Unit conditionné par ${flag} dans connectGraph`, wired);
}

console.log('5. iOS : la description d’Audio Unit est-elle présente ?');
check(
  'effectDescription déclarée (kAudioUnitSubType_Generic)',
  /kAudioUnitSubType_Generic/.test(swiftEngine)
);

console.log('6. Android : la table de bandes est-elle dans la bonne unité ?');
// `getCenterFreq()` rend des millihertz, la comparaison se fait en kHz.
// Une table en Hz ici produirait des écarts 1000× trop grands.
check(
  'la table canonique est déclarée EN KILOHERTZ (doubleArrayOf)',
  /canonicalFreqsKHz = doubleArrayOf\(/.test(kotlin)
);
check('aucune ancienne table en Hz ne subsiste', !/canonicalFreqs = intArrayOf/.test(kotlin));

console.log('7. Android : les centres natifs sont-ils convertis en kHz ?');
check(
  'getCenterFreq(...) est divisé par 1000',
  /getCenterFreq\(b\.toShort\(\)\)\.toDouble\(\) \/ 1000\.0/.test(kotlin)
);

console.log('8. Android : la répartition remplace-t-elle la plus-proche-voisin ?');
for (const fn of ['mapCanonicalBands']) {
  check(`${fn} existe`, new RegExp(`private fun ${fn}\\(`).test(kotlin));
}
check('la répartition est réellement appelée', /mapCanonicalBands\(nativeCentersKHz, pendingBands\)/.test(kotlin));
check(
  'le plus-proche-voisin réserve chaque bande canonique (évite le conflit 8 kHz)',
  /taken\[best\] = true/.test(kotlin)
);
check(
  'les bandes orphelines à gain nul ne diluent pas leurs voisines',
  /gainOf\(c\) == 0\.0\) continue/.test(kotlin)
);
check(
  'les deux 8 kHz co-localisées sont additionnées, pas moyennées',
  /coLocated/.test(kotlin)
);

console.log();
if (failures === 0) {
  console.log('LA CHAINE DSP NATIVE EST CABLEE');
} else {
  console.log(`${failures} VERIFICATION(S) EN ECHEC`);
  process.exit(1);
}
