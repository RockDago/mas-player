import { Platform, PermissionsAndroid } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { Directory } from 'expo-file-system';
import JSZip from 'jszip';
import { Track } from '../types/audio';
import { persistAudioFile } from '../utils/audioStorage';
import { saveWebAudioBlob } from './webAudioStorage';

/**
 * Demande les permissions de stockage et d'accès aux fichiers audio sur Android.
 * - Sur Android 13+ (API 33+) : android.permission.READ_MEDIA_AUDIO
 * - Sur Android 12 et versions antérieures : android.permission.READ_EXTERNAL_STORAGE
 */
export async function requestAndroidStoragePermission(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;

  try {
    const apiLevel =
      typeof Platform.Version === 'number'
        ? Platform.Version
        : parseInt(String(Platform.Version), 10);

    if (apiLevel >= 33) {
      const permission = 'android.permission.READ_MEDIA_AUDIO' as any;
      const hasPermission = await PermissionsAndroid.check(permission);
      if (hasPermission) return true;

      const status = await PermissionsAndroid.request(permission, {
        title: 'Accès aux fichiers audio',
        message:
          'MAS Player a besoin d’accéder à vos fichiers audio pour lire vos morceaux directement depuis votre stockage sans les dupliquer.',
        buttonPositive: 'Autoriser',
        buttonNegative: 'Refuser',
      });
      return status === PermissionsAndroid.RESULTS.GRANTED;
    } else {
      const permission = PermissionsAndroid.PERMISSIONS.READ_EXTERNAL_STORAGE;
      const hasPermission = await PermissionsAndroid.check(permission);
      if (hasPermission) return true;

      const status = await PermissionsAndroid.request(permission, {
        title: 'Accès au stockage',
        message:
          'MAS Player a besoin d’accéder à votre stockage pour lire vos morceaux directement depuis votre appareil sans les dupliquer.',
        buttonPositive: 'Autoriser',
        buttonNegative: 'Refuser',
      });
      return status === PermissionsAndroid.RESULTS.GRANTED;
    }
  } catch (err) {
    console.warn('[Permissions] Erreur demande permission stockage Android:', err);
    return false;
  }
}

/**
 * Vérifie si un morceau existe déjà dans la bibliothèque pour éviter les doublons
 */
export function isTrackDuplicate(
  title: string,
  artist: string,
  fileName: string,
  folderName: string,
  existingTracks?: Track[]
): boolean {
  if (!existingTracks || existingTracks.length === 0) return false;
  const normTitle = (title || '').trim().toLowerCase();
  const normArtist = (artist || '').trim().toLowerCase();
  const normFile = (fileName || '').trim().toLowerCase();
  const normFolder = (folderName || '').trim().toLowerCase();

  return existingTracks.some((t) => {
    const tTitle = (t.title || '').trim().toLowerCase();
    const tArtist = (t.artist || '').trim().toLowerCase();
    const tFile = (t.folderPath || t.uri || '').split('/').pop()?.toLowerCase() || '';
    const tFolder = (t.folder || t.album || '').trim().toLowerCase();

    // Même titre et même artiste
    if (normTitle && tTitle === normTitle && normArtist && tArtist === normArtist) {
      return true;
    }
    // Même nom de fichier dans le même dossier
    if (normFile && tFile === normFile && normFolder && tFolder === normFolder) {
      return true;
    }
    return false;
  });
}

const AUDIO_EXTENSIONS = new Set([
  'mp3',
  'flac',
  'wav',
  'aac',
  'm4a',
  'ogg',
  'oga',
  'opus',
  'wma',
  'alac',
  'aiff',
  'aif',
  'caf',
  'webm',
]);

export interface ImportFolderResult {
  tracks: Track[];
  folderName: string;
  count: number;
}

export interface ImportFilesResult {
  tracks: Track[];
  count: number;
}

/**
 * Tente de déterminer la durée exacte d'un fichier audio via l'API Web Audio / HTML5 Audio
 */
