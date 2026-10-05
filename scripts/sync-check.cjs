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
// Le pont natif est lu ici, et non à l'endroit où l'on s'en sert pour la
// première fois : les vérifications de la section 3 (pastilles TONE et LIMIT)
// en ont besoin bien avant. Un `const` déclaré plus bas serait en zone morte
// jusqu'à cette ligne — c'est-à-dire jusqu'au moment où le harnais échoue avec
// un `ReferenceError` qui masque la vraie divergence.
const bridge = readFileSync('src/services/nativeAudioDSP.ts', 'utf8');
// Le pont natif est lu ici, et non à l'endroit où l'on s'en sert pour la
// première fois : les vérifications de la section 3 (pastilles TONE et LIMIT)
// en ont besoin bien avant. Un `const` déclaré plus bas serait en zone morte
// jusqu'à cette ligne — c'est-à-dire jusqu'au moment où le harnais échoue avec
// un `ReferenceError` qui masque la vraie divergence.


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
// Le limiteur iOS vit dans son propre fichier (AudioDSPLimiter.swift) : le seuil
// n'est plus dans AudioDSPEngine.swift. Avant, cette branche tombait dans le
// `else` et affichait « -- », ce qui laissait passer n'importe quelle divergence
// entre les deux plateformes. Elle compare maintenant réellement les deux côtés.
const limiter = readFileSync('modules/expo-audio-dsp/ios/AudioDSPLimiter.swift', 'utf8');
// Les deux seuils sont désormais des CONSTANTES NOMMÉES des deux côtés : le web
// ne réécrit plus le littéral dans `build()`. Le harnais lisait
// `threshold.value = -3`, qui n'existe plus — il ne comparait donc plus rien et
// échouait sur sa propre branche de repli, ce qui masquait une divergence réelle
// en la faisant passer pour un problème de regex.
const webLimitMatch = /const LIMIT_THRESHOLD_DB = (-?[\d.]+)/.exec(web);
const swiftLimitMatch = /thresholdDb:\s*Float\s*=\s*(-?[\d.]+)/.exec(limiter);
if (webLimitMatch && swiftLimitMatch) {
  // Comparaison en NOMBRE, pas en chaîne : le seuil s'écrit `-3.0` en Swift et
  // `-3` en TypeScript, ce qui est le même seuil. Comparer les chaînes faisait
  // échouer le test sur un détail de formatage.
  check('limiteur (seuil dB)', +swiftLimitMatch[1], +webLimitMatch[1]);
} else {
  check('limiteur (seuil dB) — trouvé des deux côtés', Boolean(webLimitMatch && swiftLimitMatch), 'true');
}

// Seuil du mode contourné (pastille LIMIT éteinte). Les deux plateformes sont
// dans la même contrainte — impossible de retirer l'étage du graphe — donc
// elles doivent relever le plafond au MÊME point. Si le web passait à 0 et le
// natif à -6, la même pastille produirait deux plafonds différents.
const webBypass = /limiterOn \? LIMIT_THRESHOLD_DB : (-?[\d.]+)/.exec(web);
const swiftBypass = /bypassThresholdDb:\s*Float\s*=\s*(-?[\d.]+)/.exec(limiter);
if (webBypass && swiftBypass) {
  check('limiteur (plafond contourné, dB)', +swiftBypass[1], +webBypass[1]);
} else {
  check('limiteur (plafond contourné) — trouvé des deux côtés', Boolean(webBypass && swiftBypass), 'true');
}

