import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { createAudioPlayer } from 'expo-audio';
import { Track } from '../types/audio';

/**
 * Service universel d'extraction et d'enrichissement de durée audio.
 * Fonctionne sur Web, Android et iOS.
 *
 * Utilise une stratégie à 3 niveaux :
 * 1. Analyseur d'en-tête natif ultra-rapide (~1 ms, lit les premiers octets sans charger d'AudioContext) :
 *    - MP3 : En-tête ID3v2 + Xing/Info VBR/CBR header ou débit binaire
 *    - M4A / AAC / MP4 : Atome mvhd (timescale / duration)
 *    - WAV / RIFF : Chunk fmt (sample rate) + data (longueur en octets)
 *    - FLAC : Bloc STREAMINFO (échantillons totaux / fréquence)
 * 2. Moteur natif expo-audio createAudioPlayer (fallback fiable si l'en-tête est atypique)
 * 3. HTML5 Audio (Web)
 */

/** Décodage Base64 vers Uint8Array sans dépendance externe */
function base64ToUint8Array(base64: string): Uint8Array {
  const cleanBase64 = base64.replace(/[\r\n\s]/g, '');
  const binaryString = atob(cleanBase64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/** Tente d'extraire la durée en secondes depuis les métadonnées binaires d'un fichier audio */
async function parseAudioHeaderDuration(uri: string): Promise<number> {
  try {
    if (Platform.OS === 'web') return 0;

    // Lire les 8192 premiers octets (suffisant pour ID3v2 + premier frame MP3, FLAC STREAMINFO, WAV fmt/data, M4A ftyp/mvhd)
    const base64Chunk = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
      position: 0,
      length: 8192,
    });

    if (!base64Chunk || base64Chunk.length === 0) return 0;
    const bytes = base64ToUint8Array(base64Chunk);
    if (bytes.length < 16) return 0;

    // ── 1. WAV / RIFF ──────────────────────────────────────────────────────────
    if (
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && // "RIFF"
      bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45    // "WAVE"
    ) {
      let offset = 12;
      let byteRate = 0;
      let dataSize = 0;

      while (offset + 8 <= bytes.length) {
        const chunkId = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
        const chunkSize = ((bytes[offset + 4] | (bytes[offset + 5] << 8) | (bytes[offset + 6] << 16) | (bytes[offset + 7] << 24)) >>> 0);

        if (chunkId === 'fmt ' && offset + 16 <= bytes.length) {
          byteRate = ((bytes[offset + 16] | (bytes[offset + 17] << 8) | (bytes[offset + 18] << 16) | (bytes[offset + 19] << 24)) >>> 0);
        } else if (chunkId === 'data') {
          dataSize = chunkSize;
          break;
        }
        offset += 8 + chunkSize;
      }

      if (byteRate > 0 && dataSize > 0) {
        return Math.round(dataSize / byteRate);
      }
    }

    // ── 2. FLAC ────────────────────────────────────────────────────────────────
    if (bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43) { // "fLaC"
      // Le bloc STREAMINFO fait 34 octets (offset 4 à 38)
      if (bytes.length >= 38) {
        const sr1 = bytes[18];
        const sr2 = bytes[19];
        const sr3 = bytes[20];
        const sampleRate = (sr1 << 12) | (sr2 << 4) | (sr3 >> 4);

        // Échantillons totaux sur 36 bits (offset 21..25)
        const s1 = bytes[21] & 0x0f;
        const s2 = bytes[22];
        const s3 = bytes[23];
        const s4 = bytes[24];
        const s5 = bytes[25];
        const totalSamples = s1 * 4294967296 + ((s2 << 24) | (s3 << 16) | (s4 << 8) | s5);

        if (sampleRate > 0 && totalSamples > 0) {
          return Math.round(totalSamples / sampleRate);
        }
      }
    }

    // ── 3. M4A / AAC / MP4 (recherche de l'atome mvhd) ──────────────────────────
    // Format ISO Base Media File : recherche récursive ou linéaire de "mvhd"
    for (let i = 0; i <= bytes.length - 24; i++) {
      if (bytes[i] === 0x6d && bytes[i + 1] === 0x76 && bytes[i + 2] === 0x68 && bytes[i + 3] === 0x64) { // "mvhd"
        const version = bytes[i + 4];
        let timescale = 0;
        let durationUnits = 0;

        if (version === 0 && i + 20 <= bytes.length) {
          timescale = ((bytes[i + 12] << 24) | (bytes[i + 13] << 16) | (bytes[i + 14] << 8) | bytes[i + 15]) >>> 0;
          durationUnits = ((bytes[i + 16] << 24) | (bytes[i + 17] << 16) | (bytes[i + 18] << 8) | bytes[i + 19]) >>> 0;
        } else if (version === 1 && i + 32 <= bytes.length) {
          timescale = ((bytes[i + 20] << 24) | (bytes[i + 21] << 16) | (bytes[i + 22] << 8) | bytes[i + 23]) >>> 0;
          const durHigh = ((bytes[i + 24] << 24) | (bytes[i + 25] << 16) | (bytes[i + 26] << 8) | bytes[i + 27]) >>> 0;
          const durLow = ((bytes[i + 28] << 24) | (bytes[i + 29] << 16) | (bytes[i + 30] << 8) | bytes[i + 31]) >>> 0;
          durationUnits = durHigh * 4294967296 + durLow;
        }

        if (timescale > 0 && durationUnits > 0) {
          return Math.round(durationUnits / timescale);
        }
      }
    }

    // ── 4. MP3 (ID3v2 + en-tête de trame MPEG avec Xing/Info ou CBR) ─────────────
    let mpegOffset = 0;
    let id3Size = 0;

    // Détecter tag ID3v2
    if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) { // "ID3"
      id3Size =
        ((bytes[6] & 0x7f) << 21) |
        ((bytes[7] & 0x7f) << 14) |
        ((bytes[8] & 0x7f) << 7) |
        (bytes[9] & 0x7f);
      id3Size += 10; // taille du header ID3
      mpegOffset = id3Size;
    }

    // Si le tag ID3 est très grand et dépasse notre premier buffer de 8 Ko, relire au bon offset
    let frameBytes = bytes;
    if (mpegOffset > 0 && mpegOffset >= bytes.length - 64) {
      try {
        const nextChunk = await FileSystem.readAsStringAsync(uri, {
          encoding: FileSystem.EncodingType.Base64,
          position: mpegOffset,
          length: 4096,
        });
        if (nextChunk) {
          frameBytes = base64ToUint8Array(nextChunk);
          mpegOffset = 0;
        }
      } catch (_) {}
    }

    // Trouver le synchronisateur de trame MPEG (0xFF suivi de 0xE0 à 0xFF)
    for (let i = mpegOffset; i < frameBytes.length - 40; i++) {
      if (frameBytes[i] === 0xff && (frameBytes[i + 1] & 0xe0) === 0xe0) {
        const b1 = frameBytes[i + 1];
        const b2 = frameBytes[i + 2];
        const mpegVersionId = (b1 >> 3) & 0x03; // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
        const layerId = (b1 >> 1) & 0x03;       // 1 = Layer III, 2 = Layer II, 3 = Layer I
        const bitrateIdx = (b2 >> 4) & 0x0f;
        const sampleRateIdx = (b2 >> 2) & 0x03;
        const channelMode = (frameBytes[i + 3] >> 6) & 0x03;

        if (mpegVersionId === 1 || layerId === 0 || bitrateIdx === 0 || bitrateIdx === 15 || sampleRateIdx === 3) {
          continue; // Pas un en-tête valide
        }

        const isMpeg1 = mpegVersionId === 3;
        const sampleRatesMpeg1 = [44100, 48000, 32000];
        const sampleRatesMpeg2 = [22050, 24000, 16000];
        const sampleRate = isMpeg1 ? sampleRatesMpeg1[sampleRateIdx] : sampleRatesMpeg2[sampleRateIdx];

        const bitratesMpeg1L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
        const bitratesMpeg2L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
        const kbps = isMpeg1 ? (bitratesMpeg1L3[bitrateIdx] || 128) : (bitratesMpeg2L3[bitrateIdx] || 64);

        const samplesPerFrame = isMpeg1 ? 1152 : 576;
        const sideInfoSize = isMpeg1 ? (channelMode === 3 ? 17 : 32) : (channelMode === 3 ? 9 : 17);
        const xingOffset = i + 4 + sideInfoSize;

        // Rechercher l'en-tête VBR "Xing" ou "Info"
        if (xingOffset + 12 < frameBytes.length) {
          const tag = String.fromCharCode(
            frameBytes[xingOffset],
            frameBytes[xingOffset + 1],
            frameBytes[xingOffset + 2],
            frameBytes[xingOffset + 3]
          );

          if (tag === 'Xing' || tag === 'Info') {
            const flags =
              (frameBytes[xingOffset + 4] << 24) |
              (frameBytes[xingOffset + 5] << 16) |
              (frameBytes[xingOffset + 6] << 8) |
              frameBytes[xingOffset + 7];

            // Si le flag 0x0001 (frames count) est présent
            if (flags & 0x0001) {
              const framesCount =
                ((frameBytes[xingOffset + 8] << 24) |
                (frameBytes[xingOffset + 9] << 16) |
                (frameBytes[xingOffset + 10] << 8) |
                frameBytes[xingOffset + 11]) >>> 0;

              if (framesCount > 0 && sampleRate > 0) {
                return Math.round((framesCount * samplesPerFrame) / sampleRate);
              }
            }
          }
        }

        // Si pas de Xing/Info : estimation CBR basée sur la taille du fichier
        try {
          const info = await FileSystem.getInfoAsync(uri);
          if (info.exists && info.size && info.size > 0 && kbps > 0) {
            const audioDataSize = Math.max(0, info.size - id3Size);
            const calculatedSec = Math.round((audioDataSize * 8) / (kbps * 1000));
            if (calculatedSec > 0) return calculatedSec;
          }
        } catch (_) {}

        break;
      }
    }
  } catch (_) {
    // Si l'accès au fichier échoue, on continue vers le fallback natif
  }

  return 0;
}