export function getWebAudioDuration(url: string, timeoutMs: number = 2000): Promise<number> {
  return new Promise((resolve) => {
    if (typeof Audio === 'undefined') {
      resolve(0);
      return;
    }
    const tempAudio = new Audio();
    tempAudio.preload = 'metadata';
    let settled = false;

    const cleanup = () => {
      tempAudio.onloadedmetadata = null;
      tempAudio.onerror = null;
      try {
        tempAudio.src = '';
      } catch (_) {}
    };

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        resolve(0);
      }
    }, timeoutMs);

    tempAudio.onloadedmetadata = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        const dur = Math.round(tempAudio.duration || 0);
        cleanup();
        resolve(dur);
      }
    };

    tempAudio.onerror = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        cleanup();
        resolve(0);
      }
    };

    tempAudio.src = url;
  });
}

/**
 * Extrait le titre et l'artiste à partir du nom du fichier
 */
function parseTrackMetadata(fileName: string, fallbackFolder: string) {
  const baseName = fileName.replace(/\.[^/.]+$/, '').trim();

  if (baseName.includes(' - ')) {
    const parts = baseName.split(' - ');
    const rawArtist = parts[0].replace(/^[\d\s._-]+/, '').trim();
    const rawTitle = parts.slice(1).join(' - ').trim();
    return {
      title: rawTitle || baseName,
      artist: rawArtist || fallbackFolder || 'Artiste Inconnu',
    };
  }

  const cleanTitle = baseName.replace(/^[\d\s._-]+/, '').trim() || baseName;
  return {
    title: cleanTitle,
    artist: fallbackFolder || 'Artiste Inconnu',
  };
}

function getAudioFormat(extension: string): Track['format'] {
  const ext = extension.toUpperCase();
  if (ext === 'FLAC') return 'FLAC';
  if (ext === 'WAV') return 'WAV';
  if (ext === 'AAC' || ext === 'M4A') return 'AAC';
  if (ext === 'ALAC') return 'ALAC';
  return 'MP3';
}

/**
 * Détection si l'on est sur Safari / WebKit iOS (iPhone / iPad)
 */
export function isIOSDevice(): boolean {
  if (Platform.OS === 'ios') return true;
  if (Platform.OS === 'web' && typeof navigator !== 'undefined') {
    return (
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    );
  }
  return false;
}

/**
 * Scan récursif d'un Directory natif (iOS / Android)
 */
async function scanNativeDirectory(
  dir: any,
  relativePrefix: string = ''
): Promise<{ name: string; uri: string; relativePath: string }[]> {
  const audioList: { name: string; uri: string; relativePath: string }[] = [];
  try {
    const items = dir.list();
    for (const item of items) {
      // Si c'est un sous-dossier
      if (
        item instanceof Directory ||
        item?.constructor?.name === 'Directory' ||
        item?.isDirectory
      ) {
        const subResults = await scanNativeDirectory(
          item,
          `${relativePrefix}${item.name || 'Dossier'}/`
        );
        audioList.push(...subResults);
      } else if (item && item.name) {
        const ext = item.name.split('.').pop()?.toLowerCase() || '';
        if (AUDIO_EXTENSIONS.has(ext)) {
          audioList.push({
            name: item.name,
            uri: item.uri,
            relativePath: `${relativePrefix}${item.name}`,
          });
        }
      }
    }
  } catch (err) {
    console.warn('Erreur lecture sous-dossier natif:', err);
  }
  return audioList;
}

/**
 * Décompresse un fichier .zip contenant un album ou dossier musical (très utile sur iPhone / iPad)
 */
