import { Platform } from 'react-native';
import {
  createAudioPlayer,
  AudioPlayer,
  setAudioModeAsync,
  requestNotificationPermissionsAsync,
} from 'expo-audio';
import { DSPState } from '../types/audio';
import { WebAudioEngine } from './webAudioEngine';
import {
  applyNativeDSP,
  setNativeVolume,
  loadNativeTrack,
  isNativeEQAvailable,
  addNativeProgressListener,
  addNativeRemoteCommandListener,
  addNativeSystemVolumeListener,
  getNativeSystemVolume,
  clearNativeNowPlaying,
  playNative,
  pauseNative,
  stopNative,
  seekNative,
  getNativeStatus,
  setNativeAudioSessionId,
} from './nativeAudioDSP';
import { beatStore } from './beatStore';
import { getLiveWebTrackUri } from './webAudioStorage';

export type PlaybackCallback = (status: {
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  didFinish?: boolean;
}) => void;

export type RemoteCommandAction = 'next' | 'previous' | 'play' | 'pause';

/**
 * Taille du tampon lu dans l'analyser web. Doit correspondre au `fftSize` de
 * l'analyser (voir `webAudioEngine`), et est alloué UNE fois : `getFloatTimeDomainData`
 * refuse un tableau de longueur différente.
 */
const WEB_ANALYSER_BUFFER_SIZE = 2048;

/**
 * Délai sans échantillon avant de considérer la source de rythme morte.
 *
 * `isAudioSamplingSupported` vaut `true` en dur sur iOS et Android, alors que
 * l'installation du tap peut échouer sans bruit (item sans piste audio). Ce
 * chien de garde est donc le seul contrôle fiable.
 */
const BEAT_SOURCE_TIMEOUT_MS = 1500;

class UniversalPlayerManager {
  private player: AudioPlayer | null = null;
  private webAudio: HTMLAudioElement | null = null;
  private webEngine: WebAudioEngine | null = null;
  private rafId: number | null = null;
  private intervalTimer: any = null;
  private onStatus: PlaybackCallback | null = null;
  private currentUri: string = '';
  /** Identifiant séquentiel de chargement pour éliminer toute condition de course entre clics rapides */
  private currentLoadId = 0;

  // --- Commandes distantes (écran verrouillé / notification / écouteurs) ---
  private remoteSub: { remove: () => void } | null = null;
  /**
   * Abonnement aux commandes de notification Android, lié au lecteur courant.
   *
   * Distinct de `remoteSub`, qui écoute le module natif iOS : Android reçoit
   * ses commandes par le lecteur, et le lecteur est recréé à chaque piste.
   */
  private androidRemoteSub: { remove: () => void } | null = null;
  private remoteCommandListeners = new Set<(action: RemoteCommandAction) => void>();

  // --- Détection de rythme -----------------------------------------
  /** Abonnement PCM natif, à retirer à chaque changement de piste. */
  private sampleSubscription: { remove: () => void } | null = null;
  private webBeatBuffer: Float32Array | null = null;
  private webBeatRaf: number | null = null;
  private beatWatchdog: ReturnType<typeof setInterval> | null = null;

  /**
   * Dernier état DSP reçu. Conservé pour que les réglages appliqués avant
   * l'existence du graphe (au tout premier rendu) ne soient pas perdus :
   * ils sont rejoués dès que le moteur est construit.
   */
  private pendingDsp: DSPState | null = null;
  private currentPlaybackRate = 1.0;

  // --- Moteur DSP natif iOS (AVAudioEngine) -------------------------
  /**
   * Vrai tant que le graphe `AudioDSP` porte réellement la lecture.
   *
   * `createAudioPlayer` d'expo-audio et l'`AVAudioEngine` du module sont deux
   * sources audio concurrentes : brancher les deux ferait jouer deux fois la
   * même piste. Sur iOS natif on utilise donc **uniquement** le moteur du
   * module (c'est lui qui contient l'EQ), et `expo-audio` ne sert plus que de
   * secours — quand le module est absent, typiquement sous Expo Go.
   */
  private nativeEngineActive = false;
  /** Abonnement au `onProgress` du module natif, à retirer au relâchement. */
  private nativeProgressSub: { remove: () => void } | null = null;

  // --- Volume système ------------------------------------------------
  /**
   * Volume de l'appareil en pourcentage, ou `null` quand il est illisible.
   *
   * Seul iOS sait le lire (`AVAudioSession.outputVolume`, observé par KVO côté
   * natif). Le web n'a aucune API pour cela : `AudioContext.destination` n'expose
   * pas de volume, `HTMLMediaElement.volume` est un gain propre à l'élément,
   * `setSinkId` choisit une sortie et non un niveau, et `navigator.volume`
   * n'existe pas. Vrai `null`, l'app ne prétend donc pas suivre l'OS : le knob
   * redevient une attestation app-locale.
   */
  private systemVolume: number | null = null;
  private systemVolumeListeners = new Set<(volume: number) => void>();
  private systemVolumeSub: { remove: () => void } | null = null;
  /**
   * File d'attente sérialisée des appels au module natif.
   *
   * `setDSPAsync` / `setVolumeAsync` sont des `AsyncFunction` : chaque geste de
   * fader en déclenche une, et rien ne garantit que le pont les exécute dans
   * l'ordre d'émission. Sans sérialisation, un réglage ancien peut atterrir en
   * dernier et rester affiché — le « dernier geste gagne » n'est plus vrai.
   */
  private nativeChain: Promise<unknown> = Promise.resolve();
  private activeAndroidSessionId = 0;

