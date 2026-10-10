import React, { useCallback, useMemo, useRef, useState } from 'react';
import { View, Text, PanResponder, Platform, StyleSheet } from 'react-native';
import * as Haptics from 'expo-haptics';

/**
 * Barre de progression « en ligne », scrubbable.
 *
 * Remplace les 36 barres tactiles d'origine, qui ne donnaient que 36 positions
 * discrètes par appui. Ici on fait glisser n'importe où, et la progression est
 * une simple ligne : c'est un indicateur de position, pas une visualisation. Le
 * rythme appartient au logo (`BeatLogo`), rien d'autre ne doit bouger avec la
 * musique — sinon on ne sait plus où l'on est dans le morceau.
 *
 * Deux pièges traités ici, tous deux rencontrés :
 *
 * 1. Les mises à jour de position entrantes (poll 250 ms natif, rAF web) ne
 *    doivent surtout pas ramener le curseur en arrière sous le doigt. D'où
 *    `previewMs`, non nul exactement pendant le glissement, qui prend le dessus.
 *
 * 2. Le seek final NE DOIT PAS être déclenché depuis l'updater de `setState`.
 *    React appelle cet updater pendant sa phase de rendu : y faire un effet de
 *    bord (`setPositionMillis` sur `App`) déclenche « Cannot update a component
 *    while rendering a different component », et le seek est parfois purement
 *    et simplement perdu — d'où « on ne peut pas sauter ». On conserve la
 *    valeur dans une ref et on valide depuis le gestionnaire du geste, hors
 *    rendu.
 */

interface ProgressBarProps {
  positionMillis: number;
  durationMillis: number;
  playedColor?: string;
  unplayedColor?: string;
  onSeekCommit: (millis: number) => void;
  disabled?: boolean;
}

