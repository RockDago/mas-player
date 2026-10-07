/**
 * Vérifie que la chaîne de réverbération est complète, de l'interface au moteur.
 *
 * ## Pourquoi un harnais alors que `tsc` passe
 *
 * Parce que le bug qu'on corrige ici était invisible au compilateur. Les trois
 * contrôles de l'onglet FX étaient un `useState` local : `tsc` y voyait un
 * composant parfaitement valide, et l'utilisateur pouvait manœuvrer trois knobs
 * sans produire le moindre son. La faute était dans le *câblage*, pas dans les
 * types.
 *
 * Ce fichier attrape cette catégorie de faute — un champ absent du tableau de
 * dépendances React, un knob qui écrit dans le vide, une valeur qui n'atteint
 * pas le moteur — là où aucun autre contrôle ne la verrait.
 *
 * Il ne remplace ni `verify:sync` (qui compare les constantes des deux
 * plateformes) ni `verify:dsp` (qui mesure la chaîne). Il vérifie ce qu'il y a
 * entre les deux : que tout est branché.
 *
 * Lancer : node scripts/verify-reverb.cjs
 */
const { readFileSync } = require('fs');

const rd = (p) => readFileSync(p, 'utf8');
let ok = true;
const check = (label, actual, expected) => {
  const good = String(actual) === String(expected);
  ok &&= good;
  console.log(`   ${good ? 'OK  ' : 'FAIL'} ${label.padEnd(44)} ${actual}`);
  if (!good) console.log(`        attendu : ${expected}`);
};

const types = rd('src/types/audio.ts');
const presets = rd('src/constants/presets.ts');
const storage = rd('src/services/storageService.ts');
const app = rd('App.tsx');
const eqView = rd('src/components/EqualizerView.tsx');
const web = rd('src/services/webAudioEngine.ts');
const bridge = rd('src/services/nativeAudioDSP.ts');
const swiftModule = rd('modules/expo-audio-dsp/ios/AudioDSPModule.swift');
const reverbSwift = rd('modules/expo-audio-dsp/ios/AudioDSPReverb.swift');

console.log('1. Les quatre champs vivent dans DSPState');
for (const f of ['reverbEnabled', 'roomSize', 'damping', 'reverbMix']) {
  check(`DSPState.${f}`, new RegExp(`\\b${f}\\s*:`).test(types), 'true');
}

