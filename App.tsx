import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  SafeAreaView,
  TouchableOpacity,
  Dimensions,
  ActivityIndicator,
  Platform,
  TextInput,
  Modal,
  FlatList,
  Image,
  AppState,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Haptics from 'expo-haptics';
import {
  Ionicons,
  MaterialCommunityIcons,
  Feather,
} from '@expo/vector-icons';

import { Track, DSPState, EqualizerPreset, Playlist } from './src/types/audio';
import { INITIAL_TRACKS } from './src/data/demoTracks';
import { DEFAULT_PRESETS } from './src/constants/presets';
import { formatTime } from './src/services/audioService';
import { playerManager } from './src/services/playerManager';
import {
  storageService,
  AppSettings,
  DEFAULT_APP_SETTINGS,
} from './src/services/storageService';
import { EqualizerView } from './src/components/EqualizerView';
import { BeatLogo } from './src/components/BeatLogo';
import { ProgressBar } from './src/components/ProgressBar';
import { TrackListModal } from './src/components/TrackListModal';
import { LibraryView } from './src/components/LibraryView';
import { SettingsModal } from './src/components/SettingsModal';
import { SongActionModal } from './src/components/SongActionModal';
import { QueueDrawerModal } from './src/components/QueueDrawerModal';
import { APP_VERSION } from './src/constants/version';

/**
 * Morceau de repli affiché quand la bibliothèque est vide.
 *
 * Sans lui, `tracks[currentTrackIndex] || tracks[0]` vaut `undefined` après la
 * suppression du dernier morceau, et le rendu déréférence `currentTrack.title`.
 * Ce n'est qu'un garde-fou : aucun son ne lui est associé, donc la lecture est
 * inerte tant que la bibliothèque est vide.
 */
const EMPTY_TRACK: Track = {
  id: '__empty__',
  title: 'Aucune piste',
  artist: 'Importez un morceau',
  album: '',
  duration: 0,
  uri: '',
};

// Apply global pure black background and title to document body on Web
if (Platform.OS === 'web' && typeof document !== 'undefined') {
  document.title = 'MAS Player';
  const styleEl = document.createElement('style');
  styleEl.innerHTML = `
    html, body, #root {
      background-color: #000000 !important;
      margin: 0 !important;
      padding: 0 !important;
      width: 100% !important;
      height: 100% !important;
      overflow: hidden !important;
      user-select: none;
    }
  `;
  document.head.appendChild(styleEl);
}