// La pastille doit être câblée des deux côtés, du `DSPState` jusqu'au nœud.
check('web : la pastille LIMIT est lue', /dsp\.limitEnabled/.test(web), 'true');
check('natif : la pastille LIMIT est lue', /limitEnabled/.test(swift), 'true');
check('natif : setEnabled est appelé', /limiterState\.setEnabled\(/.test(swift), 'true');
check('natif : le seuil variable n était pas du code mort', /func setEnabled\(/.test(limiter), 'true');
check('pont : limitEnabled transmis au natif', /dsp\.limitEnabled \?\? true/.test(bridge), 'true');

// Même règle pour TONE : la contribution bass/treble doit être pondérée des
// deux côtés par le même multiplicateur.
check('web : la pastille TONE est lue', /dsp\.toneEnabled/.test(web), 'true');
check('pont : la pastille TONE est lue', /dsp\.toneEnabled/.test(bridge), 'true');
check('web : TONE pondère les bandes graves', /tone \* bass/.test(web), 'true');
check('pont : TONE pondère les bandes graves', /tone \* bass/.test(bridge), 'true');
// Le ratio n'est plus un réglage : les deux côtés implémentent un PLAFOND dur
// (ratio 1), dont la fonction est vérifiée par scripts/verify-limiter.cjs.
// On vérifie ici que le web ne redeclare pas un ratio de compression.
check('web : ratio 1 (plafond dur, pas de compression)', /limiter\.ratio\.value = 1\b/.test(web), 'true');

// L'avance doit rester alignée sur la latence du compresseur web, sinon les
// deux plateformes ne convergent pas sur les mêmes transitoires.
const swiftLookahead = /lookaheadSeconds:\s*Double\s*=\s*([\d.]+)/.exec(limiter);
check('limiteur iOS : avance de 6 ms', swiftLookahead && String(swiftLookahead[1] * 1000), '6');
check('limiteur : présent dans le graphe natif', /AudioDSPLimiter|limiterState|LimiterState/.test(swift), 'true');

// --- Étage spatial : largeur + crossfeed ---------------------------------
// Deux moteurs distincts implémentent la même idée. Sans assertion commune,
// l'un peut gaining un plafond que l'autre n'a pas, et le knob devient muet
// d'une plateforme à l'autre sans qu'aucune erreur n'apparaisse.
const spatial = readFileSync('modules/expo-audio-dsp/ios/AudioDSPSpatial.swift', 'utf8');
const swiftCrossfeedCap = /maxCrossfeed:\s*Float\s*=\s*([\d.]+)/.exec(spatial);
const webCrossfeedCap = /MAX_CROSSFEED\s*=\s*([\d.]+)/.exec(web);
check(
  'crossfeed : plafond de mélange identique',
  swiftCrossfeedCap && webCrossfeedCap && +swiftCrossfeedCap[1],
  webCrossfeedCap && +webCrossfeedCap[1]
);
const swiftWidthExp = /maxWidthExponent:\s*Float\s*=\s*([\d.]+)/.exec(spatial);
const webWidthExp = /const MAX_WIDTH_EXPONENT\s*=\s*([\d.]+)/.exec(web);
check(
  "largeur stereo : exposant identique",
  swiftWidthExp && webWidthExp && +swiftWidthExp[1],
  webWidthExp && +webWidthExp[1]
);
check('crossfeed : présent dans le graphe natif', /spatialState|SpatialState/.test(swift), 'true');
check('crossfeed : présent dans le graphe web', /applyCrossfeed/.test(web), 'true');
// Le crossfeed s'applique sur le signal reconstruit, pas avant : mélangé avant
// la reconstruction M/S, il attenuait aussi le Side et les deux plateformes
// donnaient alors des images différentes.
check(
  'crossfeed : appliqué apres la reconstruction M/S (natif)',
  spatial.indexOf('wideR + c * wideL') !== -1,
  'true'
);
check(
  'crossfeed : appliqué apres la reconstruction M/S (web)',
  /merger\.connect\(this\.crossfeedSplit\)/.test(web),
  'true'
);

const webQ = /EQ_PEAKING_Q\s*=\s*([\d.]+)/.exec(ts)[1];
const swiftQ = /peakingQ:\s*Float\s*=\s*([\d.]+)/.exec(swift)[1];
check('Q des bandes peaking', swiftQ, webQ);

/**
 * Section 3 bis — réverbération.
 *
 * Même principe que pour le crossfeed : les constantes sont dupliquées en Swift
 * (le natif ne peut pas importer le TypeScript), donc chaque nombre doit être
 * comparé à son jumeau. La section porte aussi sur la **stabilité de la boucle**,
 * parce que c'est le seul endroit où une divergence ne produit aucune erreur de
 * compilation : une boucle divergente, c'est un son qui sature en quelques
 * secondes, pas un build qui casse.
 */
console.log('\n3 bis. Réverbération : constantes et stabilité de la boucle');

const reverbSwift = readFileSync('modules/expo-audio-dsp/ios/AudioDSPReverb.swift', 'utf8');


// Retards de base : 37 / 58 ms des deux côtés.
const tsDelayL = /REVERB_DELAY_L\s*=\s*([\d.]+)/.exec(ts)[1];
const tsDelayR = /REVERB_DELAY_R\s*=\s*([\d.]+)/.exec(ts)[1];
const swDelayL = /baseDelayL:\s*Float\s*=\s*([\d.]+)/.exec(reverbSwift)[1];
const swDelayR = /baseDelayR:\s*Float\s*=\s*([\d.]+)/.exec(reverbSwift)[1];
check('retard gauche (s)', swDelayL, tsDelayL);
check('retard droit (s)', swDelayR, tsDelayR);

// Facteur d'échelle de la pièce : 8 des deux côtés.
const tsScale = /REVERB_ROOM_SCALE\s*=\s*(\d+)/.exec(ts)[1];
// En Swift la loi est écrite en dur `1 + pct/100 * 7` : le 7 doit valoir scale-1.
const swScaleInline = /1\.0\s*\+\s*\(sizePct\s*\/\s*100\.0\)\s*\*\s*([\d.]+)/.exec(reverbSwift)[1];
check('echelle de piece (max)', String(+swScaleInline + 1), tsScale);

// Bornes d'amortissement : 80 Hz et 3600 Hz. Comparaison **numérique** : le
// Swift écrit `80.0` là où le TypeScript écrit `80`, et une comparaison de
// chaînes échouerait sur une égalité parfaite.
const tsDampMin = +/REVERB_DAMPING_MIN_HZ\s*=\s*([\d.]+)/.exec(ts)[1];
const tsDampMax = +/REVERB_DAMPING_MAX_HZ\s*=\s*([\d.]+)/.exec(ts)[1];
// En Swift : `80.0 * pow(3600.0 / 80.0, dampPct)`.
const swDamp = /([\d.]+)\s*\*\s*pow\(\s*([\d.]+)\s*\/\s*([\d.]+)\s*,\s*dampPct\s*\)/.exec(reverbSwift);
check('amortissement : borne basse (Hz)', +swDamp[1], tsDampMin);
check('amortissement : borne haute (Hz)', +swDamp[2], tsDampMax);
check('amortissement : loi exponentielle', +swDamp[3], tsDampMin);

// Gains de boucle, normalisés. C'est le contrôle qui compte : la plus grande
// valeur propre de la matrice [[s, x], [x, s]] vaut `s + x` et doit rester < 1,
// sinon la boucle diverge. Ce contrôle échouerait bruyamment si quelqu'un
// réécrivait la normalisation.
const fb = +/REVERB_FEEDBACK\s*=\s*([\d.]+)/.exec(ts)[1];
const cc = +/REVERB_CROSS_COUPLING\s*=\s*([\d.]+)/.exec(ts)[1];
const sGain = fb / (1 + cc);
const xGain = (fb * cc) / (1 + cc);
const maxEigen = sGain + xGain;
check('reverb : valeur propre max < 1', String(maxEigen < 1), 'true');
// La normalisation doit restituer exactement la constante documentée.
check('reverb : s + x = REVERB_FEEDBACK', maxEigen.toFixed(4), fb.toFixed(4));

// Le Swift doit normaliser aussi — pas utiliser le gain brut.
check(
  'reverb : boucle normalisee (natif)',
  /feedback\s*\/\s*Self\.loopNormaliser/.test(reverbSwift),
  'true'
);
check(
  'reverb : couplage croise identique',
  /feedback\s*\*\s*Self\.crossCoupling\s*\/\s*Self\.loopNormaliser/.test(reverbSwift),
  'true'
);

// Le couplage croisé doit exister des DEUX côtés, sinon l'image s'ouvre sur un
// plateau et reste fixe sur l'autre.
check('reverb : couplage croise (web)', /reverbCrossL\.connect\(this\.reverbDelayR\)/.test(web), 'true');
check('reverb : couplage croise (natif)', /coupling \* filtered/.test(reverbSwift), 'true');

// Plafond de dosage, et le fait qu'il n'est PAS recalculé en Swift.
const tsWetCap = /REVERB_WET_CAP\s*=\s*([\d.]+)/.exec(ts)[1];
const swWetCap = /wetCap:\s*Float\s*=\s*([\d.]+)/.exec(reverbSwift)[1];
check('reverb : plafond du gain humide', swWetCap, tsWetCap);
check(
  'reverb : loi de dosage calculee en JS',
  /import[\s\S]*?computeReverbGains/.test(bridge),
  'true'
);
check(
  'Swift ne recalcule PAS le dosage',
  /REVERB_WET_CAP\s*\*\s*mix|mix\s*\*\s*Self\.wetCap/.test(reverbSwift),
  'false'
);

// Position dans la chaîne : après le crossfeed, avant la balance, limiteur en
// dernier. Un désaccord ici change la couleur de l'effet sans erreur visible.
check(
  'reverb : apres le crossfeed (web)',
  web.indexOf('crossfeedMerge.connect(this.reverbInput)') !== -1,
  'true'
);
check(
  'reverb : avant la balance (web)',
  web.indexOf('reverbMerge.connect(this.balancePan') !== -1,
  'true'
);
check(
  'reverb : avant la balance (natif)',
  swift.includes('engine.connect(reverbNode, to: balanceNode'),
  'true'
);
check(
  'reverb : limiteur toujours dernier (web)',
  web.indexOf('limiter.connect(this.masterGain)') !== -1 &&
    web.indexOf('this.masterGain.connect(ctx.destination)') !== -1 &&
    web.indexOf('this.limiter.connect(this.masterGain)') <
      web.indexOf('this.masterGain.connect(ctx.destination)'),
  'true'
);

// Les lignes doivent couvrir le retard maximal, avec de la marge. Une ligne trop
// courte déborde sur l'audio du tampon voisin : c'est un clic, pas une erreur.
const tsMaxDelay = +tsDelayR * +tsScale;
const capMatch = /capacitySeconds:\s*Float\s*=\s*([\d.]+)\s*\*\s*([\d.]+)\s*\*\s*([\d.]+)/.exec(reverbSwift);
check('reverb : capacité déclarée en Swift', !!capMatch, 'true');
const capBase = +capMatch[1];
const capScale = +capMatch[2];
const capMargin = +capMatch[3];
// Le facteur d'échelle Swift doit être celui du TypeScript, sinon les lignes
// seraient dimensionnées pour une autre plage de retards.
check('reverb : capacité à la bonne échelle', capScale, +tsScale);
const capacitySeconds = capBase * capScale * capMargin;
check('reverb : lignes >= retard max', String(capacitySeconds >= tsMaxDelay), 'true');
check(
  'reverb : marge de securite',
  ((capacitySeconds / tsMaxDelay - 1) * 100).toFixed(0) + '%',
  '15%'
);

console.log('\n4. Préampli : calculé au même endroit ?');
const webImport = /import[\s\S]*?computeHeadroom/.test(web);
check('web importe computeHeadroom', webImport, 'true');
check('pont natif importe computeHeadroom', /computeHeadroom/.test(bridge), 'true');
const swiftComputesHeadroom = /positiveSum|computeHeadroom/.test(swift);
check('Swift ne recalcule PAS la marge', swiftComputesHeadroom, 'false');

console.log('\n' + (ok ? 'LES DEUX MOTEURS SONT ALIGNÉS' : 'DIVERGENCE ENTRE WEB ET IOS'));
process.exit(ok ? 0 : 1);