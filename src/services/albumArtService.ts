import { Track } from '../types/audio';
import { AppSettings } from './storageService';

const artworkMemoryCache = new Map<string, string>();

/**
 * Nettoie une chaîne de titre ou d'artiste pour maximiser le taux de correspondance de l'API.
 * Supprime les mentions comme [Official Audio], (feat. ...), .mp3, etc.
 */
function cleanQueryTerm(text: string): string {
  if (!text) return '';
  return text
    .replace(/\.(mp3|flac|wav|m4a|aac|ogg|opus)$/i, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\([^)]*(feat|ft|official|remix|edit|prod)[^)]*\)/gi, '')
    .replace(/[_-]+/g, ' ')
    .trim();
}

/**
 * Recherche et télécharge l'URL de la pochette officielle en haute définition
 * via l'API publique iTunes Search (rapide, sans clé, gratuite et fiable).
 */
export async function fetchAlbumArtForTrack(
  title: string,
  artist?: string,
  highQuality: boolean = true
): Promise<string | null> {
  const cleanTitle = cleanQueryTerm(title);
  const cleanArtist = cleanQueryTerm(artist || '');

  if (!cleanTitle && !cleanArtist) return null;

  const cacheKey = `${cleanArtist} - ${cleanTitle}`.toLowerCase();
  if (artworkMemoryCache.has(cacheKey)) {
    return artworkMemoryCache.get(cacheKey) || null;
  }

  try {
    const query = [cleanArtist, cleanTitle].filter(Boolean).join(' ');
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(
      query
    )}&entity=song&limit=1`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!res.ok) return null;

    const data = await res.json();
    if (data.resultCount > 0 && data.results[0]?.artworkUrl100) {
      let rawArtwork: string = data.results[0].artworkUrl100;
      // Convertit la miniature 100x100 en HD 600x600 ou standard 300x300
      const targetSize = highQuality ? '600x600bb' : '300x300bb';
      const hdArtwork = rawArtwork.replace('100x100bb', targetSize);

      artworkMemoryCache.set(cacheKey, hdArtwork);
      return hdArtwork;
    } else {
      // Aucun résultat trouvé sur le store officiel : mémoriser pour éviter de requêter en boucle
      artworkMemoryCache.set(cacheKey, '');
      return null;
    }
  } catch (err) {
    // Échec réseau ou timeout passager : ne pas polluer le cache pour permettre un nouvel essai
  }

  return null;
}

/**
 * Scanne la liste des morceaux et télécharge automatiquement les pochettes
 * pour tous ceux qui n'en possèdent pas encore.
 */
export async function downloadMissingArtworks(
  tracks: Track[],
  highQuality: boolean = true,
  onProgress?: (processed: number, total: number, found: number) => void
): Promise<{ updatedTracks: Track[]; addedCount: number }> {
  const missingTracks = tracks.filter((t) => !t.artwork || t.artwork.trim() === '');
  if (missingTracks.length === 0) {
    return { updatedTracks: tracks, addedCount: 0 };
  }

  const trackArtMap = new Map<string, string>();
  let addedCount = 0;
  let processed = 0;

  for (const track of missingTracks) {
    processed++;
    const artworkUrl = await fetchAlbumArtForTrack(
      track.title,
      track.artist,
      highQuality
    );

    if (artworkUrl) {
      trackArtMap.set(track.id, artworkUrl);
      addedCount++;
    }

    onProgress?.(processed, missingTracks.length, addedCount);
  }

  const updatedTracks = tracks.map((t) => {
    const newArt = trackArtMap.get(t.id);
    if (newArt) {
      return { ...t, artwork: newArt };
    }
    return t;
  });

  return { updatedTracks, addedCount };
}

/**
 * Vide le cache mémoire des pochettes.
 */
export function clearArtworkCache(): void {
  artworkMemoryCache.clear();
}
