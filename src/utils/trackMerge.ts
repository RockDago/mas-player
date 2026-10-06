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

  return {
    metaKey: normTitle && normArtist ? `${normTitle}:::${normArtist}` : '',
    fullKey: `${normTitle}:::${normArtist}:::${normAlbum}`,
    filenameKey: filename ? `${normFolder}:::${filename}` : '',
    uri: t.uri || '',
  };
}

function sameTrack(a: ReturnType<typeof fingerprint>, b: ReturnType<typeof fingerprint>) {
  return (
    (a.uri && a.uri === b.uri) ||
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

  incoming.forEach((t) => {
    const fp = fingerprint(t);
    const existingIdx = merged.findIndex((other) => sameTrack(fp, fingerprint(other)));

    if (existingIdx === -1) {
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
        id: t.id,
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