async function extractZipArchive(
  zipFile: File
): Promise<{ tracks: Track[]; folderName: string }> {
  const zip = new JSZip();
  const loadedZip = await zip.loadAsync(zipFile);
  const detectedFolder = zipFile.name.replace(/\.[^/.]+$/, '') || 'Album Importé';
  const tracks: Track[] = [];
  let idx = 0;

  for (const [relativePath, zipEntry] of Object.entries(loadedZip.files)) {
    if (zipEntry.dir) continue;
    const fileName = relativePath.split('/').pop() || '';
    const ext = fileName.split('.').pop()?.toLowerCase() || '';

    if (AUDIO_EXTENSIONS.has(ext)) {
      const blob = await zipEntry.async('blob');
      const uri = URL.createObjectURL(blob);
      const { title, artist } = parseTrackMetadata(fileName, detectedFolder);
      const format = getAudioFormat(ext);

      // Dossier / sous-dossier
      const parts = relativePath.split('/');
      let album = detectedFolder;
      if (parts.length > 2) {
        album = parts[parts.length - 2];
      }

      const trackId = `zip-${Date.now()}-${idx++}-${Math.random().toString(36).substring(2, 6)}`;
      void saveWebAudioBlob(trackId, blob, fileName);

      tracks.push({
        id: trackId,
        title,
        artist,
        album,
        duration: 0,
        uri,
        format,
        sampleRate: '44.1 kHz',
        bitrate: '320 kbps',
        folder: detectedFolder,
        folderPath: relativePath,
        addedAt: Date.now(),
      });
    }
  }

  // Récupérer les durées réelles
  await Promise.all(
    tracks.map(async (t) => {
      const dur = await getWebAudioDuration(t.uri, 2000);
      if (dur > 0) t.duration = dur;
    })
  );

  return { tracks, folderName: detectedFolder };
}

/**
 * IMPORTATION D'UN DOSSIER COMPLET EN UN SEUL CLIC
 * - Sur iOS Natif : Ouvre le Directory Picker natif iOS (UIDocumentPickerViewController mode dossier)
 * - Sur Web Desktop : Ouvre le sélecteur de dossier natif (webkitdirectory)
 * - Sur Safari iOS (Mobile) : Permet de choisir un dossier de musique complet, un .zip d'album, ou plusieurs pistes
 */
