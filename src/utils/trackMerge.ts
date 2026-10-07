import { Platform } from 'react-native';
import { Track } from '../types/audio';

export interface MergeResult {
  /** Bibliothèque complète après fusion, prête à être stockée dans l'état. */
  tracks: Track[];
  /** Morceaux réellement nouveaux — c'est le seul chiffre qu'un UI doit annoncer. */
  added: number;
  /** Morceaux déjà présents dont la version saine a replaced la version cassée. */
  repaired: number;
  /** Doublons ignorés. */
  skipped: Track[];
}

/**
 * Empreinte d'un morceau, pour reconnaître un doublon.
 *
 * Trois clés, parce qu'aucune ne suffit seule. L'URI identifie le fichier exact
 * mais change d'une importation à l'autre — un même fichier ré-importé depuis
 * un autre dossier porte une autre URI. Le couple dossier + nom de fichier
 * survit à un ré-Emplacement. Le couple titre + artiste attrape enfin les copies
 * dont le nom a changé, au prix d'un risque de faux positif assumé : deux
 * morceaux réellement distincts mais homonymes sont traités comme un doublon,
 * ce qui vaut mieux que deux fois le même morceau dans la bibliothèque.
 */
function fingerprint(t: Track) {
  const normTitle = (t.title || '').trim().toLowerCase();
  const normArtist = (t.artist || '').trim().toLowerCase();
  const normAlbum = (t.album || '').trim().toLowerCase();
  const normFolder = (t.folder || '').trim().toLowerCase();
  const uriFilename = (t.uri || '').split('/').pop()?.toLowerCase() || '';
  const pathFilename = (t.folderPath || '').split('/').pop()?.toLowerCase() || '';
  const filename = pathFilename || uriFilename;

  // Le chemin RELATIF, pas le seul nom de base.
  //
  // C'était `(folderPath).split('/').pop()` — le nom de base — associé à
  // `folder`, qui est la RACINE de l'import, pas le sous-dossier. Deux albums
  // d'une même arborescence contiennent très souvent les mêmes noms
  // (`01 - Intro.mp3`) : les deux produisent la même clé
  // `mymusic:::01 - intro.mp3`. Le premier importé gagnait, le second était
  // classé doublon et JETÉ : l'utilisateur voit « déjà présent », alors que ce
  // morceau n'a jamais été importé. Le dossier disparaissait sans un mot.
  //
  // `folderPath` porte le chemin complet depuis la racine, donc le comparer en
  // entier distingue les deux. Les deux clés sont conservées : le chemin exact
  // d'abord (fiable), le nom de base ensuite (rattrapage quand `folderPath`
  // manque, notamment sur le web où seule l'URI est disponible) — mais le
  // chemin exact prime toujours.
  const relPath = (t.folderPath || '').trim().toLowerCase().replace(/^\/+/, '');
  const uriPath = (t.uri || '').trim().toLowerCase();

  return {
    metaKey: normTitle && normArtist ? `${normTitle}:::${normArtist}` : '',
    fullKey: `${normTitle}:::${normArtist}:::${normAlbum}`,
    pathKey: relPath ? `${normFolder}:::${relPath}` : '',
    filenameKey: filename ? `${normFolder}:::${filename}` : '',
    uri: t.uri || '',
  };
}

/**
 * Deux morceaux sont-ils le même fichier ?
 *
 * L'ordre des tests est une décision, pas une coquetterie : c'est
 * `pathKey` qui tranche en PREMIER, et il est le seul à pouvoir conclure
 * « ce sont deux fichiers différents ».
 *
 * Le code était un simple OU, où `metaKey` (titre + artiste) suffisait à
 * déclarer un doublon. Or deux albums d'une même arborescence contiennent
 * couramment des morceaux au même titre et au même artiste — un `Intro`
 * dans chaque album, un même nom de festival dans deux sous-dossiers. Le
 * chemin prouvait que c'étaient deux fichiers, et le test s'en fichait :
 * le second était jeté et l'import annonçait « déjà présent ». Un morceau
 * absent de la bibliothèque, et personne pour contester le rapport.
 *
 * La règle est donc : quand les deux morceaux ont un `pathKey` connu et que
 * ces chemins DIFFÈRENT, ce sont deux fichiers distincts, et le test
 * s'arrête là. `metaKey` ne sert plus qu'en dernier recours, quand aucune
 * preuve de chemin n'existe — c'est-à-dire sur le web, où seul le nom de
 * base est disponible.
 */
function sameTrack(a: ReturnType<typeof fingerprint>, b: ReturnType<typeof fingerprint>) {
  // Preuve absolue : la même URI est le même fichier.
  if (a.uri && a.uri === b.uri) return true;

  // Preuve de chemin. Elle tranche dans les deux sens — mais seulement si les
  // deux parties de la comparaison portent sur le MÊME album.
  //
  // `folder` est la racine de l'import : le même album déplacé, ou le même
  // album ré-importé depuis une autre arborescence, produit deux racines
  // différentes pour un album identique. Dans ce cas les chemins divergent alors
  // que c'est très probablement le même fichier, et un chemin seul conclurait à
  // tort « deux morceaux différents » — d'où un doublon à chaque réimport.
  // `fullKey` (titre + artiste + album) est le garde-fou : il dit « le contenu
  // est le même », ce qui prime alors sur une simple divergence de chemin.
  if (a.pathKey && b.pathKey) {
    if (a.pathKey === b.pathKey) return true;
    if (a.fullKey && a.fullKey === b.fullKey) return true;
    return false;
  }

  // Pas de chemin comparable des deux côtés : on retombe sur les clés faibles.
  return (
    (a.filenameKey && a.filenameKey === b.filenameKey) ||
    (a.metaKey && a.metaKey === b.metaKey)
  );
}

