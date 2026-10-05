import { Platform, StatusBar } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * Marges système — le seul endroit du projet qui lit les encoches, la barre
 * d'état et la barre de navigation.
 *
 * ── Pourquoi ce fichier existe ─────────────────────────────────────────────
 * L'appogroupait ses marges de deux façons incohérentes. Elle enveloppait ses
 * écrans dans le `SafeAreaView` de React Native, qui sur Android **est un simple
 * `View`** : `Platform.select({ ios: ..., default: View })`. Cinq écrans se
 * croyaient donc protégés et ne l'étaient pas. Le reste compensait à la main,
 * avec `StatusBar.currentHeight`, sur quatre écrans, chacun avec son propre
 * décalage (+4, +10), et la lecture n'était pas symétrique : le haut était
 * traité, le bas jamais. Le dock et la feuille d'action étaient donc dessinés
 * *sous* la barre de navigation.
 *
 * Sur Android 15+ le mode bord à bord est obligatoire (targetSdk 36) et les deux
 * barres sont transparentes : aucun réglage natif ne les détourne. La seule façon
 * de ne pas passer dessous est de mesurer les marges ici, une fois, et de les
 * appliquer à la main au même endroit.
 *
 * ── Pourquoi `currentHeight` a été abandonné ────────────────────────────────
 * `StatusBar.currentHeight` n'est pas une mesure, c'est une constante de
 * l'appareil lue à froid au chargement du module. Elle ne réagit ni au
 * redimensionnement de la fenêtre, ni au multi-fenêtre, ni à la rotation. Et sa
 * valeur est fausse précisément dans le cas qui nous intéresse : quand
 * l'application est bord à bord de bout en bout, il n'y a plus de « hauteur de
 * barre d'état » à rapporter. Une lecture à `0` laisse le contenu fusionner avec
 * l'horloge — exactement le symptôme signalé.
 *
 * `useSafeAreaInsets` est une mesure, pas une supposition : elle vient des
 * WindowInsets réels et se met à jour quand ils changent.
 */

/**
 * Marges nulles, stables entre deux rendus.
 *
 * Constante au niveau du module : retourner un objet neuf à chaque appel
 * déclencherait le `useEffect` de tous les appelants à chaque rendu.
 */
const ZERO_INSETS = { top: 0, bottom: 0, left: 0, right: 0 };

export function useScreenInsets(): {
  top: number;
  bottom: number;
  left: number;
  right: number;
} {
  // Le web n'a pas de barre système : ses marges sont toujours nulles.
  // Court-circuiter évite l'erreur de SafeAreaProvider manquant sur web.
  if (Platform.OS === 'web') {
    return ZERO_INSETS;
  }

  let raw = ZERO_INSETS;
  try {
    const insets = useSafeAreaInsets();
    if (insets) raw = insets;
  } catch {
    raw = ZERO_INSETS;
  }

  if (Platform.OS === 'android') {
    // Sur Android bord-à-bord, la barre d'état (horloge, réseau, batterie)
    // mesure au minimum StatusBar.currentHeight (24 à 42 px selon encoche).
    // Si useSafeAreaInsets rapporte 0 ou trop peu, la barre supérieure fusionnait avec la batterie.
    const sbHeight =
      typeof StatusBar.currentHeight === 'number' && StatusBar.currentHeight > 0
        ? StatusBar.currentHeight
        : 28;
    const top = Math.max(raw.top || 0, sbHeight);

    // Même principe pour la barre de navigation Android (gestes ou 3 boutons) :
    // elle réclame au minimum 26 à 48 px pour que le dock ne soit pas confondu avec la navbar du téléphone.
    const bottom = Math.max(raw.bottom || 0, 26);

    return {
      top,
      bottom,
      left: raw.left || 0,
      right: raw.right || 0,
    };
  }

  return raw;
}

/**
 * Marge de contenu au bord d'une barre système, À AJOUTER à l'espacement
 * esthétique de la barre.
 *
 * Sépare les deux notions qui étaient confondues : l'espace que l'occupant de
 * l'OS réclame, et l'espace que l'écran choisit pour respirer. Les deux
 * s'additionnent, mais seul le premier suit le modèle de l'appareil — il vaut
 * 24 px sur un téléphone à encoche, 0 sur un autre.
 */
export function insetPadding(
  insets: { top: number; bottom: number },
  edge: 'top' | 'bottom',
  aesthetic = 0
): number {
  return insets[edge] + aesthetic;
}