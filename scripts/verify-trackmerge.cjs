/**
 * Vérifie la fusion d'une importation dans la bibliothèque existante.
 *
 * ## Pourquoi un harnais alors que `tsc` passe
 *
 * Aucun de ces défauts n'était un problème de type : `mergeTracks` est pure,
 * typée, et renvoyait exactement ce qu'elle promettait. Les trois fautes
 * portaient sur ce qu'elle PROMETTAIT — et sur ce que ses appelants en font.
 *
 * La plus grave ne vivait d'ailleurs pas dans cette fonction. `id` est la clé
 * de jointure de tout le reste de l'application : les playlists stockent une
 * liste de `trackIds`, la file d'attente résout les morceaux par `t.id`.
 * Réécrire l'id d'un morceau « réparé » ne cassait rien au moment de la fusion —
 * ça cassait la playlist, plus tard, définitivement, sans message.
 *
 * ## Lancer
 *
 *   node scripts/verify-trackmerge.cjs
 */
const fs = require('fs');
const path = require('path');

// `Platform` n'est utilisé qu'une ligne (`Platform.OS === 'web'` dans le test du
// blob). On l'injecte dans la portée évaluée plutôt que d'instancier le module.
const Platform = { OS: 'android' };

const SOURCE = path.join(__dirname, '..', 'src', 'utils', 'trackMerge.ts');

/**
 * Charge la fonction RÉELLE depuis le source TypeScript.
 *
 * transcribed à la main serait le défaut même que ce harnais combat : une
 * copie peut diverger du code livré et rester verte. On lit donc le fichier,
 * on retire les annotations de type, et on évalue le résultat. Si quelqu'un
 * ajoute un `: number` dans une signature, ce harnais échoue bruyamment au
 * lieu de tester du code qui n'existe plus.
 */
function loadMergeTracks(platformOS) {
  const raw = fs.readFileSync(SOURCE, 'utf8');
  const start = raw.indexOf('function fingerprint');
  if (start === -1) throw new Error('fingerprint() introuvable — le harnais est périmé');

  const code = raw
    .slice(start)
    .replace(/\bexport /g, '')
    .replace(/new Map<string,[^;]*?>\(\)/g, 'new Map()')
    .replace(
      /\(\s*existing\s*:\s*Track\[\]\s*,\s*incoming\s*:\s*Track\[\]\s*\)\s*:\s*MergeResult/,
      '(existing, incoming)'
    )
    .replace(/\(\s*t\s*:\s*Track\s*\)/g, '(t)')
    .replace(
      /\(\s*a\s*:\s*ReturnType<typeof fingerprint>\s*,\s*b\s*:\s*ReturnType<typeof fingerprint>\s*\)/,
      '(a, b)'
    )
    .replace(/(\w+)\s*:\s*Track\[\]/g, '$1')
    .replace(/(\w+)\s*:\s*ReturnType<typeof fingerprint>/g, '$1')
    .replace(/(\w+)\s*:\s*number/g, '$1');

  return new Function('Platform', code + '\nreturn mergeTracks;')({ OS: platformOS });
}

let ok = true;
const rows = [];

/** Un contrôle : nom, résultat attendu, valeur obtenue. */
function check(label, pass, detail) {
  rows.push({ label, pass, detail });
  if (!pass) ok = false;
}

/** Morceau de confort : la plupart des cas n'en ont besoin que de trois champs. */
const t = (o) => ({
  title: '',
  artist: '',
  album: '',
  folder: '',
  folderPath: '',
  uri: '',
  duration: 0,
  format: '',
  ...o,
});

const mergeTracks = loadMergeTracks('android');

// ── 1. La playlist doit survivre au rescan ───────────────────────────────────
// Le scénario réel : sur natif `duration` vaut 0 tant que le morceau n'a pas été
// joué une fois. Une bibliothèque fraîchement importée est donc ENTIÈREMENT
// « cassée ». L'utilisateur crée une playlist, puis relance « Actualiser » sur
// les mêmes fichiers : sans la conservation de l'id, chaque morceau prend la
// branche de réparation et la playlist devient vide. Dix références, dix morts.
{
  const r = mergeTracks(
    [t({ id: 'OLD-1', title: 'Song', artist: 'A', album: 'B', uri: 'file:///old.mp3' })],
    [t({ id: 'NEW-1', title: 'Song', artist: 'A', album: 'B', uri: 'file:///new.mp3' })]
  );
  check(
    'réparation : l\'id d\'origine est conservé',
    r.tracks[0].id === 'OLD-1',
    `id=${r.tracks[0].id}`
  );
  check(
    'réparation : l\'URI est bien mise à jour',
    r.tracks[0].uri === 'file:///new.mp3',
    `uri=${r.tracks[0].uri}`
  );
  check('réparation : comptée comme réparée', r.repaired === 1, `repaired=${r.repaired}`);
  check('réparation : rien d\'ajouté', r.added === 0, `added=${r.added}`);
}

// ── 2. Un doublon dans le MÊME lot ───────────────────────────────────────────
// `merged` n'était jamais alimenté par les morceaux acceptés : deux copies du
// même fichier dans un seul import passaient toutes les deux. Sur web cela
// persistait deux blobs IndexedDB pour un fichier, dont un orphelin définitif.
{
  const r = mergeTracks(
    [],
    [
      t({ id: 'd1', title: 'X', artist: 'Y', album: 'Z', uri: 'file:///a.mp3', duration: 100 }),
      t({ id: 'd2', title: 'X', artist: 'Y', album: 'Z', uri: 'file:///a.mp3', duration: 100 }),
    ]
  );
  check('doublon intra-lot : ajouté une seule fois', r.added === 1, `added=${r.added}`);
  check('doublon intra-lot : compté en ignoré', r.skipped.length === 1, `skipped=${r.skipped.length}`);
  check('doublon intra-lot : bibliothèque = 1', r.tracks.length === 1, `tracks=${r.tracks.length}`);
}

