import { Platform } from 'react-native';
import { Track } from '../types/audio';

const DB_NAME = 'MASPlayerAudioDB';
const DB_VERSION = 1;
const STORE_NAME = 'audio_blobs';

export interface StoredAudioBlob {
  id: string;
  blob: Blob;
  name: string;
  mimeType: string;
  duration?: number;
  updatedAt: number;
}

// Cache local en mémoire des ObjectURLs créés dans la session courante
const liveObjectUrls = new Map<string, string>();

/**
 * Vérifie si IndexedDB est supporté sur la plateforme courante
 */
export function isWebStorageAvailable(): boolean {
  return (
    Platform.OS === 'web' &&
    typeof window !== 'undefined' &&
    typeof window.indexedDB !== 'undefined'
  );
}

/**
 * Ouvre ou initialise la base IndexedDB
 */
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!isWebStorageAvailable()) {
      reject(new Error('IndexedDB non disponible'));
      return;
    }

    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event: any) => {
      const db = event.target.result as IDBDatabase;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };

    request.onsuccess = (event: any) => {
      resolve(event.target.result as IDBDatabase);
    };

    request.onerror = (event: any) => {
      reject(event.target.error || new Error('Erreur ouverture IndexedDB'));
    };
  });
}

/**
 * Enregistre de manière permanente le Blob d'un morceau audio dans IndexedDB
 */
export async function saveWebAudioBlob(
  trackId: string,
  blob: Blob,
  name: string = 'track.mp3',
  mimeType: string = 'audio/mpeg',
  duration?: number
): Promise<void> {
  if (!isWebStorageAvailable()) return;

  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);

      const record: StoredAudioBlob = {
        id: trackId,
        blob,
        name,
        mimeType: mimeType || blob.type || 'audio/mpeg',
        duration: duration && duration > 0 ? duration : undefined,
        updatedAt: Date.now(),
      };

      const req = store.put(record);
      req.onsuccess = () => resolve();
      req.onerror = (e: any) => reject(e.target.error);
    });
  } catch (err) {
    console.warn('[WebAudioStorage] Erreur sauvegarde IndexedDB:', err);
  }
}

/**
 * Récupère le Blob d'un morceau depuis IndexedDB
 */
export async function getWebAudioBlob(trackId: string): Promise<Blob | null> {
  if (!isWebStorageAvailable() || !trackId) return null;

  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(trackId);

      req.onsuccess = () => {
        const record = req.result as StoredAudioBlob | undefined;
        resolve(record ? record.blob : null);
      };
      req.onerror = () => resolve(null);
    });
  } catch (err) {
    console.warn('[WebAudioStorage] Erreur lecture IndexedDB:', err);
    return null;
  }
}

/**
 * Supprime le Blob d'un morceau de IndexedDB
 */
export async function deleteWebAudioBlob(trackId: string): Promise<void> {
  if (!isWebStorageAvailable() || !trackId) return;

  // Révoquer l'URL active si existante
  if (liveObjectUrls.has(trackId)) {
    try {
      URL.revokeObjectURL(liveObjectUrls.get(trackId)!);
    } catch (_) {}
    liveObjectUrls.delete(trackId);
  }

  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(trackId);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
    });
  } catch (err) {
    console.warn('[WebAudioStorage] Erreur suppression morceau IndexedDB:', err);
  }
}

/**
 * Supprime une liste de morceaux (ex: suppression de dossier)
 */
export async function deleteWebAudioBlobs(trackIds: string[]): Promise<void> {
  if (!isWebStorageAvailable() || !trackIds || trackIds.length === 0) return;

  for (const id of trackIds) {
    if (liveObjectUrls.has(id)) {
      try {
        URL.revokeObjectURL(liveObjectUrls.get(id)!);
      } catch (_) {}
      liveObjectUrls.delete(id);
    }
  }

  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      for (const id of trackIds) {
        store.delete(id);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch (err) {
    console.warn('[WebAudioStorage] Erreur suppression multiple IndexedDB:', err);
  }
}

/**
 * Vérifie si une URL de type blob est toujours vivante et valide.
 */
export async function isBlobUrlAlive(blobUrl: string): Promise<boolean> {
  if (!blobUrl || !blobUrl.startsWith('blob:')) return true;
  try {
    const res = await fetch(blobUrl, { method: 'HEAD' });
    return res.ok || res.status === 200 || res.type === 'basic';
  } catch {
    return false;
  }
}

/**
 * Fournit une URL active et valide pour un morceau donné.
 * Si l'URL actuelle est morte (ex: après un rafraîchissement F5 de page web / Safari iOS),
 * elle est automatiquement recréée à partir du Blob sauvegardé dans IndexedDB.
 */
export async function getLiveWebTrackUri(trackId: string, currentUri: string): Promise<string> {
  if (!isWebStorageAvailable()) return currentUri;

  // Si on a déjà créé une URL vivante pour cette session
  if (liveObjectUrls.has(trackId)) {
    return liveObjectUrls.get(trackId)!;
  }

  // Tenter de récupérer le blob depuis IndexedDB
  const blob = await getWebAudioBlob(trackId);
  if (blob) {
    const newUri = URL.createObjectURL(blob);
    liveObjectUrls.set(trackId, newUri);
    return newUri;
  }

  return currentUri;
}

/**
 * Réconcilie et ré-hydrate l'ensemble des pistes restaurées au lancement de l'application.
 * Remplace les URIs blob périmées par de nouvelles URLs vivantes issues d'IndexedDB.
 */
export async function restoreWebAudioBlobs(tracks: Track[]): Promise<Track[]> {
  if (!isWebStorageAvailable() || !Array.isArray(tracks) || tracks.length === 0) {
    return tracks;
  }

  try {
    const db = await openDB();
    const records = await new Promise<Map<string, StoredAudioBlob>>((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();

      req.onsuccess = () => {
        const map = new Map<string, StoredAudioBlob>();
        const list = (req.result || []) as StoredAudioBlob[];
        for (const item of list) {
          map.set(item.id, item);
        }
        resolve(map);
      };
      req.onerror = () => resolve(new Map());
    });

    return tracks.map((track) => {
      const record = records.get(track.id);
      if (record && record.blob) {
        let liveUri = liveObjectUrls.get(track.id);
        if (!liveUri) {
          liveUri = URL.createObjectURL(record.blob);
          liveObjectUrls.set(track.id, liveUri);
        }

        const dur = (track.duration && track.duration > 0)
          ? track.duration
          : (record.duration && record.duration > 0 ? record.duration : 0);

        return {
          ...track,
          uri: liveUri,
          duration: dur,
        };
      }
      return track;
    });
  } catch (err) {
    console.warn('[WebAudioStorage] Erreur réconciliation des morceaux:', err);
    return tracks;
  }
}
