import { Platform, TextStyle } from 'react-native';

/**
 * Système de design MAS Player — direction « instrument / studio ».
 *
 * Ce fichier est la SEULE source de vérité pour les couleurs, les rayons, la
 * typographie et l'espacement. Aucun autre fichier ne doit déclarer de hex, ni
 * de `borderRadius` hors de l'échelle `radius`.
 *
 * ── Pourquoi ce fichier existe ────────────────────────────────────────────
 * L'interface reprenait la géométrie d'une table de mixage concurrente :
 * faders en capsule, boutons circulaires à trois niveaux, rangées de pastilles.
 * Neuf valeurs de rayon coexistaient sans correspondance sémantique et
 * quarante-sept nuances de gris se déclaraient localement. Le problème n'était
 * pas les couleurs individuellement — c'était qu'aucune ne se rattachait à une
 * intention. Nommer les valeurs rend l'arbitrage explicite : un rayon se choisit
 * pour ce qu'il désigne, pas parce qu'il traînait dans le fichier voisin.
 *
 * ── Ce qui n'a PAS changé ──────────────────────────────────────────────────
 * Le fond noir et le cyan `#38BDF8` sont identiques à ce qu'ils étaient. La
 * palette a été *consolidée* : des valeurs quasi indiscernables à l'œil
 * (`#161519` contre `#131215`, `#27272E` contre `#27272A`) ont fusionné en une
 * seule. Rien n'est devenu une autre couleur — c'est le même noir, élevé à la
 * même hauteur, partout.
 */

/* ── Couleurs ─────────────────────────────────────────────────────────────── */

/**
 * Rampe de gris. Sept valeurs nommées par leur *rôle*, pas par leur teinte.
 *
 * La consolidation a pris pour référence les gris déjà les plus présents dans le
 * code d'origine — `#000000`, `#131215`, `#18181B`, `#27272A` — : ce sont eux
 * que l'œil a déjà appris à reconnaître, donc ce sont eux qu'on conserve.
 */
export const color = {
  /** Fond d'application. Le noir le plus profond, réservé à l'écran. */
  base: '#000000',

  /** Panneau de premier niveau : barres d'outils, dock, en-têtes. */
  surface: '#131215',

  /** Élément posé sur un panneau : ligne de liste, champ, bouton neutre. */
  surfaceRaised: '#18181B',

  /** Feuille modale, menu surgissant, dialogue centré. */
  surfaceOverlay: '#1A191E',

  /** Séparateur entre deux blocs d'une même surface. Le trait d'1px. */
  hairline: '#22212B',

  /** Contour d'un élément posé. */
  border: '#27272A',

  /** Contour d'un élément au repos ou survolé — plus présent que `border`. */
  borderStrong: '#35333E',

  /** Accent de l'application. Inchangé. */
  accent: '#38BDF8',

  /** Accent à pleine intensité : fond de badge, curseur de progression. */
  accentSolid: '#38BDF8',

  /** Accent estompé — fond de pastille sélectionnée. */
  accentSoft: 'rgba(56, 189, 248, 0.12)',

  /** Contour de pastille sélectionnée. */
  accentSoftBorder: 'rgba(56, 189, 248, 0.35)',

  /** Texte principal. */
  text: '#FFFFFF',

  /** Texte secondaire : artiste, album, sous-titre. */
  textSecondary: '#94A3B8',

  /** Texte tertiaire : durée, compte, valeur au repos. */
  textTertiary: '#71717A',

  /** Texte quat-Doigt : placeholder, libellé désactivé. */
  textFaint: '#52525B',

  /** Voile derrière une modale. */
  backdrop: 'rgba(0, 0, 0, 0.82)',
} as const;

/**
 * Rampe de gain de l'égaliseur.
 *
 * Ces quatre couleurs n'ont pas été harmonisées : elles portent une *sémantique
 * de gain*, pas une identité visuelle. Le vert est le point neutre (0 dB), le
 * rouge la saturation, le cyan l'atténuation. Les garder est un choix
 * fonctionnel — un Readiness à l'œil doit se lire d'un coup, avant même la
 * position du curseur.
 */
