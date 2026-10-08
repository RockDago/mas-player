import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  Animated,
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  Dimensions,
  useWindowDimensions,
  ScrollView,
  ActivityIndicator,
  Platform,
  TextInput,
  Modal,
  FlatList,
  Image,
  AppState,
  Alert,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import {
  Ionicons,
  MaterialCommunityIcons,
  Feather,
} from '@expo/vector-icons';

import { Track, DSPState, EqualizerPreset, Playlist } from './src/types/audio';
import { DEFAULT_PRESETS } from './src/constants/presets';
import { formatTime } from './src/services/audioService';
import { playerManager } from './src/services/playerManager';
import {
  storageService,
  AppSettings,
  DEFAULT_APP_SETTINGS,
} from './src/services/storageService';
import { EqualizerView } from './src/components/EqualizerView';
import { NeonWaveVisualizer } from './src/components/NeonWaveVisualizer';
import { ProgressBar } from './src/components/ProgressBar';
import { TrackListModal } from './src/components/TrackListModal';
import { LibraryView } from './src/components/LibraryView';
import { SettingsModal } from './src/components/SettingsModal';
import { SongActionModal } from './src/components/SongActionModal';
import { QueueDrawerModal } from './src/components/QueueDrawerModal';
import { AppLoadingScreen } from './src/components/AppLoadingScreen';
import { APP_VERSION } from './src/constants/version';
import { getTranslation } from './src/i18n/translations';
import { resolveTrackUri, deletePersistedAudioFile } from './src/utils/audioStorage';
import { mergeTracks } from './src/utils/trackMerge';
import { restoreWebAudioBlobs } from './src/services/webAudioStorage';
import { requestAndroidStoragePermission, pickAudioFiles } from './src/services/filePickerService';
import { useAutoFade } from './src/hooks/useAutoFade';
import { useScreenInsets, insetPadding } from './src/theme/insets';

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

function MainApp() {
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const isShortScreen = screenHeight < 740;
  const isExtraShort = screenHeight < 660;
  // Marge réellement mesurée (encoche, barre d'état, barre de navigation).
  // Remplace `StatusBar.currentHeight`, qui est une constante d'appareil et non
  // une mesure — voir src/theme/insets.ts.
  const insets = useScreenInsets();

  const [tracks, setTracks] = useState<Track[]>([]);
  const [currentTrackIndex, setCurrentTrackIndex] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isStartingUp, setIsStartingUp] = useState<boolean>(true);
  const [isAppLoadingVisible, setIsAppLoadingVisible] = useState<boolean>(true);
  // Zéro et non une durée de démo : sur une bibliothèque vide, une barre de
  // progression affichant 0:10 / 3:29 pour une piste inexistante était un
  // mensonge visible. Ces valeurs ne sont plus écrites qu'à la lecture réelle.
  const [positionMillis, setPositionMillis] = useState<number>(0);
  const [durationMillis, setDurationMillis] = useState<number>(0);
  const [isShuffle, setIsShuffle] = useState<boolean>(false);
  const [repeatMode, setRepeatMode] = useState<'off' | 'all' | 'one'>('all');

  // Persistence & Application settings
  const [appSettings, setAppSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);

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
  const isShuffleRef = useRef<boolean>(isShuffle);
  isShuffleRef.current = isShuffle;

  // Main navigation tab: 'player', 'library' or 'equalizer'
  const [currentTab, setCurrentTab] = useState<'player' | 'library' | 'equalizer'>('player');

  // Modals state
  const [isTrackListVisible, setIsTrackListVisible] = useState<boolean>(false);
  const [isSearchVisible, setIsSearchVisible] = useState<boolean>(false);
  const [isPresetsVisible, setIsPresetsVisible] = useState<boolean>(false);
  const [isSettingsVisible, setIsSettingsVisible] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [customPresets, setCustomPresets] = useState<EqualizerPreset[]>([]);

  // Playlists state (commence vide, sans fausses listes par défaut)
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [activePlaylistId, setActivePlaylistId] = useState<string | null>(null);
  const activePlaylistIdRef = useRef<string | null>(null);
  activePlaylistIdRef.current = activePlaylistId;

  // `null` = racine de la bibliothèque (la liste des catégories). Démarrer sur
  // 'playlists' ouvrait l'application directement dans une sous-liste.
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [activeGroupKey, setActiveGroupKey] = useState<string | null>(null);

  // Queue state (Morceaux programmés pour "Lire plus tard")
  const [queue, setQueue] = useState<Track[]>([]);
  const queueRef = useRef<Track[]>([]);
  queueRef.current = queue;

  // Context Action Menu, Queue Drawer & Sleep Timer states
  const [activeActionTrack, setActiveActionTrack] = useState<Track | null>(null);
  const [activeActionPlaylistId, setActiveActionPlaylistId] = useState<string | null>(null);
  const [isActionModalVisible, setIsActionModalVisible] = useState<boolean>(false);
  const [isQueueDrawerVisible, setIsQueueDrawerVisible] = useState<boolean>(false);
  const [isSleepTimerVisible, setIsSleepTimerVisible] = useState<boolean>(false);
  const [sleepTimerMinutes, setSleepTimerMinutes] = useState<number | null>(null);

  // Vrai tant que le navigateur n'a pas autorisé la lecture (web uniquement)
  const [needsUserGesture, setNeedsUserGesture] = useState<boolean>(
    Platform.OS === 'web'
  );

  // Equalizer & Tone DSP state (neutre par défaut : 0 dB, sans coloration initiale)
  const [dsp, setDsp] = useState<DSPState>({
    enabled: true,
    presetId: 'flat',
    bass: 0,
    treble: 0,
    preamp: 0,
    stereoExpansion: 0,
    crossfeed: 0,
    tempo: 1.0,
    bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    balance: 0.0,
    volume: 100,
    mono: false,
    tempoEnabled: false,
    // Réverbération éteinte : elle ne s'active que si l'utilisateur la demande.
    roomSize: 40,
    damping: 50,
    reverbMix: 25,
    reverbEnabled: false,
    // TONE et LIMIT actifs. Le limiteur reste actif par défaut : il porte la
    // garantie anti-écrêtage, qu'un utilisateur n'a pas à réclamer.
    toneEnabled: true,
    limitEnabled: true,
  });

  // Verrou d'hydratation : empêche d'écraser les réglages sauvegardés par des valeurs
  // par défaut à 0 lors du premier rendu React au démarrage
  const isHydratedRef = useRef<boolean>(false);
  const dspRef = useRef<DSPState>(dsp);
  dspRef.current = dsp;
  const repeatModeRef = useRef<'off' | 'all' | 'one'>(repeatMode);
  repeatModeRef.current = repeatMode;
  const playlistsRef = useRef<Playlist[]>(playlists);
  playlistsRef.current = playlists;

  // Bibliothèque vide possible : supprimer le dernier morceau laisse `tracks`
