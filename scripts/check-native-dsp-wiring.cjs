/**
 * Vérifie que la chaîne DSP native est câblée et conforme aux contraintes
 * de compilation AVFoundation / Swift 6 (iOS) et Media3 PCM (Android).
 *
 * Lancer : node scripts/check-native-dsp-wiring.cjs
 */
const { readFileSync } = require('fs');

const swiftEngine = readFileSync('modules/expo-audio-dsp/ios/AudioDSPEngine.swift', 'utf8');
const swiftRenderUnit = readFileSync('modules/expo-audio-dsp/ios/AudioDSPRenderUnit.swift', 'utf8');
const kotlin = readFileSync(
  'modules/expo-audio-dsp/android/src/main/java/expo/modules/audiodsp/AudioDSPModule.kt',
  'utf8'
);
const androidProcessor = readFileSync(
  'modules/expo-audio-dsp/android/src/main/java/expo/modules/audiodsp/AudioDSPProcessor.kt',
  'utf8'
);
const expoAudioPatch = readFileSync('scripts/patch-expo-audio-android.cjs', 'utf8');
const androidBuild = readFileSync('modules/expo-audio-dsp/android/build.gradle', 'utf8');
const androidKeepRules = readFileSync('modules/expo-audio-dsp/android/consumer-rules.pro', 'utf8');

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
check('AudioDSPRenderUnit attachée au moteur', /engine\.attach\(unit\)/.test(swiftEngine));
check('le graphe iOS traverse AudioDSPRenderUnit', /engine\.connect\(currentNode, to: dspRenderUnit/.test(swiftEngine));
check('AudioDSPRenderUnit applique spatial, réverbération et limiteur',
  /spatial\.process/.test(swiftRenderUnit) &&
  /reverb\.process/.test(swiftRenderUnit) &&
  /limiter\.processChannels/.test(swiftRenderUnit)
);

console.log('2. iOS : le graphe audio est-il raccordé dans le bon ordre ?');
check('playerNode -> eqUnit', /engine\.connect\(playerNode, to: eqUnit/.test(swiftEngine));
check('eqUnit -> timePitchUnit -> preampNode', /engine\.connect\(eqUnit, to: timePitchUnit/.test(swiftEngine) && /engine\.connect\(timePitchUnit, to: preampNode/.test(swiftEngine));
check('AudioDSPRenderUnit -> balanceNode', /engine\.connect\(currentNode, to: balanceNode/.test(swiftEngine));
check('currentNode -> mainMixerNode', /engine\.connect\(currentNode, to: engine\.mainMixerNode/.test(swiftEngine));
check('gestion du downmix mono (channels: 1)', /channels:\s*1\b/.test(swiftEngine));

console.log('3. iOS : les états DSP sont-ils configurés sans code mort ?');
check('largeur stéréo : DSP state configuré', /dspRenderState\.spatial\.setParameters\(/.test(swiftEngine));
check('réverbération : DSP state configuré', /dspRenderState\.reverb\.setParameters\(/.test(swiftEngine));
check('limiteur : DSP state configuré', /dspRenderState\.limiter\.setEnabled\(/.test(swiftEngine));
check('tempo iOS : AVAudioUnitTimePitch est attachée et dans le graphe', /engine\.attach\(timePitchUnit\)/.test(swiftEngine) && /engine\.connect\(eqUnit, to: timePitchUnit/.test(swiftEngine) && /engine\.connect\(timePitchUnit, to: preampNode/.test(swiftEngine));
check('tempo iOS : vitesse réglable sans changer la hauteur', /timePitchUnit\.rate = max\(0\.5, min\(2\.0, value\)\)/.test(swiftEngine));

console.log('4. iOS : conformité AVFoundation & Swift 6');
// auAudioUnit.renderBlock est get-only dans le SDK Apple et provoque une erreur de build Xcode si affecté
check('aucune affectation invalide sur renderBlock (get-only)', !/\.renderBlock\s*=/.test(swiftEngine));
// kAudioUnitSubType_Generic n'existe pas dans le scope CoreAudio
check('aucun symbole inexistant kAudioUnitSubType_Generic', !/kAudioUnitSubType_Generic/.test(swiftEngine));

console.log('5. Android : le processeur PCM est-il raccordé au sink Media3 ?');
check('AudioDSPProcessor implémente BaseAudioProcessor', /class AudioDSPProcessor : BaseAudioProcessor\(\)/.test(androidProcessor));
check('PCM 16 bits et float acceptés', /ENCODING_PCM_16BIT/.test(androidProcessor) && /ENCODING_PCM_FLOAT/.test(androidProcessor));
check('10 filtres EQ canoniques compilés', /doubleArrayOf\(250\.0, 125\.0, 250\.0, 500\.0, 1_000\.0, 2_000\.0, 4_000\.0, 6_000\.0, 8_000\.0, 8_000\.0\)/.test(androidProcessor));
check('égaliseur paramétrique appliqué au PCM', /for \(band in settings\.filters\.indices\)/.test(androidProcessor));
check('mono, largeur et crossfeed appliqués', /settings\.mono/.test(androidProcessor) && /MAX_WIDTH_EXPONENT/.test(androidProcessor) && /MAX_CROSSFEED/.test(androidProcessor));
check('room, damping et wet/dry appliqués au PCM', /settings\.reverbEnabled/.test(androidProcessor) && /settings\.reverbWet/.test(androidProcessor) && /settings\.reverbDry/.test(androidProcessor));
check('balance et limiteur appliqués en sortie', /settings\.balance/.test(androidProcessor) && /settings\.limitEnabled/.test(androidProcessor));
check('le pont Kotlin pousse tout l’état au processeur', /AudioDSPProcessorState\.update\(/.test(kotlin) && /reverbWet = pendingReverbWet/.test(kotlin) && /reverbDry = pendingReverbDry/.test(kotlin));
check('le patch Expo injecte le processeur via DefaultAudioSink', /MASAudioRenderersFactory/.test(expoAudioPatch) && /setAudioProcessors\(arrayOf\(processor\)\)/.test(expoAudioPatch));
check('ExoPlayer reçoit MASAudioRenderersFactory', /ExoPlayer\.Builder\(context, MASAudioRenderersFactory\(context\)\)/.test(expoAudioPatch));
check('Media3 common est déclaré pour le module', /media3-common:1\.9\.0/.test(androidBuild));
check('R8 conserve la classe instanciée par réflexion', /-keep class expo\.modules\.audiodsp\.AudioDSPProcessor/.test(androidKeepRules));
check('le tempo reste appliqué par Expo Audio', /p\.setPlaybackRate\(this\.currentPlaybackRate\)/.test(
  readFileSync('src/services/playerManager.ts', 'utf8')
));

console.log();
if (failures === 0) {
  console.log('LA CHAINE DSP NATIVE EST CABLEE');
} else {
  console.log(`${failures} VERIFICATION(S) EN ECHEC`);
  process.exit(1);
}