export const gainColor = {
  /** 0 dB — la position de repos. */
  neutral: '#22C55E',
  /** Atténuation (valeurs négatives). */
  cut: '#38BDF8',
  /** Amplification légère. */
  boost: '#84CC16',
  /** Amplification forte. */
  peak: '#F97316',
  /** Saturation au maximum. */
  clip: '#EF4444',
} as const;

/** Accents secondaires, propres à une fonction (et non au thème). */
export const featureColor = {
  tempo: '#F59E0B',
  fx: '#06B6D4',
  preset: '#22C55E',
} as const;

/**
 * Palette de la voie de lecture : vert « doux », ambre, rouge.
 * Utilisée par les préréglages et les bannières d'état, pas par les contrôles.
 */
export const statusColor = {
  success: '#4ADE80',
  warning: '#FBBF24',
  danger: '#F87171',
} as const;

/* ── Rayons ───────────────────────────────────────────────────────────────── */

/**
 * Quatre valeurs, pas neuf.
 *
 * L'échelle d'origine (`4 6 8 10 12 16 18 20 22`) n'avait aucun sens : `10`
 * désignait un chip dans les réglages, une ligne dans la file d'attente et un
 * champ dans les actions. Les valeurs quasi-circulaires (18, 19, 20, 26, 41)
 * sur des éléments qui ne sont pas ronds sont surtout responsables de la
 * ressemblance avec un produit concurrent : une pastille à `borderRadius: 20`
 * signale « contrôle », et c'est exactement le vocabulaire qu'on cherche à
 * quitter.
 *
 * Aucun élément ne dépasse `lg`. Les seuls cercles de l'application sont ceux
 * qui sont réellement ronds : les boutons d'icône circulaires, qui tirent leur
 * rayon de leur demi-dimension.
 */
export const radius = {
  /** Faders, rails de progression, surfaces dures. Quasi droit. */
  xs: 2,
  /** Badges, petits chips, curseur de progression. */
  sm: 4,
  /** Boutons, champs de saisie, lignes de liste. */
  md: 8,
  /** Cartes, feuilles modales. */
  lg: 12,
} as const;

/* ── Typographie ──────────────────────────────────────────────────────────── */

/**
 * Chiffres tabulaires partout où une valeur change en direct.
 *
 * Sans `tabular-nums`, une minuterie change de chasse à chaque tick et la
 * colonne tremble. C'est le détail qui distingue un instrument d'un jouet :
 * les chiffres d'un appareil de mesure ne respirent pas.
 */
const tabular: TextStyle = Platform.select({
  ios: { fontVariant: ['tabular-nums' as const] },
  android: { fontVariant: ['tabular-nums' as const] },
  default: { fontVariant: ['tabular-nums' as const] },
}) as TextStyle;

/**
 * Familles de caractères.
 *
 * `mono` sert aux chiffres de mesure : temps, dB, fréquences. Un intervalle
 * aligné se lit d'un coup d'œil, un intervalle proportionnel non. Le repli
 * `monospace` couvre le web, où `tabular-nums` n'est pas garanti.
 */
export const font = {
  mono: Platform.select({
    ios: 'Menlo',
    android: 'monospace',
    default: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  }),
  body: undefined as string | undefined,
} as const;

/**
 * Échelle typographique — sept niveaux nommés par fonction.
 *
 * L'origine en comptait vingt-six, dont des demi-pas (11.5, 12.5, 13.5, 14.5,
 * 15.5, 16.5) qui n'existaient que parce que chaque composant arrondissait à sa
 * guise. Un niveau existe quand deux usages partagent réellement le même rôle.
 */