  /**
   * Synchronise dynamiquement l'audioSessionId d'ExoPlayer avec AudioDSPModule sur Android.
   *
   * ExoPlayer initialise son audioSessionId de façon asynchrone lors de la préparation
   * ou du démarrage du décodeur (initialement 0 ou C.AUDIO_SESSION_ID_UNSET).
   * Cette méthode vérifie et attache les effets matériels natifs dès qu'un session ID
   * réel (> 0) devient disponible.
   */
  private syncAndroidAudioSession(player: AudioPlayer | null) {
    if (Platform.OS !== 'android' || !player || !isNativeEQAvailable()) return;
    try {
      const rawId =
        (player as any).audioSessionId ??
        (player as any).getAudioSessionId?.() ??
        (player as any).currentStatus?.()?.audioSessionId;
      const sessionId = typeof rawId === 'number' ? rawId : parseInt(String(rawId), 10);
      if (typeof sessionId === 'number' && !isNaN(sessionId) && sessionId > 0 && sessionId !== this.activeAndroidSessionId) {
        this.activeAndroidSessionId = sessionId;
        void setNativeAudioSessionId(sessionId).then(() => {
          if (this.pendingDsp) {
            void this.enqueueNative(() => applyNativeDSP(this.pendingDsp!));
          }
        });
      }
    } catch (_) {}
  }

  /** Enfile un appel au module natif et attend que les précédents se résolvent. */
  private enqueueNative<T>(task: () => Promise<T>): Promise<T> {
    const next = this.nativeChain.then(task, task);
    // La chaîne ne doit jamais rester rejetée : un échec isolé ne doit pas
    // empêcher les réglages suivants de partir.
    this.nativeChain = next.catch(() => {});
    return next;
  }

  /**
   * S'abonne au volume système iOS et expose le dernier relevé.
   *
   * Renvoie une fonction de désabonnement. Renvoie `null` immédiatement sur les
   * plateformes où le volume système est illisible (web, Android) : l'appelant
   * garde alors son knob en attestation app-locale, sans crash ni faux positif.
   */
  subscribeSystemVolume(listener: (volume: number | null) => void): () => void {
    if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
      listener(null);
      return () => {};
    }
    this.systemVolumeListeners.add(listener);

    // Si on a déjà une valeur connue, la transmettre immédiatement
    if (this.systemVolume !== null) {
      listener(this.systemVolume);
    } else {
      // Sinon interroger la valeur système native de manière asynchrone
      getNativeSystemVolume().then((vol) => {
        if (vol !== null) {
          this.systemVolume = vol;
          listener(vol);
        }
      }).catch(() => {});
    }

