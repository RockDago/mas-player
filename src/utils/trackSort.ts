import { Track } from '../types/audio';

export type LibrarySort = 'title' | 'artist' | 'album' | 'date';

/**
 * Durée sous laquelle un morceau est considéré comme « court ».
 *
 * Sonnerie, mémo vocal, bruitage de début d'enregistrement : ce que les
 * utilisateurs importent depuis un téléphone et ne veulent pas voir dans leur
 * bibliothèque musicale.
 */
export const SHORT_TRACK_SECONDS = 30;

/**
 * Filtre les morceaux trop courts, SANS jamais masquer ceux dont la durée est
 * inconnue.
 *
 * Cette garde n'est pas une précaution de style, c'est le comportement correct.
 * `Track.duration` vaut `0` en dur sur les sept sites de construction de
 * `filePickerService` : sur iOS et Android, la durée réelle n'arrive qu'après
 * une première lecture (`App.tsx`, dans `loadTrack`). Une bibliothèque
 * fraîchement importée porte donc `duration === 0` partout.
 *
 * Un prédicat naïf `duration < 30` masquerait donc *toute* la bibliothèque sur
 * mobile — le réglage s'il s'activait viderait la bibliothèque, et l'utilisateur verrait sa musique
 * disparaître sans pouvoir revenir en arrière. Ici, `0` signifie « pas encore
 * connu », donc « ne pas juger » : seuls les morceaux déjà joués une fois sont
 * candidats, et le filtre devient juste au fur et à mesure que la bibliothèque
 * se remplit.
 */
export function filterShortTracks(tracks: Track[], ignoreShort: boolean): Track[] {
  if (!ignoreShort) return tracks;
  return tracks.filter(
    (t) => !(t.duration > 0 && t.duration < SHORT_TRACK_SECONDS)
  );
}

/**
 * Compare deux chaînes pour un tri lisible : insensible à la casse et aux
 * accents, et ordre numérique naturel — « Piste 2 » avant « Piste 10 », ce que
 * le tri lexicographique (`Piste 10` < `Piste 2`) inverserait.
 */
function compareText(a: string, b: string): number {
  return (a || '').localeCompare(b || '', undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

/**
 * Tri de la bibliothèque par titre, artiste, album ou ordre d'import.
 *
 * Chaque comparateur se termine par une égalité sur `title` puis `id`. Ce n'est
 * pas de l'enjolivement : `Array.prototype.sort` est stable depuis ES2019, mais
 * l'ordre de sortie dépend alors de l'ordre D'ENTRÉE, c'est-à-dire de l'ordre
 * d'import. Un ré-import réordonne alors la bibliothèque sous les yeux de
 * l'utilisateur, et le morceau qu'il était en train de lire saute de ligne.
 * Trancher les égalités rend le tri reproductible d'un rendu à l'autre.
 */
export function sortTracks(tracks: Track[], sort: LibrarySort): Track[] {
  // Copie : `sort` mute son argument, et `tracks` vient souvent de l'état React.
  // Trier en place modifierait le tableau d'origine sous `useMemo`, ce qui est
  // à la fois invisible et source de rendus fantômes.
  const sorted = [...tracks];

  const byTitle = (a: Track, b: Track) =>
    compareText(a.title, b.title) ||
    compareText(a.artist, b.artist) ||
    a.id.localeCompare(b.id);

  switch (sort) {
    case 'artist':
      sorted.sort(
        (a, b) =>
          compareText(a.artist, b.artist) ||
          compareText(a.album, b.album) ||
          byTitle(a, b)
      );
      break;

    case 'album':
      sorted.sort(
        (a, b) =>
          compareText(a.album, b.album) ||
          compareText(a.artist, b.artist) ||
          byTitle(a, b)
      );
      break;

    case 'date':
      // « Récent » = ordre d'import, pas date du fichier. `addedAt` est posé à
      // l'import ; les morceaux qui en sont dépourvus (bibliothèques antérieures
      // à ce champ) tombent à 0 et se retrouvent en fin de liste, les plus
      // anciens donc — ce qui est le bon défaut.
      sorted.sort(
        (a, b) =>
          (b.addedAt || 0) - (a.addedAt || 0) || byTitle(a, b)
      );
      break;

    case 'title':
    default:
      sorted.sort(byTitle);
      break;
  }

  return sorted;
}