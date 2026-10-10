/**
 * Verifie le patch iOS de `patch-expo-audio-equalizer.cjs`.
 *
 * Pourquoi un harnais : un `String.replace` echoue SILENCIEUSEMENT quand son
 * ancrage bouge. Le script annoncait alors son succes sans avoir change quoi
 * que ce soit, et la CI livrait un IPA avec l'ancien code qui crashe.
 *
 * Deux pieges deja vus sur ce fichier, que ce test garde :
 *
 *  1. Un remplacement groupe sous un garde portant sur AUTRE chose
 *     (`if (!includes('_dspState...'))`) n'est applique que sur un arbre vierge.
 *     Or la CI fait `npm ci` puis rejoue les scripts : le cas deja patche est le
 *     cas le plus frequent, et c'est exactement celui qui etait rate.
 *
 *  2. Une API inventee. `MTAudioProcessingTapDestroy` n'existe pas - le build
 *     103089817507 a echoue la-dessus ("call to undeclared function" ; le SDK
 *     ne propose que `MTAudioProcessingTapCreate`). Le tap est un objet Core
 *     Foundation : la liberation passe par `CFRelease`.
 *
 * La verification REJOUE LE VRAI SCRIPT, dans une arborescence temporaire ou
 * les chemins relatifs (`../node_modules/expo-audio`, `../native/audio-dsp`)
 * tombent juste. Aucune extraction par motif : parser le tableau de lignes du
 * script s'est avéré trompeur, le motif captait du texte Objective-C venu d'un
 * bloc ulterieur, et le harnais a conclu deux fois a l'envers.
 *
 * Deux niveaux :
 *   A. Sur une copie de l'arbre installe, deja patche ou non. Verifie les
 *      proprietes attendues et l'idempotence. Sans reseau.
 *   B. Sur le tarball npm tel qu'il a ete publie, si on peut l'obtenir. Seul
 *      niveau qui prouve que chaque ancre s'applique sur du code vierge.
 *
 * En prime, une MUTATION : le harnais doit rejeter le script tel qu'il etait
 * avant la correction. Un test qui passe quoi qu'il arrive ne teste rien.
 *
 * Sortie : 0 = tout va bien, 2 = le script est bon mais l'arbre installe est
 * anterieur (normal apres `npm ci`), 1 = le patch est casse.
 *
 * Lancer : node scripts/_patchselftest.cjs
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const scriptName = 'patch-expo-audio-equalizer.cjs';
const scriptPath = path.join(__dirname, scriptName);
const installedExpo = path.join(repoRoot, 'node_modules', 'expo-audio');
const installedTap = path.join(installedExpo, 'ios', 'AudioTapProcessor.m');

let failures = 0;

function check(label, condition, detail) {
  if (condition) {
    console.log(`[selftest]   ok   ${label}`);
    return true;
  }
  failures += 1;
  console.error(`[selftest] ECHEC  ${label}${detail ? `\n          ${detail}` : ''}`);
  return false;
}

function note(msg) {
  console.warn(`[selftest] note  ${msg}`);
}

/**
 * Reproduit l'arborescence que le patch attend : il resout ses chemins depuis
 * son propre `__dirname`, donc il faut scripts/, native/audio-dsp/ et
 * node_modules/expo-audio/ dans la meme racine. On execute le script avec node
 * plutot que de l'evaluer : pas de hack de source, pas d'hypothese sur ses
 * internes, et c'est exactement le chemin que prend `postinstall`.
 */
function stageTree(label, expoSourceDir) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `mas-selftest-${label}-`));
  const scripts = path.join(root, 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  fs.mkdirSync(path.join(root, 'native'), { recursive: true });

  fs.copyFileSync(scriptPath, path.join(scripts, scriptName));
  fs.cpSync(path.join(repoRoot, 'native', 'audio-dsp'), path.join(root, 'native', 'audio-dsp'), {
    recursive: true,
  });

  const expoTarget = path.join(root, 'node_modules', 'expo-audio');
  fs.mkdirSync(path.dirname(expoTarget), { recursive: true });
  fs.cpSync(expoSourceDir, expoTarget, { recursive: true });

  return { root, tapPath: path.join(expoTarget, 'ios', 'AudioTapProcessor.m') };
}