export async function pickAudioFolder(existingTracks?: Track[]): Promise<ImportFolderResult | null> {
  // 1. CAS ANDROID : Utilisation de StorageAccessFramework (sélecteur officiel et persistant de dossier Android)
  if (Platform.OS === 'android') {
    try {
      await requestAndroidStoragePermission();
      const permissions = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
      if (permissions && permissions.granted) {
        const directoryUri = permissions.directoryUri;
        const decodedDirUri = decodeURIComponent(directoryUri);
        const folderParts = decodedDirUri.split(/[:/]/);
        const folderName = folderParts[folderParts.length - 1] || 'Dossier Musique';

        const fileUris = await FileSystem.StorageAccessFramework.readDirectoryAsync(directoryUri);

        const audioFiles: { name: string; uri: string }[] = [];
        for (const fUri of fileUris) {
          const decoded = decodeURIComponent(fUri);
          const fileName = decoded.split('/').pop()?.split(':').pop() || '';
          const ext = fileName.split('.').pop()?.toLowerCase() || '';
          if (AUDIO_EXTENSIONS.has(ext)) {
            audioFiles.push({ name: fileName, uri: fUri });
          }
        }

        if (audioFiles.length > 0) {
          const tracks: Track[] = [];
          for (let idx = 0; idx < audioFiles.length; idx++) {
            const file = audioFiles[idx];
            const ext = file.name.split('.').pop()?.toLowerCase() || '';
            const format = getAudioFormat(ext);
            const { title, artist } = parseTrackMetadata(file.name, folderName);

            if (existingTracks && isTrackDuplicate(title, artist, file.name, folderName, existingTracks)) {
              continue;
            }

            const permanentUri = await persistAudioFile(file.uri, file.name);

            tracks.push({
              id: `android-folder-${Date.now()}-${idx}-${Math.random().toString(36).substring(2, 6)}`,
              title,
              artist,
              album: folderName,
              duration: 0,
              uri: permanentUri,
              format,
              sampleRate: '44.1 kHz',
              bitrate: '320 kbps',
              folder: folderName,
              folderPath: file.name,
              addedAt: Date.now(),
            });
          }

          return {
            tracks,
            folderName,
            count: tracks.length,
          };
        } else {
          return { tracks: [], folderName, count: 0 };
        }
      } else {
        return null;
      }
    } catch (safErr) {
      console.warn('Tentative StorageAccessFramework Android:', safErr);
    }
  }

  // 2. CAS IOS NATIF (Directory.pickDirectoryAsync)
  if (Platform.OS === 'ios') {
    try {
      if (typeof Directory !== 'undefined' && typeof Directory.pickDirectoryAsync === 'function') {
        const dir = await Directory.pickDirectoryAsync();
        if (dir) {
          const folderName = dir.name || 'Dossier Musique';
          const audioFiles = await scanNativeDirectory(dir);

          if (audioFiles.length > 0) {
            const tracks: Track[] = [];
            for (let idx = 0; idx < audioFiles.length; idx++) {
              const file = audioFiles[idx];
              const ext = file.name.split('.').pop()?.toLowerCase() || '';
              const format = getAudioFormat(ext);
              const { title, artist } = parseTrackMetadata(file.name, folderName);

              if (existingTracks && isTrackDuplicate(title, artist, file.name, folderName, existingTracks)) {
                continue;
              }

              const permanentUri = await persistAudioFile(file.uri, file.name);

              tracks.push({
                id: `ios-folder-${Date.now()}-${idx}-${Math.random().toString(36).substring(2, 6)}`,
                title,
                artist,
                album: folderName,
                duration: 0,
                uri: permanentUri,
                format,
                sampleRate: '44.1 kHz',
                bitrate: '320 kbps',
                folder: folderName,
                folderPath: file.relativePath || file.name,
                addedAt: Date.now(),
              });
            }

            return {
              tracks,
              folderName,
              count: tracks.length,
            };
          } else {
            return { tracks: [], folderName, count: 0 };
          }
        }
      }
    } catch (nativeErr: any) {
      if (
        nativeErr?.message?.includes?.('cancel') ||
        nativeErr?.name === 'FilePickingCancelledException'
      ) {
        return null;
      }
      console.warn('Tentative native Directory.pickDirectoryAsync:', nativeErr);
    }

    // Repli natif si le sélecteur de dossier échoue
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['public.folder', 'public.directory', 'audio/*', '*/*'],
        multiple: true,
        copyToCacheDirectory: true,
      });

      if (!result.canceled && result.assets && result.assets.length > 0) {
        const folderName = 'Dossier Importé';
        const tracks: Track[] = [];
        for (let idx = 0; idx < result.assets.length; idx++) {
          const file = result.assets[idx];
          const ext = file.name.split('.').pop()?.toLowerCase() || '';
          const format = getAudioFormat(ext);
          const { title, artist } = parseTrackMetadata(file.name, folderName);

          if (existingTracks && isTrackDuplicate(title, artist, file.name, folderName, existingTracks)) {
            continue;
          }

          const permanentUri = await persistAudioFile(file.uri, file.name);

          tracks.push({
            id: `ios-asset-${Date.now()}-${idx}-${Math.random().toString(36).substring(2, 6)}`,
            title,
            artist,
            album: folderName,
            duration: 0,
            uri: permanentUri,
            format,
            sampleRate: '44.1 kHz',
            bitrate: '320 kbps',
            folder: folderName,
            folderPath: file.name,
            addedAt: Date.now(),
          });
        }

        return {
          tracks,
          folderName,
          count: tracks.length,
        };
      }
      return null;
    } catch (err) {
      console.warn('Erreur DocumentPicker iOS:', err);
      return null;
    }
  }

  // 2. CAS WEB (Safari iOS ou Desktop Web)
  if (Platform.OS === 'web' && typeof document !== 'undefined') {
    const isMobileIOS = isIOSDevice();

    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.style.display = 'none';

      if (!isMobileIOS) {
        // Desktop Chrome, Edge, Firefox, macOS Safari : webkitdirectory permet de choisir le dossier
        input.setAttribute('webkitdirectory', '');
        input.setAttribute('directory', '');
      }

      // Toujours autoriser la sélection multiple et les formats audio + .zip
      input.setAttribute('multiple', '');
      input.setAttribute(
        'accept',
        'audio/*,.mp3,.flac,.wav,.aac,.m4a,.ogg,.opus,.zip,application/zip,application/x-zip-compressed'
      );

      let isResolved = false;

      const cleanup = () => {
        if (input.parentNode) {
          input.parentNode.removeChild(input);
        }
      };

      input.addEventListener('change', async (e: any) => {
        if (isResolved) return;
        isResolved = true;

        const files: FileList | null = input.files || (e.target && e.target.files);
        if (!files || files.length === 0) {
          cleanup();
          resolve(null);
          return;
        }

        const filesArray = Array.from(files);

        // A. Cas d'une archive .zip (ex: dossier d'album téléchargé sur iPhone / iPad)
        const zipFile = filesArray.find((f) => f.name.toLowerCase().endsWith('.zip'));
        if (zipFile) {
          try {
            const zipResult = await extractZipArchive(zipFile);
            cleanup();
            resolve({
              tracks: zipResult.tracks,
              folderName: zipResult.folderName,
              count: zipResult.tracks.length,
            });
            return;
          } catch (zipErr) {
            console.warn('Erreur extraction zip:', zipErr);
          }
        }

        // B. Cas des fichiers audio normaux ou dossier webkitdirectory
        const audioFiles: File[] = [];
        for (const file of filesArray) {
          const ext = file.name.split('.').pop()?.toLowerCase() || '';
          if (file.type.startsWith('audio/') || AUDIO_EXTENSIONS.has(ext)) {
            audioFiles.push(file);
          }
        }

        if (audioFiles.length === 0) {
          cleanup();
          resolve({ tracks: [], folderName: '', count: 0 });
          return;
        }

        // Détecter le nom du dossier
        let detectedFolder = 'Dossier Musique';
        const sampleRelative = audioFiles[0].webkitRelativePath;
        if (sampleRelative) {
          const parts = sampleRelative.split('/');
          if (parts.length > 1) {
            detectedFolder = parts[0];
          }
        } else if (isMobileIOS) {
          detectedFolder = 'Musique iPhone';
        }

        const tracks: Track[] = [];

        for (let i = 0; i < audioFiles.length; i++) {
          const file = audioFiles[i];
          const ext = file.name.split('.').pop()?.toLowerCase() || '';
          const format = getAudioFormat(ext);
          const relativePath = file.webkitRelativePath || file.name;

          let albumName = detectedFolder;
          let trackFolder = detectedFolder;
          if (file.webkitRelativePath) {
            const parts = file.webkitRelativePath.split('/');
            if (parts.length > 2) {
              albumName = parts[parts.length - 2];
            }
            if (parts.length > 1) {
              trackFolder = parts[0];
            }
          }

          const { title, artist } = parseTrackMetadata(file.name, detectedFolder);

          // Éviter les doublons
          if (existingTracks && isTrackDuplicate(title, artist, file.name, trackFolder, existingTracks)) {
            continue;
          }

          const trackId = `folder-${Date.now()}-${i}-${Math.random().toString(36).substring(2, 6)}`;
          const uri = URL.createObjectURL(file);

          // Sauvegarde persistante dans IndexedDB pour que les musiques ne soient jamais corrompues après rafraîchissement
          void saveWebAudioBlob(trackId, file, file.name, file.type);

          tracks.push({
            id: trackId,
            title,
            artist,
            album: albumName,
            duration: 0,
            uri,
            format,
            sampleRate: '44.1 kHz',
            bitrate: '320 kbps',
            folder: trackFolder,
            folderPath: relativePath,
            addedAt: Date.now(),
          });
        }

        // Récupérer les durées réelles avant de renvoyer les morceaux
        await Promise.all(
          tracks.map(async (t) => {
            const dur = await getWebAudioDuration(t.uri, 2000);
            if (dur > 0) t.duration = dur;
          })
        );

        cleanup();
        resolve({
          tracks,
          folderName: detectedFolder,
          count: tracks.length,
        });
      });

      input.addEventListener('cancel', () => {
        if (!isResolved) {
          isResolved = true;
          cleanup();
          resolve(null);
        }
      });

      document.body.appendChild(input);
      input.click();
    });
  }

  return null;
}