export const ProgressBar: React.FC<ProgressBarProps> = ({
  positionMillis,
  durationMillis,
  playedColor = '#00F0FF',
  unplayedColor = 'rgba(56, 189, 248, 0.18)',
  onSeekCommit,
  disabled = false,
}) => {
  const [previewMs, setPreviewMs] = useState<number | null>(null);

  // Miroir de `previewMs` : lisible depuis les gestionnaires de geste sans
  // passer par un état, donc utilisable hors de la phase de rendu.
  const previewRef = useRef<number | null>(null);

  // Réf plutôt qu'un état : la largeur n'a pas besoin de provoquer un rendu,
  // et elle est relue pendant le glissement.
  const widthRef = useRef(0);
  // Position au moment du doigt posé, pour que le glissement soit relatif et
  // que le curseur ne saute pas si le doigt revient sur la zone.
  const startMsRef = useRef(0);

  // Miroirs pour que le PanResponder puisse être figé (voir plus bas) sans
  // capturer des valeurs périmées.
  const durationRef = useRef(0);
  durationRef.current = durationMillis > 0 ? durationMillis : 0;
  const onSeekCommitRef = useRef(onSeekCommit);
  onSeekCommitRef.current = onSeekCommit;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  const duration = durationMillis > 0 ? durationMillis : 0;

  /**
   * PanResponder figé dans une ref, créé UNE seule fois.
   *
   * En `useMemo`, il était recréé dès que `commit` changeait d'identité — donc
   * à chaque rendu du parent, y compris les 4 fois/seconde du poll de position.
   * Chaque recréation réinitialise l'état interne du geste : `gestureState.dx`
   * repart de zéro et la barre sautait en arrière sous le doigt, par à-coups.
   * Les valeurs variables passent donc par `durationRef` / `onSeekCommitRef` /
   * `previewRef`, toutes relues au moment du geste.
   */
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !disabledRef.current && durationRef.current > 0,
      onMoveShouldSetPanResponder: () => !disabledRef.current && durationRef.current > 0,
      // Sur le web, la barre doit capter le geste horizontal avant que le
      // navigateur ne l'utilise pour défiler la page.
      onPanResponderTerminationRequest: () => false,

      onPanResponderGrant: (event) => {
        // `locationX` est relatif à la vue qui reçoit le geste. Les enfants
        // portent `pointerEvents="none"`, donc la cible est toujours la zone
        // tactile — sans quoi le repère serait mesuré depuis la ligne interne.
        const width = widthRef.current;
        const dur = durationRef.current;
        const locationX = event.nativeEvent.locationX ?? 0;
        startMsRef.current = width > 0 && dur > 0
          ? Math.max(0, Math.min(dur, (locationX / width) * dur))
          : 0;
        previewRef.current = startMsRef.current;
        setPreviewMs(startMsRef.current);
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      },

      onPanResponderMove: (_event, gesture) => {
        const width = widthRef.current;
        const dur = durationRef.current;
        if (width <= 0 || dur <= 0) return;
        const deltaMs = (gesture.dx / width) * dur;
        const next = Math.max(0, Math.min(dur, startMsRef.current + deltaMs));
        previewRef.current = next;
        setPreviewMs(next);
      },

      onPanResponderRelease: () => {
        const target = previewRef.current;
        if (target !== null) {
          onSeekCommitRef.current(target);
        }
        setTimeout(() => {
          previewRef.current = null;
          setPreviewMs(null);
        }, 60);
      },

      // Geste interrompu (notification, changement d'onglet) : on valide ce qui
      // était prévisualisé plutôt que d'ignorer le geste.
      onPanResponderTerminate: () => {
        const target = previewRef.current;
        if (target !== null) {
          onSeekCommitRef.current(target);
        }
        setTimeout(() => {
          previewRef.current = null;
          setPreviewMs(null);
        }, 60);
      },
    })
  ).current;

  const effectiveMs = previewMs ?? positionMillis;
  // `Number.isFinite` et pas seulement `duration > 0` : le moteur audio peut
  // rapporter `NaN` avant le premier chargement, et `Math.min(1, NaN)` propage
  // le `NaN` jusqu'au `width: 'NaN%'` — que le moteur de layout natif refuse.
  const playedRatio =
    Number.isFinite(duration) && duration > 0 && Number.isFinite(effectiveMs)
      ? Math.max(0, Math.min(1, effectiveMs / duration))
      : 0;

  const fmt = (total: number) => {
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  };

  return (
    <View style={[styles.wrapper, disabled && { opacity: 0.35 }]}>
      <View
        style={[
          styles.hitArea,
          disabled && (Platform.OS === 'web' ? ({ cursor: 'default' } as object) : {}),
        ]}
        onLayout={(event) => {
          widthRef.current = event.nativeEvent.layout.width;
        }}
        {...panResponder.panHandlers}
      >
        {/* Rail et remplissage : `pointerEvents: 'none'` pour que le pointeur
            atteigne toujours la zone tactile et non l'une de ces vues. */}
        <View style={styles.rail}>
          <View
            style={[
              styles.fill,
              { width: `${playedRatio * 100}%`, backgroundColor: playedColor },
            ]}
          />
        </View>
      </View>

      <View style={styles.timeRow}>
        <Text style={styles.timeText}>{fmt(Math.floor(Math.max(0, effectiveMs) / 1000))}</Text>
        <Text style={styles.timeText}>{fmt(Math.floor(duration / 1000))}</Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  wrapper: {
    width: '100%',
    paddingHorizontal: 10,
    marginVertical: 4,
  },
  hitArea: {
    // Zone tactile bien plus haute que la ligne : le geste reste confortable
    // malgré la précision demandée.
    height: 34,
    justifyContent: 'center',
    ...(Platform.OS === 'web'
      ? ({ cursor: 'pointer', userSelect: 'none', touchAction: 'none' } as object)
      : {}),
  },
  rail: {
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(15, 23, 42, 0.65)',
    borderWidth: 0.5,
    borderColor: 'rgba(0, 212, 255, 0.2)',
    overflow: 'hidden',
    pointerEvents: 'none',
  },
  fill: {
    height: '100%',
    borderRadius: 2,
    shadowColor: '#00F0FF',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.9,
    shadowRadius: 6,
    elevation: 4,
  },
  timeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 2,
    pointerEvents: 'none',
  },
  timeText: {
    color: '#8A9AA8',
    fontSize: 13,
    fontVariant: ['tabular-nums'],
  },
});