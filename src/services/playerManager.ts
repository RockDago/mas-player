import { Platform } from 'react-native';
import {
  createAudioPlayer,
  setAudioModeAsync,
  requestNotificationPermissionsAsync,
} from 'expo-audio';
import type { AudioPlayer } from 'expo-audio/build/AudioModule.types';
import { getEffectiveEqualizerBands } from '../constants/presets';
import { DSPState } from '../types/audio';
import { WebAudioEngine } from './webAudioEngine';
import { beatStore } from './beatStore';
import { getLiveWebTrackUri } from './webAudioStorage';

/**
 * Résout mono / crossfeed / stereoExpansion en un seul largeur Mid-Side.
 *
 * Le DSP natif n'a qu'un paramètre `stereo` : les trois réglages UI s'y
 * écrivent mutuellement, et la priorité était implicite dans une ternaire
 * écrite en place dans `applyEqualizer`. Deux conséquences :
 *   - le knob Crossfeed à 0 n'atteignait jamais le moteur (le `else` envoyait
 *     `stereoExpansion`) ;
 *   - basculer MONO effaçait le Stereo Expand.
 *
 * La priorité est ici explicite et partagée par le web et le natif, pour que
 * les deux plateformes ne puissent plus diverger. MONO l'emporte : c'est une
 * bascule on/off explicite, alors que le crossfeed est continu. Le crossfeed
 * ensuite, parce qu'il *est* une réduction de largeur. Le Stereo Expand n'est
 * retenu que si les deux sont neutres.
 */