export default function App() {
  const [tracks, setTracks] = useState<Track[]>(INITIAL_TRACKS);
  const [currentTrackIndex, setCurrentTrackIndex] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [positionMillis, setPositionMillis] = useState<number>(10000);
  const [durationMillis, setDurationMillis] = useState<number>(209000); // 3:29
  const [isShuffle, setIsShuffle] = useState<boolean>(false);
  const [repeatMode, setRepeatMode] = useState<'off' | 'all' | 'one'>('all');

  // Persistence & Application settings
  const [appSettings, setAppSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [restoredNotice, setRestoredNotice] = useState<string | null>(null);

  // Synchronisation des références pour callbacks et écouteurs d'événements
  // Verrou de ré-entrance du passage automatique à la piste suivante : le
  // lecteur réémet `didFinish` tant que la nouvelle piste n'est pas chargée.
  const isAdvancingRef = useRef(false);
  const tracksRef = useRef<Track[]>(tracks);
  tracksRef.current = tracks;
  const currentTrackIndexRef = useRef<number>(currentTrackIndex);
  currentTrackIndexRef.current = currentTrackIndex;
  const positionMillisRef = useRef<number>(positionMillis);
  positionMillisRef.current = positionMillis;
  const durationMillisRef = useRef<number>(durationMillis);
  durationMillisRef.current = durationMillis;
  const appSettingsRef = useRef<AppSettings>(appSettings);
  appSettingsRef.current = appSettings;
  const isPlayingRef = useRef<boolean>(isPlaying);
  isPlayingRef.current = isPlaying;

  // Main navigation tab: 'player', 'library' or 'equalizer'
  const [currentTab, setCurrentTab] = useState<'player' | 'library' | 'equalizer'>('player');

  // Modals state
  const [isTrackListVisible, setIsTrackListVisible] = useState<boolean>(false);
  const [isSearchVisible, setIsSearchVisible] = useState<boolean>(false);
  const [isPresetsVisible, setIsPresetsVisible] = useState<boolean>(false);
  const [isSettingsVisible, setIsSettingsVisible] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [customPresets, setCustomPresets] = useState<EqualizerPreset[]>([]);

  // Playlists state avec listes par défaut
  const [playlists, setPlaylists] = useState<Playlist[]>([
    {
      id: 'pl-favorites',
      name: 'Coups de Cœur',
      description: 'Mes morceaux préférés',
      trackIds: ['demo-cyberpunk'],
      createdAt: Date.now(),
    },
    {
      id: 'pl-chill',
      name: 'Acoustic & Chill',
      description: 'Détente et mélodies',
      trackIds: ['demo-sweet-live'],
      createdAt: Date.now() - 100000,
    },
  ]);

  // Queue state (Morceaux programmés pour "Lire plus tard")
  const [queue, setQueue] = useState<Track[]>([]);
  const queueRef = useRef<Track[]>([]);
  queueRef.current = queue;

  // Context Action Menu, Queue Drawer & Sleep Timer states
  const [activeActionTrack, setActiveActionTrack] = useState<Track | null>(null);
  const [isActionModalVisible, setIsActionModalVisible] = useState<boolean>(false);
  const [isQueueDrawerVisible, setIsQueueDrawerVisible] = useState<boolean>(false);
  const [isSleepTimerVisible, setIsSleepTimerVisible] = useState<boolean>(false);
  const [sleepTimerMinutes, setSleepTimerMinutes] = useState<number | null>(null);

  // Vrai tant que le navigateur n'a pas autorisé la lecture (web uniquement)
  const [needsUserGesture, setNeedsUserGesture] = useState<boolean>(
    Platform.OS === 'web'
  );

  // Equalizer & Tone DSP state
  const [dsp, setDsp] = useState<DSPState>({
    enabled: true,
    presetId: 'bass-heavy',
    bass: 8,
    treble: 5,
    preamp: 0,
    stereoExpansion: 0,
    tempo: 1.0,
    bands: [8, 7, 5, 2, 0, 0, 1, 2, 3, 2],
    balance: 0.0,
    volume: 75,
    mono: false,
    tempoEnabled: false,
  });

  // Bibliothèque vide possible : supprimer le dernier morceau laisse `tracks`
// à `[]`, et les deux accès ci-dessous renverraient alors `undefined` — que le
// rendu déréférence (`currentTrack.title`), d'où un crash natif. On garde donc
// un objet de repli plutôt que de laisser fuire `undefined`.
const currentTrack = tracks[currentTrackIndex] || tracks[0] || EMPTY_TRACK;

  // Sync volume and playback tempo with audio player
  useEffect(() => {
    playerManager.setVolume(dsp.volume ?? 75);
    playerManager.setPlaybackRate(dsp.tempoEnabled ? (dsp.tempo ?? 1.0) : 1.0);
  }, [dsp.volume, dsp.tempo, dsp.tempoEnabled]);

  // Pousse la courbe d'égalisation complète vers le moteur audio.
  // `bands.join(',')` sert de dépendance : les faders créent un nouveau tableau
  // à chaque geste, et une comparaison par référenceylation ne se déclencherait
  // donc pas de façon fiable.
  useEffect(() => {
    playerManager.setDSP(dsp);
  }, [
    dsp.enabled,
    dsp.presetId,
    dsp.bass,
    dsp.treble,
    dsp.preamp,
    dsp.bands.join(','),
    dsp.balance,
    dsp.stereoExpansion,
    dsp.volume,
    dsp.mono,
  ]);

  // Auto-play audio & Restore previous session on startup
  useEffect(() => {
    let isMounted = true;
    (async () => {
      await playerManager.init();

      // Charger l'ensemble des données et paramètres sauvegardés
      const [
        savedSettings,
        savedDsp,
        savedModes,
        savedPlaylists,
        savedQueue,
        savedCustomTracks,
        savedLast,
        savedCustomPresets,
      ] = await Promise.all([
        storageService.getSettings(),
        storageService.getDSP(),
        storageService.getPlaybackModes(),
        storageService.getPlaylists(),
        storageService.getQueue(),
        storageService.getCustomTracks(),
        storageService.getLastPlayback(),
        storageService.getCustomPresets(),
      ]);

      if (!isMounted) return;

      if (savedSettings) {
        setAppSettings(savedSettings);
        appSettingsRef.current = savedSettings;
      }
      if (savedDsp) setDsp(savedDsp);
      if (savedCustomPresets && savedCustomPresets.length > 0) {
        setCustomPresets(savedCustomPresets);
      }
      if (savedModes) {
        setIsShuffle(savedModes.isShuffle);
        setRepeatMode(savedModes.repeatMode);
      }
      if (savedPlaylists && savedPlaylists.length > 0) {
        setPlaylists(savedPlaylists);
      }
      if (savedQueue && savedQueue.length > 0) {
        setQueue(savedQueue);
      }

      // Restauration de la bibliothèque musicale
      let currentTrackList = INITIAL_TRACKS;
      if (savedCustomTracks && savedCustomTracks.length > 0) {
        const uniqueCustom = savedCustomTracks.filter(
          (ct) => !INITIAL_TRACKS.some((it) => it.id === ct.id)
        );
        currentTrackList = [...INITIAL_TRACKS, ...uniqueCustom];
        setTracks(currentTrackList);
        tracksRef.current = currentTrackList;
      }

      // Restauration de la dernière musique et de la position d'écoute
      let targetIndex = 0;
      let resumePosMs = 0;
      const shouldRemember = savedSettings?.rememberLastTrack ?? true;
      const shouldAutoPlay = savedSettings?.autoPlayOnLaunch ?? false;

      if (shouldRemember && savedLast) {
        const foundIdx = currentTrackList.findIndex((t) => t.id === savedLast.trackId);
        if (foundIdx !== -1) {
          targetIndex = foundIdx;
        } else if (savedLast.trackIndex >= 0 && savedLast.trackIndex < currentTrackList.length) {
          targetIndex = savedLast.trackIndex;
        }

        if ((savedSettings?.rememberPlaybackPosition ?? true) && savedLast.positionMillis > 0) {
          resumePosMs = savedLast.positionMillis;
        }
      }

      await loadTrack(targetIndex, shouldAutoPlay, resumePosMs, currentTrackList);

      // Notification visuelle de reprise
      if (shouldRemember && savedLast && currentTrackList[targetIndex]) {
        const restoredTrack = currentTrackList[targetIndex];
        const timeStr = resumePosMs > 1000 ? ` • ${formatTime(resumePosMs / 1000)}` : '';
        setRestoredNotice(`Reprise : ${restoredTrack.title}${timeStr}`);
        setTimeout(() => setRestoredNotice(null), 3500);
      }
    })();

    return () => {
      isMounted = false;
      playerManager.release();
    };
  }, []);

  // Sauvegarde continue de la position d'écoute et de l'état
  const persistSession = () => {
    if (!appSettingsRef.current.rememberLastTrack) return;
    const curTrack = tracksRef.current[currentTrackIndexRef.current];
    if (!curTrack) return;

    storageService.saveLastPlayback({
      trackId: curTrack.id,
      trackIndex: currentTrackIndexRef.current,
      positionMillis: positionMillisRef.current,
      durationMillis: durationMillisRef.current,
      updatedAt: Date.now(),
    });
  };

  // Sauvegarde périodique (toutes les 2.5 secondes)
  useEffect(() => {
    const timer = setInterval(() => {
      if (isPlayingRef.current) {
        persistSession();
      }
    }, 2500);
    return () => clearInterval(timer);
  }, []);

  // Sauvegarde sur mise en arrière-plan (Native) ou fermeture de page (Web)
  useEffect(() => {
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      const handleUnload = () => persistSession();
      window.addEventListener('beforeunload', handleUnload);
      return () => window.removeEventListener('beforeunload', handleUnload);
    } else {
      const sub = AppState.addEventListener('change', (state) => {
        if (state === 'background' || state === 'inactive') {
          persistSession();
        }
      });
      return () => sub.remove();
    }
  }, []);

  // Sauvegarde automatique des réglages DSP dès modification
  useEffect(() => {
    storageService.saveDSP(dsp);
  }, [dsp]);

  // Sauvegarde des modes de lecture (shuffle / repeat)
  useEffect(() => {
    storageService.savePlaybackModes({ isShuffle, repeatMode });
  }, [isShuffle, repeatMode]);

  // Sauvegarde des playlists personnalisées
  useEffect(() => {
    storageService.savePlaylists(playlists);
  }, [playlists]);

  // Sauvegarde de la file d'attente
  useEffect(() => {
    storageService.saveQueue(queue);
  }, [queue]);

  // Sauvegarde des morceaux importés
  useEffect(() => {
    const customOnly = tracks.filter((t) => !INITIAL_TRACKS.some((it) => it.id === t.id));
    storageService.saveCustomTracks(customOnly);
  }, [tracks]);

  const handleUpdateSettings = async (newSettings: Partial<AppSettings>) => {
    const updated = await storageService.saveSettings(newSettings);
    setAppSettings(updated);
    appSettingsRef.current = updated;
  };

  const handleClearSession = async () => {
    await storageService.clearAllSessionData();
    setDsp({
      enabled: true,
      presetId: 'bass-heavy',
      bass: 8,
      treble: 5,
      preamp: 0,
      stereoExpansion: 0,
      tempo: 1.0,
      bands: [8, 7, 5, 2, 0, 0, 1, 2, 3, 2],
      balance: 0.0,
      volume: 75,
      mono: false,
      tempoEnabled: false,
    });
    setRepeatMode('all');
    setIsShuffle(false);
    setQueue([]);
  };

  /**
   * Les navigateurs refusent de démarrer un AudioContext et de jouer un média
   * sans geste utilisateur préalable. Sur le web, `loadTrack(0, true)` ci-dessus
   * échoue donc silencieusement au premier chargement et l'app paraît muette.
   * Ce listener one-shot lève le verrou au premier clic/tap, puis disparaît.
   */
  useEffect(() => {
    if (Platform.OS !== 'web') return;

    const unlock = () => {
      playerManager.resumeFromUserGesture().then(() => {
        setNeedsUserGesture(false);
      });
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };

    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  const loadTrack = async (
    index: number,
    shouldPlay: boolean = true,
    initialPositionMs?: number,
    trackList?: Track[]
  ) => {
    try {
      setIsLoading(true);
      const list = trackList || tracksRef.current;
      const targetTrack = list[index];
      if (!targetTrack) return;

      setCurrentTrackIndex(index);
      currentTrackIndexRef.current = index;
      setIsPlaying(shouldPlay);

      if (initialPositionMs && initialPositionMs > 0) {
        setPositionMillis(initialPositionMs);
        positionMillisRef.current = initialPositionMs;
      }

      await playerManager.loadTrack(
        targetTrack.uri,
        shouldPlay,
        (status) => {
          if (!status) return;
          const curMs = (status.currentTime || 0) * 1000;
          setPositionMillis(curMs);
          positionMillisRef.current = curMs;

          const durMs = (status.duration && status.duration > 1 ? status.duration : targetTrack.duration || 209) * 1000;
          setDurationMillis(durMs);
          durationMillisRef.current = durMs;

          setIsPlaying(status.isPlaying);
          isPlayingRef.current = status.isPlaying;

          // Garde de ré-entrance : le lecteur peut émettre `didFinish` à
          // plusieurs reprises tant que la piste suivante n'est pas chargée.
          // Sans ce verrou, chaque émission empile un nouveau `loadTrack` et
          // donc un nouvel écouteur de statut auprès du moteur natif.
          if (status.didFinish && !isAdvancingRef.current) {
            isAdvancingRef.current = true;
            // Libère le verrou une fois la piste suivante montée, sans quoi un
            // Libère le verrou une fois la piste suivante montée, sans quoi
            // un simple redémarrage de la lecture ne déclencherait plus la fin.
            if (queueRef.current.length > 0) {
              const nextFromQueue = queueRef.current[0];
              setQueue((prev) => prev.slice(1));
              const idx = tracksRef.current.findIndex((t) => t.id === nextFromQueue.id);
              if (idx !== -1) {
                loadTrack(idx, true, 0);
              } else {
                handleNextTrack();
              }
            } else {
              handleNextTrack();
            }
          }
        },
        initialPositionMs ? initialPositionMs / 1000 : undefined,
        { title: targetTrack.title, artist: targetTrack.artist }
      );

      // Mémoriser dès le chargement du morceau
      persistSession();
    } catch (error) {
      console.warn('Erreur chargement audio:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handlePlayPause = async () => {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    } catch {}

    if (isPlaying) {
      playerManager.pause();
      setIsPlaying(false);
      isPlayingRef.current = false;
      persistSession();
    } else {
      playerManager.play();
      setIsPlaying(true);
      isPlayingRef.current = true;
    }
  };

  const handleNextTrack = async () => {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {}

    let nextIndex = 0;
    if (isShuffle) {
      nextIndex = Math.floor(Math.random() * tracks.length);
    } else {
      nextIndex = (currentTrackIndex + 1) % tracks.length;
    }

    await loadTrack(nextIndex, true, 0);
  };

  const handlePrevTrack = async () => {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {}

    if (positionMillis > 3000) {
      await playerManager.seekToSeconds(0);
      setPositionMillis(0);
      positionMillisRef.current = 0;
      persistSession();
      return;
    }

    const prevIndex = (currentTrackIndex - 1 + tracks.length) % tracks.length;
    await loadTrack(prevIndex, true, 0);
  };

  const handleFastForward = async () => {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {}
    const newPos = Math.min(durationMillis, positionMillis + 10000);
    setPositionMillis(newPos);
    positionMillisRef.current = newPos;
    await playerManager.seekToSeconds(newPos / 1000);
    persistSession();
  };

  const handleFastRewind = async () => {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {}
    const newPos = Math.max(0, positionMillis - 10000);
    setPositionMillis(newPos);
    positionMillisRef.current = newPos;
    await playerManager.seekToSeconds(newPos / 1000);
    persistSession();
  };

  /**
   * Seek final, après un glissement sur la barre de progression.
   *
   * La prévisualisation pendant le glissement est purement visuelle : elle ne
   * touche pas au lecteur. Un seul seek au relâchement évite qu'un
   * `seekTo` par frame ne fasse bondir la lecture sur les plateformes où le
   * seek n'est pas instantané.
   */
  const handleSeekCommit = async (targetPos: number) => {
    const clamped = Math.max(0, Math.min(durationMillis, targetPos));
    setPositionMillis(clamped);
    positionMillisRef.current = clamped;
    await playerManager.seekToSeconds(clamped / 1000);
    persistSession();
  };

  const handleSelectPreset = (preset: EqualizerPreset) => {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {}
    setDsp({
      ...dsp,
      presetId: preset.id,
      bass: 0, // Séparé : commence à 0 dB neutre
      treble: 0, // Séparé : commence à 0 dB neutre
      preamp: preset.preamp ?? 0,
      bands: [...preset.bands],
    });
    setIsPresetsVisible(false);
  };

  const handleSaveCustomPreset = async (name: string): Promise<EqualizerPreset> => {
    const finalName = name.trim() || `Préréglage ${customPresets.length + 1}`;
    const newPreset: EqualizerPreset = {
      id: `custom-${Date.now()}`,
      name: finalName,
      description: 'Préréglage utilisateur personnalisé',
      bass: dsp.bass,
      treble: dsp.treble,
      preamp: dsp.preamp,
      bands: [...dsp.bands],
    };
    const updated = [newPreset, ...customPresets];
    setCustomPresets(updated);
    await storageService.saveCustomPresets(updated);
    setDsp((prev) => ({ ...prev, presetId: newPreset.id }));
    return newPreset;
  };

  const handleDeleteCustomPreset = async (presetId: string) => {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {}
    const updated = customPresets.filter((p) => p.id !== presetId);
    setCustomPresets(updated);
    await storageService.saveCustomPresets(updated);
    if (dsp.presetId === presetId) {
      setDsp((prev) => ({ ...prev, presetId: 'flat' }));
    }
  };

  const handleAddTracks = (newTracks: Track[]) => {
    setTracks((prev) => [...prev, ...newTracks]);
  };

  // Sleep Timer effect
  useEffect(() => {
    if (sleepTimerMinutes === null) return;
    const timer = setTimeout(() => {
      playerManager.pause();
      setIsPlaying(false);
      setSleepTimerMinutes(null);
    }, sleepTimerMinutes * 60 * 1000);
    return () => clearTimeout(timer);
  }, [sleepTimerMinutes]);

  const openTrackAction = (track: Track) => {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {}
    setActiveActionTrack(track);
    setIsActionModalVisible(true);
  };

  const handlePlayNext = (track: Track) => {
    setQueue((prev) => [track, ...prev]);
  };

  const handleAddToQueue = (track: Track) => {
    setQueue((prev) => [...prev, ...prev.some((t) => t.id === track.id) ? [] : [track]]);
  };

  const handlePlayQueuedTrack = (track: Track, index: number) => {
    setQueue((prev) => prev.filter((_, i) => i !== index));
    const idx = tracks.findIndex((t) => t.id === track.id);
    if (idx !== -1) {
      loadTrack(idx, true);
    }
  };

  const handleRemoveFromQueue = (index: number) => {
    setQueue((prev) => prev.filter((_, i) => i !== index));
  };

  const handleClearQueue = () => {
    setQueue([]);
  };

  const handleMoveQueueItem = (fromIdx: number, toIdx: number) => {
    setQueue((prev) => {
      const arr = [...prev];
      const [item] = arr.splice(fromIdx, 1);
      arr.splice(toIdx, 0, item);
      return arr;
    });
  };

  const handleAddToPlaylist = (track: Track, playlistId: string) => {
    setPlaylists((prev) =>
      prev.map((pl) => {
        if (pl.id === playlistId && !pl.trackIds.includes(track.id)) {
          return { ...pl, trackIds: [...pl.trackIds, track.id] };
        }
        return pl;
      })
    );
  };

  const handleCreatePlaylistWithTrack = (track: Track, playlistName: string) => {
    const newPl: Playlist = {
      id: `pl-${Date.now()}`,
      name: playlistName,
      trackIds: [track.id],
      createdAt: Date.now(),
    };
    setPlaylists((prev) => [newPl, ...prev]);
  };

  const handleCreatePlaylist = (playlistName: string) => {
    const newPl: Playlist = {
      id: `pl-${Date.now()}`,
      name: playlistName,
      trackIds: [],
      createdAt: Date.now(),
    };
    setPlaylists((prev) => [newPl, ...prev]);
  };

  const handleDeletePlaylist = (playlistId: string) => {
    setPlaylists((prev) => prev.filter((pl) => pl.id !== playlistId));
  };

  const handleUpdateTrackTags = (updatedTrack: Track) => {
    setTracks((prev) =>
      prev.map((t) => (t.id === updatedTrack.id ? updatedTrack : t))
    );
  };

  const handleDeleteTrack = (trackToDelete: Track) => {
    setTracks((prev) => prev.filter((t) => t.id !== trackToDelete.id));
    setQueue((prev) => prev.filter((t) => t.id !== trackToDelete.id));
    setPlaylists((prev) =>
      prev.map((pl) => ({
        ...pl,
        trackIds: pl.trackIds.filter((id) => id !== trackToDelete.id),
      }))
    );
    if (currentTrack.id === trackToDelete.id) {
      handleNextTrack();
    }
  };

  const handleToggleFavorite = (track: Track) => {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {}
    const nextFav = !track.isFavorite;
    setTracks((prev) =>
      prev.map((t) => (t.id === track.id ? { ...t, isFavorite: nextFav } : t))
    );
    if (nextFav) {
      handleAddToPlaylist(track, 'pl-favorites');
    } else {
      setPlaylists((prev) =>
        prev.map((pl) =>
          pl.id === 'pl-favorites'
            ? { ...pl, trackIds: pl.trackIds.filter((id) => id !== track.id) }
            : pl
        )
      );
    }
  };

  const handleSelectTrack = (track: Track) => {
    const idx = tracks.findIndex((t) => t.id === track.id);
    if (idx !== -1) {
      loadTrack(idx, true);
    }
  };

  const toggleRepeatMode = () => {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {}
    if (repeatMode === 'off') setRepeatMode('all');
    else if (repeatMode === 'all') setRepeatMode('one');
    else setRepeatMode('off');
  };

  // Filtered tracks for search
  const filteredTracks = tracks.filter(
    (t) =>
      t.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      t.artist.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <View style={styles.rootBackground}>
      <SafeAreaView style={styles.safeContainer}>
        <StatusBar style="light" />

        <View style={styles.appContainer}>
          {/* TAB 1: PLAYER SCREEN */}
          {currentTab === 'player' ? (
            <>
              {/* Top Bar on Player Screen: Left Queue Drawer, Center MAS Logo & Right Cast */}
              <View style={styles.topPlayerBar}>
                <TouchableOpacity
                  onPress={() => setIsQueueDrawerVisible(true)}
                  style={styles.topPlayerIconBtn}
                  activeOpacity={0.7}
                >
                  <MaterialCommunityIcons name="clock-outline" size={22} color="#38BDF8" />
                  {queue.length > 0 && (
                    <View style={styles.queueBadge}>
                      <Text style={styles.queueBadgeText}>{queue.length}</Text>
                    </View>
                  )}
                </TouchableOpacity>

                {/* Center MAS Player Logo & Brand */}
                <View style={styles.topBrandPill}>
                  <Image
                    source={require('./assets/mas_icon_square.png')}
                    style={styles.topBrandLogo}
                    resizeMode="contain"
                  />
                  <Text style={styles.topBrandTitle}>MAS PLAYER</Text>
                  <View style={styles.topBrandVersionBadge}>
                    <Text style={styles.topBrandVersionText}>v{APP_VERSION}</Text>
                  </View>
                </View>

                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <TouchableOpacity
                    onPress={() => {
                      try {
                        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      } catch {}
                      alert('MAS Player Output: Bluetooth WH-1000XM4 LDAC 32-BIT 96 KHZ');
                    }}
                    style={styles.topPlayerIconBtn}
                    activeOpacity={0.7}
                  >
                    <MaterialCommunityIcons name="cast" size={22} color="#FFFFFF" />
                  </TouchableOpacity>

                  <TouchableOpacity
                    onPress={() => setIsTrackListVisible(true)}
                    style={styles.topPlayerIconBtn}
                    activeOpacity={0.7}
                  >
                    <Feather name="more-vertical" size={22} color="#FFFFFF" />
                  </TouchableOpacity>
                </View>
              </View>

              {/* Main Visualizer Area: logo animé sur le rythme réel du morceau */}
              <View style={styles.centerStage}>
                <BeatLogo />
              </View>

              {/* Like / Dislike + 3-Dots Row matching latest user screenshot */}
              <View style={styles.ratingActionsRow}>
                <View style={styles.thumbsPill}>
                  <TouchableOpacity
                    style={styles.thumbBtn}
                    onPress={() => handleToggleFavorite(currentTrack)}
                    activeOpacity={0.7}
                  >
                    <Ionicons
                      name={currentTrack.isFavorite ? 'thumbs-up' : 'thumbs-up-outline'}
                      size={18}
                      color={currentTrack.isFavorite ? '#38BDF8' : '#D1D5DB'}
                    />
                  </TouchableOpacity>

                  <View style={styles.thumbsDivider} />

                  <TouchableOpacity
                    style={styles.thumbBtn}
                    onPress={handleNextTrack}
                    activeOpacity={0.7}
                  >
                    <Ionicons name="thumbs-down-outline" size={18} color="#D1D5DB" />
                  </TouchableOpacity>
                </View>

                {/* 3-Dots Menu Button */}
                <TouchableOpacity
                  style={styles.songMoreBtn}
                  onPress={() => openTrackAction(currentTrack)}
                  activeOpacity={0.7}
                >
                  <MaterialCommunityIcons name="dots-vertical" size={22} color="#FFFFFF" />
                </TouchableOpacity>
              </View>

              {/* Metadata Badges: Title in dark rounded pill, Artist in subtitle */}
              <View style={styles.metaSection}>
                <View style={styles.titlePill}>
                  <Text numberOfLines={1} style={styles.trackTitleText}>
                    {currentTrack.title}
                  </Text>
                </View>
                <Text numberOfLines={1} style={styles.trackSubtitleText}>
                  {currentTrack.artist} - {currentTrack.album}
                </Text>
              </View>

              {/* Quick Utility Pill Buttons Row: EQ, Timer, Repeat, Shuffle */}
              <View style={styles.utilityPillsRow}>
                {/* Left Utility Pills */}
                <View style={styles.pillsSubgroup}>
                  <TouchableOpacity
                    onPress={() => setCurrentTab('equalizer')}
                    style={styles.utilityPill}
                    activeOpacity={0.7}
                  >
                    <MaterialCommunityIcons
                      name="equalizer"
                      size={20}
                      color={dsp.enabled ? '#FFFFFF' : '#666666'}
                    />
                  </TouchableOpacity>

                  <TouchableOpacity
                    onPress={() => {
                      try {
                        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      } catch {}
                      setIsSleepTimerVisible(true);
                    }}
                    style={styles.utilityPill}
                    activeOpacity={0.7}
                  >
                    <Ionicons
                      name={sleepTimerMinutes !== null ? 'time' : 'time-outline'}
                      size={20}
                      color={sleepTimerMinutes !== null ? '#38BDF8' : '#8A9AA8'}
                    />
                  </TouchableOpacity>
                </View>

                {/* Right Utility Pills */}
                <View style={styles.pillsSubgroup}>
                  <TouchableOpacity
                    onPress={toggleRepeatMode}
                    style={styles.utilityPill}
                    activeOpacity={0.7}
                  >
                    <MaterialCommunityIcons
                      name={repeatMode === 'one' ? 'repeat-once' : 'repeat'}
                      size={22}
                      color={repeatMode !== 'off' ? '#FFFFFF' : '#8A9AA8'}
                    />
                  </TouchableOpacity>

                  <TouchableOpacity
                    onPress={() => {
                      try {
                        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      } catch {}
                      setIsShuffle(!isShuffle);
                    }}
                    style={styles.utilityPill}
                    activeOpacity={0.7}
                  >
                    <MaterialCommunityIcons
                      name="shuffle-variant"
                      size={22}
                      color={isShuffle ? '#FFFFFF' : '#8A9AA8'}
                    />
                  </TouchableOpacity>
                </View>
              </View>

              {/* Transport controls — plus en superposition : la barre de progression
                  passe EN dessous, ce qui l'empêchait d'être attrapable */}
              <View style={styles.transportRow}>
                <TouchableOpacity
                  onPress={handleFastRewind}
                  style={styles.smallTransportBtn}
                  activeOpacity={0.7}
                >
                  <Ionicons name="play-back" size={15} color="#FFFFFF" />
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={handlePrevTrack}
                  style={styles.mediumTransportBtn}
                  activeOpacity={0.7}
                >
                  <Ionicons name="play-back" size={24} color="#FFFFFF" />
                </TouchableOpacity>

                {/* Big Central Black Play/Pause Button */}
                <TouchableOpacity
                  onPress={handlePlayPause}
                  style={styles.bigCentralPlayBtn}
                  activeOpacity={0.8}
                >
                  {isLoading ? (
                    <ActivityIndicator color="#FFFFFF" size="small" />
                  ) : (
                    <Ionicons
                      name={isPlaying ? 'pause' : 'play'}
                      size={42}
                      color="#FFFFFF"
                      style={{ marginLeft: isPlaying ? 0 : 4 }}
                    />
                  )}
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={handleNextTrack}
                  style={styles.mediumTransportBtn}
                  activeOpacity={0.7}
                >
                  <Ionicons name="play-forward" size={24} color="#FFFFFF" />
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={handleFastForward}
                  style={styles.smallTransportBtn}
                  activeOpacity={0.7}
                >
                  <Ionicons name="play-forward" size={15} color="#FFFFFF" />
                </TouchableOpacity>
              </View>

              {/* Barre de progression scrubbable : glisser pour sauter.
                  Aucune prévisualisation remontée vers `App` — le curseur se
                  dessine seul dans `ProgressBar`, ce qui évite de re-rendre toute
                  l'app à chaque mouvement de doigt. */}
              <ProgressBar
                positionMillis={positionMillis}
                durationMillis={durationMillis}
                onSeekCommit={handleSeekCommit}
              />

              {/* Time & Tech Specs Row */}
              <View style={styles.timeSpecsRow}>
                <View style={styles.specsPill}>
                  <Text style={styles.specsPillText}>
                    {currentTrack.sampleRate ? `${currentTrack.sampleRate}` : '44.1 KHZ'}{' '}
                    {currentTrack.bitrate ? `${currentTrack.bitrate}` : '1116 KBPS'}{' '}
                    {currentTrack.format ? currentTrack.format : 'FLAC'}
                  </Text>
                </View>
              </View>
            </>
          ) : currentTab === 'library' ? (
            /* TAB 2: LIBRARY SCREEN MATCHING USER SCREENSHOT 1 */
            <View style={{ flex: 1 }}>
              <LibraryView
                tracks={tracks}
                currentTrack={currentTrack}
                isPlaying={isPlaying}
                playlists={playlists}
                onPlayPause={() => handlePlayPause()}
                onSelectTrack={(track) => {
                  const idx = tracks.findIndex((t) => t.id === track.id);
                  if (idx !== -1) loadTrack(idx, true);
                }}
                onAddTracks={handleAddTracks}
                onBackToPlayer={() => setCurrentTab('player')}
                onTrackAction={openTrackAction}
                onCreatePlaylist={handleCreatePlaylist}
                onDeletePlaylist={handleDeletePlaylist}
                onOpenQueueDrawer={() => setIsQueueDrawerVisible(true)}
              />
            </View>
          ) : (
            /* TAB 3: EQUALIZER SCREEN MATCHING USER SCREENSHOT */
            <View style={{ flex: 1 }}>
              <EqualizerView
                dsp={dsp}
                onUpdateDSP={setDsp}
                onOpenPresets={() => setIsPresetsVisible(true)}
                customPresets={customPresets}
                onSaveCustomPreset={handleSaveCustomPreset}
                onDeleteCustomPreset={handleDeleteCustomPreset}
              />

              {/* Mini Player Bar above Dock on Equalizer screen */}
              <TouchableOpacity
                onPress={() => setCurrentTab('player')}
                style={styles.miniPlayerBar}
                activeOpacity={0.85}
              >
                {/* Mini Album Cover / Icon */}
                {currentTrack.artwork ? (
                  <Image source={{ uri: currentTrack.artwork }} style={styles.miniCoverImg} />
                ) : (
                  <View style={styles.miniCoverBox}>
                    <Ionicons name="musical-notes" size={20} color="#E2E8F0" />
                  </View>
                )}

                {/* Track Title and Artist */}
                <View style={styles.miniMetaBox}>
                  <Text numberOfLines={1} style={styles.miniTitleText}>
                    {currentTrack.title}
                  </Text>
                  <Text numberOfLines={1} style={styles.miniArtistText}>
                    {currentTrack.artist} - {currentTrack.album}
                  </Text>
                </View>

                {/* Mini Play/Pause button */}
                <TouchableOpacity
                  onPress={handlePlayPause}
                  style={styles.miniPlayBtn}
                  activeOpacity={0.7}
                >
                  <Ionicons
                    name={isPlaying ? 'pause' : 'play'}
                    size={24}
                    color="#FFFFFF"
                  />
                </TouchableOpacity>
              </TouchableOpacity>
            </View>
          )}

          {/* Bottom Elevated Navigation Dock: Grid, Equalizer, Search, Menu */}
          <View style={styles.bottomDock}>
            {/* 1. Grid (Categories / Library / Back to Player) */}
            <TouchableOpacity
              onPress={() => {
                try {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                } catch {}
                setCurrentTab(currentTab === 'library' ? 'player' : 'library');
              }}
              style={styles.dockIconBtn}
              activeOpacity={0.7}
            >
              <MaterialCommunityIcons
                name="view-grid"
                size={28}
                color={currentTab === 'library' ? '#FFFFFF' : '#7D8A99'}
              />
            </TouchableOpacity>

            {/* 2. Equalizer Graph Icon */}
            <TouchableOpacity
              onPress={() => {
                try {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                } catch {}
                setCurrentTab(currentTab === 'equalizer' ? 'player' : 'equalizer');
              }}
              style={styles.dockIconBtn}
              activeOpacity={0.7}
            >
              <MaterialCommunityIcons
                name="chart-bar"
                size={28}
                color={currentTab === 'equalizer' ? '#FFFFFF' : '#7D8A99'}
              />
            </TouchableOpacity>

            {/* 3. Search Icon (Recherche de son) */}
            <TouchableOpacity
              onPress={() => setIsSearchVisible(true)}
              style={styles.dockIconBtn}
              activeOpacity={0.7}
            >
              <Ionicons name="search" size={26} color="#7D8A99" />
            </TouchableOpacity>

            {/* 4. Menu / Settings Icon (Matching image 2) */}
            <TouchableOpacity
              onPress={() => {
                try {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                } catch {}
                setIsSettingsVisible(true);
              }}
              style={styles.dockIconBtn}
              activeOpacity={0.7}
            >
              <MaterialCommunityIcons
                name="menu"
                size={30}
                color="#7D8A99"
              />
            </TouchableOpacity>
          </View>
        </View>

        {/* Presets Modal */}
        <Modal
          visible={isPresetsVisible}
          animationType="slide"
          transparent
          onRequestClose={() => setIsPresetsVisible(false)}
        >
          <View style={styles.searchModalOverlay}>
            <View style={styles.searchModalBox}>
              <View style={styles.presetsModalHeader}>
                <Text style={styles.presetsModalTitle}>PRÉRÉGLAGES MAS PLAYER</Text>
                <TouchableOpacity onPress={() => setIsPresetsVisible(false)}>
                  <Ionicons name="close" size={24} color="#FFFFFF" />
                </TouchableOpacity>
              </View>

              <FlatList
                data={DEFAULT_PRESETS}
                keyExtractor={(item) => item.id}
                ListHeaderComponent={
                  <View style={{ marginBottom: 16 }}>
                    {/* MES PRÉRÉGLAGES SECTION */}
                    <View style={styles.presetSectionHeaderRow}>
                      <Ionicons name="bookmark" size={16} color="#22C55E" />
                      <Text style={styles.presetSectionHeaderTitle}>
                        MES PRÉRÉGLAGES ({customPresets.length})
                      </Text>
                    </View>

                    {customPresets.length === 0 ? (
                      <View style={styles.presetEmptyBox}>
                        <Text style={styles.presetEmptyText}>
                          Aucun préréglage personnalisé. Utilisez le bouton SAVE de l'égaliseur pour enregistrer votre courbe actuelle.
                        </Text>
                      </View>
                    ) : (
                      customPresets.map((item) => {
                        const isSelected = dsp.presetId === item.id;
                        return (
                          <View
                            key={item.id}
                            style={[
                              styles.presetItemRow,
                              isSelected && styles.presetItemRowActive,
                            ]}
                          >
                            <TouchableOpacity
                              style={{ flex: 1 }}
                              onPress={() => handleSelectPreset(item)}
                            >
                              <Text
                                style={[
                                  styles.presetItemName,
                                  isSelected && styles.presetItemNameActive,
                                  { color: '#22C55E' },
                                ]}
                              >
                                {item.name}
                              </Text>
                              <Text style={styles.presetItemDesc}>
                                {`Bass: ${item.bass > 0 ? '+' : ''}${item.bass}dB • Treble: ${
                                  item.treble > 0 ? '+' : ''
                                }${item.treble}dB • Preamp: ${
                                  item.preamp > 0 ? '+' : ''
                                }${item.preamp}dB`}
                              </Text>
                            </TouchableOpacity>

                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                              {isSelected && (
                                <Ionicons name="checkmark-circle" size={22} color="#22C55E" />
                              )}
                              <TouchableOpacity
                                onPress={() => handleDeleteCustomPreset(item.id)}
                                style={styles.presetDeleteBtn}
                                activeOpacity={0.7}
                              >
                                <Ionicons name="trash-outline" size={18} color="#EF4444" />
                              </TouchableOpacity>
                            </View>
                          </View>
                        );
                      })
                    )}

                    {/* PRÉRÉGLAGES D'USINE SECTION HEADER */}
                    <View style={[styles.presetSectionHeaderRow, { marginTop: 16 }]}>
                      <MaterialCommunityIcons name="equalizer" size={18} color="#38BDF8" />
                      <Text style={styles.presetSectionHeaderTitle}>
                        PRÉRÉGLAGES D'USINE
                      </Text>
                    </View>
                  </View>
                }
                renderItem={({ item }) => {
                  const isSelected = dsp.presetId === item.id;
                  return (
                    <TouchableOpacity
                      style={[
                        styles.presetItemRow,
                        isSelected && styles.presetItemRowActive,
                      ]}
                      onPress={() => handleSelectPreset(item)}
                    >
                      <View style={{ flex: 1 }}>
                        <Text
                          style={[
                            styles.presetItemName,
                            isSelected && styles.presetItemNameActive,
                          ]}
                        >
                          {item.name}
                        </Text>
                        <Text style={styles.presetItemDesc}>
                          {item.description}
                        </Text>
                      </View>
                      {isSelected && (
                        <Ionicons name="checkmark-circle" size={22} color="#FFFFFF" />
                      )}
                    </TouchableOpacity>
                  );
                }}
              />
            </View>
          </View>
        </Modal>

        {/* Search Modal (Recherche de son) */}
        <Modal
          visible={isSearchVisible}
          animationType="fade"
          transparent
          onRequestClose={() => setIsSearchVisible(false)}
        >
          <View style={styles.searchModalOverlay}>
            <View style={styles.searchModalBox}>
              <View style={styles.searchBarRow}>
                <Ionicons name="search" size={22} color="#7D8A99" />
                <TextInput
                  placeholder="Rechercher un son, titre, artiste..."
                  placeholderTextColor="#64748B"
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                  style={styles.searchInput}
                  autoFocus
                />
                {searchQuery.length > 0 && (
                  <TouchableOpacity onPress={() => setSearchQuery('')}>
                    <Ionicons name="close-circle" size={20} color="#94A3B8" />
                  </TouchableOpacity>
                )}
                <TouchableOpacity
                  onPress={() => setIsSearchVisible(false)}
                  style={styles.searchCancelBtn}
                >
                  <Text style={styles.searchCancelText}>Fermer</Text>
                </TouchableOpacity>
              </View>

              <FlatList
                data={filteredTracks}
                keyExtractor={(item) => item.id}
                style={styles.searchResultsList}
                renderItem={({ item }) => (
                  <TouchableOpacity
                    style={styles.searchResultItem}
                    onPress={() => {
                      handleSelectTrack(item);
                      setIsSearchVisible(false);
                    }}
                  >
                    <Ionicons name="musical-note" size={20} color="#7D8A99" />
                    <View style={{ flex: 1, marginLeft: 12 }}>
                      <Text style={styles.searchResultTitle}>{item.title}</Text>
                      <Text style={styles.searchResultArtist}>
                        {item.artist} • {item.album}
                      </Text>
                    </View>
                    <Text style={styles.searchResultFormat}>
                      {item.format || 'FLAC'}
                    </Text>
                  </TouchableOpacity>
                )}
                ListEmptyComponent={
                  <View style={styles.searchEmptyBox}>
                    <Text style={styles.searchEmptyText}>
                      Aucun morceau trouvé pour "{searchQuery}"
                    </Text>
                  </View>
                }
              />
            </View>
          </View>
        </Modal>

        {/* Library / Track List Modal */}
        <TrackListModal
          visible={isTrackListVisible}
          onClose={() => setIsTrackListVisible(false)}
          tracks={tracks}
          currentTrackId={currentTrack.id}
          onSelectTrack={handleSelectTrack}
          onAddTracks={handleAddTracks}
          onTrackAction={openTrackAction}
        />

        {/* Settings Modal matching Image 2 */}
        <SettingsModal
          visible={isSettingsVisible}
          onClose={() => setIsSettingsVisible(false)}
          onRescanLibrary={() => {
            console.log('Bibliothèque actualisée');
          }}
          settings={appSettings}
          onUpdateSettings={handleUpdateSettings}
          currentTrack={currentTrack}
          positionMillis={positionMillis}
          durationMillis={durationMillis}
          dsp={dsp}
          onClearSession={handleClearSession}
        />

        {/* Toast visuel de reprise de lecture */}
        {restoredNotice && (
          <View style={styles.restoredToast}>
            <Ionicons name="bookmark" size={16} color="#38BDF8" />
            <Text style={styles.restoredToastText}>{restoredNotice}</Text>
          </View>
        )}

        {/* Song Context Menu (Éditer tags, Supprimer, Lire ensuite, Lire plus tard, Playlists) */}
        <SongActionModal
          visible={isActionModalVisible}
          track={activeActionTrack}
          playlists={playlists}
          onClose={() => {
            setIsActionModalVisible(false);
            setActiveActionTrack(null);
          }}
          onPlayNext={handlePlayNext}
          onAddToQueue={handleAddToQueue}
          onAddToPlaylist={handleAddToPlaylist}
          onCreatePlaylistWithTrack={handleCreatePlaylistWithTrack}
          onUpdateTrackTags={handleUpdateTrackTags}
          onDeleteTrack={handleDeleteTrack}
          onToggleFavorite={handleToggleFavorite}
        />

        {/* Left Queue Drawer (Lire plus tard) */}
        <QueueDrawerModal
          visible={isQueueDrawerVisible}
          queue={queue}
          onClose={() => setIsQueueDrawerVisible(false)}
          onPlayQueuedTrack={handlePlayQueuedTrack}
          onRemoveFromQueue={handleRemoveFromQueue}
          onClearQueue={handleClearQueue}
          onMoveQueueItem={handleMoveQueueItem}
        />

        {/* Sleep Timer Modal */}
        <Modal
          visible={isSleepTimerVisible}
          animationType="fade"
          transparent
          onRequestClose={() => setIsSleepTimerVisible(false)}
        >
          <View style={styles.searchModalOverlay}>
            <View style={styles.searchModalBox}>
              <View style={styles.presetsModalHeader}>
                <Text style={styles.presetsModalTitle}>MINUTERIE DE VEILLE</Text>
                <TouchableOpacity onPress={() => setIsSleepTimerVisible(false)}>
                  <Ionicons name="close" size={24} color="#FFFFFF" />
                </TouchableOpacity>
              </View>
              <Text style={{ color: '#94A3B8', fontSize: 13, marginBottom: 14 }}>
                Mettre la musique en pause automatiquement après :
              </Text>
              {[15, 30, 45, 60].map((mins) => (
                <TouchableOpacity
                  key={mins}
                  style={[
                    styles.presetItemRow,
                    sleepTimerMinutes === mins && styles.presetItemRowActive,
                  ]}
                  onPress={() => {
                    setSleepTimerMinutes(mins);
                    setIsSleepTimerVisible(false);
                  }}
                >
                  <Text
                    style={[
                      styles.presetItemName,
                      sleepTimerMinutes === mins && styles.presetItemNameActive,
                    ]}
                  >
                    {mins} minutes
                  </Text>
                  {sleepTimerMinutes === mins && (
                    <Ionicons name="checkmark-circle" size={20} color="#38BDF8" />
                  )}
                </TouchableOpacity>
              ))}
              {sleepTimerMinutes !== null && (
                <TouchableOpacity
                  style={[styles.presetItemRow, { marginTop: 10 }]}
                  onPress={() => {
                    setSleepTimerMinutes(null);
                    setIsSleepTimerVisible(false);
                  }}
                >
                  <Text style={[styles.presetItemName, { color: '#F87171' }]}>
                    Désactiver la minuterie
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        </Modal>
      {/*
          Verrou d'autoplay du navigateur : tant qu'aucun geste utilisateur n'a
          eu lieu, le contexte audio est suspendu et rien ne s'entend. L'overlay
          disparaît au premier clic/tap, qui relance la lecture dans le
          gestionnaire d'événements (et non ici, pour ne pas dépendre du
          temps de rendu de React).
        */}
        {needsUserGesture && (
          <View style={styles.autoplayGate} pointerEvents="none">
            <Text style={styles.autoplayGateText}>
              Touchez pour lancer la lecture
            </Text>
          </View>
        )}
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  rootBackground: {
    flex: 1,
    backgroundColor: '#000000',
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  safeContainer: {
    flex: 1,
    backgroundColor: '#000000',
    width: '100%',
    maxWidth: 480, // Responsive clamp on large desktop screens
    height: '100%',
  },
  appContainer: {
    flex: 1,
    backgroundColor: '#000000',
    justifyContent: 'space-between',
    width: '100%',
    paddingBottom: Platform.OS === 'ios' ? 8 : 4,
  },
  topPlayerBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: Platform.OS === 'ios' ? 4 : 8,
    paddingBottom: 4,
    zIndex: 10,
  },
  topBrandPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#0F1218',
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#1E2530',
  },
  topBrandLogo: {
    width: 22,
    height: 22,
    borderRadius: 6,
  },
  topBrandTitle: {
    color: '#F3F4F6',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.5,
  },
  topBrandVersionBadge: {
    backgroundColor: 'rgba(56, 189, 248, 0.12)',
    paddingHorizontal: 5,
    paddingVertical: 1.5,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.28)',
    marginLeft: 2,
  },
  topBrandVersionText: {
    color: '#38BDF8',
    fontSize: 9.5,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  topPlayerIconBtn: {
    padding: 6,
    position: 'relative',
  },
  queueBadge: {
    position: 'absolute',
    top: 2,
    right: 0,
    backgroundColor: '#38BDF8',
    borderRadius: 8,
    minWidth: 16,
    height: 16,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 4,
  },
  queueBadgeText: {
    color: '#000000',
    fontSize: 10,
    fontWeight: '700',
  },
  ratingActionsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 24,
    marginTop: -4,
    marginBottom: 10,
  },
  thumbsPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1E1D24',
    borderRadius: 20,
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: '#2D2B35',
  },
  thumbBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  thumbsDivider: {
    width: 1,
    height: 16,
    backgroundColor: '#35333E',
  },
  songMoreBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: '#1E1D24',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#2D2B35',
  },
  centerStage: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#000000',
    minHeight: 200,
    position: 'relative',
  },
  moreMenuFloatingBtn: {
    position: 'absolute',
    right: 18,
    bottom: 20,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#16191E',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 10,
  },
  // `sharpWaveContainer`, `zigzagPath` et `zigzagBar` vivaient ici : ils sont
  // passés dans `BeatLogo`, qui anime désormais le motif.
  metaSection: {
    paddingHorizontal: 20,
    marginBottom: 12,
  },
  titlePill: {
    alignSelf: 'flex-start',
    backgroundColor: '#16191E',
    paddingVertical: 5,
    paddingHorizontal: 12,
    borderRadius: 6,
    marginBottom: 6,
  },
  trackTitleText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '800',
  },
  trackSubtitleText: {
    color: '#9EABB8',
    fontSize: 13,
    fontWeight: '400',
  },
  utilityPillsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    marginBottom: 14,
  },
  pillsSubgroup: {
    flexDirection: 'row',
    gap: 8,
  },
  utilityPill: {
    backgroundColor: '#14171C',
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#1D2128',
  },
  // `waveformContainer`, `waveBarsRow`, `waveBarTouchZone`, `waveBar` et
  // `transportOverlayRow` ont disparu : la barre vit dans `ProgressBar`, et les
  // boutons de transport ne sont plus en superposition (c'est ce qui les rendait
  // impossibles à distinguer de la zone de seek).
  transportRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    marginVertical: 8,
  },
  smallTransportBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#0A0C0F',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: '#1A1E24',
  },
  mediumTransportBtn: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#0A0C0F',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: '#1A1E24',
  },
  bigCentralPlayBtn: {
    width: 82,
    height: 82,
    borderRadius: 41,
    backgroundColor: '#000000',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#262C36',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.9,
    shadowRadius: 8,
    elevation: 8,
  },
  timeSpecsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    marginTop: 8,
    marginBottom: 10,
  },
  // `timeElapsedText`, `durationPill` et `durationPillText` supprimés : les deux
  // temps sont désormais affichés par `ProgressBar`, sous la barre.
  specsPill: {
    backgroundColor: '#12151A',
    paddingVertical: 3,
    paddingHorizontal: 10,
    borderRadius: 12,
  },
  specsPillText: {
    color: '#8A9AA8',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  miniPlayerBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0F1115',
    marginHorizontal: 12,
    marginBottom: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#1C2028',
  },
  miniCoverBox: {
    width: 38,
    height: 38,
    borderRadius: 6,
    backgroundColor: '#202530',
    justifyContent: 'center',
    alignItems: 'center',
  },
  miniCoverImg: {
    width: 38,
    height: 38,
    borderRadius: 6,
    backgroundColor: '#1E232B',
  },
  miniMetaBox: {
    flex: 1,
    marginLeft: 12,
  },
  miniTitleText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  miniArtistText: {
    color: '#8A9AA8',
    fontSize: 11,
    marginTop: 1,
  },
  miniPlayBtn: {
    padding: 8,
  },
  bottomDock: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    backgroundColor: '#13161B',
    marginHorizontal: 12,
    marginBottom: 8,
    paddingVertical: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#1C2128',
  },
  dockIconBtn: {
    padding: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  searchModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.85)',
    justifyContent: 'flex-start',
    paddingTop: Platform.OS === 'web' ? 40 : 60,
    paddingHorizontal: 16,
  },
  searchModalBox: {
    backgroundColor: '#12151B',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: '#222834',
    maxHeight: '80%',
  },
  searchBarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1A1E26',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: 14,
    paddingVertical: 4,
  },
  searchCancelBtn: {
    paddingLeft: 8,
  },
  searchCancelText: {
    color: '#8A9AA8',
    fontSize: 13,
    fontWeight: '600',
  },
  searchResultsList: {
    marginTop: 12,
  },
  searchResultItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1A1E26',
  },
  searchResultTitle: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  searchResultArtist: {
    color: '#8A9AA8',
    fontSize: 12,
  },
  searchResultFormat: {
    color: '#7D8A99',
    fontSize: 11,
    fontWeight: '800',
  },
  searchEmptyBox: {
    paddingVertical: 30,
    alignItems: 'center',
  },
  searchEmptyText: {
    color: '#64748B',
    fontSize: 13,
  },
  autoplayGate: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: 120,
  },
  autoplayGateText: {
    color: '#8A9AA8',
    fontSize: 13,
    fontWeight: '600',
    backgroundColor: 'rgba(0,0,0,0.65)',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 16,
    overflow: 'hidden',
  },
  presetsModalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#222834',
  },
  presetsModalTitle: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: 1.5,
  },
  presetItemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 10,
    borderRadius: 8,
    marginBottom: 6,
    backgroundColor: '#161922',
  },
  presetItemRowActive: {
    backgroundColor: '#202634',
    borderWidth: 1,
    borderColor: '#4C566A',
  },
  presetItemName: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  presetItemNameActive: {
    color: '#ECEFF4',
  },
  presetItemDesc: {
    color: '#8A9AA8',
    fontSize: 11,
    marginTop: 2,
  },
  presetSectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 8,
    paddingBottom: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#1F242D',
  },
  presetSectionHeaderTitle: {
    color: '#94A3B8',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1,
  },
  presetEmptyBox: {
    backgroundColor: '#12151B',
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#1C222D',
    marginBottom: 8,
  },
  presetEmptyText: {
    color: '#64748B',
    fontSize: 12,
    lineHeight: 16,
  },
  presetDeleteBtn: {
    padding: 6,
    borderRadius: 6,
    backgroundColor: '#261418',
  },
  restoredToast: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 56 : 24,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(24, 24, 27, 0.95)',
    borderColor: '#38BDF8',
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 20,
    zIndex: 9999,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 6,
    elevation: 8,
  },
  restoredToastText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
  },
});