// à `[]`, et les deux accès ci-dessous renverraient alors `undefined` — que le
// rendu déréférence (`currentTrack.title`), d'où un crash natif. On garde donc
// un objet de repli plutôt que de laisser fuire `undefined`.
const currentTrack = tracks[currentTrackIndex] || tracks[0] || EMPTY_TRACK;
const hasTrack = tracks.length > 0 && currentTrack.id !== '__empty__' && !!currentTrack.uri;
const hasTrackRef = useRef(hasTrack);
hasTrackRef.current = hasTrack;

  // Estompage des contrôles après inactivité. Borné aux DEUX blocs de commandes
  // (pastilles utilitaires et transport) : étendu à l'écran, ce réglage rendrait
  // la bibliothèque et les modales inutilisables tant qu'il est actif.
  const {
    opacity: fadeOpacity,
    panHandlers: fadePanHandlers,
  } = useAutoFade({
    enabled: appSettings.autoFadeControls,
    minOpacity: appSettings.fadedOpacity,
    isPlaying,
  });

  // Résolution de la playlist active et de la liste de lecture courante
  const activePlaylist = useMemo(() => {
    if (!activePlaylistId) return null;
    return playlists.find((p) => p.id === activePlaylistId) || null;
  }, [activePlaylistId, playlists]);

  const currentPlaybackList = useMemo(() => {
    if (activePlaylist && activePlaylist.trackIds.length > 0) {
      const set = new Set(activePlaylist.trackIds);
      const filtered = tracks.filter((t) => set.has(t.id));
      if (filtered.length > 0) return filtered;
    }
    return tracks;
  }, [activePlaylist, tracks]);

  const currentPlaybackListRef = useRef<Track[]>(currentPlaybackList);
  currentPlaybackListRef.current = currentPlaybackList;

  // Sync volume and playback tempo with audio player
  useEffect(() => {
    playerManager.setVolume(dsp.volume ?? 100);
    playerManager.setPlaybackRate(dsp.tempoEnabled ? (dsp.tempo ?? 1.0) : 1.0);
  }, [dsp.volume, dsp.tempo, dsp.tempoEnabled]);

  // Auto-play audio & Restore previous session on startup
  useEffect(() => {
    let isMounted = true;
    (async () => {
      if (Platform.OS === 'android') {
        void requestAndroidStoragePermission();
      }
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
        // Le mode audio est posé dans `playerManager.init()` AVANT ce point, et
        // init() lit `autoResumeOnInterruption` — encore à sa valeur par défaut.
        // Sans cet appel, un utilisateur qui a coupé la reprise dans les
        // réglages la retrouverait activée à chaque lancement.
        void playerManager.setAutoResumeOnInterruption(savedSettings.resumeOnHeadset);
      }
      if (savedDsp) {
        setDsp(savedDsp);
        dspRef.current = savedDsp;
      }
      if (savedCustomPresets && savedCustomPresets.length > 0) {
        setCustomPresets(savedCustomPresets);
      }
      if (savedModes) {
        setIsShuffle(savedModes.isShuffle);
        isShuffleRef.current = savedModes.isShuffle;
        setRepeatMode(savedModes.repeatMode);
        repeatModeRef.current = savedModes.repeatMode;
      }
      // Restauration de la bibliothèque musicale.
      // Elle passe en PREMIER : playlists et file d'attente ne sont restaurées
      // qu'après, pour pouvoir filtrer les identifiants qui ne résolvent plus.
      let currentTrackList: Track[] = savedCustomTracks ?? [];
      if (Platform.OS === 'web' && currentTrackList.length > 0) {
        currentTrackList = await restoreWebAudioBlobs(currentTrackList);
      }
      // Migration : les pistes de démonstration sont retirées du code, mais une
      // installation antérieure les a pu PERSISTER dans la bibliothèque (elles
      // étaient la liste initiale, donc « les morceaux importés » pour le
      // stockage). Sans ce filtre, l'application continuerait de les afficher
      // indéfiniment, puisque rien ne les supprime du stockage — la seule
      // trace qui en reste est l'URI et l'identifiant.
      currentTrackList = currentTrackList.filter((t) => !t.id.startsWith('demo-'));
      if (currentTrackList.length > 0) {
        setTracks(currentTrackList);
        tracksRef.current = currentTrackList;
      }

      // Les pistes retirées (démonstration) peuvent encore être référencées par
      // les playlists et la file d'attente persistées. Sans ce filtre, une
      // install mise à jour afficherait « 1 morceau » pour une piste qui
      // n'existe plus, et jouer un élément de la file le ferait disparaître
      // sans rien jouer (`idx === -1`, sans `else`).
      // On ne garde donc que ce qui résout encore dans la bibliothèque.
      const validIds = new Set(currentTrackList.map((t) => t.id));
      if (savedPlaylists && savedPlaylists.length > 0) {
        const filteredPlaylists = savedPlaylists.map((pl) => ({
          ...pl,
          trackIds: pl.trackIds.filter((id) => validIds.has(id)),
        }));
        setPlaylists(filteredPlaylists);
        playlistsRef.current = filteredPlaylists;
      }
      if (savedQueue && savedQueue.length > 0) {
        const filteredQueue = savedQueue.filter((t) => validIds.has(t.id));
        setQueue(filteredQueue);
        queueRef.current = filteredQueue;
      }

      // Restauration de la dernière musique et de la position d'écoute
      let targetIndex = 0;
      let resumePosMs = 0;
      const shouldRemember = savedSettings?.rememberLastTrack ?? true;
      const shouldAutoPlay = savedSettings?.autoPlayOnLaunch ?? false;

      if (shouldRemember && savedLast) {
        if (savedLast.activePlaylistId) {
          setActivePlaylistId(savedLast.activePlaylistId);
          activePlaylistIdRef.current = savedLast.activePlaylistId;
        }
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

      // ── Verrou d'hydratation : ici, et pas 150 ms plus tôt ────────────────
      //
      // Il était posé par un `setTimeout(…, 150)` placé AVANT le
      // `await loadTrack`. Un minuteur n'est pas une barrière : sur un
      // démarrage natif à froid, `loadTrack` est encore en vol 150 ms plus
      // tard — c'est le cas ordinaire, pas l'exception. Le verrou s'ouvrait donc
      // pendant que la restauration n'était pas terminée.
      //
      // Ce qui pouvait alors écrire : l'abonnement au volume système (ligne
      // ~800) appelle `setDsp(prev => ({ ...prev, volume }))` dès que iOS
      // rapporte un niveau, ce qui arrive typiquement dans cette fenêtre. Cet
      // effet déclenche `saveDSP`, protégé par `isHydratedRef` — donc la courbe
      // d'égaliseur de l'utilisateur, relue à l'instant, était écrasée par un
      // état construit sur les valeurs PAR DÉFAUT. Au lancement suivant, la
      // courbe était plate. Aucune erreur, aucun signe : l'égaliseur se
      // réinitialisait seul.
      //
      // Le curseur est donc posé ici, après le dernier `await` : à partir de
      // cette ligne, tout ce que l'application a restauré est en place, et les
      // effets de sauvegarde ne peuvent plus écrire que des changements réels.
      if (isMounted) {
        isHydratedRef.current = true;
      }

      // Fin du chargement initial : transition fluide vers le lecteur
      setTimeout(() => {
        if (isMounted) {
          setIsStartingUp(false);
        }
      }, 400);
    })().catch((e) => {
      // Un rejet ICI avait un effet terminal : `setIsStartingUp(false)` n'est
      // atteint qu'en fin de ce chemin, et le splash reste affiché tant que
      // ce drapeau est vrai. Une seule promesse rejetée — un pont natif qui
      // refuse, un fichier illisible — suffisait donc à boucher l'app au
      // démarrage, sans message et sans issue.
      //
      // Le chargement a échoué, mais l'application est utilisable : on libère
      // l'écran de chargement et on laisse l'utilisateur atteindre l'interface vide
      // plutôt que de le garder devant un logo éternel.
      console.warn('Échec du démarrage, ouverture sur une bibliothèque vide:', e);
      if (isMounted) {
        // Le verrou doit être levé ICI aussi. `loadTrack` est le dernier await
        // de l'hydratation : s'il rejette, la ligne qui le pose n'est jamais
        // atteinte, et les cinq effets de sauvegarde resteraient bloqués
        // indéfiniment. L'utilisateur pourrait changer tous ses réglages sans
        // que rien ne soit jamais écrit sur le disque — le défaut inverse de
        // celui qu'on corrige, et tout aussi silencieux.
        isHydratedRef.current = true;
        setIsStartingUp(false);
      }
    });

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
      activePlaylistId: activePlaylistIdRef.current,
    });
  };

  // Sauvegarde périodique (toutes les 5 secondes en premier plan uniquement)
  useEffect(() => {
    const timer = setInterval(() => {
      if (isPlayingRef.current && (Platform.OS === 'web' || AppState.currentState === 'active')) {
        persistSession();
      }
    }, 5000);
    return () => clearInterval(timer);
  }, []);

  // Sauvegarde sur mise en arrière-plan (Native) ou fermeture de page (Web)
  useEffect(() => {
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      const handleUnload = () => {
        persistSession();
        if (isHydratedRef.current) {
          void storageService.saveDSP(dspRef.current);
          void storageService.savePlaybackModes({
            isShuffle: isShuffleRef.current,
            repeatMode: repeatModeRef.current,
          });
          void storageService.savePlaylists(playlistsRef.current);
          void storageService.saveQueue(queueRef.current);
          void storageService.saveCustomTracks(tracksRef.current);
        }
      };
      window.addEventListener('beforeunload', handleUnload);
      return () => window.removeEventListener('beforeunload', handleUnload);
    } else {
      const sub = AppState.addEventListener('change', (state) => {
        if (state === 'background' || state === 'inactive') {
          // Avant toute sauvegarde : la détection de rythme n'a aucun intérêt en
          // screen off, et son flux natif traverserait le pont en continu. Voir
          // `playerManager.setAppActive`.
          playerManager.setAppActive(false);
          persistSession();
          if (isHydratedRef.current) {
            void storageService.saveDSP(dspRef.current);
            void storageService.savePlaybackModes({
              isShuffle: isShuffleRef.current,
              repeatMode: repeatModeRef.current,
            });
            void storageService.savePlaylists(playlistsRef.current);
            void storageService.saveQueue(queueRef.current);
            void storageService.saveCustomTracks(tracksRef.current);
          }
        } else if (state === 'active') {
          playerManager.setAppActive(true);
          playerManager.syncPlaybackState();
          setPositionMillis(positionMillisRef.current);
          if (durationMillisRef.current > 0) {
            setDurationMillis(durationMillisRef.current);
          }
          setIsPlaying(isPlayingRef.current);
        }
      });
      return () => sub.remove();
    }
  }, []);

  // Sauvegarde automatique des réglages DSP dès modification (protégée contre l'écrasement initial)
  useEffect(() => {
    if (!isHydratedRef.current) return;
    storageService.saveDSP(dsp);
  }, [dsp]);

  // Sauvegarde des modes de lecture (shuffle / repeat)
  useEffect(() => {
    if (!isHydratedRef.current) return;
    storageService.savePlaybackModes({ isShuffle, repeatMode });
  }, [isShuffle, repeatMode]);

  // Sauvegarde des playlists personnalisées
  useEffect(() => {
    if (!isHydratedRef.current) return;
    storageService.savePlaylists(playlists);
  }, [playlists]);

  // Sauvegarde de la file d'attente
  useEffect(() => {
    if (!isHydratedRef.current) return;
    storageService.saveQueue(queue);
  }, [queue]);

  // Sauvegarde des morceaux importés.
  useEffect(() => {
    if (!isHydratedRef.current) return;
    storageService.saveCustomTracks(tracks);
  }, [tracks]);

  const handleUpdateSettings = async (newSettings: Partial<AppSettings>) => {
    const updated = await storageService.saveSettings(newSettings);
    setAppSettings(updated);
    appSettingsRef.current = updated;

    // La reprise après interruption se décide AU NIVEAU DU MODE AUDIO, pas
    // dans un rendu : sans cet appel, le réglage n'aurait d'effet qu'au
    // prochain démarrage de l'app — l'utilisateur le couperait, verrait que la
    // musique reprend quand même après un appel, et aurait raison de dire que
    // ça ne marche pas.
    if (newSettings.resumeOnHeadset !== undefined) {
      void playerManager.setAutoResumeOnInterruption(newSettings.resumeOnHeadset);
    }
  };

  const handleClearSession = async () => {
    await storageService.clearAllSessionData();
    setDsp({
      enabled: true,
      presetId: 'flat',
      bass: 0,
      treble: 0,
      preamp: 0,
      stereoExpansion: 0,
      crossfeed: 0,
      tempo: 1.0,
      bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      balance: 0.0,
      volume: 100,
      mono: false,
      tempoEnabled: false,
      // « Effacer la session » doit aussi silence la réverbération : la laisser
      // active donnerait un morceau conservé dans une pièce qui n'existe plus.
      roomSize: 40,
      damping: 50,
      reverbMix: 25,
      reverbEnabled: false,
      // Ces deux-là reviennent à l'état par défaut, c'est-à-dire actifs.
      toneEnabled: true,
      limitEnabled: true,
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
      isAdvancingRef.current = false;
      const list = trackList || tracksRef.current;
      const targetTrack = list[index];
      if (!targetTrack) return;

      setCurrentTrackIndex(index);
      currentTrackIndexRef.current = index;
      setIsPlaying(shouldPlay);

      const initialPos = initialPositionMs ?? 0;
      setPositionMillis(initialPos);
      positionMillisRef.current = initialPos;

      const targetUri = resolveTrackUri(targetTrack.uri);

      await playerManager.loadTrack(
        targetUri,
        shouldPlay,
        (status) => {
          if (!status) return;
          const curMs = (status.currentTime || 0) * 1000;
          positionMillisRef.current = curMs;

          // Durée dynamique et synchronisée
          const durSeconds = status.duration && status.duration > 0 ? status.duration : 0;
          const durMs = (durSeconds > 0 ? durSeconds : targetTrack.duration || 0) * 1000;
          durationMillisRef.current = durMs;
          isPlayingRef.current = status.isPlaying;

          // En arrière-plan (écran verrouillé / autre app), éviter 4 reconciliations React
          // complètes par seconde qui saturent le thread JS et provoquent la fermeture de l'app.
          const isAppActive = Platform.OS === 'web' || AppState.currentState === 'active';
          if (isAppActive) {
            setPositionMillis(curMs);
            setDurationMillis(durMs);
            setIsPlaying(status.isPlaying);

            // Si le morceau n'avait pas encore sa durée calculée, la sauvegarder immédiatement
            if (durSeconds > 0 && (!targetTrack.duration || targetTrack.duration <= 0)) {
              const intDur = Math.round(durSeconds);
              targetTrack.duration = intDur;
              setTracks((prev) =>
                prev.map((t) => (t.id === targetTrack.id ? { ...t, duration: intDur } : t))
              );
            }
          }

          // Garde de ré-entrance : le lecteur peut émettre `didFinish` à
          // plusieurs reprises tant que la piste suivante n'est pas chargée.
          // Sans ce verrou, chaque émission empile un nouveau `loadTrack` et
          // donc un nouvel écouteur de statut auprès du moteur natif.
          if (status.didFinish && !isAdvancingRef.current) {
            isAdvancingRef.current = true;
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
        {
          title: targetTrack.title,
          artist: targetTrack.artist,
          album: targetTrack.album,
          artwork: targetTrack.artwork,
        },
        targetTrack.id
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
    if (!hasTrack) return;
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    } catch {}

    if (isPlayingRef.current) {
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
    if (!hasTrack) return;
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {}

    const curList = currentPlaybackListRef.current;
    if (curList.length === 0) return;

    const curTrackId = tracksRef.current[currentTrackIndexRef.current]?.id;
    const curIdx = curList.findIndex((t) => t.id === curTrackId);

    let nextIndex = 0;
    if (isShuffleRef.current) {
      nextIndex = Math.floor(Math.random() * curList.length);
    } else {
      nextIndex = curIdx !== -1 ? (curIdx + 1) % curList.length : 0;
    }

    const nextTrack = curList[nextIndex];
    if (nextTrack) {
      const globalIdx = tracksRef.current.findIndex((t) => t.id === nextTrack.id);
      if (globalIdx !== -1) {
        await loadTrack(globalIdx, true, 0);
      }
    }
  };

  const handlePrevTrack = async () => {
    if (!hasTrack) return;
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {}

    const curList = currentPlaybackListRef.current;
    if (curList.length === 0) return;

    if (positionMillisRef.current > 3000) {
      await playerManager.seekToSeconds(0);
      setPositionMillis(0);
      positionMillisRef.current = 0;
      persistSession();
      return;
    }

    const curTrackId = tracksRef.current[currentTrackIndexRef.current]?.id;
    const curIdx = curList.findIndex((t) => t.id === curTrackId);

    const prevIndex = curIdx !== -1 ? (curIdx - 1 + curList.length) % curList.length : 0;
    const prevTrack = curList[prevIndex];
    if (prevTrack) {
      const globalIdx = tracksRef.current.findIndex((t) => t.id === prevTrack.id);
      if (globalIdx !== -1) {
        await loadTrack(globalIdx, true, 0);
      }
    }
  };

  /**
   * Volume système iOS (boutons de l'appareil).
   *
   * Reste `null` partout où il est illisible — c'est-à-dire partout sauf iOS
   * natif : aucun navigateur n'expose le volume du système. Dans ce cas le knob
   * redevient une attestation app-locale et l'interface le dit, plutôt que de
   * laisser croire à une synchronisation qui n'existe pas.
   */
  const [systemVolume, setSystemVolume] = useState<number | null>(null);

  useEffect(() => {
    const unsubscribe = playerManager.subscribeSystemVolume((vol) => {
      setSystemVolume(vol);
      if (vol !== null) {
        setDsp((prev) => ({ ...prev, volume: vol }));
      }
    });
    return () => unsubscribe();
  }, []);

  const handleNextTrackRef = useRef(handleNextTrack);
  handleNextTrackRef.current = handleNextTrack;
  const handlePrevTrackRef = useRef(handlePrevTrack);
  handlePrevTrackRef.current = handlePrevTrack;

  // Écoute des commandes de l'écran verrouillé / notification iOS (Morceau suivant, précédent, play/pause)
  useEffect(() => {
    const unsub = playerManager.addRemoteCommandListener((action) => {
      if (action === 'next') {
        handleNextTrackRef.current();
      } else if (action === 'previous') {
        handlePrevTrackRef.current();
      } else if (action === 'play') {
        if (!hasTrackRef.current) return;
        playerManager.play();
        setIsPlaying(true);
        isPlayingRef.current = true;
      } else if (action === 'pause') {
        playerManager.pause();
        setIsPlaying(false);
        isPlayingRef.current = false;
        persistSession();
      }
    });

    return () => {
      unsub();
    };
  }, []);

  const handleFastForward = async () => {
    if (!hasTrack) return;
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
    if (!hasTrack) return;
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
    if (!hasTrack) return;
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
    setDsp((prev) => ({
      ...prev,
      presetId: preset.id,
      bass: preset.bass ?? 0,
      treble: preset.treble ?? 0,
      preamp: preset.preamp ?? 0,
      bands: [...preset.bands],
    }));
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
    setTracks((prev) => {
      const { tracks: merged, added, repaired, skipped } = mergeTracks(prev, newTracks);

      // Supprimer les copies locales temporaires créées pour des pistes qui sont des doublons réels
      if (skipped.length > 0) {
        skipped.forEach((t) => {
          if (t.uri && t.uri.includes('/tracks/') && !prev.some((p) => p.uri === t.uri)) {
            void deletePersistedAudioFile(t.uri);
          }
        });
      }

      if (added === 0 && repaired === 0) {
        Alert.alert(
          'Morceaux déjà présents',
          newTracks.length === 1
            ? 'Ce morceau est déjà présent et fonctionnel dans votre bibliothèque musicale.'
            : `Tous les ${newTracks.length} morceaux sont déjà dans votre bibliothèque. Aucun doublon n'a été ajouté.`
        );
        return prev;
      }

      if (repaired > 0 || skipped.length > 0) {
        Alert.alert(
          'Importation terminée',
          `${added} nouveau(x) morceau(x) ajouté(s)${repaired > 0 ? `, ${repaired} morceau(x) réparé(s)` : ''}.${skipped.length > 0 ? ` ${skipped.length} doublon(s) ignoré(s).` : ''}`
        );
      }

      return merged;
    });
  };

  /**
   * Rescan de la bibliothèque, et Renvoie le nombre de morceaux RÉELLEMENT ajoutés.
   *
   * Ce bouton affichait « Bibliothèque actualisée avec succès ! » après 800 ms
   * sans avoir rien fait : le callback fourni à la modale n'était qu'un
   * `console.log`. Le compte rendu vient donc du scan lui-même, et une
   * annulation du sélecteur remonte en échec au lieu d'être absorbée.
   *
   * Une limite assumée : `pickAudioFiles` ouvre le sélecteur système — il n'existe
   * aucun chemin non interactif pour relire un dossier en arrière-plan. « Actualiser »
   * est donc un ré-import, pas une réindexation ; c'est aussi ce que voit
   * l'utilisateur, puisque c'est lui qui choisit les fichiers.
   *
   * On ne rapporte que des AJOUTS. Rien ne prouve qu'un fichier a disparu du
   * stockage sans le relire entièrement, et annoncer des suppressions
   * invérifiables serait retomber dans le mensonge que ce handler corrige.
   */
  const handleRescanLibrary = async (): Promise<number> => {
    const res = await pickAudioFiles(tracksRef.current);
    // Sélecteur annulé, ou aucun fichier audio lisible : ni l'un ni l'autre
    // n'est une erreur technique, mais aucun n'est un succès à annoncer.
    if (!res || res.tracks.length === 0) {
      throw new Error(res ? 'Aucun nouveau fichier audio' : 'Sélection annulée');
    }

    // Le dédoublonnage est refait ici, et non délégué à `handleAddTracks` : celui-ci
    // travaille dans un `setTracks` dont le corps n'est pas exécuté avant le
    // rendu suivant, donc le nombre d'ajouts n'y est pas lisible au moment où
    // le rescan doit rendre son verdict.
    const { added } = mergeTracks(tracksRef.current, res.tracks);
    if (added === 0) {
      throw new Error('Tous les morceaux sont déjà présents');
    }

    handleAddTracks(res.tracks);
    return added;
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

  const openTrackAction = (track: Track, playlistId?: string | null) => {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {}
    setActiveActionTrack(track);
    setActiveActionPlaylistId(playlistId || activePlaylistId || null);
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
    // La restauration filtre déjà la file contre la bibliothèque, donc ce cas
    // ne devrait pas survenir. S'il le fait malgré tout, on prévient plutôt que
    // de laisser l'élément disparaître de la file sans qu'aucun son ne parte.
    else {
      Alert.alert('Piste introuvable', `"${track.title}" ne fait plus partie de la bibliothèque.`);
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
    if (activePlaylistId === playlistId) {
      setActivePlaylistId(null);
    }
    setPlaylists((prev) => prev.filter((pl) => pl.id !== playlistId));
  };

  const handleUpdateTrackTags = (updatedTrack: Track) => {
    setTracks((prev) =>
      prev.map((t) => (t.id === updatedTrack.id ? updatedTrack : t))
    );
  };

  const handleDeleteTrack = (trackToDelete: Track) => {
    // Supprimer le fichier audio physique du stockage de l'application (et IndexedDB sur Web)
    void deletePersistedAudioFile(trackToDelete.uri, trackToDelete.id);
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

  const handleDeleteFolder = (folderName: string) => {
    const folderTracks = tracks.filter((t) => {
      if (t.folder && t.folder === folderName) return true;
      if (!t.folder && (folderName === 'Musique importée' || t.album === folderName)) return true;
      return false;
    });
    const folderTrackIds = new Set(folderTracks.map((t) => t.id));

    // Supprimer les fichiers physiques du stockage de l'application (et IndexedDB sur Web)
    folderTracks.forEach((t) => {
      void deletePersistedAudioFile(t.uri, t.id);
    });

    setTracks((prev) => prev.filter((t) => !folderTrackIds.has(t.id)));
    setQueue((prev) => prev.filter((t) => !folderTrackIds.has(t.id)));
    setPlaylists((prev) =>
      prev.map((pl) => ({
        ...pl,
        trackIds: pl.trackIds.filter((id) => !folderTrackIds.has(id)),
      }))
    );

    if (folderTrackIds.has(currentTrack.id)) {
      handleNextTrack();
    }
  };

  const handleRenameFolder = (oldFolderName: string, newFolderName: string) => {
    const trimmed = newFolderName.trim();
    if (!trimmed || trimmed === oldFolderName) return;

    setTracks((prev) =>
      prev.map((t) => {
        const match =
          (t.folder && t.folder === oldFolderName) ||
          (!t.folder && (oldFolderName === 'Musique importée' || t.album === oldFolderName));
        if (match) {
          return {
            ...t,
            folder: trimmed,
            album: t.album === oldFolderName ? trimmed : t.album,
          };
        }
        return t;
      })
    );

    setQueue((prev) =>
      prev.map((t) => {
        const match =
          (t.folder && t.folder === oldFolderName) ||
          (!t.folder && (oldFolderName === 'Musique importée' || t.album === oldFolderName));
        if (match) {
          return {
            ...t,
            folder: trimmed,
            album: t.album === oldFolderName ? trimmed : t.album,
          };
        }
        return t;
      })
    );
  };

  const handleRemoveFromPlaylist = (track: Track, playlistId: string) => {
    setPlaylists((prev) =>
      prev.map((pl) => {
        if (pl.id === playlistId) {
          return {
            ...pl,
            trackIds: pl.trackIds.filter((id) => id !== track.id),
          };
        }
        return pl;
      })
    );
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
      setPlaylists((prev) => {
        const existing = prev.find((pl) => pl.id === 'pl-favorites');
        if (existing) {
          if (!existing.trackIds.includes(track.id)) {
            return prev.map((pl) =>
              pl.id === 'pl-favorites'
                ? { ...pl, trackIds: [...pl.trackIds, track.id] }
                : pl
            );
          }
          return prev;
        } else {
          return [
            {
              id: 'pl-favorites',
              name: 'Coups de Cœur',
              description: 'Mes morceaux préférés',
              trackIds: [track.id],
              createdAt: Date.now(),
            },
            ...prev,
          ];
        }
      });
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

  /**
   * Choix d'un morceau PAR L'UTILISATEUR — un des deux points d'entrée du
   * réglage « vider la file ».
   *
   * Volontairement pas dans `loadTrack` : tout démarrage de lecture y passe, y
   * compris l'enchaînement automatique en fin de morceau, qui décale lui-même
   * la file (`setQueue(prev => prev.slice(1))`). Vider là-bas effacerait la
   * file à chaque morceau terminé, et le morceau suivant n'aurait jamais rien à
   * jouer. Seuls les clics humans vident la file ; la lecture depuis la file
   * elle-même (`handlePlayQueuedTrack`) est exclue pour la même raison — vider
   * au moment d'en consume un élément le ferait disparaître.
   */
  const clearQueueIfRequested = () => {
    if (appSettingsRef.current.clearQueueOnNewPlay) {
      setQueue([]);
    }
  };

  const handleSelectTrack = (track: Track) => {
    const idx = tracks.findIndex((t) => t.id === track.id);
    if (idx !== -1) {
      clearQueueIfRequested();
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
      <SafeAreaView
        style={styles.safeContainer}
        edges={Platform.OS === 'ios' ? ['top', 'bottom', 'left', 'right'] : ['left', 'right']}
      >
        <StatusBar style="light" />

        <View style={styles.appContainer}>
          {/* TAB 1: PLAYER SCREEN */}
          <View style={{ flex: 1, display: currentTab === 'player' ? 'flex' : 'none' }}>
            <ScrollView
              contentContainerStyle={{
                flexGrow: 1,
                justifyContent: 'space-between',
                paddingBottom: isShortScreen ? 2 : 6,
              }}
              showsVerticalScrollIndicator={false}
              bounces={false}
              scrollEnabled={screenHeight < 620}
            >
              {/* Top Bar on Player Screen: Left Queue Drawer, Center MAS Logo & Right Cast */}
              <View
                style={[
                  styles.topPlayerBar,
                  {
                    paddingTop:
                      Platform.OS === 'android'
                        ? insetPadding(insets, 'top', 4)
                        : Platform.OS === 'ios'
                        ? 4
                        : 8,
                  },
                ]}
              >
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

                <View style={{ width: 34 }} />
              </View>

              {/* Main Visualizer Area: visualiseur d'ondes néon réactif au rythme du son */}
              <View
                style={[
                  styles.centerStage,
                  {
                    minHeight: isExtraShort ? 130 : isShortScreen ? 160 : 210,
                  },
                ]}
              >
                <NeonWaveVisualizer
                  isActive={hasTrack && isPlaying}
                  hasTrack={hasTrack}
                  spectrumReactive={appSettings.spectrumReactive}
                />
              </View>

              {/* Like / Dislike + 3-Dots Row matching latest user screenshot */}
              <View
                style={[
                  styles.ratingActionsRow,
                  { marginBottom: isShortScreen ? 4 : 10 },
                ]}
              >
                <View style={[styles.thumbsPill, !hasTrack && { opacity: 0.35 }]}>
                  <TouchableOpacity
                    style={styles.thumbBtn}
                    onPress={() => handleToggleFavorite(currentTrack)}
                    disabled={!hasTrack}
                    activeOpacity={0.7}
                  >
                    <Ionicons
                      name={currentTrack.isFavorite ? 'thumbs-up' : 'thumbs-up-outline'}
                      size={18}
                      color={hasTrack ? (currentTrack.isFavorite ? '#38BDF8' : '#D1D5DB') : '#64748B'}
                    />
                  </TouchableOpacity>

                  <View style={styles.thumbsDivider} />

                  <TouchableOpacity
                    style={styles.thumbBtn}
                    onPress={handleNextTrack}
                    disabled={!hasTrack}
                    activeOpacity={0.7}
                  >
                    <Ionicons name="thumbs-down-outline" size={18} color={hasTrack ? '#D1D5DB' : '#64748B'} />
                  </TouchableOpacity>
                </View>

                {/* 3-Dots Menu Button */}
                <TouchableOpacity
                  style={[styles.songMoreBtn, !hasTrack && { opacity: 0.35 }]}
                  onPress={() => openTrackAction(currentTrack)}
                  disabled={!hasTrack}
                  activeOpacity={0.7}
                >
                  <MaterialCommunityIcons name="dots-vertical" size={22} color={hasTrack ? '#FFFFFF' : '#64748B'} />
                </TouchableOpacity>
              </View>

              {/* Metadata Badges: Title in dark rounded pill, Artist in subtitle */}
              <View
                style={[
                  styles.metaSection,
                  { marginBottom: isShortScreen ? 6 : 12 },
                ]}
              >
                <View style={styles.titlePill}>
                  <Text numberOfLines={1} style={styles.trackTitleText}>
                    {currentTrack.title}
                  </Text>
                </View>
                <Text numberOfLines={1} style={styles.trackSubtitleText}>
                  {currentTrack.artist}{currentTrack.album ? ` - ${currentTrack.album}` : ''}
                </Text>
              </View>

              {/* Quick Utility Pill Buttons Row: EQ, Timer, Repeat, Shuffle */}
              <Animated.View
                {...fadePanHandlers}
                style={[
                  styles.utilityPillsRow,
                  { marginBottom: isShortScreen ? 6 : 14 },
                  { opacity: fadeOpacity },
                ]}
              >
                {/* Left Utility Pills */}
                <View style={styles.pillsSubgroup}>
                  <TouchableOpacity
                    onPress={() => setCurrentTab('equalizer')}
                    style={[
                      styles.utilityPill,
                      isShortScreen && { paddingVertical: 6, paddingHorizontal: 12 },
                    ]}
                    activeOpacity={0.7}
                  >
                    <MaterialCommunityIcons
                      name="equalizer"
                      size={isShortScreen ? 18 : 20}
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
                    style={[
                      styles.utilityPill,
                      isShortScreen && { paddingVertical: 6, paddingHorizontal: 12 },
                    ]}
                    activeOpacity={0.7}
                  >
                    <Ionicons
                      name={sleepTimerMinutes !== null ? 'time' : 'time-outline'}
                      size={isShortScreen ? 18 : 20}
                      color={sleepTimerMinutes !== null ? '#38BDF8' : '#8A9AA8'}
                    />
                  </TouchableOpacity>
                </View>

                {/* Right Utility Pills */}
                <View style={styles.pillsSubgroup}>
                  <TouchableOpacity
                    onPress={toggleRepeatMode}
                    style={[
                      styles.utilityPill,
                      isShortScreen && { paddingVertical: 6, paddingHorizontal: 12 },
                    ]}
                    activeOpacity={0.7}
                  >
                    <MaterialCommunityIcons
                      name={repeatMode === 'one' ? 'repeat-once' : 'repeat'}
                      size={isShortScreen ? 19 : 22}
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
                    style={[
                      styles.utilityPill,
                      isShortScreen && { paddingVertical: 6, paddingHorizontal: 12 },
                    ]}
                    activeOpacity={0.7}
                  >
                    <MaterialCommunityIcons
                      name="shuffle-variant"
                      size={isShortScreen ? 19 : 22}
                      color={isShuffle ? '#FFFFFF' : '#8A9AA8'}
                    />
                  </TouchableOpacity>
                </View>
              </Animated.View>

              {/* Transport controls — tailles adaptatives selon la hauteur de l'écran */}
              <Animated.View
                style={[
                  styles.transportRow,
                  { marginVertical: isShortScreen ? 4 : 8 },
                  { opacity: fadeOpacity },
                ]}
              >
                <TouchableOpacity
                  onPress={handleFastRewind}
                  disabled={!hasTrack}
                  style={[
                    styles.smallTransportBtn,
                    isShortScreen && { width: 32, height: 32, borderRadius: 16 },
                    !hasTrack && { opacity: 0.35 },
                  ]}
                  activeOpacity={0.7}
                >
                  <Ionicons name="play-back" size={isShortScreen ? 13 : 15} color={hasTrack ? '#FFFFFF' : '#64748B'} />
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={handlePrevTrack}
                  disabled={!hasTrack}
                  style={[
                    styles.mediumTransportBtn,
                    isShortScreen && { width: 44, height: 44, borderRadius: 22 },
                    !hasTrack && { opacity: 0.35 },
                  ]}
                  activeOpacity={0.7}
                >
                  <Ionicons name="play-back" size={isShortScreen ? 20 : 24} color={hasTrack ? '#FFFFFF' : '#64748B'} />
                </TouchableOpacity>

                {/* Central Play/Pause Button - Responsive size */}
                <TouchableOpacity
                  onPress={handlePlayPause}
                  disabled={!hasTrack}
                  style={[
                    styles.bigCentralPlayBtn,
                    isShortScreen && { width: 68, height: 68, borderRadius: 34 },
                    !hasTrack && { opacity: 0.35 },
                  ]}
                  activeOpacity={0.8}
                >
                  {isLoading ? (
                    <ActivityIndicator color="#FFFFFF" size="small" />
                  ) : (
                    <Ionicons
                      name={isPlaying && hasTrack ? 'pause' : 'play'}
                      size={isShortScreen ? 34 : 42}
                      color={hasTrack ? '#FFFFFF' : '#64748B'}
                      style={{ marginLeft: isPlaying && hasTrack ? 0 : 3 }}
                    />
                  )}
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={handleNextTrack}
                  disabled={!hasTrack}
                  style={[
                    styles.mediumTransportBtn,
                    isShortScreen && { width: 44, height: 44, borderRadius: 22 },
                    !hasTrack && { opacity: 0.35 },
                  ]}
                  activeOpacity={0.7}
                >
                  <Ionicons name="play-forward" size={isShortScreen ? 20 : 24} color={hasTrack ? '#FFFFFF' : '#64748B'} />
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={handleFastForward}
                  disabled={!hasTrack}
                  style={[
                    styles.smallTransportBtn,
                    isShortScreen && { width: 32, height: 32, borderRadius: 16 },
                    !hasTrack && { opacity: 0.35 },
                  ]}
                  activeOpacity={0.7}
                >
                  <Ionicons name="play-forward" size={isShortScreen ? 13 : 15} color={hasTrack ? '#FFFFFF' : '#64748B'} />
                </TouchableOpacity>
              </Animated.View>

              {/* Barre de progression scrubbable */}
              <ProgressBar
                positionMillis={hasTrack ? positionMillis : 0}
                durationMillis={hasTrack ? durationMillis : 0}
                onSeekCommit={handleSeekCommit}
                disabled={!hasTrack}
              />

              {/* Time & Tech Specs Row */}
              {appSettings.showTrackDetails !== false && currentTrack.uri !== '' && (
                <View
                  style={[
                    styles.timeSpecsRow,
                    {
                      marginTop: isShortScreen ? 4 : 8,
                      marginBottom: isShortScreen ? 4 : 10,
                    },
                  ]}
                >
                  <View style={styles.specsPill}>
                    <Text style={styles.specsPillText}>
                      {currentTrack.sampleRate ? `${currentTrack.sampleRate}` : '44.1 KHZ'}{' '}
                      {currentTrack.bitrate ? `${currentTrack.bitrate}` : '1116 KBPS'}{' '}
                      {currentTrack.format ? currentTrack.format : 'FLAC'}
                    </Text>
                  </View>
                </View>
              )}
            </ScrollView>
          </View>

          {/* TAB 2: LIBRARY SCREEN MATCHING USER SCREENSHOT 1 */}
          <View style={{ flex: 1, display: currentTab === 'library' ? 'flex' : 'none' }}>
            <LibraryView
              tracks={tracks}
              currentTrack={currentTrack}
              isPlaying={isPlaying}
              playlists={playlists}
              activePlaylistId={activePlaylistId}
              activeCategory={activeCategory}
              selectedGroupKey={activeGroupKey}
              isVisible={currentTab === 'library'}
              onPlayPause={() => handlePlayPause()}
              onSelectTrack={(track, playlist, category, groupKey) => {
                if (playlist) {
                  setActivePlaylistId(playlist.id);
                  setActiveCategory('playlists');
                  setActiveGroupKey(null);
                } else if (category) {
                  setActivePlaylistId(null);
                  setActiveCategory(category);
                  setActiveGroupKey(groupKey || null);
                }
                const idx = tracks.findIndex((t) => t.id === track.id);
                if (idx !== -1) {
                  clearQueueIfRequested();
                  loadTrack(idx, true);
                }
              }}
              onNavigateCategory={(category, groupKey, playlist) => {
                setActiveCategory(category);
                setActiveGroupKey(groupKey || null);
                if (playlist) {
                  setActivePlaylistId(playlist.id);
                }
              }}
              onAddTracks={handleAddTracks}
              onBackToPlayer={() => setCurrentTab('player')}
              onTrackAction={openTrackAction}
              onCreatePlaylist={handleCreatePlaylist}
              onDeletePlaylist={handleDeletePlaylist}
              onDeleteFolder={handleDeleteFolder}
              onRenameFolder={handleRenameFolder}
              onOpenQueueDrawer={() => setIsQueueDrawerVisible(true)}
              sort={appSettings.librarySort}
              ignoreShortAudio={appSettings.ignoreShortAudio}
            />
          </View>

          {/* TAB 3: EQUALIZER SCREEN MATCHING USER SCREENSHOT */}
          <View style={{ flex: 1, display: currentTab === 'equalizer' ? 'flex' : 'none' }}>
            <EqualizerView
              dsp={dsp}
              systemVolume={systemVolume}
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
                disabled={!hasTrack}
                style={[styles.miniPlayBtn, !hasTrack && { opacity: 0.35 }]}
                activeOpacity={0.7}
              >
                <Ionicons
                  name={isPlaying && hasTrack ? 'pause' : 'play'}
                  size={24}
                  color={hasTrack ? '#FFFFFF' : '#64748B'}
                />
              </TouchableOpacity>
            </TouchableOpacity>
          </View>

          {/* Bottom Elevated Navigation Dock: Grid, Equalizer, Search, Menu */}
          <View
            style={[
              styles.bottomDock,
              {
                paddingVertical: isShortScreen ? 8 : 11,
                // La barre de navigation du système occupe le bas de l'écran et
                // le dock se dessinait dessous. La marge système s'ajoute à
                // l'espacement esthétique du dock.
                //
                // Android seulement : le SafeAreaView racine ne réclame que
                // ['left','right'], donc il faut la marge ici. Sur iOS il
                // réclame déjà 'bottom' (ligne 1270) — l'appliquer aussi
                // surélevait le dock d'une seconde barre home.
                marginBottom:
                  Platform.OS === 'android'
                    ? insetPadding(insets, 'bottom', isShortScreen ? 4 : 8)
                    : 0,
              },
            ]}
          >
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
                size={isShortScreen ? 24 : 28}
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
                size={isShortScreen ? 24 : 28}
                color={currentTab === 'equalizer' ? '#FFFFFF' : '#7D8A99'}
              />
            </TouchableOpacity>

            {/* 3. Search Icon (Recherche de son) */}
            <TouchableOpacity
              onPress={() => setIsSearchVisible(true)}
              style={styles.dockIconBtn}
              activeOpacity={0.7}
            >
              <Ionicons name="search" size={isShortScreen ? 22 : 26} color="#7D8A99" />
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
                size={isShortScreen ? 26 : 30}
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
          <View
            style={[
              styles.searchModalOverlay,
              {
                // Marge système mesurée : la constante 60 px était devinée et
                // ne tombait juste sur aucun écran. En bas, rien n'était prévu.
                paddingTop: Platform.OS === 'web' ? 40 : insetPadding(insets, 'top', 12),
                paddingBottom: insetPadding(insets, 'bottom', 16),
              },
            ]}
          >
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
          <View
            style={[
              styles.searchModalOverlay,
              {
                // Marge système mesurée : la constante 60 px était devinée et
                // ne tombait juste sur aucun écran. En bas, rien n'était prévu.
                paddingTop: Platform.OS === 'web' ? 40 : insetPadding(insets, 'top', 12),
                paddingBottom: insetPadding(insets, 'bottom', 16),
              },
            ]}
          >
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
          onRescanLibrary={handleRescanLibrary}
          settings={appSettings}
          onUpdateSettings={handleUpdateSettings}
          currentTrack={currentTrack}
          positionMillis={positionMillis}
          durationMillis={durationMillis}
          dsp={dsp}
          onClearSession={handleClearSession}
        />

        {/* Song Context Menu (Éditer tags, Supprimer, Lire ensuite, Lire plus tard, Playlists) */}
        <SongActionModal
          visible={isActionModalVisible}
          track={activeActionTrack}
          playlists={playlists}
          currentPlaylistId={activeActionPlaylistId}
          onClose={() => {
            setIsActionModalVisible(false);
            setActiveActionTrack(null);
            setActiveActionPlaylistId(null);
          }}
          onPlayNext={handlePlayNext}
          onAddToQueue={handleAddToQueue}
          onAddToPlaylist={handleAddToPlaylist}
          onRemoveFromPlaylist={handleRemoveFromPlaylist}
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
          <View
            style={[
              styles.searchModalOverlay,
              {
                // Marge système mesurée : la constante 60 px était devinée et
                // ne tombait juste sur aucun écran. En bas, rien n'était prévu.
                paddingTop: Platform.OS === 'web' ? 40 : insetPadding(insets, 'top', 12),
                paddingBottom: insetPadding(insets, 'bottom', 16),
              },
            ]}
          >
            <View style={styles.searchModalBox}>
              <View style={styles.presetsModalHeader}>
                <Text style={styles.presetsModalTitle}>
                  {getTranslation(appSettings.language, 'sleepTimerTitle')}
                </Text>
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
          <View style={styles.autoplayGate}>
            <Text style={styles.autoplayGateText}>
              {getTranslation(appSettings.language, 'touchToPlay')}
            </Text>
          </View>
        )}

        {/* Écran officiel de démarrage et chargement avec le logo MAS Player et mot Chargement */}
        {isAppLoadingVisible && (
          <AppLoadingScreen
            visible={isStartingUp}
            statusText={getTranslation(appSettings.language, 'loading')}
            onFinish={() => setIsAppLoadingVisible(false)}
          />
        )}
      </SafeAreaView>
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <MainApp />
    </SafeAreaProvider>
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
    maxWidth: 520, // Responsive clamp on large desktop / tablet screens
    height: '100%',
  },
  appContainer: {
    flex: 1,
    backgroundColor: '#000000',
    justifyContent: 'space-between',
    width: '100%',
    paddingBottom: Platform.OS === 'android' ? 12 : (Platform.OS === 'ios' ? 8 : 4),
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
    width: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#000000',
    minHeight: 180,
    position: 'relative',
    overflow: 'hidden',
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
  activePlaylistPill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    backgroundColor: 'rgba(56, 189, 248, 0.12)',
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.35)',
    marginTop: 6,
  },
  activePlaylistPillText: {
    color: '#38BDF8',
    fontSize: 12,
    fontWeight: '700',
    maxWidth: 240,
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
    // La marge haute était une constante devinée (60 px) : elle ne tombe juste
    // ni sur un statut bar de 24 px ni sur une encoche de 48, et sur un écran
    // plus bas la boîte passe sous l'horloge. Le web n'a pas de barre système —
    // il garde sa valeur propre.
    paddingTop: Platform.OS === 'web' ? 40 : undefined,
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
    pointerEvents: 'none',
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
