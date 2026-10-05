import React from 'react';
import {
  View,
  Text,
  Modal,
  StyleSheet,
  TouchableOpacity,
  ViewStyle,
  TextStyle,
  StyleProp,
  Platform,
  LayoutChangeEvent,
} from 'react-native';
import { color, radius, space, type, layout, font } from './tokens';

/**
 * Primitives d'interface MAS Player.
 *
 * Chaque composant de l'application devrait passer par ici. L'origine
 * réimplémentait ses propres boutons dans chaque fichier : huit boutons de
 * fermeture à quatre tailles différentes, des icônes nues dans un `View` à
 * `gap: 10`, des pastilles recomposées à la main. Ces primitives suppriment
 * cette duplication par construction — il n'y a plus qu'un bouton à ajuster,
 * et il l'est une fois.
 *
 * La règle qui gouverne ce fichier : un composant dessine une *intention*, pas
 * une forme. `IconButton` sait qu'il est pressable ; il ne sait pas qu'il doit
 * faire 36 px. La taille est un paramètre, la couleur vient des tokens.
 */

/* ── IconButton ───────────────────────────────────────────────────────────── */

export type IconButtonVariant = 'ghost' | 'raised' | 'accent' | 'solid';

interface IconButtonProps {
  /** Glyphe déjà rendu par l'appelant : `<Ionicons name="play" …/>`. */
  children: React.ReactNode;
  onPress: () => void;
  /** Convention : libellé en capitales, sans ponctuation terminale. */
  accessibilityLabel: string;
  variant?: IconButtonVariant;
  /** État engagé : change le fond et la bordure, pas seulement la couleur du glyphe. */
  active?: boolean;
  /** Carré de côté en px. Un cercle si `circular`. */
  size?: number;
  circular?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  hitSlop?: number;
}

/**
 * Bouton d'icône carré, ou circulaire si `circular`.
 *
 * La forme carrée est le cas par défaut. C'est volontaire : l'ancien écran
 * empilait cinq disques de trois tailles différentes, et c'est cette succession
 * de ronds qui faisait régresser vers un produit concurrent. Ici, un bouton
 * d'icône est un carré à bord net ; seuls les boutons réellement ronds passent
 * par `circular`.
 */
export const IconButton: React.FC<IconButtonProps> = ({
  children,
  onPress,
  accessibilityLabel,
  variant = 'ghost',
  active = false,
  size = layout.toolbarSize,
  circular = false,
  disabled = false,
  style,
  hitSlop = 8,
}) => {
  const palette = resolvePalette(variant, active);

  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected: active, disabled }}
      activeOpacity={0.6}
      hitSlop={hitSlop}
      style={[
        styles.iconButton,
        {
          width: size,
          height: size,
          borderRadius: circular ? size / 2 : radius.md,
          backgroundColor: palette.background,
          borderColor: palette.border,
          borderWidth: palette.borderWidth,
        },
        disabled && styles.disabled,
        style,
      ]}
    >
      {children}
    </TouchableOpacity>
  );
};

function resolvePalette(variant: IconButtonVariant, active: boolean) {
  switch (variant) {
    case 'accent':
      return {
        background: color.accentSoft,
        border: color.accentSoftBorder,
        borderWidth: layout.hairlineWidth,
      };
    case 'solid':
      return {
        background: active ? color.accentSolid : color.accentSolid,
        border: color.accentSolid,
        borderWidth: layout.hairlineWidth,
      };
    case 'raised':
      return {
        background: active ? color.border : color.surfaceRaised,
        border: active ? color.borderStrong : color.hairline,
        borderWidth: layout.hairlineWidth,
      };
    case 'ghost':
    default:
      return {
        background: 'transparent',
        border: active ? color.hairline : 'transparent',
        borderWidth: active ? layout.hairlineWidth : 0,
      };
  }
}

/* ── Pressable (zone de geste sans chrome) ────────────────────────────────── */

/**
 * Zone sensible sans chrome visible.
 *
 * Sert aux gestes plutôt qu'aux commandes : le glisser d'une piste de fader,
 * une ligne de liste. Un `TouchableOpacity` nu ferait le même travail, mais le
 * nommer dit ce que c'est — et évite qu'on lui ajoute un fond par réflexe.
 */
