import { useEffect, useRef } from 'react';
import { Animated, PanResponder, Platform } from 'react-native';

/** Délai d'inactivité avant estompage, en lecture. */
const FADE_DELAY_MS = 4000;
/** Durée de la transition elle-même. Courte : elle doit suivre le doigt. */
const FADE_DURATION_MS = 280;

/**
 * Estompe un bloc de contrôles quand l'utilisateur ne touche plus rien.
 *
 * Utilise `Animated` du cœur React Native : `react-native-reanimated` n'est pas
 * une dépendance de ce projet, et l'ajouter pour un simple fondu en opacité
 * coûterait un arborescence native et un risque de build pour rien.
 *
 * **Portée volontairement étroite.** Le hook ne rend rien et ne décide pas quoi
 * estomper : l'appelant enchaîne la valeur sur les blocs de son choix. Un
 * fondu appliqué à l'écran entier rendrait la bibliothèque et les modales
 * inutilisables, ce qui est exactement le genre de réglage « marche mais casse
 * tout » qu'on cherche ici à éliminer.
 *
 * En pause, l'estompage est IMMÉDIAT et ne part pas sur minuterie : quand rien
 * ne joue, les contrôles sont la seule chose utile à l'écran, les laisser
 * scintiller quatre secondes avant de disparaître n'aurait aucun sens. En
 * lecture au contraire, on laisse le temps de profiter de la musique.
 */
export function useAutoFade(opts: {
  enabled: boolean;
  /** Opacité cible une fois estompé, 0–1. */
  minOpacity: number;
  /** Faux en lecture/pause : décide si le fondu part immédiatement ou différé. */
  isPlaying: boolean;
  /** Remet le fondu à 1 et relance la minuterie. Utilisé par `panHandlers`. */
}) {
  const { enabled, minOpacity, isPlaying } = opts;
  const opacity = useRef(new Animated.Value(1)).current;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // `wake` est capturé UNE SEULE FOIS par le PanResponder ci-dessous, qui vit
  // dans un `useRef` et n'est donc jamais recréé. Sans ces miroirs, il
  // conserverait `enabled` et `minOpacity` du PREMIER rendu : un réglage
  // activé en cours de session ne réveillerait jamais les contrôles, et l'opacité
  // visée resterait celle de l'état initial.
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const minOpacityRef = useRef(minOpacity);
  minOpacityRef.current = minOpacity;

  const clearTimer = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const animateTo = (toValue: number, duration: number) => {
    clearTimer();
    Animated.timing(opacity, {
      toValue,
      duration,
      useNativeDriver: Platform.OS !== 'web',
    }).start();
  };

  /** Rappelle les contrôles et relance le compte à rebours. */
  const wake = () => {
    if (!enabledRef.current) return;
    animateTo(1, FADE_DURATION_MS);
    clearTimer();
    timer.current = setTimeout(() => {
      animateTo(minOpacityRef.current, FADE_DURATION_MS);
    }, FADE_DELAY_MS);
  };

  // Estompage immédiat en pause, différé en lecture, et rien du tout si le
  // réglage est coupé — dans ce dernier cas l'opacité est ÉPINGLÉE à 1 et
  // aucune minuterie n'est armée, pour qu'une désactivation en cours de session
  // rende les contrôles immédiatement.
  useEffect(() => {
    if (!enabled) {
      clearTimer();
      opacity.setValue(1);
      return;
    }
    if (!isPlaying) {
      animateTo(minOpacity, FADE_DURATION_MS);
      return () => clearTimer();
    }
    wake();
    return () => clearTimer();
    // `wake` et `animateTo` sont recréés à chaque rendu ; les inclure
    // relancerait la minuterie à chaque rendu et le fondu n'arriverait jamais.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, isPlaying, minOpacity]);

  /**
   * `onStartShouldSetPanResponder` à `true` : ce geste doit *intercepter* le
   * toucher pour rappeler les contrôles. Avec `false`, le `ScrollView` parent
   * vole le geste avant que le rappel ne parte, et l'utilisateur voit les
   * contrôles rester estompés en pleine écoute.
   *
   * Sur le web, le responder de RN laisse passer les événements pointeur :
   * un listener `touchstart` sur la racine est ajouté en complément.
   */
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => wake(),
    })
  ).current;

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    // `document` n'existe pas au rendu sous SSR ; ce hook n'est monté que
    // dans l'app, mais le garde reste prudent et ne coûte rien.
    const el = typeof document !== 'undefined' ? document : null;
    if (!el) return;
    const onTouch = () => wake();
    el.addEventListener('touchstart', onTouch, { passive: true });
    return () => el.removeEventListener('touchstart', onTouch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, minOpacity, isPlaying]);

  return { opacity, panHandlers: enabled ? panResponder.panHandlers : {}, wake };
}