/** Tente d'extraire la durée via le lecteur natif expo-audio (court cycle sans son) */
function getNativeAudioPlayerDuration(uri: string, timeoutMs: number = 1200): Promise<number> {
  return new Promise((resolve) => {
    let p: any = null;
    let sub: any = null;
    let settled = false;

    const cleanup = () => {
      try { sub?.remove?.(); } catch (_) {}
      try { p?.remove?.(); } catch (_) {}
    };

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        const dur = Math.round(p?.duration || 0);
        cleanup();
        resolve(dur > 0 ? dur : 0);
      }
    }, timeoutMs);

    try {
      p = createAudioPlayer(uri, { updateInterval: 100, keepAudioSessionActive: false });

      if (p?.duration && p.duration > 0) {
        settled = true;
        clearTimeout(timer);
        const dur = Math.round(p.duration);
        cleanup();
        resolve(dur);
        return;
      }

      sub = p.addListener('playbackStatusUpdate', (status: any) => {
        if (!settled && status?.duration && status.duration > 0) {
          settled = true;
          clearTimeout(timer);
          const dur = Math.round(status.duration);
          cleanup();
          resolve(dur);
        }
      });
    } catch (_) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        cleanup();
        resolve(0);
      }
    }
  });
}

/** Tente de déterminer la durée exacte d'un fichier audio via l'API Web Audio / HTML5 Audio */
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
 * Récupère la durée réelle d'un fichier audio en secondes.
 * Fonctionne pour n'importe quel fichier local ou distant, sur iOS, Android et Web.
 */
