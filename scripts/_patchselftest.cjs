/**
 * Verifie que le patch iOS de `patch-expo-audio-equalizer.cjs` est idempotent
 * et qu'il s'applique sur une source amont Expo, pas seulement sur un
 * node_modules deja patche.
 *
 * Le piege que ce test garde : un `String.replace` dont l'ancrage a change
 * echoue SILENCIEUSEMENT. Le script annoncait alors son succes sans avoir
 * corrige quoi que ce soit. Le cas reel : la correction de cycle de vie du tap
 * etait groupee sous le garde `if (!includes('_dspState...'))`, donc sautee sur
 * tout arbre deja patche — c'est-a-dire precisement le cas le plus frequent.
 *
 * Rejoue les remplacements sur un amont reconstruit, deux fois de suite, et
 * exige que la seconde passe soit un no-op.
 *
 * Lancer : node scripts/_patchselftest.cjs
 */
const fs = require('fs');
const path = require('path');

const scriptPath = path.resolve(__dirname, 'patch-expo-audio-equalizer.cjs');
const tapPath = path.resolve(__dirname, '../node_modules/expo-audio/ios/AudioTapProcessor.m');
const script = fs.readFileSync(scriptPath, 'utf8');
const installed = fs.readFileSync(tapPath, 'utf8');

function die(msg) {
  console.error(`[selftest] ECHEC : ${msg}`);
  process.exit(1);
}

/**
 * Extraire un remplacement `tapSource.replace(<motif>, <tableau>.join('\n'))`
 * depuis le script, et le rejouer sur `src`.
 *
 * On rejoue le TEXTE DU SCRIPT plutot qu'une copie : une copie, meme fidele
 * aujourd'hui, diverge des que le script change, et le test cesserait de
 * tester quoi que ce soit. C'est le meme piege que le harnais de l equaliseur.
 */
function extractReplacement(src, marker) {
  const at = script.indexOf(marker);
  if (at === -1) return { applied: false, src, why: `marqueur absent du script : ${marker}` };
  // Le tableau de lignes commence apres le motif passe a `replace`, pas forcement
  // sur la ligne du marqueur : chercher `[\n` depuis le marqueur echoue quand le
  // motif tient sur sa propre ligne. On cherche donc la premiere occurrence
  // apres le marqueur, quel que soit le contenu intermediaire.
  const arrStart = script.indexOf('[', at);
  if (arrStart === -1) return { applied: false, src, why: 'tableau de lignes absent' };
  const arrEnd = script.indexOf("].join('\\n')", arrStart);
  if (arrEnd === -1) return { applied: false, src, why: 'fin de tableau absente' };
  const body = script
    .slice(arrStart, arrEnd)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^'/.test(l) || /^"/.test(l))
    .map((l) => {
      const q = l[0];
      let v = l.slice(1, -1);
      if (v.endsWith(q)) v = v.slice(0, -1);
      return v.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    });
  const replacement = body.join('\n');
  if (!replacement.includes('MTAudioProcessingTapDestroy')) {
    return { applied: false, src, why: 'le tableau extrait ne contient pas MTAudioProcessingTapDestroy' };
  }
  const before = src;
  const after = src.replace(/- \(void\)dealloc \{[\s\S]*?\n\}/, replacement);
  return { applied: after !== before, src: after, replacement };
}

// --- Reconstruire l'amont Expo : retirer ce que le patch y avait pose. -------
let upstream = installed
  .replace('#import "AudioTapProcessor.h"\n#import "MASAudioDSP.h"', '#import "AudioTapProcessor.h"')
  .replace(/  _audioProcessingTap = NULL;\n    _dspState = MASAudioDSPCreate\(\);\n/, '  _audioProcessingTap = NULL;\n')
  .replace(/- \(void\)setDSPEnabled:[\s\S]*?- \(BOOL\)isTapInstalled \{/, '- (BOOL)isTapInstalled {')
  .replace(
    /- \(void\)dealloc \{[\s\S]*?\n\}/,
    '- (void)dealloc {\n  [self invalidate];\n}'
  )
  .replace(
    /void tapPrepare[\s\S]*?\n\}\n\nvoid tapProcess/,
    'void tapPrepare(MTAudioProcessingTapRef tap, CMItemCount maxFrames, const AudioStreamBasicDescription *processingFormat) {\n  [self doesNotRecognizeSelector:_cmd];\n}\n\nvoid tapProcess'
  )
  .replace(
    /- \(void\)invalidate \{[\s\S]*?\n\}\n\n- \(void\)dealloc/,
    '- (void)invalidate {\n  [self doesNotRecognizeSelector:_cmd];\n}\n\n- (void)dealloc'
  );

// Si l'amont reconstruit ne ressemble pas a l'amont, le test ne teste rien.
if (upstream.includes('_dspState')) die('la reconstruction amont a laisse _dspState');
if (upstream.includes('setDSPEnabled')) die('la reconstruction amont a laisse setDSPEnabled');
if (upstream.includes('MTAudioProcessingTapDestroy')) {
  die("l'amont reconstruit contient deja MTAudioProcessingTapDestroy : reconstruction invalide");
}

// --- Passe 1 : appliquer les deux corrections de cycle de vie. --------------
const d1 = extractReplacement(upstream, 'dealloc');
if (!d1.applied) die(`le remplacement de dealloc ne s'applique pas sur l'amont (${d1.why})`);
if (!d1.src.includes('MTAudioProcessingTapDestroy(_audioProcessingTap)')) {
  die('le dealloc reconstruit ne detruit pas le tap');
}
if (!/MTAudioProcessingTapDestroy\(_audioProcessingTap\);[\s\S]*?MASAudioDSPDestroy\(_dspState\)/.test(d1.src)) {
  die('la destruction du tap ne precede pas la liberation du DSP');
}

// --- Passe 2 : le meme remplacement doit etre un NO-OP (idempotence). ------
const d2 = extractReplacement(d1.src, 'dealloc');
if (d2.applied) {
  die(
    'le remplacement de dealloc reapplique une seconde fois : le patch n\'est pas idempotent, ' +
      'donc un node_modules deja patche reste a l ancien etat'
  );
}

// --- Le fichier reellement compile doit porter la correction. ---------------
//
// Echec distinct de celui du dessus, remede distinct : ici le script est bon et
// c'est l'arbre installe qui est anterieur. La CI fait `npm ci` puis relance les
// scripts, donc elle repart de zero ; en local, `npm install` suffit.
if (!installed.includes('MTAudioProcessingTapDestroy(_audioProcessingTap)')) {
  console.warn(
    '[selftest] ATTENTION : le script produit bien la correction, mais le ' +
      'AudioTapProcessor.m installe est anterieur.\n' +
      '          Lancer `npm install` pour re-patcher node_modules (la CI le fait via postinstall).'
  );
  process.exit(2);
}

console.log('[selftest] le patch s\'applique sur l\'amont, et reapplique ne change rien (idempotent)');
console.log('[selftest] le fichier compile porte la correction');
console.log('[selftest] OK');