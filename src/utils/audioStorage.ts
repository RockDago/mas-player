import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { Track } from '../types/audio';
import { saveWebAudioBlob, deleteWebAudioBlob } from '../services/webAudioStorage';

/**
 * Sous iOS et Android, le conteneur sandbox ou le chemin vers les fichiers
 * de l'application peut changer ou pointer vers l'ancien chemin après mise à jour.
 * Cette fonction réécrit dynamiquement l'URI stockée pour qu'elle pointe toujours
 * vers le conteneur `documentDirectory` ou `cacheDirectory` actif de l'application.
 */
export function resolveTrackUri(uri: string): string {
  if (!uri) return uri;

  // Sous Android : les URIs de type content:// ou pointant vers le stockage externe
  // (/storage/, /sdcard/) ne doivent pas être altérées
  if (Platform.OS === 'android') {
    if (uri.startsWith('content://') || uri.includes('/storage/') || uri.includes('/sdcard/')) {
      return uri;
    }
  }

  if (!uri.startsWith('file://')) {
    return uri;
  }

  const docDir = FileSystem.documentDirectory;
  if (!docDir) return uri;

  // Si l'URI pointe déjà vers le documentDirectory actif
  if (uri.startsWith(docDir)) {
    return uri;
  }

  // iOS: Si le chemin contient /Documents/
  const docIdx = uri.indexOf('/Documents/');
  if (docIdx !== -1) {
    const subPath = uri.substring(docIdx + '/Documents/'.length);
    return `${docDir}${subPath}`;
  }

  // Android & iOS: Si le chemin contient /files/
  const filesIdx = uri.indexOf('/files/');
  if (filesIdx !== -1) {
    const subPath = uri.substring(filesIdx + '/files/'.length);
    return `${docDir}${subPath}`;
  }

  // Si le chemin contient /Library/Caches/ ou /cache/
  const cacheDir = FileSystem.cacheDirectory;
  const cacheIdx = uri.indexOf('/Library/Caches/');
  if (cacheIdx !== -1 && cacheDir) {
    const subPath = uri.substring(cacheIdx + '/Library/Caches/'.length);
    return `${cacheDir}${subPath}`;
  }
  const androidCacheIdx = uri.indexOf('/cache/');
  if (androidCacheIdx !== -1 && cacheDir) {
    const subPath = uri.substring(androidCacheIdx + '/cache/'.length);
    return `${cacheDir}${subPath}`;
  }

  return uri;
}

/**
 * Normalise une piste ou une liste de pistes en s'assurant que leurs URIs
 * pointent vers le répertoire actuel du sandbox.
 */
export function normalizeTrack(track: Track): Track {
  if (!track) return track;
  const resolved = resolveTrackUri(track.uri);
  if (resolved !== track.uri) {
    return { ...track, uri: resolved };
  }
  return track;
}

export function normalizeTracks(tracks: Track[]): Track[] {
  if (!Array.isArray(tracks)) return [];
  return tracks.map(normalizeTrack);
}

/**
 * Sauvegarde d'un fichier audio :
 * - Web : persistance dans IndexedDB (Blob permanent).
 * - iOS : copie obligatoire dans le conteneur sandbox de l'application
 *   (FileSystem.documentDirectory/tracks/) car iOS révoque l'accès hors sandbox dès la fermeture du sélecteur.
 * - Android : PAS de copie dans les données de l'application !
 *   La musique est lue directement depuis son emplacement d'origine sur l'appareil (sans dupliquer le fichier).
 */
export async function persistAudioFile(
  sourceUri: string,
  originalName: string,
  webBlob?: Blob,
  trackId?: string
): Promise<string> {
  if (Platform.OS === 'web') {
    if (webBlob && trackId) {
      try {
        await saveWebAudioBlob(trackId, webBlob, originalName);
      } catch (err) {
        console.warn('[Storage] Erreur sauvegarde Web IndexedDB:', err);
      }
    }
    return sourceUri;
  }

  // Sous Android : pas de copie dans les données de l'application.
  // Le morceau est joué directement depuis son emplacement de stockage (content:// ou file://)
  if (Platform.OS === 'android') {
    return sourceUri;
  }

  // Sous iOS uniquement : le conteneur sandbox nécessite la persistance
  // dans FileSystem.documentDirectory/tracks/ pour conserver l'accès au fichier
  if (!FileSystem.documentDirectory) {
    return sourceUri;
  }

  try {
    const tracksDir = `${FileSystem.documentDirectory}tracks/`;
    const dirInfo = await FileSystem.getInfoAsync(tracksDir);
    if (!dirInfo.exists) {
      await FileSystem.makeDirectoryAsync(tracksDir, { intermediates: true });
    }

    // Nom de fichier propre et unique
    const sanitized = (originalName || 'audio_track').replace(/[^a-zA-Z0-9._-]/g, '_');
    const uniqueFileName = `${Date.now()}_${Math.random().toString(36).substring(2, 7)}_${sanitized}`;
    const destinationUri = `${tracksDir}${uniqueFileName}`;

    await FileSystem.copyAsync({
      from: sourceUri,
      to: destinationUri,
    });

    return destinationUri;
  } catch (error) {
    console.warn('[Storage] Erreur copie du fichier audio vers documentDirectory/tracks:', error);
    return sourceUri;
  }
}

/**
 * Supprime un fichier audio du stockage interne de l'application :
 * - Web : suppression du Blob dans IndexedDB.
 * - iOS : suppression du fichier dupliqué dans documentDirectory/tracks/.
 * - Android : AUCUNE suppression physique car le fichier appartient à la musique personnelle de l'utilisateur.
 */
export async function deletePersistedAudioFile(uri: string, trackId?: string): Promise<void> {
  if (Platform.OS === 'web') {
    if (trackId) {
      await deleteWebAudioBlob(trackId);
    }
    return;
  }

  // Sous Android : ne jamais supprimer le fichier original de l'utilisateur sur son stockage
  if (Platform.OS === 'android') {
    return;
  }

  if (!uri) return;

  try {
    const resolved = resolveTrackUri(uri);
    if (resolved && (resolved.includes('/tracks/') || resolved.includes(FileSystem.documentDirectory || ''))) {
      const info = await FileSystem.getInfoAsync(resolved);
      if (info.exists) {
        await FileSystem.deleteAsync(resolved, { idempotent: true });
      }
    }
  } catch (err) {
    console.warn('[Storage] Erreur suppression fichier local:', err);
  }
}