// ── 3. Deux albums homonymes ─────────────────────────────────────────────────
// `filenameKey` associait le nom de BASE du fichier à la racine de l'import.
// Deux albums d'une même arborescence contiennent couramment les mêmes noms :
// le second était classé doublon et JETÉ, et l'import annonçait « déjà présent »
// pour un morceau qui n'avait jamais été importé.
{
  const r = mergeTracks(
    [
      t({
        id: 'o',
        title: 'Intro',
        artist: 'B',
        album: 'AlbumB',
        uri: 'file:///B/intro.mp3',
        duration: 200,
        folder: 'musique',
        folderPath: 'AlbumB/Intro.mp3',
      }),
    ],
    [
      t({
        id: 'n',
        title: 'Intro',
        artist: 'B',
        album: 'AlbumA',
        uri: 'file:///A/intro.mp3',
        duration: 200,
        folder: 'musique',
        folderPath: 'AlbumA/Intro.mp3',
      }),
    ]
  );
  check('albums homonymes : le 2e est bien ajouté', r.added === 1, `added=${r.added}`);
  check('albums homonymes : rien n\'est jeté', r.skipped.length === 0, `skipped=${r.skipped.length}`);
}

// ── Non-régressions ──────────────────────────────────────────────────────────
// Le risque de la règle « chemins différents = fichiers différents » est
// d'inventer des doublons à chaque réimport. Ces trois cas vérifient le contraire.

{
  // Le vrai doublon, même chemin.
  const r = mergeTracks(
    [t({ id: 'k', title: 'I', artist: 'B', album: 'X', uri: 'file:///B/i.mp3', duration: 200, folder: 'm', folderPath: 'A/Intro.mp3' })],
    [t({ id: 'k2', title: 'I', artist: 'B', album: 'X', uri: 'file:///B/i.mp3', duration: 200, folder: 'm', folderPath: 'A/Intro.mp3' })]
  );
  check('non-rég : vrai doublon toujours ignoré', r.added === 0 && r.skipped.length === 1, `added=${r.added}`);
}

{
  // Le même album ré-importé depuis une racine différente : `pathKey` diverge,
  // mais le contenu est identique. Sans `fullKey`, ce cas créait un doublon.
  const r = mergeTracks(
    [t({ id: 'o', title: 'Intro', artist: 'B', album: 'X', uri: 'file:///old/Intro.mp3', duration: 200, folder: 'musique', folderPath: 'Intro.mp3' })],
    [t({ id: 'n', title: 'Intro', artist: 'B', album: 'X', uri: 'file:///new/Intro.mp3', duration: 200, folder: 'downloads', folderPath: 'Intro.mp3' })]
  );
  check('non-rég : album déplacé toujours reconnu', r.added === 0 && r.skipped.length === 1, `added=${r.added}`);
}

{
  const r = mergeTracks(
    [],
    [
      t({ id: '1', title: 'A', artist: 'B', album: 'C', uri: 'file:///a.mp3', duration: 100, folder: 'f', folderPath: 'A/one.mp3' }),
      t({ id: '2', title: 'B', artist: 'C', album: 'D', uri: 'file:///b.mp3', duration: 100, folder: 'f', folderPath: 'A/two.mp3' }),
    ]
  );
  check('non-rég : import normal ajoute tout', r.added === 2, `added=${r.added}`);
}

// ── Web : aucun chemin comparable, seul le titre porte ───────────────────────
// Sur web, `folderPath` ne porte que le nom de base : `pathKey` ne peut rien
// prouver. La dédup doit alors retomber sur titre + artiste, sinon chaque
// réimport crée un doublon.
//
// Le doublon web n'est pas classé `skipped` mais `repaired`, et c'est
// normal : une URI `blob:` périmée ne survivrait pas à un rechargement de
// page. Elle est donc rafraîchie depuis la nouvelle importation. Ce qui compte
// ici, c'est qu'aucun DEUXIÈME morceau ne soit créé — le test vérifie donc
// `added === 0` et l'unicité de la bibliothèque, pas le canal de comptage.
{
  const web = loadMergeTracks('web');
  const r = web(
    [t({ id: 'o', title: 'Intro', artist: 'B', album: 'X', uri: 'blob:a', duration: 200 })],
    [t({ id: 'n', title: 'Intro', artist: 'B', album: 'X', uri: 'blob:b', duration: 200 })]
  );
  check(
    'web : aucun doublon créé sans chemin',
    r.added === 0 && r.tracks.length === 1,
    `added=${r.added} tracks=${r.tracks.length} (réparé=${r.repaired})`
  );
  check(
    'web : l\'URI du blob est rafraîchie',
    r.tracks[0].uri === 'blob:b',
    `uri=${r.tracks[0].uri}`
  );
}

// ── Rapport ──────────────────────────────────────────────────────────────────
for (const { label, pass, detail } of rows) {
  console.log(`  ${pass ? 'OK   ' : 'ÉCHEC'}  ${label.padEnd(42)} ${detail}`);
}
console.log(
  '\n' +
    (ok
      ? 'LA FUSION DE BIBLIOTHÈQUE EST CORRECTE'
      : 'LA FUSION PERD OU INVENTE DES MORCEAUX')
);
process.exit(ok ? 0 : 1);