export function resolveStereoWidth(eq: Partial<DSPState>): number {
  if (eq.mono) return -1.0;
  const crossfeed = (eq.crossfeed ?? 0) / 100;
  if (crossfeed > 0) return -crossfeed;
  return (eq.stereoExpansion ?? 0) / 100;
}

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
  /**
   * Abonnement aux commandes de notification Android, lié au lecteur courant.
   *
   * Android reçoit ses commandes par le lecteur (`onRemoteCommand`, événement
   * ajouté à `expo-audio` par `scripts/patch-expo-audio-android.cjs`), et le
   * lecteur est recréé à chaque piste. Sur iOS, `expo-audio` câble lui-même
   * play/pause/seek sur `MPRemoteCommandCenter` et n'émet rien à JS : il n'y a
   * donc pas d'abonnement à tenir de ce côté.
   */
  private androidRemoteSub: { remove: () => void } | null = null;
  private remoteCommandListeners = new Set<(action: RemoteCommandAction) => void>();

  // --- Détection de rythme -----------------------------------------
  /** Abonnement PCM natif, à retirer à chaque changement de piste. */
  private sampleSubscription: { remove: () => void } | null = null;
  private webBeatBuffer: Float32Array<ArrayBuffer> | null = null;
  private webBeatRaf: number | null = null;
  private beatWatchdog: ReturnType<typeof setInterval> | null = null;

  /**
   * Verrou d'arrière-plan : quand il est armé, aucun flux d'échantillons n'est
   * ouvert, quel que soit le chemin qui le réclame.
   *
   * Arrêter le tap au passage en arrière-plan ne suffit pas. En fond, le lecteur
   * reste vivant et n'émet plus de `didFinish` vers l'UI… mais le passage à la
   * piste suivante passe quand même par `loadTrack`, donc par
   * `startNativeBeatSampling`. Une simple coupure serait donc rallumée au premier
   * changement de morceau en screen off — c'est-à-dire au moment où la fuite est
   * la plus coûteuse. Ce drapeau est la seule constante qui rend l'état
   * «background» lisible depuis tous les points d'entrée du tap.
   *
   * Le chien de garde est coupé avec : il ne sert qu'à surveiller un flux qui
   * n'existe plus, et le laisser tourner ne fait que consommer du CPU pendant que
   * l'app est censée dormir.
   */
  private isBackgrounded = false;

  private currentPlaybackRate = 1.0;
  private currentVolume = 100;
  private currentEqualizer: Partial<DSPState> = { enabled: true, bands: new Array<number>(10).fill(0), preamp: 0 };

  // --- Volume système ------------------------------------------------
  /**
   * Volume de l'appareil en pourcentage, ou `null` quand il est illisible.
   *
   * Aucun lecteur natif ne l'expose aujourd'hui : `expo-audio` ne publie que le
   * gain du lecteur (`volume`, 0-1), jamais `AVAudioSession.outputVolume`. Le web
   * n'a pas davantage d'API : `AudioContext.destination` n'expose pas de volume,
   * `HTMLMediaElement.volume` est un gain propre à l'élément, `setSinkId` choisit
   * une sortie et non un niveau, et `navigator.volume` n'existe pas. Vrai `null`,
   * l'app ne prétend donc pas suivre l'OS : le knob redevient une attestation
   * app-locale, et l'UI affiche l'aide prévue pour ce cas.
   */
  private systemVolume: number | null = null;
  private systemVolumeListeners = new Set<(volume: number) => void>();

  /**
   * Expose le volume système — aujourd'hui indéterminable, donc `null`.
   *
   * Renvoie une fonction de désabonnement. L'appelant garde son knob en
   * attestation app-locale, sans crash ni faux positif.
   */
  subscribeSystemVolume(listener: (volume: number | null) => void): () => void {
    // Aucun lecteur natif ne publie `AVAudioSession.outputVolume` : sans
    // observation KVO, le volume système reste indéterminable partout. On
    // annonce donc `null` sans condition, et l'appelant garde son knob en
    // attestation app-locale — c'est le chemin qu'il sait déjà traiter.
    this.systemVolume = null;
    listener(null);
    return () => {};
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

  /**
   * Reprise automatique après une interruption (appel entrant, alarme).
   *
   * `true` par défaut : la reprise est le comportement attendu d'un lecteur de
   * musique, et couper cette option laisse la musique silencieuse après un appel
   * jusqu'au toucher — c'est un choix de l'utilisateur, pas un défaut.
   */
  private autoResumeOnInterruption = true;

  /**
   * Android n'a pas besoin d'un événement natif pour cette feature, et c'est
   * contre-intuitif : il n'y a rien à écouter, rien à notifier.
   *
   * Tout se joue sur le focus audio, que le module `expo-audio` gère déjà :
   * `AUDIOFOCUS_LOSS_TRANSIENT` met `isPaused = true`, `AUDIOFOCUS_GAIN` remet
   * `isPaused = false` et appelle `play()`. JS voit le résultat par la sonde
   * d'état à 250 ms, qui relit `player.playing` — donc JS peut SAVOIR, mais pas
   * EMPÊCHER.
   *
   * Le levier est `interruptionMode` :
   *   - `'doNotMix'`     → demande le focus → pause puis reprise automatiques.
   *   - `'mixWithOthers'` → ne demande aucun focus → aucune pause, donc aucune
   *                         reprise automatique.
   *
   * Couper la reprise revient donc à ne plus demander le focus. C'est
   * contre-intuitif parce que le mode mélangeur semble signifier « tolère les
   * interruptions », alors qu'en réalité il supprime complètement la gestion
   * du focus — mais le comportement observé est bien le voulu : avec
   * `mixWithOthers`, une alarme ne met pas la musique en pause, donc il n'y a
   * rien à reprendre.
   *
   */
  private interruptionModeForPlatform(): 'doNotMix' | 'mixWithOthers' {
    // Le web n'a pas de session audio : le mode y est ignoré, et en demander un
    // chose n'aurait aucun effet mais pourrait brouiller les pistes de test.
    if (Platform.OS === 'web') return 'mixWithOthers';
    return this.autoResumeOnInterruption ? 'doNotMix' : 'mixWithOthers';
  }

  /**
   * Active ou désactive la reprise après une interruption, puis réapplique le
   * mode audio pour qu'un changement en cours de session prenne effet
   * immédiatement — sans cela, le réglage ne s'appliquerait qu'au prochain
   * démarrage de l'app.
   */
  async setAutoResumeOnInterruption(enabled: boolean): Promise<void> {
    if (this.autoResumeOnInterruption === enabled) return;
    this.autoResumeOnInterruption = enabled;
    try {
      await setAudioModeAsync({
        playsInSilentMode: true,
        shouldPlayInBackground: true,
        interruptionMode: this.interruptionModeForPlatform(),
      });
    } catch (err) {
      console.warn('setAudioModeAsync (reprise après interruption) a échoué:', err);
    }
  }

  async init() {
    try {
      await setAudioModeAsync({
        playsInSilentMode: true,
        shouldPlayInBackground: true,
        interruptionMode: this.interruptionModeForPlatform(),
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
   * (expo-audio ou HTMLAudio web) et libère les ressources.
   * Garantit de façon étanche qu'aucun morceau précédent ne continue à jouer
   * en arrière-plan lorsqu'un nouveau morceau est chargé.
   */
  async stopCurrentPlayback() {
    // 1. Arrêter le timer JS de progression
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }

    // 1 bis. Boucles web.
    //
    // Elles n'étaient annulées que dans `release()`, jamais entre deux pistes.
    // `startWebProgressLoop` se re-garde d'elle-même, mais la pompe de rythme
    // ne le faisait pas : entre deux morceaux, une boucle
    // survivait et continuait de pousser `beatStore` depuis le moteur
    // précédent, pendant que la piste suivante en lançait une autre. D'où des
    // battements incohérents en cours de lecture, sur web seulement.
    // La pompe de rythme a reçu le même garde dans `startWebBeatPump`.
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.webBeatRaf !== null) {
      cancelAnimationFrame(this.webBeatRaf);
      this.webBeatRaf = null;
    }

    // 2. Chien de garde et détection de rythme
    this.stopBeatWatchdog();
    this.stopNativeBeatSampling();

    // 3. Moteur expo-audio (Expo Go / Android / iOS)
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

    // 4. Moteur Web
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
          interruptionMode: this.interruptionModeForPlatform(),
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
          this.webEngine.setVolume(this.currentVolume);
          this.applyEqualizer();
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
      this.setVolume(this.currentVolume);

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

    // Native iOS / Android via expo-audio : seul chemin mobile.
    await this.loadViaExpoAudio(uri, autoPlay, initialPositionSeconds, meta, loadId);
  }

  /**
   * Charge une piste dans le lecteur `expo-audio`.
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
      p.volume = this.currentVolume / 100;
      this.applyEqualizer();
      // Le tempo peut avoir été sélectionné avant la création de ce lecteur.
      // Chaque nouvelle instance expo-audio doit reprendre le réglage courant.
      p.setPlaybackRate(this.currentPlaybackRate);

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
      }

      // En arrière-plan, aucun flux d'échantillons : `startNativeBeatSampling`
      // respecte `isBackgrounded` et ne fait donc rien ici. Le chien de garde
      // n'a rien à surveiller dans ce cas.
      if (!this.isBackgrounded) {
        this.startNativeBeatSampling(p);
        this.startBeatWatchdog();
      }

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
      console.warn('Erreur chargement audio natif:', (error as any)?.stack || error);
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
    // Garde anti-double-boucle, comme dans `startWebProgressLoop`.
    //
    // Cette fonction est appelée à CHAQUE chargement de piste. Sans cette
    // annulation, le `webBeatRaf` d'origine n'était jamais annulé et sa
    // closure survivait : après dix morceaux, dix boucles tournaient à 60 Hz,
    // chacune poussant le même tampon vers `beatStore` — dix fois le travail
    // CPU et un tempo de détection faussé. Le symptôme (battement décalé après
    // quelques pistes) n'apparaît qu'après usage, jamais au premier morceau.
    if (this.webBeatRaf !== null) cancelAnimationFrame(this.webBeatRaf);
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
    // Porte d'arrière-plan : aucun flux ne s'ouvre depuis cet appareil quand
    // l'app est en fond. Voir `isBackgrounded`.
    if (this.isBackgrounded) return;
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
    // Même porte qu'au chargement : un seek déclenché en arrière-plan ne doit
    // pas rouvrir le flux.
    if (this.isBackgrounded) return;
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
    } else if (this.player) {
      this.player.play();
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
    } else if (this.player) {
      this.player.pause();
    }
    beatStore.setPlaying(false);
  }

  async seekToSeconds(seconds: number) {
    if (Platform.OS === 'web' && this.webAudio) {
      this.webAudio.currentTime = seconds;
    } else if (this.player) {
      await this.player.seekTo(seconds);
      // Un seek coupe le flux d'échantillons : sans ce rattrapage, le chien
      // de garde finit par basculer sur 'none' et le logo ne revient plus.
      this.resumeBeatSampling();
    }
  }

  /**
   * Ouvre ou ferme la détection de rythme selon que l'app est au premier plan.
   *
   * À appeler depuis le `AppState` de l'écran. En fond, ferme le flux natif et
   * coupe le chien de garde ; au retour, ne rouvre que si un lecteur est monté —
   * sinon le premier plan suivant n'aurait aucun flux tant qu'aucune piste n'est
   * chargée, ce qui est le comportement normal.
   *
   * Symétrique par construction : `setAppActive(false)` est idempotent, donc
   * les transitions `inactive` → `background` d'iOS (qui publient deux états
   * successifs) ne font rien de plus.
   */
  setAppActive(active: boolean) {
    if (this.isBackgrounded === !active) return;
    this.isBackgrounded = !active;
    if (active) {
      if (this.player && !this.sampleSubscription) {
        this.startNativeBeatSampling(this.player);
        this.startBeatWatchdog();
      }
    } else {
      this.stopNativeBeatSampling();
      this.stopBeatWatchdog();
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
    this.currentVolume = clamped;

    if (Platform.OS === 'web' && this.webAudio) {
      if (this.webEngine) {
        this.webEngine.setVolume(clamped);
      } else {
        this.webAudio.volume = clamped / 100;
      }
    } else if (this.player) {
      this.player.volume = clamped / 100;
    }
  }

  setEqualizer(dsp: DSPState) {
    const bands = getEffectiveEqualizerBands(dsp.bands, dsp.bass, dsp.treble);

    this.currentEqualizer = { ...dsp, bands };
    this.applyEqualizer();
  }

  private applyEqualizer() {
    const eq = this.currentEqualizer;
    if (!eq) return;
    if (Platform.OS === 'web') {
      this.webEngine?.setEqualizer(eq.enabled ?? false, eq.bands ?? [], eq.preamp ?? 0);
      // Balance et Mid-Side sont branchés après l'égaliseur dans le graphe et
      // restent actifs même quand l'EQ est éteint — comme côté natif, où ils
      // alimentent `hasProcessing` sans dépendre des bandes.
      this.webEngine?.setBalance(eq.balance ?? 0);
      this.webEngine?.setStereoWidth(resolveStereoWidth(eq));
      this.webEngine?.setReverb(
        eq.reverbEnabled ?? false,
        eq.roomSize ?? 40,
        eq.damping ?? 50,
        eq.reverbMix ?? 25
      );
      this.webEngine?.setLimiter(eq.limitEnabled ?? true);
    } else {
      if (typeof (this.player as any)?.setDSP === 'function') (this.player as any).setDSP(
        eq.enabled ?? false, eq.bands ?? [], eq.preamp ?? 0,
        eq.balance ?? 0, resolveStereoWidth(eq), eq.limitEnabled ?? true,
        eq.reverbEnabled ?? false, eq.roomSize ?? 40, eq.damping ?? 50, eq.reverbMix ?? 25
      );
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
    this.systemVolumeListeners.clear();
    this.systemVolume = null;
    this.unsubscribeAndroidRemoteCommands();
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
