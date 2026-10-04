import { Platform } from 'react-native';
import { createAudioPlayer, AudioPlayer, setAudioModeAsync } from 'expo-audio';
import { DSPState } from '../types/audio';
import { WebAudioEngine } from './webAudioEngine';
import { applyNativeDSP, setNativeVolume, loadNativeTrack, isNativeEQAvailable, addNativeProgressListener, playNative, pauseNative, stopNative, seekNative } from './nativeAudioDSP';
import { beatStore } from './beatStore';

export type PlaybackCallback = (status: {
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  didFinish?: boolean;
}) => void;

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
  /**
   * File d'attente sérialisée des appels au module natif.
   *
   * `setDSPAsync` / `setVolumeAsync` sont des `AsyncFunction` : chaque geste de
   * fader en déclenche une, et rien ne garantit que le pont les exécute dans
   * l'ordre d'émission. Sans sérialisation, un réglage ancien peut atterrir en
   * dernier et rester affiché — le « dernier geste gagne » n'est plus vrai.
   */
  private nativeChain: Promise<unknown> = Promise.resolve();

  /** Enfile un appel au module natif et attend que les précédents se résolvent. */
  private enqueueNative<T>(task: () => Promise<T>): Promise<T> {
    const next = this.nativeChain.then(task, task);
    // La chaîne ne doit jamais rester rejetée : un échec isolé ne doit pas
    // empêcher les réglages suivants de partir.
    this.nativeChain = next.catch(() => {});
    return next;
  }

  async init() {
    try {
      await setAudioModeAsync({
        playsInSilentMode: true,
        shouldPlayInBackground: true,
        interruptionMode: 'mixWithOthers',
      });
    } catch (err) {
      console.warn('init audio mode warning:', err);
    }
  }

  async loadTrack(
    uri: string,
    autoPlay: boolean = true,
    onStatusUpdate?: PlaybackCallback,
    initialPositionSeconds?: number,
    meta?: { title?: string; artist?: string }
  ) {
    this.currentUri = uri;
    if (onStatusUpdate) {
      this.onStatus = onStatusUpdate;
    }

    if (Platform.OS === 'web') {
      // Un seul élément audio pour toute la session : MediaElementAudioSourceNode
      // ne peut être attaché qu'une fois par élément, donc on ne recrée pas
      // `new Audio(uri)` à chaque piste.
      if (!this.webAudio) {
        this.webAudio = new Audio();
        this.webAudio.onended = () => {
          if (this.onStatus) {
            this.onStatus({
              currentTime: this.webAudio?.duration || 0,
              duration: this.webAudio?.duration || 1,
              isPlaying: false,
              didFinish: true,
            });
          }
        };
      }

      const audio = this.webAudio;

      if (!this.webEngine && WebAudioEngine.isSupported()) {
        this.webEngine = new WebAudioEngine(audio);
        if (this.pendingDsp) {
          // applyDSP pose déjà la largeur via applyStereo : setMono ne serait
          // qu'un second propriétaire des mêmes gains, qui l'écraserait.
          this.webEngine.applyDSP(this.pendingDsp);
        }
      }

      audio.src = uri;
      audio.load();

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
      await this.loadViaNativeEQ(uri, autoPlay, initialPositionSeconds, meta);
      return;
    }

    // Native iOS / Android via expo-audio : aussi le repli quand le module
    // AudioDSP est absent (Expo Go) ou que son chargement a échoué.
    await this.loadViaExpoAudio(uri, autoPlay, initialPositionSeconds);
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
    meta?: { title?: string; artist?: string }
  ) {
    // L'historique de rythme de la piste précédente ne doit pas colorer la
    // nouvelle : on remet l'analyseur à zéro avant le chargement.
    this.stopNativeBeatSampling();
    beatStore.reset();

    const loaded = await this.enqueueNative(() =>
      loadNativeTrack(uri, meta?.title, meta?.artist)
    );

    if (!loaded) {
      this.nativeEngineActive = false;
      console.warn('AudioDSP: chargement impossible, repli sur expo-audio');
      await this.loadViaExpoAudio(uri, autoPlay, initialPositionSeconds);
      return;
    }

    this.nativeEngineActive = true;

    // Rejoue les réglages DSP reçus avant l'existence du graphe.
    if (this.pendingDsp) {
      await this.enqueueNative(() => applyNativeDSP(this.pendingDsp!));
    }
    await this.enqueueNative(() => setNativeVolume(this.pendingDsp?.volume ?? 75));

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
    initialPositionSeconds?: number
  ) {
    try {
      if (this.player) {
        try { this.player.remove(); } catch (_) {}
        this.player = null;
      }
      if (this.intervalTimer) {
        clearInterval(this.intervalTimer);
        this.intervalTimer = null;
      }

      this.stopNativeBeatSampling();
      beatStore.reset();

      const p = createAudioPlayer(uri, { updateInterval: 250 });
      this.player = p;

      this.startNativeBeatSampling(p);
      this.startBeatWatchdog();

      if (initialPositionSeconds && initialPositionSeconds > 0) {
        try {
          await p.seekTo(initialPositionSeconds);
        } catch (_) {}
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
        this.onStatus({
          currentTime: audio.currentTime || 0,
          duration: audio.duration || 1,
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
    if (Platform.OS === 'web' && this.webAudio) {
      if (this.webEngine) {
        this.webEngine.resume().catch(() => {});
      }
      this.webAudio.play().catch(() => {});
    } else if (this.nativeEngineActive) {
      void this.enqueueNative(() => playNative());
    } else if (this.player) {
      this.player.play();
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
    }
  }

  setVolume(volumePercent: number) {
    const vol = Math.max(0, Math.min(1, volumePercent / 100));
    if (Platform.OS === 'web' && this.webAudio) {
      if (this.webEngine) {
        this.webEngine.setVolume(volumePercent);
      } else {
        this.webAudio.volume = vol;
      }
    } else if (this.nativeEngineActive) {
      // Le volume passe par le nœud master du graphe, pas par expo-audio :
      // `this.player` ne joue rien tant que le moteur natif porte l'audio.
      void this.enqueueNative(() => setNativeVolume(volumePercent));
    } else if (this.player) {
      this.player.volume = vol;
    }
  }

  setPlaybackRate(rate: number) {
    const clamped = Math.max(0.5, Math.min(2.0, rate));
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
    }
    // Moteur natif iOS : sérialisé, sinon un réglage ancien peut atterrir
    // après le dernier geste de fader et rester affiché.
    if (Platform.OS === 'ios' && isNativeEQAvailable()) {
      void this.enqueueNative(() => applyNativeDSP(dsp));
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
    if (this.nativeEngineActive) {
      void this.enqueueNative(() => stopNative());
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
      this.player.remove();
      this.player = null;
    }
  }
}

export const playerManager = new UniversalPlayerManager();
