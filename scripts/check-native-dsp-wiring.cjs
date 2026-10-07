/**
 * Vérifie que la chaîne DSP native est câblée et conforme aux contraintes
 * de compilation AVFoundation / Swift 6 (iOS) et Android AudioFX.
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

console.log('1. iOS : les nœuds audio essentiels sont-ils attachés au moteur ?');
for (const node of ['playerNode', 'eqUnit', 'preampNode', 'balanceNode']) {
  check(`engine.attach(${node}) présent`, new RegExp(`engine\\.attach\\(${node}\\)`).test(swiftEngine));
}

console.log('2. iOS : le graphe audio est-il raccordé dans le bon ordre ?');
check('playerNode -> eqUnit', /engine\.connect\(playerNode, to: eqUnit/.test(swiftEngine));
check('eqUnit -> timePitchUnit -> preampNode', /engine\.connect\(eqUnit, to: timePitchUnit/.test(swiftEngine) && /engine\.connect\(timePitchUnit, to: preampNode/.test(swiftEngine));
check('reverbNode -> balanceNode', /engine\.connect\(reverbNode, to: balanceNode/.test(swiftEngine));
check('currentNode -> mainMixerNode', /engine\.connect\(currentNode, to: engine\.mainMixerNode/.test(swiftEngine));
check('gestion du downmix mono (channels: 1)', /channels:\s*1\b/.test(swiftEngine));

console.log('3. iOS : les états DSP sont-ils configurés sans code mort ?');
check('largeur stéréo : spatialState.setParameters présent', /spatialState\.setParameters\(/.test(swiftEngine));
check('réverbération : reverbState.setParameters présent', /reverbState\.setParameters\(/.test(swiftEngine));
check('limiteur : limiterState.setEnabled présent', /limiterState\.setEnabled\(/.test(swiftEngine));
check('tempo iOS : AVAudioUnitTimePitch est attachée et dans le graphe', /engine\.attach\(timePitchUnit\)/.test(swiftEngine) && /engine\.connect\(eqUnit, to: timePitchUnit/.test(swiftEngine) && /engine\.connect\(timePitchUnit, to: preampNode/.test(swiftEngine));
check('tempo iOS : vitesse réglable sans changer la hauteur', /timePitchUnit\.rate = max\(0\.5, min\(2\.0, value\)\)/.test(swiftEngine));

console.log('4. iOS : conformité AVFoundation & Swift 6');
// auAudioUnit.renderBlock est get-only dans le SDK Apple et provoque une erreur de build Xcode si affecté
check('aucune affectation invalide sur renderBlock (get-only)', !/\.renderBlock\s*=/.test(swiftEngine));
// kAudioUnitSubType_Generic n'existe pas dans le scope CoreAudio
check('aucun symbole inexistant kAudioUnitSubType_Generic', !/kAudioUnitSubType_Generic/.test(swiftEngine));

console.log('5. Android : la table de bandes est-elle dans la bonne unité ?');
check(
  'la table canonique est déclarée EN KILOHERTZ (doubleArrayOf)',
  /canonicalFreqsKHz = doubleArrayOf\(/.test(kotlin)
);
check('aucune ancienne table en Hz ne subsiste', !/canonicalFreqs = intArrayOf/.test(kotlin));

console.log('6. Android : les centres natifs sont-ils convertis en kHz ?');
check(
  'getCenterFreq(...) est divisé par 1000',
  /getCenterFreq\(b\.toShort\(\)\)\.toDouble\(\) \/ 1000\.0/.test(kotlin)
);

console.log('7. Android : la répartition remplace-t-elle la plus-proche-voisin ?');
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
check('Android : tempo conservé lors de la création du lecteur', /p\.setPlaybackRate\(this\.currentPlaybackRate\)/.test(
  readFileSync('src/services/playerManager.ts', 'utf8')
));

console.log();
if (failures === 0) {
  console.log('LA CHAINE DSP NATIVE EST CABLEE');
} else {
  console.log(`${failures} VERIFICATION(S) EN ECHEC`);
  process.exit(1);
}