/**
 * IMPORTATION DE FICHIERS INDIVIDUELS
 */
export async function pickAudioFiles(existingTracks?: Track[]): Promise<ImportFilesResult | null> {
  if (Platform.OS === 'web' && typeof document !== 'undefined') {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.style.display = 'none';
      input.setAttribute(
        'accept',
        'audio/*,.mp3,.flac,.wav,.aac,.m4a,.ogg,.opus,.zip'
      );
      input.setAttribute('multiple', '');

      let isResolved = false;

      const cleanup = () => {
        if (input.parentNode) {
          input.parentNode.removeChild(input);
        }
      };

      input.addEventListener('change', async (e: any) => {
        if (isResolved) return;
        isResolved = true;

        const files: FileList | null = input.files || (e.target && e.target.files);
        if (!files || files.length === 0) {
          cleanup();
          resolve(null);
          return;
        }

        const filesArray = Array.from(files);
        const tracks: Track[] = [];

        for (let i = 0; i < filesArray.length; i++) {
          const file = filesArray[i];
          const ext = file.name.split('.').pop()?.toLowerCase() || '';

          if (ext === 'zip') {
            try {
              const zipRes = await extractZipArchive(file);
              for (const zTrack of zipRes.tracks) {
                if (!existingTracks || !isTrackDuplicate(zTrack.title, zTrack.artist, zTrack.title, zTrack.album, existingTracks)) {
                  tracks.push(zTrack);
                }
              }
              continue;
            } catch (err) {
              console.warn('Erreur zip:', err);
            }
          }

          const format = getAudioFormat(ext);
          const { title, artist } = parseTrackMetadata(file.name, 'Fichiers Importés');

          if (existingTracks && isTrackDuplicate(title, artist, file.name, 'Fichiers Locaux', existingTracks)) {
            continue;
          }

          const trackId = `file-${Date.now()}-${i}-${Math.random().toString(36).substring(2, 6)}`;
          const uri = URL.createObjectURL(file);

          // Sauvegarde persistante dans IndexedDB
          void saveWebAudioBlob(trackId, file, file.name, file.type);

          tracks.push({
            id: trackId,
            title,
            artist,
            album: 'Fichiers Locaux',
            duration: 0,
            uri,
            format,
            sampleRate: '44.1 kHz',
            bitrate: '320 kbps',
            folder: 'Fichiers Locaux',
            folderPath: file.name,
            addedAt: Date.now(),
          });
        }

        // Récupérer les durées réelles
        await Promise.all(
          tracks.map(async (t) => {
            const dur = await getWebAudioDuration(t.uri, 2000);
            if (dur > 0) t.duration = dur;
          })
        );

        cleanup();
        resolve({
          tracks,
          count: tracks.length,
        });
      });

      input.addEventListener('cancel', () => {
        if (!isResolved) {
          isResolved = true;
          cleanup();
          resolve(null);
        }
      });

      document.body.appendChild(input);
      input.click();
    });
  }

  // Fallback Native
  try {
    if (Platform.OS === 'android') {
      await requestAndroidStoragePermission();
    }

    const result = await DocumentPicker.getDocumentAsync({
      type: ['audio/*'],
      multiple: true,
      copyToCacheDirectory: Platform.OS === 'ios',
    });

    if (!result.canceled && result.assets && result.assets.length > 0) {
      const tracks: Track[] = [];
      for (let idx = 0; idx < result.assets.length; idx++) {
        const file = result.assets[idx];
        const ext = file.name.split('.').pop()?.toLowerCase() || '';
        const format = getAudioFormat(ext);
        const { title, artist } = parseTrackMetadata(file.name, 'Fichier Local');

        if (existingTracks && isTrackDuplicate(title, artist, file.name, 'Fichiers Locaux', existingTracks)) {
          continue;
        }

        const permanentUri = await persistAudioFile(file.uri, file.name);

        tracks.push({
          id: `file-${Date.now()}-${idx}-${Math.random().toString(36).substring(2, 6)}`,
          title,
          artist,
          album: 'Importation',
          duration: 0,
          uri: permanentUri,
          format,
          sampleRate: '44.1 kHz',
          bitrate: '320 kbps',
          folder: 'Fichiers Locaux',
          folderPath: file.name,
          addedAt: Date.now(),
        });
      }

      return {
        tracks,
        count: tracks.length,
      };
    }
    return null;
  } catch (err) {
    console.warn('Erreur sélection fichiers native:', err);
    return null;
  }
}