/**
 * Fusionne des morceaux importés dans une bibliothèque existante, sans doublon.
 *
 * Fonction PURE, volontairement : elle prend la bibliothèque et rend le
 * résultat, sans toucher à l'état React.
 *
 * Cette pureté n'est pas une coquetterie. Elle existait d'abord à l'intérieur
 * d'un `setTracks(prev => …)`, où le corps n'est évalué qu'au rendu suivant :
 * impossible d'y lire un décompte pour l'afficher dans la même interaction. Le
 * rescan de la bibliothèque doit justement rendre ce décompte — « 3 morceaux
 * ajoutés » — et il ne peut pas le demander à une closure différée d'un rendu.
 */
export function mergeTracks(existing: Track[], incoming: Track[]): MergeResult {
  const merged = [...existing];
  const uniqueNewTracks: Track[] = [];
  const skippedTracks: Track[] = [];
  let repaired = 0;

  // `merged` est la seule source de vérité du dédoublonnage, et il est
  // nécessaire de le conserver ainsi.
  //
  // Il ne faut surtout pas y ajouter `uniqueNewTracks` au fil de l'eau pour
  // « rattraper » les doublons du même lot : la boucle compare alors un morceau
  // à un autre qui n'a pas encore été réparé, et surtout la clé de réparation
  // change. La conséquence concrète est qu'un fichier déjà présent mais
  // cassé ne serait jamais réparé s'il arrive dans le même lot qu'un morceau
  // neuf portant le même nom — cas réel quand on réimporte un dossier.
  //
  // Les deux correctingifs sont donc distincts et indépendants :
  //   1. le fingerprint des morceaux DÉJÀ ADDÉS est mémorisé à part, pour
  //      qu'un doublon du même lot soit compté `skipped` et non `added` ;
  //   2. la réparation conserve l'`id` d'origine (voir plus bas).
  const fingerprintsOfIncoming = new Map<string, ReturnType<typeof fingerprint>>();

  incoming.forEach((t) => {
    const fp = fingerprint(t);
    const existingIdx = merged.findIndex((other) => sameTrack(fp, fingerprint(other)));

    if (existingIdx === -1) {
      // Le lot peut contenir deux fois le même fichier. Avant, les deux
      // passaient : `merged` n'était jamais alimenté par les nouveaux morceaux,
      // donc la comparaison ne les voyait pas. Résultat, deux copies du même
      // titre dans la bibliothèque, et deux blobs web persistés pour un seul
      // fichier — dont un orphelin définitif, puisque supprimer une piste ne
      // supprime pas l'enregistrement de l'autre.
      const priorFp = fingerprintsOfIncoming.get(
        `${fp.filenameKey}|${fp.metaKey}|${fp.uri}`
      );
      if (priorFp) {
        skippedTracks.push(t);
        return;
      }
      fingerprintsOfIncoming.set(`${fp.filenameKey}|${fp.metaKey}|${fp.uri}`, fp);
      uniqueNewTracks.push(t);
      return;
    }

    const found = merged[existingIdx];
    // Un morceau existant est « cassé » s'il n'a pas de durée connue — sur
    // natif, la durée n'arrive qu'après une première lecture, donc un morceau
    // jamais joué est indistinguishable d'un fichier tronqué — ou si c'est un
    // blob web non persisté qui ne survivrait pas à un rechargement.
    const isBroken =
      !found.duration ||
      found.duration <= 0 ||
      (Platform.OS === 'web' && found.uri.startsWith('blob:') && found.uri !== t.uri);

    if (isBroken) {
      merged[existingIdx] = {
        ...found,
        // `id` VOLONTAIREMENT CONSERVÉ.
        //
        // C'était `id: t.id`, et c'était la perte de données la plus grave du
        // fichier. `id` est la clé de jointure de tout le reste : les playlists
        // stockent une liste de `trackIds`, la file d'attente résout les
        // morceaux par `t.id`. Réécrire l'id ne corrigeait que l'URI du
        // morceau — au prix de rendre ces références orphelines, sans aucune
        // compensation nulle part ailleurs.
        //
        // Le scénario est celui de l'usage normal : sur natif, `duration` vaut 0
        // en dur tant que le morceau n'a pas été joué une fois. Une bibliothèque
        // fraîchement importée est donc entièrement « cassée » au sens de
        // `isBroken`. L'utilisateur crée une playlist, puis lance « Actualiser »
        // sur les mêmes fichiers : les dix morceaux prennent la branche de
        // réparation, changent tous d'id, et la playlist — dix références, toutes
        // mortes — devient vide. Aucun message, aucun retour en arrière.
        //
        // Réparer un morceau ne doit changer que ce qui est réellement cassé :
        // son URI, sa durée, son format.
        uri: t.uri,
        duration: t.duration > 0 ? t.duration : found.duration,
        format: t.format || found.format,
      };
      repaired++;
    } else {
      skippedTracks.push(t);
    }
  });

  return {
    tracks: [...merged, ...uniqueNewTracks],
    added: uniqueNewTracks.length,
    repaired,
    skipped: skippedTracks,
  };
}