export const Pressable: React.FC<{
  children?: React.ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  disabled?: boolean;
  hitSlop?: number;
}> = ({ children, onPress, onLongPress, accessibilityLabel, style, disabled, hitSlop }) => (
  <TouchableOpacity
    onPress={onPress}
    onLongPress={onLongPress}
    disabled={disabled}
    accessibilityRole={onPress ? 'button' : undefined}
    accessibilityLabel={accessibilityLabel}
    activeOpacity={onPress ? 0.6 : 1}
    hitSlop={hitSlop}
    style={style}
  >
    {children}
  </TouchableOpacity>
);

/* ── Chip ─────────────────────────────────────────────────────────────────── */

/**
 * Étiquette compacte — format, état, compteur.
 *
 * Distingué de `IconButton` : un chip ne se presse pas. Il en découle qu'un chip
 * n'a pas d'état actif : s'il change, c'est qu'un autre chip est devenu actif,
 * et c'est le groupe qui doit le montrer, pas le chip isolé.
 */
export const Chip: React.FC<{
  children: React.ReactNode;
  tone?: 'neutral' | 'accent' | 'success';
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
  compact?: boolean;
}> = ({ children, tone = 'neutral', style, textStyle, compact = false }) => {
  const tones = {
    neutral: { bg: color.surfaceRaised, fg: color.textSecondary, bd: color.hairline },
    accent: { bg: color.accentSoft, fg: color.accent, bd: color.accentSoftBorder },
    success: { bg: 'rgba(34,197,94,0.14)', fg: '#4ADE80', bd: 'rgba(34,197,94,0.34)' },
  } as const;
  const t = tones[tone];

  return (
    <View
      style={[
        styles.chip,
        {
          backgroundColor: t.bg,
          borderColor: t.bd,
          paddingVertical: compact ? 1.5 : 3,
          paddingHorizontal: compact ? 6 : 9,
        },
        style,
      ]}
    >
      {typeof children === 'string' ? (
        <Text style={[styles.chipText, { color: t.fg }, compact && styles.chipTextCompact, textStyle]}>
          {children}
        </Text>
      ) : (
        children
      )}
    </View>
  );
};

/* ── Divider ──────────────────────────────────────────────────────────────── */

/**
 * Filet plein. Le matériau de base de cette direction.
 *
 * L'ancien écran délimitait les blocs par des pastilles chacune dans son
 * cadre ; celui-ci les aligne sur un même trait. Un `Divider` entre deux
 * sections vaut mieux qu'un `marginBottom` — il dit *où* est la séparation
 * au lieu de la faire sentir.
 */
export const Divider: React.FC<{
  vertical?: boolean;
  inset?: number;
  style?: StyleProp<ViewStyle>;
}> = ({ vertical = false, inset = 0, style }) => (
  <View
    style={[
      vertical
        ? { width: layout.hairlineWidth, alignSelf: 'stretch', marginVertical: inset }
        : { height: layout.hairlineWidth, alignSelf: 'stretch', marginHorizontal: inset },
      { backgroundColor: color.hairline },
      style,
    ]}
  />
);

/* ── SectionLabel ─────────────────────────────────────────────────────────── */

/**
 * Micro-label de section, en capitales espacées.
 *
 * Ne porte jamais une valeur qui change : c'est un texte, pas un `metric`. Si
 * un nombre doit apparaître à côté, il va dans un `Text` séparé en `metric`.
 */
export const SectionLabel: React.FC<{
  children: React.ReactNode;
  style?: StyleProp<TextStyle>;
  /** Élément aligné à droite du libellé — un compteur, un bouton. */
  accessory?: React.ReactNode;
}> = ({ children, style, accessory }) => (
  <View style={styles.sectionLabelRow}>
    <Text style={[type.label, style]}>{children}</Text>
    {accessory ? <View style={styles.sectionLabelAccessory}>{accessory}</View> : null}
  </View>
);

/* ── SegmentedControl ─────────────────────────────────────────────────────── */