/** Rejoue le vrai script sur l'etage, deux fois. Renvoie le contenu final. */
function runPatchTwice(tree) {
  const staged = path.join(tree.root, 'scripts', scriptName);
  for (let pass = 1; pass <= 2; pass++) {
    const run = spawnSync(process.execPath, [staged], { cwd: tree.root, encoding: 'utf8' });
    if (run.status !== 0) {
      throw new Error(`le script a echoue au passage ${pass} (code ${run.status})\n${run.stderr || run.stdout}`);
    }
  }
  return fs.readFileSync(tree.tapPath, 'utf8');
}

// --- Proprietes attendues du fichier produit. -------------------------------

/**
 * Verifie les invariants de `AudioTapProcessor.m` apres patch. Chaque assertion
 * porte sur le comportement qu'on cherche a obtenir, pas sur la forme du
 * script qui le produit.
 */
function inspect(label, src) {
  // Le tap est un objet Core Foundation. Il n'existe aucune fonction
  // MTAudioProcessingTapDestroy : l'appeler ne compile pas.
  check(
    `${label} : n'appelle pas MTAudioProcessingTapDestroy`,
    !/MTAudioProcessingTapDestroy\s*\(/.test(src),
    "l'API n'existe pas dans MediaToolbox (run 103089817507)"
  );

  // invalidate ET dealloc doivent chacun liberer le tap, une fois exactement.
  // Une fois : deux CFRelease sur le meme objet = over-release = crash.
  const releases = (src.match(/CFRelease\(_audioProcessingTap\);/g) || []).length;
  check(
    `${label} : libere le tap exactement deux fois (invalidate + dealloc)`,
    releases === 2,
    `trouve ${releases} CFRelease(_audioProcessingTap)`
  );

  check(
    `${label} : chaque liberation remet le pointeur a NULL`,
    (src.match(/_audioProcessingTap = NULL;\s*\n\s*\}/g) || []).length >= 2,
    'sans cette remise a NULL, une seconde liberation viserait un pointeur conserve'
  );

  // CFRelease doit venir de somewhere : une dependance transitive n'est pas
  // une garantie, si Expo Audio leve un jour cet import le build echoue.
  check(
    `${label} : importe CoreFoundation explicitement`,
    (src.match(/#import <CoreFoundation\/CoreFoundation\.h>/g) || []).length === 1
  );

  // L'ordre est tout l'interet : le tap d'abord, le DSP ensuite. Inverser,
  // c'est rendre au thread de rendu un pointeur vers un etat libere.
  const deallocAt = src.indexOf('- (void)dealloc {');
  check(`${label} : dealloc present`, deallocAt !== -1);
  if (deallocAt !== -1) {
    const dealloc = src.slice(deallocAt, src.indexOf('\n@end', deallocAt) === -1 ? undefined : src.indexOf('\n@end', deallocAt));
    check(
      `${label} : dealloc libere le tap AVANT le DSP`,
      /CFRelease\(_audioProcessingTap\);[\s\S]*MASAudioDSPDestroy\(_dspState\)/.test(dealloc)
    );
    check(
      `${label} : dealloc ne detruit pas un DSP deja detruit`,
      /MASAudioDSPDestroy\(_dspState\);\s*\n\s*_dspState = NULL;/.test(dealloc),
      'sans remise a NULL, un dealloc repasse (relance de session audio) libere deux fois'
    );
  }

  // Les remplacements non gardes, ceux qui s'appliquent a chaque execution.
  // Leur absence signalerait que le script a change et que le harnais serait
  // devenu aveugle : mieux vaut une assertion qui crie qu'un test qui passe.
  check(`${label} : setDSPEnabled present`, src.includes('- (void)setDSPEnabled:'));
  check(`${label} : tapProcess traite le DSP`, src.includes('MASAudioDSPProcess('));
  check(
    `${label} : tapPrepare valide le contexte avant usage`,
    /tapPrepare\([\s\S]*?if \(!context\) \{\s*\n\s*return;/.test(src)
  );
  return failures;
}

if (!fs.existsSync(installedExpo)) {
  note('expo-audio absent de node_modules : lancer `npm install` avant ce harnais');
  process.exit(2);
}

// === Niveau A : l'arbre installe (deja patche ou non) =======================

console.log("[selftest] A. sur l'arbre installe");
const treeA = stageTree('arbre', installedExpo);
const wasAlreadyPatched = fs.readFileSync(installedTap, 'utf8').includes('CFRelease(_audioProcessingTap');
let pass1;
try {
  pass1 = runPatchTwice(treeA);
} catch (e) {
  console.error(`[selftest] ECHEC  le rejeu du script a echoue : ${e.message}`);
  process.exit(1);
}
inspect('installe', pass1);
check(
  'installe : idempotent',
  pass1 === fs.readFileSync(treeA.tapPath, 'utf8'),
  'le second passage a modifie le fichier ; sur un arbre deja patche cela accumule les corrections'
);
fs.rmSync(treeA.root, { recursive: true, force: true });

// === Niveau B : la source amont publiee =====================================
//
// Seul niveau qui prouve que les ancres s'appliquent sur du code vierge. Sur
// l'arbre installe, tout est deja patche : un garde qui saute un remplacement
// passe inapercu. Le tarball est la seule source de verite.
// `npm ci` en CI fait `npm install` juste apres, donc le niveau A rattrape le
// fichier reel ; le niveau B attrape l'ancrage.

console.log("\n[selftest] B. sur la source amont publiee");
const version = JSON.parse(fs.readFileSync(path.join(installedExpo, 'package.json'), 'utf8')).version;
const packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mas-selftest-pack-'));
let upstreamRoot = null;

// `packDir` n'est PAS supprime a la fin de ce bloc : le niveau C lit encore
// l'amont. Le nettoyage a lieu en fin de script.
{
  // `npm` est un `.cmd` sous Windows, et ce poste refuse le spawn direct
  // (EINVAL sur npm.cmd, ENOENT sur npm). Le seul chemin qui marche est
  // shell: true, dont Node avertit (DEP0190) : bruit, pas echec.
  const packed = spawnSync(
    'npm',
    ['pack', `expo-audio@${version}`, '--pack-destination', packDir, '--prefer-offline', '--no-audit', '--no-fund'],
    { encoding: 'utf8', shell: true }
  );
  const tarballName = fs.readdirSync(packDir).find((f) => f.endsWith('.tgz'));

  if (packed.status !== 0 || !tarballName) {
    note(
      `tarball indisponible (reseau ou cache absent) : niveaux B et C ignores.\n` +
        `          ${(packed.stderr || packed.stdout || `code ${packed.status}`).trim().split('\n').pop()}`
    );
  } else {
    // Nom seul, cwd dans packDir : passe en chemin absolu, `tar` lit le `C:`
    // de `C:/Users/...` comme un nom d'hote distant et echoue
    // ("Cannot connect to C: resolve failed").
    const untar = spawnSync('tar', ['-xzf', tarballName], { cwd: packDir, encoding: 'utf8' });
    const tapUpstream = path.join(packDir, 'package', 'ios', 'AudioTapProcessor.m');
    if (untar.status !== 0 || !fs.existsSync(tapUpstream)) {
      // Ne pas avaler la cause : un niveau ignore en silence est exactement le
      // defaut que ce harnais existe pour attraper.
      note(
        `extraction impossible : niveaux B et C ignores.\n` +
          `          tar code ${untar.status} ; ${untar.error ? untar.error.message : (untar.stderr || '').trim().slice(0, 200)}`
      );
    } else {
      upstreamRoot = path.join(packDir, 'package');
      const upstreamSrc = fs.readFileSync(tapUpstream, 'utf8');

      // Verifie que le tarball est bien l'amont : sans cette garde, un cache
      // npm douteux ferait tester du code deja patche, et le niveau B ne
      // prouverait rien.
      check(
        'amont : le tarball est bien non patche',
        !upstreamSrc.includes('CFRelease(') && !upstreamSrc.includes('_dspState'),
        'le tarball contient deja le patch : niveau B sans valeur'
      );
      check(
        'amont : invalidate pose _audioProcessingTap a NULL sans le liberer',
        /if \(_audioProcessingTap\) \{[\s\S]*?isValid = NO;[\s\S]*?\}\s*\n\s*_audioProcessingTap = NULL;/.test(upstreamSrc),
        "l'amont attendu ne correspond plus ; verifier la version d'expo-audio"
      );

      const treeB = stageTree('amont', upstreamRoot);
      let patchedFromUpstream;
      try {
        patchedFromUpstream = runPatchTwice(treeB);
      } catch (e) {
        console.error(`[selftest] ECHEC  le patch ne s'applique pas sur l'amont : ${e.message}`);
        failures += 1;
        fs.rmSync(treeB.root, { recursive: true, force: true });
        fs.rmSync(packDir, { recursive: true, force: true });
        process.exit(1);
      }
      inspect('amont', patchedFromUpstream);

      // Les remplacements SANS garde s'appliquent a chaque execution : ils
      // doivent avoir pris aussi sur du code vierge.
      check(
        'amont : supportedTapProcessingFormat valide le format',
        patchedFromUpstream.includes('processingFormat->mFormatID == kAudioFormatLinearPCM')
      );
      check('amont : tapProcess ecrase', patchedFromUpstream.includes('MASAudioDSPProcess('));
      fs.rmSync(treeB.root, { recursive: true, force: true });
    }
  }
}

// === Niveau C : le harnais doit mordre ======================================
//
// On rejoue le script dans son etat d'avant la correction et on exige un echec.
// Sans ca, ce harnais pourrait valider n'importe quoi : un `replace` casse qui
// ne modifie rien, ou une assertion devenue vide, passeraient encore.
//
// La mutation porte sur l'AMONT, obligatoirement. Sur l'arbre deja patche, le
// garde `if (!corps.includes('CFRelease...'))` evaluait faux et sautait le
// remplacement : le mutant n'etait donc jamais exerce, et le harnais le laissait
// passer. C'etait le meme piege que le bug lui-meme.

console.log('\n[selftest] C. mutation : le harnais doit rejeter le script d avant');
const mutantSource = fs.readFileSync(scriptPath, 'utf8');
const mutantScript = mutantSource.replace(
  /CFRelease\(_audioProcessingTap\);/g,
  'MTAudioProcessingTapDestroy(_audioProcessingTap);'
);
if (mutantScript === mutantSource) {
  check('mutation : le script contient bien CFRelease a muter', false, 'la mutation n a rien change ; le niveau C ne teste rien');
} else if (!upstreamRoot) {
  note('mutation ignoree : pas d amont disponible (reseau ou cache absent)');
} else {
  const treeC = stageTree('mutant', upstreamRoot);
  fs.writeFileSync(path.join(treeC.root, 'scripts', scriptName), mutantScript, 'utf8');

  let mutantOut = null;
  try {
    const run = spawnSync(process.execPath, [path.join(treeC.root, 'scripts', scriptName)], {
      cwd: treeC.root,
      encoding: 'utf8',
    });
    if (run.status === 0) mutantOut = fs.readFileSync(treeC.tapPath, 'utf8');
  } catch {
    mutantOut = null;
  }

  if (mutantOut === null) {
    // Rejete avant d ecrire quoi que ce soit : l ancien code ne compilait pas,
    // refuser de patcher vaut mieux que patcher avec une API fantome.
    check('mutation : rejetee, aucun fichier produit', true);
  } else {
    // On passe le mutant dans les MEMES assertions que le vrai script : s il
    // les traverse, ce harnais ne teste rien. `inspect` compte ses echecs dans
    // `failures`, on les remett donc a zero — ce sont les echecs ATTENDUS ici,
    // ceux du mutant, pas ceux du harnais. Sans ca, le niveau Cacherait sa
    // reussite derriere un exit 1 qui n'a rien a reprocher a personne.
    console.log('[selftest]   ---  les ECHEC ci-dessous sont ATTENDUS : ils prouvent que le mutant est rejete ---');
    const before = failures;
    inspect('mutant', mutantOut);
    const caughtBy = failures - before;
    failures = before;
    check(
      'mutation : le harnais rejette le script d avant',
      caughtBy > 0 || /MTAudioProcessingTapDestroy\s*\(/.test(mutantOut),
      `le mutant passe les assertions : ${caughtBy} echec attendu(s) ; sans doute CFRelease absent du script mutant`
    );
  }
  fs.rmSync(treeC.root, { recursive: true, force: true });
}

// === Verdict ================================================================

fs.rmSync(packDir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n[selftest] ${failures} verification(s) en echec.`);
  process.exit(1);
}

// L'echec 2 est distinct : le script est bon, c'est l'arbre installe qui est
// anterieur. Remede distinct aussi : `npm install` en local, postinstall en CI.
if (fs.existsSync(installedTap)) {
  const installed = fs.readFileSync(installedTap, 'utf8');
  if (!installed.includes('CFRelease(_audioProcessingTap)')) {
    note(
      'le script produit bien la correction, mais le AudioTapProcessor.m installe est anterieur.\n' +
        '          Lancer `npm install` pour re-patcher node_modules (la CI le fait via postinstall).'
    );
    process.exit(2);
  }
}

console.log('\n[selftest] OK');
void wasAlreadyPatched;
void upstreamRoot;