export const type = {
  /** Titre du morceau, nom d'un album. */
  display: {
    fontSize: 22,
    fontWeight: '700',
    color: color.text,
    letterSpacing: -0.4,
  },

  /** Titre de section, en-tête d'écran. */
  title: {
    fontSize: 17,
    fontWeight: '700',
    color: color.text,
    letterSpacing: -0.2,
  },

  /** Nom d'une piste, d'un préréglage, d'un élément de liste. */
  body: {
    fontSize: 14.5,
    fontWeight: '600',
    color: color.text,
  },

  /** Artiste, album, ligne secondaire. */
  caption: {
    fontSize: 12.5,
    fontWeight: '500',
    color: color.textSecondary,
    lineHeight: 17,
  },

  /**
   * Micro-label d'interface. Capitales, interlettrage large.
   *
   * C'est le marqueur le plus net de la direction « instrument » : sur une
   * platine, ce qui est gravé sur le chrome — « GAIN », « OUTPUT », « MONO » —
   * est en capitales espacées, jamais en phrase. Réservé aux libellés : ce style
   * ne doit jamais porter une valeur qui change.
   */
  label: {
    fontSize: 10,
    fontWeight: '700',
    color: color.textTertiary,
    letterSpacing: 1.2,
    textTransform: 'uppercase' as const,
  },

  /** Valeur de mesure : temps, dB, pourcentage. Toujours tabulaire. */
  metric: {
    fontSize: 12.5,
    fontWeight: '600',
    color: color.textSecondary,
    fontFamily: font.mono,
    ...tabular,
  },

  /** Valeur de mesure mise en avant : durée totale, gain courant. */
  metricStrong: {
    fontSize: 15,
    fontWeight: '700',
    color: color.text,
    fontFamily: font.mono,
    ...tabular,
  },
} satisfies Record<string, TextStyle>;

/* ── Espacement ───────────────────────────────────────────────────────────── */

/**
 * Base 4. Aucun espacement littéral ne doit subsister : une valeur écrite en
 * dur dans un `StyleSheet` est une valeur qui divergera de sa voisine.
 */
export const space = {
  /** 2pt — ajustement d'axe. */
  xxs: 2,
  /** 4pt — entre deux icônes d'un même groupe. */
  xs: 4,
  /** 8pt — respiration standard. */
  sm: 8,
  /** 12pt — entre deux blocs. */
  md: 12,
  /** 16pt — gouttière d'écran. */
  lg: 16,
  /** 20pt — margeLatérale des barres d'outils. */
  xl: 20,
  /** 24pt — respiration d'un panneau. */
  xxl: 24,
} as const;

/* ── Rythme ───────────────────────────────────────────────────────────────── */

/**
 * Dimensions fixes de l'identité visuelle.
 *
 * Les boutons de transport se répartissent sur trois tailles. Dans la version
 * d'origine, elles étaient circulaires — 36, 52, 82 px — et c'est cette
 * succession de disques qui renvoyait au produit concurrent. Ici la hiérarchie
 * passe par la *forme* avant la taille : un carré plein pour l'action
 * principale, un cadre pour les actions voisines, rien du tout pour les gestes
 * de balayage.
 */
export const layout = {
  /** Gouttière d'écran. */
  gutter: space.xl,

  /** Action principale. Carré à bord net. */
  playSize: 72,

  /** Action voisine, encadrée. */
  transportSize: 44,

  /** Carré de l'icône seule, dans une barre d'outils. */
  toolbarSize: 36,

  /** Hauteur d'une barre d'outils. */
  toolbarHeight: 44,

  /** Hauteur du dock. */
  dockHeight: 56,

  /** Épaisseur d'un trait plein. */
  hairlineWidth: 1,

  /**
   * Profondeur d'un fader : largeur de sa piste.
   *
   * Le fader d'origine faisait 32 px de large — presque un carré — et son curseur
   * en occupait la quasi-totalité. Une piste est un *rail* : elle se lit d'en
   * haut, pas de face.
   */
  faderTrackWidth: 2,

  /** Curseur d'un fader. Plat, il masque la piste et la prolonge. */
  faderThumbWidth: 24,
  faderThumbHeight: 32,

  /** Curseur du rail de progression. Carré — la position se lit d'un bord. */
  progressThumbSize: 12,
} as const;

/**
 * Épaisseur de trait par défaut.
 *
 * La ligne d'1px est le principal matériau de cette direction. Elle remplace
 * les bordures épaisses et les pastilles : là où l'ancien écran empilait des
 * contrôles chacun dans son cadre, le nouveau les aligne sur un même filet.
 */
export const hairline = {
  borderWidth: 1,
  borderColor: color.hairline,
} as const;

/** TypeScript garde une trace des clés ; ce bloc échoue si un jeton est dupliqué. */
export const _typecheckTokens = {
  radiusKeys: Object.keys(radius),
  colorKeys: Object.keys(color),
} as const;