interface SegmentedControlProps<T extends string> {
  segments: ReadonlyArray<{
    value: T;
    label?: string;
    /** Glyphe affiché au-dessus du libellé, ou à sa place si `label` absent. */
    icon?: React.ReactNode;
    accessibilityLabel?: string;
  }>;
  value: T;
  onChange: (value: T) => void;
  style?: StyleProp<ViewStyle>;
}

/**
 * Barre de segments à curseur glissant.
 *
 * Remplace les deux systèmes qu'elle unifie : les trois capsules de l'onglet EQ,
 * et les quatre icônes du dock dont l'état actif n'était signalé que par la
 * couleur du glyphe — invisible pour qui ne distingue pas `#FFFFFF` de
 * `#7D8A99`.
 *
 * Le curseur est une vue positionnée en `transform`, mesurée après la mise en
 * page (`onLayout`), jamais un pourcentage deviné : un `flex: 1` par segment
 * donnerait des largeurs inégales dès que les libellés diffèrent en longueur,
 * et l'indicateur dériverait sur les segments les plus courts.
 */
export function SegmentedControl<T extends string>({
  segments,
  value,
  onChange,
  style,
}: SegmentedControlProps<T>) {
  const [trackWidth, setTrackWidth] = React.useState(0);
  const activeIndex = Math.max(
    0,
    segments.findIndex((s) => s.value === value)
  );
  const segmentWidth = trackWidth > 0 ? trackWidth / segments.length : 0;

  const handleLayout = (event: LayoutChangeEvent) => {
    const width = event.nativeEvent.layout.width;
    if (Math.abs(width - trackWidth) > 0.5) setTrackWidth(width);
  };

  return (
    <View style={[styles.segmentedTrack, style]} onLayout={handleLayout}>
      {segmentWidth > 0 && (
        <View
          pointerEvents="none"
          style={[
            styles.segmentedIndicator,
            {
              width: segmentWidth - space.xxs * 2,
              transform: [{ translateX: activeIndex * segmentWidth + space.xxs }],
            },
          ]}
        />
      )}

      {segments.map((segment) => {
        const isActive = segment.value === value;
        return (
          <Pressable
            key={segment.value}
            onPress={() => onChange(segment.value)}
            accessibilityLabel={segment.accessibilityLabel ?? segment.label ?? segment.value}
            style={styles.segment}
          >
            {segment.icon ? (
              <View style={[styles.segmentIconWrap, isActive && styles.segmentIconWrapActive]}>
                {segment.icon}
              </View>
            ) : null}
            {segment.label ? (
              <Text
                numberOfLines={1}
                style={[styles.segmentLabel, isActive && styles.segmentLabelActive]}
              >
                {segment.label}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

/* ── Sheet ────────────────────────────────────────────────────────────────── */

interface SheetProps {
  visible: boolean;
  onClose: () => void;
  children: React.ReactNode;
  /** `bottom` : remonte du bas. `center` : boîte de dialogue. */
  placement?: 'bottom' | 'center';
  /** Largeur maximale en mode `center`. */
  maxWidth?: number;
  accessibilityLabel?: string;
}

/**
 * Feuille modale ou boîte de dialogue.
 *
 * L'origine avait quatre 전략 différentes selon les fichiers : voile à 0.70,
 * 0.75, 0.80 ou 0.85, et rayons de 14, 16, 18 ou 20 — sans qu'aucune ne
 * corresponde à un rôle. Ici il n'y a que deux placements, et ils disent ce
 * qu'ils sont.
 *
 * Le voile absorbe les pressions hors de la feuille ; `onClose` est aussi
 * câblé sur la touche Android, sinon retour ferme l'application sans prévenir.
 */
export const Sheet: React.FC<SheetProps> = ({
  visible,
  onClose,
  children,
  placement = 'bottom',
  maxWidth = 420,
  accessibilityLabel,
}) => {
  const isBottom = placement === 'bottom';

  return (
    <ModalShell visible={visible} onRequestClose={onClose}>
      <View
        style={[styles.sheetOverlay, isBottom ? styles.sheetOverlayBottom : styles.sheetOverlayCenter]}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Fermer" />

        <View
          accessibilityLabel={accessibilityLabel}
          style={[
            styles.sheetBody,
            isBottom ? styles.sheetBodyBottom : styles.sheetBodyCenter,
            isBottom ? null : { maxWidth },
          ]}
        >
          {children}
        </View>
      </View>
    </ModalShell>
  );
};

/**
 * Coquille de `Modal` qui replie les mêmes réglages pour toutes les feuilles.
 *
 * `animationType="fade"` : plusieurs feuilles portaient un commentaire
 * annonçant une animation de glissement alors que leur parent était en fondu,
 * et rien ne glissait. Un fondu évite d'annoncer un geste qui n'a pas lieu — et
 * évite l'étirement visible de la feuille vers le haut sur iOS.
 */
const ModalShell: React.FC<{
  visible: boolean;
  onRequestClose: () => void;
  children: React.ReactNode;
}> = ({ visible, onRequestClose, children }) => (
  <Modal visible={visible} animationType="fade" transparent onRequestClose={onRequestClose}>
    {children}
  </Modal>
);

/* ── Barre d'outils ───────────────────────────────────────────────────────── */

/**
 * Barre plate posée sur un filet.
 *
 * Remplace les rangées de pastilles du lecteur. Une barre d'outils se lit comme
 * une rangée de commandes sur un panneau : les éléments sont alignés sur un
 * même trait, pas chacun posé dans son cadre.
 */
export const Toolbar: React.FC<{
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  bordered?: boolean;
}> = ({ children, style, bordered = true }) => (
  <View style={[styles.toolbar, bordered && styles.toolbarBordered, style]}>{children}</View>
);

/* ── Styles ───────────────────────────────────────────────────────────────── */

const styles = StyleSheet.create({
  iconButton: {
    alignItems: 'center',
    justifyContent: 'center',
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  disabled: {
    opacity: 0.4,
  },

  chip: {
    borderRadius: radius.sm,
    borderWidth: layout.hairlineWidth,
    alignSelf: 'flex-start',
  },
  chipText: {
    fontSize: 10.5,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
  chipTextCompact: {
    fontSize: 9,
    letterSpacing: 0.3,
  },

  sectionLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: space.sm,
  },
  sectionLabelAccessory: {
    marginLeft: space.sm,
  },

  segmentedTrack: {
    flexDirection: 'row',
    alignSelf: 'stretch',
    backgroundColor: color.surface,
    borderRadius: radius.md,
    borderWidth: layout.hairlineWidth,
    borderColor: color.hairline,
    padding: space.xxs,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  segmentedIndicator: {
    position: 'absolute',
    top: space.xxs,
    bottom: space.xxs,
    left: 0,
    borderRadius: radius.sm,
    backgroundColor: color.accentSoft,
    borderWidth: layout.hairlineWidth,
    borderColor: color.accentSoftBorder,
  },
  segment: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: space.xs + 1,
    gap: 2,
  },
  segmentIconWrap: {
    paddingHorizontal: space.xs,
    paddingVertical: 1,
    borderRadius: radius.sm,
  },
  segmentIconWrapActive: {
    backgroundColor: 'transparent',
  },
  segmentLabel: {
    fontSize: 9.5,
    fontWeight: '700',
    letterSpacing: 0.9,
    textTransform: 'uppercase',
    color: color.textTertiary,
  },
  segmentLabelActive: {
    color: color.accent,
  },

  sheetOverlay: {
    flex: 1,
    backgroundColor: color.backdrop,
  },
  sheetOverlayBottom: {
    justifyContent: 'flex-end',
  },
  sheetOverlayCenter: {
    justifyContent: 'center',
    alignItems: 'center',
    padding: space.lg,
  },
  sheetBody: {
    backgroundColor: color.surfaceOverlay,
    borderWidth: layout.hairlineWidth,
    borderColor: color.border,
  },
  sheetBodyBottom: {
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingBottom: space.xxl,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
  },
  sheetBodyCenter: {
    width: '100%',
    borderRadius: radius.lg,
    padding: space.lg,
    maxHeight: '88%',
  },

  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  toolbarBordered: {
    borderTopWidth: layout.hairlineWidth,
    borderColor: color.hairline,
  },
});

/* Réexport des tokens les plus utilisés, pour n'importer qu'un module. */
export { color, radius, space, type, layout, font };