console.log('\n2. Ils sont persistés et relus');
check('DEFAULT_DSP les definit', /reverbEnabled:\s*false/.test(storage), 'true');
check('normalizeDSP relit roomSize', (storage.match(/roomSize:\s*num\(/g) || []).length, 1);
check('normalizeDSP relit damping', (storage.match(/damping:\s*num\(/g) || []).length, 1);
check('normalizeDSP relit reverbMix', (storage.match(/reverbMix:\s*num\(/g) || []).length, 1);
check('normalizeDSP relit reverbEnabled', (storage.match(/reverbEnabled:\s*\n?\s*typeof/g) || []).length, 1);

console.log('\n3. Les etats locaux ont disparu');
check('plus de setReverbEnabled', /setReverbEnabled/.test(eqView), 'false');
check('plus de setReverbRoom', /setReverbRoom/.test(eqView), 'false');
check('plus de setReverbDamp', /setReverbDamp/.test(eqView), 'false');
check('aucun useState reverb restant', /useState[^\n]*reverb/i.test(eqView), 'false');

console.log('\n4. L effet React depend des quatre champs');
/**
 * Le point le plus facile à louper, et le plus grave : sans ces quatre lignes
 * dans le tableau de dépendances, `setDSP` n'est jamais rejoué au changement de
 * knob. L'état serait correct, persisté, affiché — et Totally inaudible. C'est
 * exactement le symptôme du bug d'origine, qui aurait survécu au reste du
 * travail.
 */
const depsBlock = app.match(/playerManager\.setDSP\(dsp\);\s*\}, \[([\s\S]*?)\]\);/);
check('tableau de dependances trouve', !!depsBlock, 'true');
if (depsBlock) {
  for (const f of ['reverbEnabled', 'roomSize', 'damping', 'reverbMix']) {
    check(`dependance dsp.${f}`, new RegExp(`dsp\\.${f}\\b`).test(depsBlock[1]), 'true');
  }
}

console.log('\n5. Les trois knobs sont ecrits dans DSPState');
check('handleToggleReverb existe', /handleToggleReverb\s*=/.test(eqView), 'true');
check(
  'il ecrit dans DSPState',
  /onUpdateDSP\(\{ \.\.\.dsp, reverbEnabled: !dsp\.reverbEnabled \}\)/.test(eqView),
  'true'
);
check('handleSetReverb existe', /handleSetReverb\s*=/.test(eqView), 'true');
check('il borne a 0-100', /Math\.max\(0, Math\.min\(100, value\)\)/.test(eqView), 'true');
check('le knob Room Size est cable', /value=\{dsp\.roomSize\}/.test(eqView), 'true');
check('le knob Damping est cable', /value=\{dsp\.damping\}/.test(eqView), 'true');
check('le knob Reverb Mix est cable', /value=\{dsp\.reverbMix\}/.test(eqView), 'true');

console.log('\n6. Les deux moteurs recoivent les trois knobs');
check('web : applyReverb est appele', /this\.applyReverb\(\s*\n?\s*!!dsp\.reverbEnabled/.test(web), 'true');
check('web : lit roomSize', /dsp\.roomSize \?\? 0/.test(web), 'true');
check('web : lit damping', /dsp\.damping \?\? 0/.test(web), 'true');
check('web : lit reverbMix', /dsp\.reverbMix \?\? 0/.test(web), 'true');
check('pont : transmet reverbEnabled', /dsp\.reverbEnabled \?\? false/.test(bridge), 'true');
check('pont : transmet roomSize', /dsp\.roomSize \?\? 0/.test(bridge), 'true');
check('pont : transmet damping', /dsp\.damping \?\? 0/.test(bridge), 'true');
check('pont : transmet reverbMix', /dsp\.reverbMix \?\? 0/.test(bridge), 'true');
check('pont : transmet wet et dry', /reverbGains\.wet,[\s\S]*?reverbGains\.dry/.test(bridge), 'true');

console.log('\n7. Le module natif accepte les six parametres');
for (const p of ['reverbEnabled', 'roomSize', 'damping', 'reverbMix', 'reverbWet', 'reverbDry']) {
  check(`setDSPAsync recoit ${p}`, new RegExp(`\\b${p}\\s*:`).test(swiftModule), 'true');
}
/**
 * Les six ont une valeur par défaut. Ce n'est pas un détail : c'est ce qui permet
 * à un appelant plus ancien de continuer à compiler et à obtenir le neutre
 * plutôt qu'une réverbération activée par surprise.
 */
const reverbParams = swiftModule.match(
  /reverbEnabled: Bool = false[\s\S]*?reverbDry: Float = 1/
);
check('les six ont une valeur par defaut', !!reverbParams, 'true');

console.log('\n8. Les fonctions partagees sont exportees et importees');
for (const fn of ['computeReverbGains', 'computeReverbDampingHz', 'computeReverbDelayScale', 'computeReverbLoopGains', 'reverbDecayMs']) {
  check(`${fn} exportee`, new RegExp(`export function ${fn}`).test(presets), 'true');
}
check('web importe les fonctions', (web.match(/computeReverb\w+/g) || []).length >= 4, 'true');
check('EqualizerView importe reverbDecayMs', /import[\s\S]*?reverbDecayMs/.test(eqView), 'true');

console.log('\n9. L etat Swift n est pas remplace apres capture');
/**
 * Le bloc de rendu capture `reverbState` à l'installation. Si le moteur
 * reconstruisait cet objet au `load()` — pour tenir compte de la fréquence
 * d'échantillonnage du fichier — le rendu porterait encore sur l'ancien état,
 * pendant que le nouveau attendait. Le symptôme serait une réverbération
 * unresponsive au premier morceau, puis correcte sur le suivant.
 *
 * D'où la règle : l'objet est construit une fois, et la fréquence
 * d'échantillonnage réelle est passée à `setParameters`.
 */
const engineSwift = rd('modules/expo-audio-dsp/ios/AudioDSPEngine.swift');
const renderUnitSwift = rd('modules/expo-audio-dsp/ios/AudioDSPRenderUnit.swift');
check('reverbState est un let, pas un var', /let reverb = ReverbState\(\)/.test(renderUnitSwift), 'true');
check('la frequence passe par setParameters', /setParameters\(sampleRate:/.test(reverbSwift), 'true');
// On cherche une AFFECTATION, pas la declaration : `let reverb = ReverbState()`
// est la seule construction legitime et ne doit pas etre comptee comme un
// reassignement. Une reconstruction se lirait `reverb = ReverbState(`.
const reassignments = (renderUnitSwift.match(/[^t]\sreverb = ReverbState\(/g) || []).length;
check('aucune reconstruction apres capture', reassignments, 0);
check('construite une seule fois', (renderUnitSwift.match(/ReverbState\(/g) || []).length, 1);

console.log('\n10. Les pastilles TONE et LIMIT ne sont pas des decoratifs');

/**
 * Même maladie que la réverbération, dans le même onglet : deux `useState` que
 * rien ne lisait. `limitEnabled` était même initialisé à `false` alors que le
 * limiteur tournait en permanence — la pastille affichait « off » pendant que le
 * limiteur était actif, ce qui est pire qu'un contrôle mort : c'est un contrôle
 * qui ment.
 */
check('toneEnabled vit dans DSPState', /toneEnabled: boolean/.test(types), 'true');
check('limitEnabled vit dans DSPState', /limitEnabled: boolean/.test(types), 'true');

check('TONE : plus de setToneEnabled', !/setToneEnabled/.test(eqView), 'true');
check('LIMIT : plus de setLimitEnabled', !/setLimitEnabled/.test(eqView), 'true');
check('TONE ecrit dans DSPState', /onUpdateDSP\(\{ \.\.\.dsp, toneEnabled: !dsp\.toneEnabled \}\)/.test(eqView), 'true');
check('LIMIT ecrit dans DSPState', /onUpdateDSP\(\{ \.\.\.dsp, limitEnabled: !dsp\.limitEnabled \}\)/.test(eqView), 'true');

// Le rendu de la pastille doit lire DSPState, pas une variable detruite : c'est
// le detail qui ferait afficher « on » en permanence si seul le handler changeait.
check('la pastille TONE lit dsp.toneEnabled', /dsp\.toneEnabled && styles\.leftPillBtnActive/.test(eqView), 'true');
check('la pastille LIMIT lit dsp.limitEnabled', /dsp\.limitEnabled && styles\.leftPillBtnActive/.test(eqView), 'true');

// Le defaut du limiteur doit valoir « actif » : le retourner dans normalizeDSP
// reviendrait a desactiver retroactivement le limiteur d'une session ancienne.
check('defaut : limitEnabled actif', /limitEnabled: true/.test(storage), 'true');
check('relecture : le repli vaut actif', /limitEnabled:\s*\n?\s*typeof input\.limitEnabled === 'boolean' \? input\.limitEnabled : DEFAULT_DSP\.limitEnabled/.test(storage), 'true');

// Les deux doivent etre dans le tableau de dependances React, sans quoi l'etat
// change sans atteindre les moteurs — exactement le symptome d'origine.
check('effet React : toneEnabled', /dsp\.toneEnabled,/.test(depsBlock), 'true');
check('effet React : limitEnabled', /dsp\.limitEnabled,/.test(depsBlock), 'true');

// cote moteur
check('web : TONE pondere les bandes', /const tone = dsp\.toneEnabled === false \? 0 : 1/.test(web), 'true');
check('pont : TONE pondere les bandes', /const tone = dsp\.toneEnabled === false \? 0 : 1/.test(bridge), 'true');
check('web : LIMIT releve le plafond', /dsp\.limitEnabled/.test(web), 'true');
check('pont : LIMIT est transmis', /dsp\.limitEnabled \?\? true/.test(bridge), 'true');
check('natif : setEnabled est appele', /dspRenderState\.limiter\.setEnabled\(limitEnabled\)/.test(engineSwift), 'true');
check('natif : setEnabled existe', /func setEnabled\(_ enabled: Bool\)/.test(rd('modules/expo-audio-dsp/ios/AudioDSPLimiter.swift')), 'true');

// Le seuil de contournement doit etre le MEME des deux cotes : sinon la meme
// pastille donnerait deux plafonds differents. `verify:sync` compare les
// valeurs ; ici on verifie qu'elles existent et sont nommees.
check('web : seuil de contournement nomme', /LIMIT_THRESHOLD_DB : 0/.test(web), 'true');
check('natif : seuil de contournement nomme', /bypassThresholdDb: Float = 0\.0/.test(rd('modules/expo-audio-dsp/ios/AudioDSPLimiter.swift')), 'true');

console.log('\n' + (ok ? 'LA CHAINE DE REVERBERATION EST COMPLETE' : 'CHAQUE TRONQUE'));
process.exit(ok ? 0 : 1);