export async function getAudioDuration(uri: string): Promise<number> {
  if (!uri) return 0;

  // 1. Sur le Web : HTML5 Audio
  if (Platform.OS === 'web') {
    return await getWebAudioDuration(uri, 2000);
  }

  // 2. Sur Natif (Android & iOS) : Essai d'abord de l'analyseur d'en-tête binaire ultra-rapide
  const parsedDur = await parseAudioHeaderDuration(uri);
  if (parsedDur > 0) {
    return parsedDur;
  }

  // 3. Fallback natif via expo-audio player
  return await getNativeAudioPlayerDuration(uri, 1200);
}

/**
 * Enrichit une liste de morceaux avec leurs durées réelles en arrière-plan.
 * Traite les morceaux par petits lots pour ne jamais bloquer l'interface.
 */
export async function enrichTracksWithDuration(
  tracks: Track[],
  onTrackUpdated?: (updated: Track) => void,
  concurrency: number = 3
): Promise<Track[]> {
  const needsEnrichment = tracks.filter((t) => !t.duration || t.duration <= 0);
  if (needsEnrichment.length === 0) return tracks;

  const results = new Map<string, number>();

  for (let i = 0; i < needsEnrichment.length; i += concurrency) {
    const chunk = needsEnrichment.slice(i, i + concurrency);
    await Promise.all(
      chunk.map(async (t) => {
        try {
          const dur = await getAudioDuration(t.uri);
          if (dur > 0) {
            results.set(t.id, dur);
            t.duration = dur;
            onTrackUpdated?.(t);
          }
        } catch (_) {}
      })
    );
  }

  return tracks.map((t) => {
    const d = results.get(t.id);
    return d && d > 0 ? { ...t, duration: d } : t;
  });
}