    if (!this.systemVolumeSub) {
      this.systemVolumeSub = addNativeSystemVolumeListener(({ volume }) => {
        const percent = Math.max(0, Math.min(100, Math.round(volume * 100)));
        this.systemVolume = percent;
        this.systemVolumeListeners.forEach((fn) => {
          try {
            fn(percent);
          } catch (e) {
            console.warn('Erreur listener volume système:', e);
          }
        });
      });
      if (!this.systemVolumeSub) {
        this.systemVolume = null;
      }
    }
    return () => {
      this.systemVolumeListeners.delete(listener);
    };
  }

  /** Dernier volume système connu, en pourcentage, ou `null` s'il est illisible. */
  getSystemVolume(): number | null {
    return this.systemVolume;
  }

  addRemoteCommandListener(listener: (action: RemoteCommandAction) => void) {
    this.remoteCommandListeners.add(listener);
    return () => {
      this.remoteCommandListeners.delete(listener);
    };
  }

  private dispatchRemoteCommand(action: RemoteCommandAction) {
    this.remoteCommandListeners.forEach((fn) => {
      try {
        fn(action);
      } catch (e) {
        console.warn('Erreur listener commande distante:', e);
      }
    });
  }

  async init() {
    try {
      await setAudioModeAsync({
        playsInSilentMode: true,
        shouldPlayInBackground: true,
        interruptionMode: 'doNotMix',
      });
    } catch (err) {
      console.warn('init audio mode warning:', err);
    }

    if (Platform.OS === 'android') {
      try {
        await requestNotificationPermissionsAsync();
      } catch (err) {
        console.warn('Android notification permission warning:', err);
      }
    }

    if (Platform.OS === 'ios' && !this.remoteSub) {
      const sub = addNativeRemoteCommandListener((payload) => {
        this.dispatchRemoteCommand(payload.action);
      });
      if (sub) {
        this.remoteSub = sub;
      }
    }
  }

  /**
   * Branche les commandes de notification Android au lecteur courant.
   *
   * Sur Android, c'est le service `AudioControlsService` d'expo-audio qui
   * possède la session média : précédent et suivant y sont de purs relais
   * vers JS, qui détient la file et le mélange aléatoire. Sans cet
   * abonnement, les boutons de la notification existent mais ne commande
   * rien.
   *
   * L'abonnement est lié au lecteur, pas au module : un nouveau lecteur est
   * créé à chaque piste, donc chaque appel retire l'abonnement précédent.
   */
  private subscribeAndroidRemoteCommands(player: AudioPlayer) {
    this.unsubscribeAndroidRemoteCommands();
    try {
      this.androidRemoteSub = (player as any).addListener('onRemoteCommand', (payload: any) => {
        const action = payload?.action;
        if (action === 'next' || action === 'previous') {
          this.dispatchRemoteCommand(action);
        } else if (action === 'play') {
          this.play();
        } else if (action === 'pause') {
          this.pause();
        }
      });
    } catch (err) {
      // Non bloquant : la notification reste affichée, seule la commande
      // précédent/suivant devient inerte.
      console.warn('Android remote command subscription warning:', err);
    }
  }

  private unsubscribeAndroidRemoteCommands() {
    if (this.androidRemoteSub) {
      try {
        this.androidRemoteSub.remove();
      } catch (_) {}
      this.androidRemoteSub = null;
    }
  }

  /**
   * Arrête immédiatement toute lecture en cours sur l'ensemble des moteurs
   * (expo-audio, AVAudioEngine natif iOS, HTMLAudio web) et libère les ressources.
   * Garantit de façon étanche qu'aucun morceau précédent ne continue à jouer
   * en arrière-plan lorsqu'un nouveau morceau est chargé.
   */
  async stopCurrentPlayback() {
    // 1. Arrêter le timer JS de progression
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }

    // 2. Chien de garde et détection de rythme
    this.stopBeatWatchdog();
    this.stopNativeBeatSampling();

    // 3. Moteur expo-audio (Expo Go / Android / repli iOS)
    if (this.player) {
      // Avant de détacher le lecteur : son abonnement aux commandes de
      // notification lui appartient et ne survit pas à `remove()`.
      this.unsubscribeAndroidRemoteCommands();
      try {
        this.player.pause();
      } catch (_) {}
      try {
        this.player.clearLockScreenControls();
      } catch (_) {}
      try {
        this.player.remove();
      } catch (_) {}
      this.player = null;
    }
    this.activeAndroidSessionId = 0;

    // 4. Moteur natif Swift DSP iOS
    if (this.nativeEngineActive) {
      try {
        await this.enqueueNative(() => stopNative());
        await clearNativeNowPlaying();
      } catch (_) {}
      this.nativeEngineActive = false;
    }

    // 5. Moteur Web
    if (this.webAudio) {
      try {
        this.webAudio.pause();
      } catch (_) {}
    }

    beatStore.setPlaying(false);
  }

  async loadTrack(
    uri: string,
    autoPlay: boolean = true,
    onStatusUpdate?: PlaybackCallback,
    initialPositionSeconds?: number,
    meta?: { title?: string; artist?: string; album?: string; artwork?: string },
    trackId?: string
  ) {
    const loadId = ++this.currentLoadId;
    // Arrêter impérativement toute lecture en cours avant de monter une nouvelle piste
    await this.stopCurrentPlayback();
    if (this.currentLoadId !== loadId) return;

    this.currentUri = uri;
    if (onStatusUpdate) {
      this.onStatus = onStatusUpdate;
    }

    if (Platform.OS !== 'web') {
      try {
        await setAudioModeAsync({
          playsInSilentMode: true,
          shouldPlayInBackground: true,
          interruptionMode: 'doNotMix',
        });
      } catch (_) {}
    }

    if (Platform.OS === 'web') {
      // Résoudre une URL vivante depuis IndexedDB si besoin (ex: après refresh de page web / Safari iOS)
      let effectiveUri = uri;
      if (trackId) {
        effectiveUri = await getLiveWebTrackUri(trackId, uri);
      }
      this.currentUri = effectiveUri;

      // Un seul élément audio pour toute la session tant que le moteur est actif :
      // MediaElementAudioSourceNode ne peut être attaché qu'une fois par élément.
      // Si webEngine n'est pas encore initialisé, on s'assure d'avoir un élément neuf.
      if (!this.webAudio || !this.webEngine) {
        if (this.webAudio) {
          try {
            this.webAudio.pause();
            this.webAudio.src = '';
          } catch (_) {}
        }
        this.webAudio = new Audio();
        this.webAudio.onended = () => {
          if (this.onStatus) {
            const dur = this.webAudio?.duration;
            const validDur = dur && !isNaN(dur) && isFinite(dur) && dur > 0 ? dur : 1;
            this.onStatus({
              currentTime: validDur,
              duration: validDur,
              isPlaying: false,
              didFinish: true,
            });
          }
        };
      }

      const audio = this.webAudio;

      // Écouteur d'erreur avec récupération dynamique depuis IndexedDB
      audio.onerror = async () => {
        const err = audio.error;
        if (!audio.src) return;
        console.warn(`[WebAudio] Erreur lecture "${meta?.title || uri}": code=${err?.code} message=${err?.message}`);
        if (trackId && effectiveUri === uri) {
          const fresh = await getLiveWebTrackUri(trackId, '');
          if (fresh && fresh !== uri && fresh.length > 0) {
            console.log('[WebAudio] Récupération réussie depuis IndexedDB');
            effectiveUri = fresh;
            this.currentUri = fresh;
            audio.src = fresh;
            audio.load();
            if (autoPlay) {
              audio.play().catch(() => {});
            }
          }
        }
      };

      // Écouteur de métadonnées pour propager immédiatement la vraie durée
      audio.onloadedmetadata = () => {
        if (this.onStatus && audio.duration && !isNaN(audio.duration) && isFinite(audio.duration) && audio.duration > 0) {
          this.onStatus({
            currentTime: audio.currentTime || 0,
            duration: audio.duration,
            isPlaying: !audio.paused,
          });
        }
      };

      if (!this.webEngine && WebAudioEngine.isSupported()) {
        try {
          this.webEngine = new WebAudioEngine(audio);
          if (this.pendingDsp) {
            // applyDSP pose déjà la largeur via applyStereo : setMono ne serait
            // qu'un second propriétaire des mêmes gains, qui l'écraserait.
            this.webEngine.applyDSP(this.pendingDsp);
            this.webEngine.setVolume(this.pendingDsp.volume ?? 100);
          }
        } catch (engineErr) {
          console.warn('[WebAudio] Erreur initialisation WebAudioEngine:', engineErr);
          this.webEngine = null;
          this.webAudio = null;
          throw engineErr;
        }
      }

      if (!effectiveUri) {
        console.warn(`[WebAudio] Piste ignorée : URI vide pour "${meta?.title || 'inconnue'}"`);
        return;
      }

      audio.src = effectiveUri;
      audio.load();
      audio.playbackRate = this.currentPlaybackRate;
      if (this.pendingDsp?.volume !== undefined) {
        this.setVolume(this.pendingDsp.volume);
      }

      // Intégration MediaSession pour la lecture arrière-plan / notification sur navigateur / Safari iOS
      if (typeof navigator !== 'undefined' && 'mediaSession' in navigator && meta) {
        try {
          navigator.mediaSession.metadata = new MediaMetadata({
            title: meta.title || 'MAS Player',
            artist: meta.artist || '',
            album: meta.album || '',
            artwork: meta.artwork
              ? [{ src: meta.artwork, sizes: '512x512', type: 'image/png' }]
              : [],
          });

          navigator.mediaSession.setActionHandler('play', () => {
            this.play();
            this.dispatchRemoteCommand('play');
          });
          navigator.mediaSession.setActionHandler('pause', () => {
            this.pause();
            this.dispatchRemoteCommand('pause');
          });
          navigator.mediaSession.setActionHandler('previoustrack', () => {
            this.dispatchRemoteCommand('previous');
          });
          navigator.mediaSession.setActionHandler('nexttrack', () => {
            this.dispatchRemoteCommand('next');
          });
          navigator.mediaSession.setActionHandler('seekto', (details) => {
            if (details.seekTime !== undefined) {
              this.seekToSeconds(details.seekTime);
            }
          });
        } catch (err) {
          console.warn('Web mediaSession error:', err);
        }
      }

      if (initialPositionSeconds && initialPositionSeconds > 0) {
        const applySeek = () => {
          try {
            audio.currentTime = initialPositionSeconds;
          } catch (_) {}
        };
        if (audio.readyState >= 1) {
          applySeek();
        } else {
          audio.addEventListener('loadedmetadata', applySeek, { once: true });
        }
      }

      if (autoPlay) {
        // Bloqué tant qu'aucun geste utilisateur n'a eu lieu : le rejeu est
        // déclenché plus tard par resumeFromUserGesture().
        audio.play().catch(() => {});
      } else {
        audio.pause();
      }

      this.startWebProgressLoop();
      // Après `startWebProgressLoop` : la pompe doit lire `this.webEngine`, et il
      // vient d'être construit ci-dessus.
      beatStore.reset();
      this.startWebBeatPump();
      return;
    }

    // iOS natif avec le module DSP : l'AVAudioEngine du module est le SEUL
    // lecteur. Brancher aussi expo-audio jouerait la piste deux fois, et
    // l'égaliseur ne serait de toute façon pas sur le chemin du son.
    if (Platform.OS === 'ios' && isNativeEQAvailable()) {
      await this.loadViaNativeEQ(uri, autoPlay, initialPositionSeconds, meta, loadId);
      return;
    }

    // Native iOS / Android via expo-audio : aussi le repli quand le module
    // AudioDSP est absent (Expo Go) ou que son chargement a échoué.
    await this.loadViaExpoAudio(uri, autoPlay, initialPositionSeconds, meta, loadId);
  }

  /**
   * Charge une piste dans le graphe `AudioDSP` et abonne sa progression.
   *
   * Échec → repli silencieux sur `createAudioPlayer` d'expo-audio : mieux vaut
   * une piste qui joue sans égaliseur qu'une piste muette.
   */
  private async loadViaNativeEQ(
    uri: string,
    autoPlay: boolean,
    initialPositionSeconds?: number,
    meta?: { title?: string; artist?: string; album?: string; artwork?: string },
    loadId?: number
  ) {
    if (loadId !== undefined && this.currentLoadId !== loadId) return;

    // L'historique de rythme de la piste précédente ne doit pas colorer la
    // nouvelle : on remet l'analyseur à zéro avant le chargement.
    this.stopNativeBeatSampling();
    beatStore.reset();

    const loaded = await this.enqueueNative(() =>
      loadNativeTrack(uri, meta?.title, meta?.artist, meta?.album, meta?.artwork)
    );

    if (loadId !== undefined && this.currentLoadId !== loadId) {
      void this.enqueueNative(() => stopNative());
      return;
    }

    if (!loaded) {
      this.nativeEngineActive = false;
      console.warn('AudioDSP: chargement impossible, repli sur expo-audio');
      await this.loadViaExpoAudio(uri, autoPlay, initialPositionSeconds, meta, loadId);
      return;
    }

    this.nativeEngineActive = true;

    // Rejoue les réglages DSP reçus avant l'existence du graphe.
    if (this.pendingDsp) {
      await this.enqueueNative(() => applyNativeDSP(this.pendingDsp!));
    }
    // Même règle que dans `setVolume` : si l'OS est l'autorité du volume, le graphe
    // repart à gain unitaire. Le `?? 75` historique réappliquait par ailleurs la
    // valeur enregistrée avant que lattenuateur ne soit neutralisé.
    await this.enqueueNative(() =>
      setNativeVolume(this.systemVolume !== null ? 100 : this.pendingDsp?.volume ?? 100)
    );

    // Le `Timer` Swift (250 ms) est la seule horloge de lecture : l'UI s'y
    // abonne au lieu de son propre `setInterval`.
    if (!this.nativeProgressSub) {
      const sub = addNativeProgressListener((status) => {
        beatStore.setPlaying(status.isPlaying);
        if (this.onStatus) this.onStatus(status);
      });
      if (sub) this.nativeProgressSub = sub;
    }

    // Les échantillons PCM d'expo-audio sont sans objet ici : le tap est posé
    // sur l'AVPlayer d'expo-audio, qui ne joue plus rien. Le logo retombe donc
    // en respiration au repos plutôt qu'en faux battement.
    beatStore.setSource('none');

    if (initialPositionSeconds && initialPositionSeconds > 0) {
      await this.enqueueNative(() => seekNative(initialPositionSeconds));
    }

    if (autoPlay) {
      await this.enqueueNative(() => playNative());
    }

    // Première notification immédiate : le Timer Swift met jusqu'à 250 ms à
    // parler, la barre de progression resterait vide jusque-là.
    this.onStatus?.({
      currentTime: initialPositionSeconds ?? 0,
      duration: loaded.duration > 0 ? loaded.duration : 1,
      isPlaying: autoPlay,
    });
  }

  /**
   * Repli sur le lecteur `expo-audio` (Expo Go, ou échec du module natif).
   *
   * Extrait de `loadTrack` pour être appelable depuis `loadViaNativeEQ`.
   */
  private async loadViaExpoAudio(
    uri: string,
    autoPlay: boolean,
    initialPositionSeconds?: number,
    meta?: { title?: string; artist?: string; album?: string; artwork?: string },
    loadId?: number
  ) {
    try {
      if (loadId !== undefined && this.currentLoadId !== loadId) return;

      await this.stopCurrentPlayback();
      if (loadId !== undefined && this.currentLoadId !== loadId) return;

      beatStore.reset();

      const p = createAudioPlayer(uri, { updateInterval: 250, keepAudioSessionActive: true });
      if (loadId !== undefined && this.currentLoadId !== loadId) {
        try { p.pause(); p.remove(); } catch (_) {}
        return;
      }
      this.player = p;

      // Active les contrôles de notification et de l'écran verrouillé
      if (meta) {
        try {
          p.setActiveForLockScreen(
            true,
            {
              title: meta.title,
              artist: meta.artist,
              albumTitle: meta.album,
              artworkUrl: meta.artwork,
            },
            {
              showSeekBackward: false,
              showSeekForward: false,
            }
          );
        } catch (e) {
          console.warn('setActiveForLockScreen error:', e);
        }
      }

      // Les boutons précédent / suivant de la notification n'existent qu'en
      // amont : c'est ici qu'ils deviennent exécutables, en relayant vers la
      // file que JS détient.
      if (Platform.OS === 'android') {
        this.subscribeAndroidRemoteCommands(p);
        this.activeAndroidSessionId = 0;
        this.syncAndroidAudioSession(p);
        try {
          (p as any).addListener?.('playbackStatusUpdate', () => {
            this.syncAndroidAudioSession(p);
          });
        } catch (_) {}
      }

      this.startNativeBeatSampling(p);
      this.startBeatWatchdog();

      if (initialPositionSeconds && initialPositionSeconds > 0) {
        try {
          await p.seekTo(initialPositionSeconds);
        } catch (_) {}
      }

      if (loadId !== undefined && this.currentLoadId !== loadId) {
        try { p.pause(); p.remove(); } catch (_) {}
        return;
      }

      if (autoPlay) p.play();

      this.intervalTimer = setInterval(() => {
        if (!this.player) return;
        if (Platform.OS === 'android') {
          this.syncAndroidAudioSession(this.player);
        }
        const cur = this.player.currentTime || 0;
        const dur = this.player.duration || 0;
        const isPlaying = this.player.playing;
        const didFinish = isPlaying && dur > 0 && cur >= dur - 0.25;

        beatStore.setPlaying(isPlaying);

        if (this.onStatus) {
          this.onStatus({
            currentTime: cur,
            duration: dur > 0 ? dur : 1,
            isPlaying,
            didFinish,
          });
        }
      }, 250);
    } catch (error) {
      console.warn('Erreur chargement audio natif:', error);
    }
  }

  /**
   * Boucle de progression web. `requestAnimationFrame` remplace le setInterval
   * à 250 ms : c'est la seule source de temps réel côté navigateur, et elle est
   * synchronisée avec le rendu, donc sans tearing visible sur la barre de seek.
   */
  private startWebProgressLoop() {
    if (Platform.OS !== 'web') return;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);

    const tick = () => {
      const audio = this.webAudio;
      if (audio && this.onStatus) {
        beatStore.setPlaying(!audio.paused);
        const rawDur = audio.duration;
        const validDur = rawDur && !isNaN(rawDur) && isFinite(rawDur) && rawDur > 0 ? rawDur : 0;
        this.onStatus({
          currentTime: audio.currentTime || 0,
          duration: validDur,
          isPlaying: !audio.paused,
        });
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  /**
   * Pompe la détection de rythme web depuis l'`AnalyserNode`.
   *
   * Partage la boucle `startWebProgressLoop` : même `requestAnimationFrame`,
   * donc ~60 Hz sans boucle supplémentaire. Le tampon est alloué une seule fois
   * et réutilisé — `getFloatTimeDomainData` exige une longueur égale au
   * `fftSize`, et allouer à chaque frame imposerait un GC à 60 Hz.
   */
  private startWebBeatPump() {
    if (Platform.OS !== 'web') return;
    if (!this.webEngine) return;
    if (!this.webBeatBuffer) {
      this.webBeatBuffer = new Float32Array(WEB_ANALYSER_BUFFER_SIZE);
    }
    beatStore.setSource('web');
    const tick = () => {
      const buffer = this.webBeatBuffer;
      if (buffer && this.webEngine) {
        const samples = this.webEngine.getTimeDomainData(buffer);
        if (samples) beatStore.pushWeb(samples);
      }
      this.webBeatRaf = requestAnimationFrame(tick);
    };
    this.webBeatRaf = requestAnimationFrame(tick);
  }

  // MARK: Détection de rythme

  /**
   * Abonne l'échantillonnage PCM d'expo-audio à la détection de rythme.
   *
   * Le format diffère par plateforme, et ce n'est pas un détail :
   *   - iOS : PCM Float32 par canal (`MTAudioProcessingTap`). Seul le premier
   *     canal est lu — en faire deux coûterait 2048 flottants de plus à faire
   *     franchir le pont à chaque tampon, pour rien à l'oreille ;
   *   - Android : `Visualizer` en mode WAVEFORM, donc des octets non signés
   *     ramenés dans [-1, 1], mono, à résolution grossière. L'énergie suffit,
   *     le BPM n'a pas de sens à ce niveau de détail.
   *
   * L'échantillonnage est activé APRÈS `createAudioPlayer` : côté iOS, un tap
   * posé avant chargement est mémorisé puis installé au chargement, ce qui est
   * le comportement attendu ici.
   */
  private startNativeBeatSampling(player: AudioPlayer) {
    try {
      player.setAudioSamplingEnabled(true);
      this.sampleSubscription = player.addListener('audioSampleUpdate', (data: any) => {
        const channels = data?.channels;
        const frames = channels?.[0]?.frames;
        if (!frames || frames.length === 0) return;

        if (Platform.OS === 'android') {
          beatStore.pushNativeCoarse(frames);
        } else {
          beatStore.pushNative(frames);
        }
      });
      beatStore.setSource('native');
    } catch (err) {
      // Pas bloquant : le logo repassera en respiration au repos.
      console.warn('Échantillonnage audio indisponible:', err);
      beatStore.setSource('none');
    }
  }

  /** Retire l'abonnement PCM. À appeler avant tout changement de piste. */
  private stopNativeBeatSampling() {
    if (this.sampleSubscription) {
      try {
        this.sampleSubscription.remove();
      } catch (_) {}
      this.sampleSubscription = null;
    }
    if (this.player) {
      try {
        this.player.setAudioSamplingEnabled(false);
      } catch (_) {}
    }
  }

  /**
   * Chien de garde : bascule en repli si plus aucun échantillon n'arrive alors
   * qu'on joue. Couvre l'installation de tap échouée en silence et le joueur
   * en attente de bufferisation.
   */
  private startBeatWatchdog() {
    if (this.beatWatchdog) return;
    this.beatWatchdog = setInterval(() => {
      if (beatStore.source !== 'native') return;
      if (!beatStore.isPlaying) return;
      const last = beatStore.lastPushAtMs;
      if (last > 0 && Date.now() - last > BEAT_SOURCE_TIMEOUT_MS) {
        beatStore.setSource('none');
      }
    }, 1000);
  }

  /**
   * Réactive la détection de rythme après un seek ou un buffering.
   *
   * Le chien de garde coupe sur absence d'échantillons pendant plus de
   * `BEAT_SOURCE_TIMEOUT_MS` — ce qui arrive à chaque seek. Or `setSource`
   * ignorerait un retour à `'native'` si la source est déjà `'none'`… sauf
   * que rien ne la faisait revenir : le logo restait mort jusqu'au prochain
   * changement de piste. Ce rattrapage est donc nécessaire.
   */
  private resumeBeatSampling() {
    if (Platform.OS !== 'ios' && Platform.OS !== 'android') return;
    if (!this.player) return;
    try {
      this.player.setAudioSamplingEnabled(true);
      beatStore.setSource('native');
    } catch (err) {
      console.warn('Réactivation échantillonnage audio impossible:', err);
    }
  }

  private stopBeatWatchdog() {
    if (this.beatWatchdog) {
      clearInterval(this.beatWatchdog);
      this.beatWatchdog = null;
    }
  }

  /** À appeler depuis un geste utilisateur pour lever le verrou d'autoplay. */
  async resumeFromUserGesture() {
    if (Platform.OS !== 'web') return;
    if (this.webEngine) {
      await this.webEngine.resume();
    } else if (this.webAudio) {
      try {
        await this.webAudio.play();
      } catch {
        /* refusé : rien de plus à faire */
      }
    }
  }

  play() {
    if (!this.currentUri) {
      return;
    }
    if (Platform.OS === 'web' && this.webAudio) {
      this.webAudio.playbackRate = this.currentPlaybackRate;
      if (this.webEngine) {
        this.webEngine.resume().catch(() => {});
      }
      this.webAudio.play().catch(() => {});
    } else if (this.nativeEngineActive) {
      void this.enqueueNative(() => playNative());
    } else if (this.player) {
      this.player.play();
      if (Platform.OS === 'android') {
        this.syncAndroidAudioSession(this.player);
      }
      // Même raison qu'après un seek : la reprise relance aussi le flux.
      this.resumeBeatSampling();
    } else {
      return;
    }
    // Immédiat : sans cela le logo resterait en respiration jusqu'au prochain
    // tick de progression (jusqu'à 250 ms sur natif).
    beatStore.setPlaying(true);
  }

  pause() {
    if (Platform.OS === 'web' && this.webAudio) {
      this.webAudio.pause();
    } else if (this.nativeEngineActive) {
      void this.enqueueNative(() => pauseNative());
    } else if (this.player) {
      this.player.pause();
    }
    beatStore.setPlaying(false);
  }

  async seekToSeconds(seconds: number) {
    if (Platform.OS === 'web' && this.webAudio) {
      this.webAudio.currentTime = seconds;
    } else if (this.nativeEngineActive) {
      await this.enqueueNative(() => seekNative(seconds));
    } else if (this.player) {
      await this.player.seekTo(seconds);
      // Un seek coupe le flux d'échantillons : sans ce rattrapage, le chien
      // de garde finit par basculer sur 'none' et le logo ne revient plus.
      this.resumeBeatSampling();
    }
  }

  /**
   * Synchronise l'état de lecture actuel avec l'interface
   * (utile lors de la reprise depuis l'arrière-plan).
   */
  async syncPlaybackState() {
    if (Platform.OS === 'web' && this.webAudio) {
      this.onStatus?.({
        currentTime: this.webAudio.currentTime || 0,
        duration: this.webAudio.duration || 1,
        isPlaying: !this.webAudio.paused,
      });
    } else if (this.nativeEngineActive) {
      const status = await getNativeStatus();
      if (status && this.onStatus) {
        this.onStatus({
          currentTime: status.currentTime,
          duration: status.duration,
          isPlaying: status.isPlaying,
        });
      }
    } else if (this.player) {
      this.onStatus?.({
        currentTime: this.player.currentTime || 0,
        duration: this.player.duration || 1,
        isPlaying: this.player.playing,
      });
    }
  }

  setVolume(volumePercent: number) {
    const clamped = Math.max(0, Math.min(100, volumePercent));
    if (this.pendingDsp) {
      this.pendingDsp.volume = clamped;
    }

    if (Platform.OS === 'web' && this.webAudio) {
      if (this.webEngine) {
        this.webEngine.setVolume(clamped);
      } else {
        this.webAudio.volume = clamped / 100;
      }
    } else if (this.nativeEngineActive) {
      void this.enqueueNative(() => setNativeVolume(clamped));
    } else if (this.player) {
      this.player.volume = clamped / 100;
    }
  }

  async resumeAudioContext() {
    if (Platform.OS === 'web' && this.webEngine) {
      await this.webEngine.resume().catch(() => {});
    }
  }

  setPlaybackRate(rate: number) {
    const clamped = Math.max(0.5, Math.min(2.0, rate));
    this.currentPlaybackRate = clamped;
    if (Platform.OS === 'web' && this.webAudio) {
      this.webAudio.playbackRate = clamped;
    } else if (this.player) {
      this.player.setPlaybackRate(clamped);
    }
    // Le graphe natif n'expose pas de vitesse de lecture : le tempo reste
    // donc inopérant sur iPhone. `AVAudioUnitTimePitch` le permettrait, mais la
    // simple vitesse de lecture déforme les aigus sans correction de hauteur.
  }

  /**
   * Pousse l'état DSP complet vers le moteur audio.
   *
   * `bass` et `treble` ne sont pas transmis : ce sont des résumés d'affichage.
   * La courbe audible est entièrement décrite par `bands` + `preamp`, ce qui
   * évite de compter deux fois les graves quand le knob bass les décale déjà.
   *
   * Sans effet sur les plateformes sans moteur DSP (Expo Go / AVPlayer) : les
   * réglages restent alors purement visuels.
   */
  setDSP(dsp: DSPState) {
    this.pendingDsp = dsp;
    if (this.webEngine) {
      this.webEngine.applyDSP(dsp);
      if (dsp.volume !== undefined) {
        this.webEngine.setVolume(dsp.volume);
      }
    }
    if (Platform.OS === 'android' && this.player) {
      this.syncAndroidAudioSession(this.player);
    }
    // Moteur natif iOS / Android : sérialisé, sinon un réglage ancien peut atterrir
    // après le dernier geste de fader et rester affiché.
    if ((Platform.OS === 'ios' || Platform.OS === 'android') && isNativeEQAvailable()) {
      void this.enqueueNative(() => applyNativeDSP(dsp));
    }
  }

  async stop() {
    await this.stopCurrentPlayback();
    if (this.onStatus) {
      this.onStatus({
        currentTime: 0,
        duration: 1,
        isPlaying: false,
      });
    }
  }

  release() {
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    // La pompe de rythme a sa propre boucle : l'annuler ici, sinon elle
    // continuerait de lire un moteur déjà détruit.
    this.stopBeatWatchdog();
    if (this.webBeatRaf !== null) {
      cancelAnimationFrame(this.webBeatRaf);
      this.webBeatRaf = null;
    }
    this.stopNativeBeatSampling();
    beatStore.setPlaying(false);
    beatStore.setSource('none');
    beatStore.reset();
    // Le Timer Swift tire 4x/s : sans retirer l'abonnement, il continuerait
    // de pousser `onProgress` vers une UI démontée.
    if (this.nativeProgressSub) {
      try {
        this.nativeProgressSub.remove();
      } catch {}
      this.nativeProgressSub = null;
    }
    // Même raison pour l'observation KVO du volume : elle continue de pousser
    // `onSystemVolume` tant qu'elle n'est pas retirée.
    if (this.systemVolumeSub) {
      try {
        this.systemVolumeSub.remove();
      } catch {}
      this.systemVolumeSub = null;
    }
    this.systemVolumeListeners.clear();
    this.systemVolume = null;
    if (this.remoteSub) {
      try {
        this.remoteSub.remove();
      } catch {}
      this.remoteSub = null;
    }
    this.unsubscribeAndroidRemoteCommands();
    if (this.nativeEngineActive) {
      void this.enqueueNative(() => stopNative());
      void clearNativeNowPlaying();
      this.nativeEngineActive = false;
    }
    if (this.webAudio) {
      this.webAudio.pause();
      this.webAudio.src = '';
      this.webAudio = null;
    }
    if (this.webEngine) {
      this.webEngine.destroy();
      this.webEngine = null;
    }
    if (this.player) {
      try {
        this.player.pause();
        this.player.clearLockScreenControls();
        this.player.remove();
      } catch (_) {}
      this.player = null;
    }
  }
}

export const playerManager = new UniversalPlayerManager();
