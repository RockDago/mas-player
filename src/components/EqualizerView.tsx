import React, { useRef, useState, useMemo } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  PanResponder,
  useWindowDimensions,
  Platform,
  ScrollView,
  Modal,
  TextInput,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { MaterialCommunityIcons, Ionicons } from '@expo/vector-icons';
import Svg, { Path, Circle } from 'react-native-svg';
import { DSPState, EqualizerPreset } from '../types/audio';
import {
  DEFAULT_PRESETS,
  MAS_PLAYER_BAND_LABELS,
  EQ_GAIN_MAX,
  EQ_GAIN_MIN,
  BASS_WEIGHTS,
  TREBLE_WEIGHTS,
  reverbDecayMs,
} from '../constants/presets';
import { storageService } from '../services/storageService';
import { useScreenInsets, insetPadding } from '../theme/insets';
import { playerManager } from '../services/playerManager';
import { isNativeEQAvailable } from '../services/nativeAudioDSP';

interface EqualizerViewProps {
  dsp: DSPState;
  /**
   * Volume de l'appareil en pourcentage, ou `null` quand il est illisible.
   *
   * Non `null`, le knob reflète l'OS en lecture seule et l'atténuateur logiciel
   * est neutralisé : l'OS est alors la seule autorité du volume. `null`, aucun
   * navigateur ne sait le dire, et le knob reste une attestation app-locale.
   */
  systemVolume?: number | null;
  onUpdateDSP: (newDsp: DSPState) => void;
  onOpenPresets: () => void;
  customPresets?: EqualizerPreset[];
  onSaveCustomPreset?: (name: string) => Promise<EqualizerPreset>;
  onDeleteCustomPreset?: (presetId: string) => Promise<void>;
}

// Convert angle (degrees, 0 = top dead center, clockwise) to SVG coordinates
function polarToCartesian(
  centerX: number,
  centerY: number,
  radius: number,
  angleInDegrees: number
) {
  const angleInRadians = ((angleInDegrees - 90) * Math.PI) / 180.0;
  return {
    x: centerX + radius * Math.cos(angleInRadians),
    y: centerY + radius * Math.sin(angleInRadians),
  };
}

// Generate SVG arc path from startAngle to endAngle
function describeArc(
  x: number,
  y: number,
  radius: number,
  startAngle: number,
  endAngle: number
) {
  const start = polarToCartesian(x, y, radius, endAngle);
  const end = polarToCartesian(x, y, radius, startAngle);
  const arcSweep = endAngle - startAngle;
  const largeArcFlag = arcSweep <= 180 ? '0' : '1';

  return [
    'M',
    start.x.toFixed(2),
    start.y.toFixed(2),
    'A',
    radius.toFixed(2),
    radius.toFixed(2),
    0,
    largeArcFlag,
    0,
    end.x.toFixed(2),
    end.y.toFixed(2),
  ].join(' ');
}

/**
 * Rendu de couleur unifié de niveau mastering professionnel :
 * - Neutre / Inactif / 0 : Slate (#64748B)
 * - Actif / Modifié : Signature Sky Blue (#38BDF8)
 */
export function getUnifiedGainColor(value: number, min: number = -12, max: number = 12): string {
  if (value === 0) return '#64748B';
  return '#38BDF8';
}

export function getUnifiedPercentColor(percent: number): string {
  if (percent === 0) return '#64748B';
  return '#38BDF8';
}

export function getUnifiedBalanceColor(balance: number): string {
  if (Math.abs(balance) < 0.03) return '#64748B';
  return '#38BDF8';
}

interface RotaryKnobProps {
  value: number; // min to max
  min: number;
  max: number;
  step?: number;
  size?: number;
  leftSubLabel?: string;
  leftSubColor?: string;
  rightSubLabel?: string;
  rightSubColor?: string;
  topIndicator?: boolean;
  defaultValue?: number;
  arcColor?: string;
  isBipolar?: boolean; // sweeps from 0° (top) instead of -135°
  isSemiCircle?: boolean; // 0% at bottom-left, 50% at top-center, 100% at bottom-right
  centerValue?: number; // value that must land on top center (e.g. 1.0 for tempo)
  isBalance?: boolean; // cyan for left, emerald for right
  /**
   * Affiche la valeur sans jamais l'écrire : le knob devient un simple miroir.
   * Utilisé pour le volume quand l'OS en est l'autorité — laisser le geste
   * modifier une valeur que le graphe n'applique plus serait un piège.
   */
  readOnly?: boolean;
  onChange: (val: number) => void;
}

export const RotaryKnob: React.FC<RotaryKnobProps> = ({
  value,
  min,
  max,
  step = 1,
  size = 80,
  leftSubLabel,
  leftSubColor,
  rightSubLabel,
  rightSubColor,
  topIndicator = false,
  defaultValue,
  arcColor = '#38BDF8',
  isBipolar = false,
  isSemiCircle = false,
  centerValue,
  isBalance = false,
  readOnly = false,
  onChange,
}) => {
  const valRef = useRef(value);
  valRef.current = value;

  const minRef = useRef(min);
  minRef.current = min;

  const maxRef = useRef(max);
  maxRef.current = max;

  const stepRef = useRef(step);
  stepRef.current = step;

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const defaultValueRef = useRef(defaultValue);
  defaultValueRef.current = defaultValue;

  const startValRef = useRef<number>(value);
  const isDraggingRef = useRef<boolean>(false);
  const lastTapRef = useRef<number>(0);

  const range = max - min;
  const normalized = Math.max(0, Math.min(1, (value - min) / (range || 1)));

  // Angle: -135° (7:30 o'clock) to +135° (4:30 o'clock), 0° is top center.
  //
  // `centerValue` splits the sweep in two halves so that value === centerValue
  // lands exactly on top (50% of the travel). The tempo knob needs this: its
  // range is 0.5x–2.0x but its neutral point is 1.0x, so a linear mapping would
  // park 1.0x at -45° instead of dead center. The two halves get independent
  // spans (half-travel each), which is what a physical dual-ganged pot around a
  // detented neutral would do.
  let angle: number;
  if (centerValue !== undefined) {
    if (value >= centerValue) {
      const span = max - centerValue || 1;
      angle = ((value - centerValue) / span) * 135;
    } else {
      const span = centerValue - min || 1;
      angle = -((centerValue - value) / span) * 135;
    }
  } else {
    angle = -135 + normalized * 270;
  }

  const triggerHaptic = () => {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {}
  };

  const updateValue = (nextRaw: number) => {
    const s = stepRef.current;
    const stepped = Math.round(nextRaw / s) * s;
    const clamped = Math.max(minRef.current, Math.min(maxRef.current, stepped));
    const formatted = Number(clamped.toFixed(2));
    if (formatted !== valRef.current) {
      triggerHaptic();
      valRef.current = formatted;
      onChangeRef.current(formatted);
    }
  };

  const resetToDefault = () => {
    const def =
      defaultValueRef.current !== undefined
        ? defaultValueRef.current
        : minRef.current <= 0 && maxRef.current >= 0
        ? 0
        : minRef.current;
    triggerHaptic();
    valRef.current = def;
    onChangeRef.current(def);
  };

  // Standard React Native PanResponder for iOS & Android & Web touch
  // `readOnly` est lu via un ref : le PanResponder est construit une seule fois,
  // il ne peut donc pas capturer la prop directement.
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !readOnlyRef.current,
      onMoveShouldSetPanResponder: (_, gs) =>
        !readOnlyRef.current &&
        (Math.abs(gs.dx) > 1 || Math.abs(gs.dy) > 1),
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        isDraggingRef.current = false;
        startValRef.current = valRef.current;

        const now = Date.now();
        if (now - lastTapRef.current < 300) {
          resetToDefault();
          lastTapRef.current = 0;
          return;
        }
        lastTapRef.current = now;
      },
      onPanResponderMove: (_, gs) => {
        if (readOnlyRef.current) return;
        isDraggingRef.current = true;
        const combinedDrag = -gs.dy * 1.0 + gs.dx * 0.85;
        const dragSensitivity = 130;
        const deltaVal =
          (combinedDrag / dragSensitivity) * (maxRef.current - minRef.current);
        updateValue(startValRef.current + deltaVal);
      },
      onPanResponderRelease: (evt, gs) => {
        if (readOnlyRef.current) return;
        if (!isDraggingRef.current && Math.abs(gs.dx) < 4 && Math.abs(gs.dy) < 4) {
          const locX = (evt.nativeEvent as any).locationX;
          if (typeof locX === 'number') {
            if (locX > size / 2) {
              updateValue(valRef.current + stepRef.current);
            } else {
              updateValue(valRef.current - stepRef.current);
            }
          }
        }
        isDraggingRef.current = false;
      },
    })
  ).current;

  // Web Mouse Drag support
  const handlePointerDownWeb = (e: any) => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    if (readOnlyRef.current) return;
    e.preventDefault?.();
    playerManager.resumeAudioContext().catch(() => {});
    const startY = e.clientY;
    const startX = e.clientX;
    const initialVal = valRef.current;
    let didMove = false;

    const target = e.currentTarget as HTMLElement | null;
    const pointerId = e.pointerId;
    if (target?.setPointerCapture && pointerId !== undefined) {
      try {
        target.setPointerCapture(pointerId);
      } catch {}
    }

    const onPointerMove = (moveEvt: MouseEvent) => {
      const dy = moveEvt.clientY - startY;
      const dx = moveEvt.clientX - startX;
      if (Math.abs(dy) > 2 || Math.abs(dx) > 2) didMove = true;
      const combined = -dy * 1.0 + dx * 0.85;
      const dragSensitivity = 130;
      const deltaVal =
        (combined / dragSensitivity) * (maxRef.current - minRef.current);
      updateValue(initialVal + deltaVal);
    };

    const onPointerUp = (upEvt: MouseEvent) => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      if (target?.releasePointerCapture && pointerId !== undefined) {
        try {
          target.releasePointerCapture(pointerId);
        } catch {}
      }
      if (!didMove) {
        const rect = target?.getBoundingClientRect();
        if (rect) {
          const clickX = upEvt.clientX - rect.left;
          if (clickX > rect.width / 2) {
            updateValue(valRef.current + stepRef.current);
          } else {
            updateValue(valRef.current - stepRef.current);
          }
        }
      }
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };

  // Web Mouse Wheel: scroll up (+), scroll down (-)
  const handleWheel = (e: any) => {
    if (Platform.OS === 'web' && e && typeof e.deltaY === 'number') {
      e.preventDefault?.();
      const direction = e.deltaY < 0 ? 1 : -1;
      updateValue(valRef.current + direction * stepRef.current);
    }
  };

  // SVG dimensions for circular glowing arc
  const svgSize = size + 16;
  const center = svgSize / 2;
  const arcRadius = (size + 6) / 2;

  // Background track: full 270° sweep (-135° → +135°). Semi-circle knobs reuse
  // the same geometry — the sweep already reads as a half circle.
  const arcStart = -135;
  const arcEnd = 135;
  const bgArcPath = describeArc(center, center, arcRadius, arcStart, arcEnd);

  // Active glowing arc calculation
  let activeArcPath = '';
  let activeColor = arcColor;

  if (isSemiCircle) {
    // Unipolar: fills from the left end (-135°) up to the current angle.
    if (angle > arcStart + 2) {
      activeArcPath = describeArc(
        center,
        center,
        arcRadius,
        arcStart,
        Math.min(arcEnd, angle)
      );
    }
  } else if (isBalance) {
    const balColor = getUnifiedBalanceColor(value);
    activeColor = balColor;
    if (value < -0.02) {
      activeArcPath = describeArc(center, center, arcRadius, Math.max(-135, angle), 0);
    } else if (value > 0.02) {
      activeArcPath = describeArc(center, center, arcRadius, 0, Math.min(135, angle));
    }
  } else if (isBipolar) {
    const bColor = getUnifiedGainColor(value, min, max);
    activeColor = bColor;
    if (value > 0.05) {
      activeArcPath = describeArc(center, center, arcRadius, 0, Math.min(135, angle));
    } else if (value < -0.05) {
      activeArcPath = describeArc(center, center, arcRadius, Math.max(-135, angle), 0);
    }
  } else {
    // Unipolar from -135° up to current angle
    if (angle > -133) {
      activeArcPath = describeArc(center, center, arcRadius, -135, Math.min(135, angle));
    }
  }

  return (
    <View
      style={styles.rotaryKnobOuter}
      // @ts-ignore
      onWheel={Platform.OS === 'web' ? handleWheel : undefined}
    >
      <View style={styles.knobWithLabelsRow}>
        {leftSubLabel ? (
          <TouchableOpacity
            onPress={() => updateValue(valRef.current - stepRef.current)}
            activeOpacity={0.7}
          >
            <Text
              style={[
                styles.knobSubLabelLeft,
                leftSubColor ? { color: leftSubColor } : undefined,
              ]}
            >
              {leftSubLabel}
            </Text>
          </TouchableOpacity>
        ) : null}

        {/* Circular SVG Glow Arc Ring + Inner Metallic Knob Disc */}
        <View style={{ width: svgSize, height: svgSize, alignItems: 'center', justifyContent: 'center' }}>
          <Svg width={svgSize} height={svgSize} style={StyleSheet.absoluteFill}>
            {/* Dark background track arc */}
            <Path
              d={bgArcPath}
              fill="none"
              stroke="#1C222B"
              strokeWidth={3.5}
              strokeLinecap="round"
            />
            {/* Center zero detent dot for bipolar or balance */}
            {(isBipolar || isBalance) && (
              <Circle
                cx={center}
                cy={center - arcRadius}
                r={2}
                fill={Math.abs(value) < 0.05 ? '#FFFFFF' : '#334155'}
              />
            )}
            {/* Glowing active arc */}
            {activeArcPath ? (
              <Path
                d={activeArcPath}
                fill="none"
                stroke={activeColor}
                strokeWidth={3.5}
                strokeLinecap="round"
              />
            ) : null}
          </Svg>

          <View
            style={[
              styles.rotaryDisc,
              {
                width: size,
                height: size,
                borderRadius: size / 2,
              },
              Platform.OS === 'web' &&
                ({
                  cursor: 'grab',
                  userSelect: 'none',
                  touchAction: 'none',
                } as any),
            ]}
            {...(Platform.OS === 'web' ? {} : panResponder.panHandlers)}
            // @ts-ignore
            onPointerDown={Platform.OS === 'web' ? handlePointerDownWeb : undefined}
            // @ts-ignore
            onDoubleClick={Platform.OS === 'web' ? resetToDefault : undefined}
          >
            {topIndicator && <View style={styles.rotaryTopDetent} />}
            <View
              style={[
                styles.rotaryNeedleWrapper,
                { transform: [{ rotate: `${angle}deg` }] },
              ]}
            >
              <View
                style={[
                  styles.rotaryNeedle,
                  isBalance
                    ? { backgroundColor: Math.abs(value) < 0.05 ? '#64748B' : activeColor }
                    : { backgroundColor: activeColor || '#38BDF8' },
                ]}
              />
            </View>
          </View>
        </View>

        {rightSubLabel ? (
          <TouchableOpacity
            onPress={() => updateValue(valRef.current + stepRef.current)}
            activeOpacity={0.7}
          >
            <Text
              style={[
                styles.knobSubLabelRight,
                rightSubColor ? { color: rightSubColor } : undefined,
              ]}
            >
              {rightSubLabel}
            </Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
};

interface FaderSliderProps {
  value: number; // dB
  min: number;
  max: number;
  height: number;
  isPreamp?: boolean;
  frequencyLabel?: string;
  onChange: (val: number) => void;
}

export const FaderSlider: React.FC<FaderSliderProps> = ({
  value,
  min,
  max,
  height,
  isPreamp = false,
  frequencyLabel,
  onChange,
}) => {
  const valRef = useRef(value);
  valRef.current = value;

  const minRef = useRef(min);
  minRef.current = min;

  const maxRef = useRef(max);
  maxRef.current = max;

  const heightRef = useRef(height);
  heightRef.current = height;

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const startValRef = useRef<number>(value);
  const isDraggingRef = useRef<boolean>(false);
  const lastTapRef = useRef<number>(0);

  const triggerHaptic = () => {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {}
  };

  const updateValue = (nextVal: number) => {
    const clamped = Math.max(
      minRef.current,
      Math.min(maxRef.current, Math.round(nextVal))
    );
    if (clamped !== valRef.current) {
      triggerHaptic();
      valRef.current = clamped;
      onChangeRef.current(clamped);
    }
  };

  const resetToZero = () => {
    triggerHaptic();
    valRef.current = 0;
    onChangeRef.current(0);
  };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, gs) =>
        Math.abs(gs.dy) > 1 || Math.abs(gs.dx) > 1,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        isDraggingRef.current = false;
        startValRef.current = valRef.current;

        const now = Date.now();
        if (now - lastTapRef.current < 300) {
          resetToZero();
          lastTapRef.current = 0;
          return;
        }
        lastTapRef.current = now;
      },
      onPanResponderMove: (_, gs) => {
        isDraggingRef.current = true;
        const effectiveHeight =
          heightRef.current > 0 ? heightRef.current * 0.76 : 180;
        const totalRange = maxRef.current - minRef.current;
        const deltaVal = (-gs.dy / effectiveHeight) * totalRange;
        updateValue(startValRef.current + deltaVal);
      },
      onPanResponderRelease: () => {
        isDraggingRef.current = false;
      },
    })
  ).current;

  // Web Mouse Drag & Direct Click support
  const handlePointerDownWeb = (e: any) => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    e.preventDefault?.();
    playerManager.resumeAudioContext().catch(() => {});
    const startY = e.clientY;
    const initialVal = valRef.current;
    let didMove = false;

    const target = e.currentTarget as HTMLElement | null;
    const pointerId = e.pointerId;
    if (target?.setPointerCapture && pointerId !== undefined) {
      try {
        target.setPointerCapture(pointerId);
      } catch {}
    }

    // Direct click jump to tapped position
    const rect = target?.getBoundingClientRect();
    if (rect) {
      const clickY = e.clientY - rect.top;
      const ratio = Math.max(0, Math.min(1, 1 - clickY / rect.height));
      const tappedDb = Math.round(
        minRef.current + ratio * (maxRef.current - minRef.current)
      );
      updateValue(tappedDb);
    }

    const onPointerMove = (moveEvt: MouseEvent) => {
      const dy = moveEvt.clientY - startY;
      if (Math.abs(dy) > 2) didMove = true;
      const effectiveHeight =
        heightRef.current > 0 ? heightRef.current * 0.76 : 180;
      const totalRange = maxRef.current - minRef.current;
      const deltaVal = (-dy / effectiveHeight) * totalRange;
      updateValue(initialVal + deltaVal);
    };

    const onPointerUp = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      if (target?.releasePointerCapture && pointerId !== undefined) {
        try {
          target.releasePointerCapture(pointerId);
        } catch {}
      }
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };

  // Mouse wheel: scroll up = +1 dB, scroll down = -1 dB
  const handleWheel = (e: any) => {
    if (Platform.OS === 'web' && e && typeof e.deltaY === 'number') {
      e.preventDefault?.();
      const direction = e.deltaY < 0 ? 1 : -1;
      updateValue(valRef.current + direction);
    }
  };

  const range = max - min;
  const ratio = (value - min) / (range || 1); // 0 at min (-12), 1 at max (+12), 0.5 at 0dB
  // Thumb top position percentage: 2% at top (+12dB), 80% at bottom (-12dB), ~41% at 0dB
  const thumbPercent = Math.max(2, Math.min(80, (1 - ratio) * 78 + 2));

  // Active glowing fill bar from 0 dB center (~41%) to thumb position
  const centerPercent = 41;
  const isPositive = value > 0;
  const isNegative = value < 0;

  const barTop = isPositive ? `${thumbPercent}%` : `${centerPercent}%`;
  const barHeight = isPositive
    ? `${centerPercent - thumbPercent}%`
    : isNegative
    ? `${thumbPercent - centerPercent}%`
    : '0%';

  const currentColor = getUnifiedGainColor(value, min, max);

  return (
    <View
      style={[
        styles.faderTrackWrapper,
        isPreamp && styles.preampCapsule,
        Platform.OS === 'web' &&
          ({
            cursor: 'ns-resize',
            userSelect: 'none',
            touchAction: 'none',
          } as any),
      ]}
      // @ts-ignore
      onWheel={Platform.OS === 'web' ? handleWheel : undefined}
      // @ts-ignore
      onPointerDown={Platform.OS === 'web' ? handlePointerDownWeb : undefined}
      // @ts-ignore
      onDoubleClick={Platform.OS === 'web' ? resetToZero : undefined}
      {...(Platform.OS === 'web' ? {} : panResponder.panHandlers)}
    >
      {/* Background vertical center line */}
      <View style={styles.faderCenterLine} />

      {/* Tick Marks along the fader channel */}
      {[0, 1, 2, 3, 4, 5, 6].map((tick) => (
        <View
          key={tick}
          style={[styles.tickMark, { top: `${tick * 16.6}%` }]}
        />
      ))}

      {/* Center 0 dB Reference Tick Line */}
      <View
        style={[
          styles.centerZeroTick,
          {
            top: `${centerPercent}%`,
            backgroundColor: value === 0 ? '#64748B' : '#475569',
          },
        ]}
      />

      {/* Active Glowing Bar from 0 dB center to thumb with unified gradient color */}
      {(isPositive || isNegative) && (
        <View
          style={[
            styles.faderActiveGlowBar,
            {
              top: barTop as any,
              height: barHeight as any,
              backgroundColor: '#38BDF8',
              shadowColor: '#38BDF8',
            },
          ]}
        />
      )}

      {/* Hardware Fader Thumb Handle */}
      <View
        style={[
          styles.faderThumb,
          {
            top: `${thumbPercent}%`,
            borderColor: value === 0 ? '#64748B' : '#38BDF8',
            shadowColor: '#38BDF8',
          },
        ]}
      >
        <View
          style={[
            styles.faderIndicatorLine,
            { backgroundColor: value === 0 ? '#64748B' : '#38BDF8' },
          ]}
        />
      </View>
    </View>
  );
};

export const EqualizerView: React.FC<EqualizerViewProps> = ({
  dsp,
  systemVolume = null,
  onUpdateDSP,
  onOpenPresets,
  customPresets = [],
  onSaveCustomPreset,
  onDeleteCustomPreset,
}) => {
  const { height: screenHeight, width: screenWidth } = useWindowDimensions();
  // Marge système mesurée (encoche / barre d'état). Remplace
  // `StatusBar.currentHeight` — voir src/theme/insets.ts.
  const insets = useScreenInsets();

  const isShortScreen = screenHeight < 720;
  const isExtraShort = screenHeight < 640;

  const [activeTab, setActiveTab] = React.useState<'eq' | 'knobs' | 'fx'>('eq');

  // Ni la réverbération, ni TONE, ni LIMIT n'ont d'état local : leurs six champs
  // vivent dans `DSPState`, donc dans le préréglage persisté et dans le pont
  // natif. Avant, `reverbEnabled` / `reverbRoom` / `reverbDamp` et les deux
  // pastilles étaient cinq `useState` que rien ne lisait — les six contrôles
  // étaient manœuvrables sans produire le moindre son.

  // Save Preset Modal states
  const [isSaveModalVisible, setIsSaveModalVisible] = React.useState<boolean>(false);
  const [savePresetName, setSavePresetName] = React.useState<string>('');
  const [saveToastNotice, setSaveToastNotice] = React.useState<string | null>(null);

  const triggerHaptic = () => {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {}
  };

  const handleToggleEQ = () => {
    triggerHaptic();
    onUpdateDSP({ ...dsp, enabled: !dsp.enabled });
  };

  const handleToggleTone = () => {
    triggerHaptic();
    onUpdateDSP({ ...dsp, toneEnabled: !dsp.toneEnabled });
  };

  const handleToggleLimit = () => {
    triggerHaptic();
    onUpdateDSP({ ...dsp, limitEnabled: !dsp.limitEnabled });
  };

  const handleToggleReverb = () => {
    triggerHaptic();
    onUpdateDSP({ ...dsp, reverbEnabled: !dsp.reverbEnabled });
  };

  /**
   * Écrit un des trois knobs de réverbération dans `DSPState`.
   *
   * Un seul point d'écriture : `onUpdateDSP` remonte au `playerManager`, qui
   * applique l'état aux DEUX moteurs (Web Audio et natif). C'est ce qui garantit
   * qu'une même valeur ne peut pas diverger entre plateformes.
   */
  const handleSetReverb = (
    field: 'roomSize' | 'damping' | 'reverbMix',
    value: number
  ) => {
    onUpdateDSP({
      ...dsp,
      [field]: Math.max(0, Math.min(100, value)),
      reverbEnabled: true,
    });
  };

  const handleResetEQ = () => {
    triggerHaptic();
    const flat = DEFAULT_PRESETS.find((p) => p.id === 'flat')!;
    onUpdateDSP({
      ...dsp,
      presetId: 'flat',
      bass: 0,
      treble: 0,
      preamp: 0,
      bands: [...flat.bands],
    });
  };

  const handleResetKnobs = () => {
    triggerHaptic();
    onUpdateDSP({
      ...dsp,
      balance: 0.0,
      stereoExpansion: 0,
      crossfeed: 0,
      tempo: 1.0,
      mono: false,
      tempoEnabled: false,
      // `volume` volontairement absent : le volume est réglé par l'utilisateur,
      // pas une valeur d'égaliseur. Le réinitialiser le ferait crier d'un coup.
    });
  };

  // Bass & treble are stored in dB but driven as a 0–100% boost: the knob runs
  // 0% (silent, -135°) → 50% (0 dB, top) → 100% (+12 dB, +135°). No negative
  // cut on these two knobs; the bass/treble cut role belongs to the 10-band
  // faders and to presets such as "Vocal Boost", which drive `bands` directly.
  const bassPercent = Math.round((dsp.bass / EQ_GAIN_MAX) * 100);
  const treblePercent = Math.round((dsp.treble / EQ_GAIN_MAX) * 100);
  const bassDb = Number(((bassPercent / 100) * EQ_GAIN_MAX).toFixed(1));
  const trebleDb = Number(((treblePercent / 100) * EQ_GAIN_MAX).toFixed(1));

  // Independent Bass boost on top of selected preset, driven in percent
  const handleBassPercentChange = (percent: number) => {
    onUpdateDSP({
      ...dsp,
      bass: Number(((percent / 100) * EQ_GAIN_MAX).toFixed(2)),
    });
  };

  // Independent Treble boost on top of selected preset, driven in percent
  const handleTreblePercentChange = (percent: number) => {
    onUpdateDSP({
      ...dsp,
      treble: Number(((percent / 100) * EQ_GAIN_MAX).toFixed(2)),
    });
  };

  // Moving individual band faders directly customizes the 10 bands
  const handleBandChange = (index: number, val: number) => {
    const nextBands = [...dsp.bands];
    nextBands[index] = val;
    onUpdateDSP({
      ...dsp,
      bands: nextBands,
      presetId: 'custom',
    });
  };

  // Save preset handler
  const handleOpenSaveModal = () => {
    triggerHaptic();
    const defaultName = `Mon Préréglage ${customPresets.length + 1}`;
    setSavePresetName(defaultName);
    setIsSaveModalVisible(true);
  };

  const handleConfirmSavePreset = async () => {
    triggerHaptic();
    const finalName = savePresetName.trim() || `Préréglage ${customPresets.length + 1}`;
    setIsSaveModalVisible(false);

    try {
      if (onSaveCustomPreset) {
        await onSaveCustomPreset(finalName);
      } else {
        // Fallback direct storage
        const currentCustoms = await storageService.getCustomPresets();
        const newPreset: EqualizerPreset = {
          id: `custom-${Date.now()}`,
          name: finalName,
          description: 'Préréglage utilisateur personnalisé',
          bass: dsp.bass,
          treble: dsp.treble,
          preamp: dsp.preamp,
          bands: [...dsp.bands],
        };
        const updated = [newPreset, ...currentCustoms];
        await storageService.saveCustomPresets(updated);
        onUpdateDSP({ ...dsp, presetId: newPreset.id });
      }

      setSaveToastNotice(`✓ Préréglage "${finalName}" enregistré !`);
      setTimeout(() => setSaveToastNotice(null), 3000);
    } catch (err) {
      console.warn('Erreur sauvegarde preset:', err);
    }
  };

  const formatBalance = (val: number) => {
    if (Math.abs(val) < 0.03) return 'CENTER';
    if (val < 0) return `L ${Math.abs(val).toFixed(2)}`;
    return `R ${val.toFixed(2)}`;
  };

  // Generous height for faders matching MAS Player interface
  const fadersHeight = isExtraShort ? 180 : isShortScreen ? 220 : 256;
  const spectrumHeight = isExtraShort ? 34 : 40;
  const knobSizeBassTreble = isExtraShort ? 66 : isShortScreen ? 74 : 84;
  const knobSizeTab2Top = isExtraShort ? 72 : isShortScreen ? 82 : 92;
  const knobSizeTab2Center = isExtraShort ? 60 : isShortScreen ? 70 : 80;
  const knobSizeVolume = isExtraShort ? 94 : isShortScreen ? 108 : 120;

  // Spectrum curve based on effective frequency response (preset bands + separate bass/treble boost)
  const spectrumWidth = Math.min(screenWidth - 28, 440);

  const effectiveBands = useMemo(() => {
    const bass = dsp.bass ?? 0;
    const treble = dsp.treble ?? 0;
    const bassWeights = BASS_WEIGHTS;
    const trebleWeights = TREBLE_WEIGHTS;
    return dsp.bands.map((band, idx) => {
      let g = band ?? 0;
      if (idx < 4) g += bass * (bassWeights[idx] ?? 0);
      else if (idx >= 6) g += treble * (trebleWeights[idx] ?? 0);
      return Math.max(EQ_GAIN_MIN, Math.min(EQ_GAIN_MAX, g));
    });
  }, [dsp.bands, dsp.bass, dsp.treble]);

  const curveSvgPath = useMemo(() => {
    if (spectrumWidth <= 0) return '';
    const points: { x: number; y: number }[] = [];
    const bands = effectiveBands;
    const count = bands.length;
    // `?? 0` comme dans la boucle ci-dessous : `bands` vient d'un `.map` sur le
    // tableau DSP, et un tableau plus court que la grille de labels y laisse des
    // trous. `undefined / 12` donnerait NaN, et le chemin SVG « M 0 NaN » fait
    // jeter react-native-svg au parsing de l'attribut `d` côté natif.
    const firstGain = bands[0] ?? 0;
    const lastGain = bands[count - 1] ?? 0;

    points.push({
      x: 0,
      y: spectrumHeight / 2 - (firstGain / 12) * (spectrumHeight * 0.38),
    });

    for (let i = 0; i < count; i++) {
      const x = ((i + 0.5) / count) * spectrumWidth;
      const gain = bands[i] ?? 0;
      const y = Math.max(
        4,
        Math.min(
          spectrumHeight - 4,
          spectrumHeight / 2 - (gain / 12) * (spectrumHeight * 0.38)
        )
      );
      points.push({ x, y });
    }

    points.push({
      x: spectrumWidth,
      y: spectrumHeight / 2 - (lastGain / 12) * (spectrumHeight * 0.38),
    });

    let d = `M ${points[0].x} ${points[0].y}`;
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i === 0 ? 0 : i - 1];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[i + 2 < points.length ? i + 2 : i + 1];

      const cp1x = p1.x + (p2.x - p0.x) / 6;
      const cp1y = p1.y + (p2.y - p0.y) / 6;
      const cp2x = p2.x - (p3.x - p1.x) / 6;
      const cp2y = p2.y - (p3.y - p1.y) / 6;

      d += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(
        1
      )} ${cp2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
    }
    return d;
  }, [effectiveBands, spectrumWidth, spectrumHeight]);

  const currentPreset =
    customPresets.find((p) => p.id === dsp.presetId) ||
    DEFAULT_PRESETS.find((p) => p.id === dsp.presetId);
  const currentPresetLabel = currentPreset
    ? currentPreset.name.split('(')[0].trim().toUpperCase()
    : dsp.presetId === 'custom'
    ? 'PERSONNALISÉ'
    : 'PRESET';

  return (
    <View
      style={[
        styles.container,
        { paddingTop: Platform.OS === 'android' ? insetPadding(insets, 'top', 4) : 2 },
      ]}
    >
      {/* Top 3 Tab Buttons: Equalizer, Knobs, Speaker/FX */}
      <View style={styles.topTabBar}>
        <TouchableOpacity
          onPress={() => {
            triggerHaptic();
            setActiveTab('eq');
          }}
          style={[styles.topTabBtn, activeTab === 'eq' && styles.topTabBtnActive]}
          activeOpacity={0.7}
        >
          <MaterialCommunityIcons
            name="tune-vertical"
            size={24}
            color={activeTab === 'eq' ? '#FFFFFF' : '#68737D'}
          />
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => {
            triggerHaptic();
            setActiveTab('knobs');
          }}
          style={[styles.topTabBtn, activeTab === 'knobs' && styles.topTabBtnActive]}
          activeOpacity={0.7}
        >
          <MaterialCommunityIcons
            name="circle-slice-8"
            size={22}
            color={activeTab === 'knobs' ? '#FFFFFF' : '#68737D'}
          />
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => {
            triggerHaptic();
            setActiveTab('fx');
          }}
          style={[styles.topTabBtn, activeTab === 'fx' && styles.topTabBtnActive]}
          activeOpacity={0.7}
        >
          <MaterialCommunityIcons
            name="speaker"
            size={22}
            color={activeTab === 'fx' ? '#FFFFFF' : '#68737D'}
          />
        </TouchableOpacity>
      </View>

      {/* Bannière explicative pour l'environnement Expo Go */}
      {Platform.OS !== 'web' && !isNativeEQAvailable() && (
        <View style={styles.expoGoBanner}>
          <Ionicons name="information-circle-outline" size={15} color="#F59E0B" style={{ marginRight: 6 }} />
          <Text style={styles.expoGoBannerText}>
            Mode Expo Go : DSP disponible en build APK/Dev Client (100% actif sur le Web)
          </Text>
        </View>
      )}

      {/* TAB 1: EQUALIZER WITH SPACED TALL FADERS MATCHING IMAGE 2 */}
      {activeTab === 'eq' && (
        <View style={styles.tab1Body}>
          {/* Main Faders Area: Preamp Column (Left) + Scrollable / Spaced 10 Bands (Right) */}
          <View style={[styles.fadersContainer, { height: fadersHeight + 42 }]}>
            {/* Preamp Column */}
            <View style={styles.preampOuterColumn}>
              <View style={{ height: fadersHeight }}>
                <FaderSlider
                  value={dsp.preamp}
                  min={-6}
                  max={6}
                  height={fadersHeight}
                  isPreamp
                  onChange={(val) => onUpdateDSP({ ...dsp, preamp: val })}
                />
              </View>
              <Text style={styles.preampLabel}>Preamp</Text>
              <Text
                style={[
                  styles.faderGainLabel,
                  { color: (dsp.preamp ?? 0) === 0 ? '#64748B' : '#38BDF8' },
                ]}
              >
                {((dsp.preamp ?? 0) > 0
                  ? `+${(dsp.preamp ?? 0).toFixed(1)}`
                  : (dsp.preamp ?? 0).toFixed(1))}
              </Text>
            </View>

            {/* Separator Line */}
            <View style={styles.preampSeparator} />

            {/* 10 Bands with Comfortable Spacing ("augmenter aussi un peut d'expace ici") */}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.bandsScrollContent}
              style={{ flex: 1 }}
            >
              {MAS_PLAYER_BAND_LABELS.map((freq, index) => {
                const gain = dsp.bands[index] ?? 0;
                return (
                  <View key={`band-${index}-${freq}`} style={styles.bandColumn}>
                    <View style={{ height: fadersHeight, width: '100%', alignItems: 'center' }}>
                      <FaderSlider
                        value={gain}
                        min={EQ_GAIN_MIN}
                        max={EQ_GAIN_MAX}
                        height={fadersHeight}
                        onChange={(val) => handleBandChange(index, val)}
                      />
                    </View>
                    <Text style={styles.frequencyLabel}>{freq}</Text>
                    <Text
                      style={[
                        styles.faderGainLabel,
                        { color: gain === 0 ? '#64748B' : '#38BDF8' },
                      ]}
                    >
                      {gain > 0 ? `+${gain.toFixed(1)}` : gain.toFixed(1)}
                    </Text>
                  </View>
                );
              })}
            </ScrollView>
          </View>

          {/* Middle Frequency Response (FR) Curve & Realtime Bars */}
          <View style={[styles.spectrumCard, { height: spectrumHeight }]}>
            <View style={styles.spectrumBarsRow}>
              {Array.from({ length: 32 }, (_, i) => {
                const bandIdx = Math.min(9, Math.floor((i / 32) * 10));
                const gain = effectiveBands[bandIdx] ?? 0;
                const barH = Math.max(
                  4,
                  Math.min(
                    spectrumHeight - 4,
                    spectrumHeight * 0.5 + gain * 1.2
                  )
                );
                return (
                  <View
                    key={i}
                    style={[
                      styles.spectrumBar,
                      {
                        height: barH,
                        backgroundColor: gain === 0 ? '#1E293B' : '#38BDF8',
                        opacity: gain === 0 ? 0.35 : 0.85,
                      },
                    ]}
                  />
                );
              })}
            </View>

            {curveSvgPath ? (
              <View style={[StyleSheet.absoluteFill, { pointerEvents: 'none' }]}>
                <Svg
                  width="100%"
                  height="100%"
                  viewBox={`0 0 ${spectrumWidth} ${spectrumHeight}`}
                >
                  <Path
                    d={curveSvgPath}
                    fill="none"
                    stroke="#38BDF8"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </Svg>
              </View>
            ) : null}
          </View>

          {/* Hi-Res Output Pill */}
          <View style={styles.hiResPillRow}>
            <View style={styles.hiResPill}>
              <Text style={styles.hiResPillText}>
                ⓘ OPENSL ES HI-RES OUTPUT 24-BIT 192KHZ
              </Text>
            </View>
          </View>

          {/* Lower Controls Section: EQU/TONE/LIMIT (Left) + PRESET/SAVE/RESET and Bass/Treble Knobs (Right) */}
          <View style={styles.lowerControlsSection}>
            {/* Left Column: EQU, TONE, LIMIT */}
            <View style={styles.verticalPillsCol}>
              <TouchableOpacity
                onPress={handleToggleEQ}
                style={[styles.leftPillBtn, dsp.enabled && styles.leftPillBtnActive]}
                activeOpacity={0.7}
              >
                <Text
                  style={[
                    styles.leftPillText,
                    dsp.enabled && styles.leftPillTextActive,
                  ]}
                >
                  EQU
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={handleToggleTone}
                style={[styles.leftPillBtn, dsp.toneEnabled && styles.leftPillBtnActive]}
                activeOpacity={0.7}
              >
                <Text
                  style={[
                    styles.leftPillText,
                    dsp.toneEnabled && styles.leftPillTextActive,
                  ]}
                >
                  TONE
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={handleToggleLimit}
                style={[
                  styles.leftPillBtn,
                  dsp.limitEnabled && styles.leftPillBtnActive,
                ]}
                activeOpacity={0.7}
              >
                <Text
                  style={[
                    styles.leftPillText,
                    dsp.limitEnabled && styles.leftPillTextActive,
                  ]}
                >
                  LIMIT
                </Text>
              </TouchableOpacity>
            </View>

            {/* Right Area: PRESET / SAVE / RESET and Bass & Treble Knobs with Glowing SVG Arcs */}
            <View style={styles.rightKnobsArea}>
              <View style={styles.presetButtonsRow}>
                <TouchableOpacity
                  onPress={onOpenPresets}
                  style={styles.presetMainBtn}
                  activeOpacity={0.7}
                >
                  <Text style={styles.presetMainBtnText} numberOfLines={1}>
                    {currentPresetLabel}
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={handleOpenSaveModal}
                  style={styles.presetSecondaryBtn}
                  activeOpacity={0.7}
                >
                  <Text style={styles.presetSecondaryBtnText}>SAVE</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={handleResetEQ}
                  style={styles.presetSecondaryBtn}
                  activeOpacity={0.7}
                >
                  <Text style={styles.presetSecondaryBtnText}>RESET</Text>
                </TouchableOpacity>
              </View>

              {/* Toast de confirmation de sauvegarde */}
              {saveToastNotice && (
                <View style={styles.saveToastBadge}>
                  <Text style={styles.saveToastText}>{saveToastNotice}</Text>
                </View>
              )}

              {/* Bass & Treble Knobs: Independent Tone Boost on top of preset */}
              <View style={styles.knobsRow}>
                {/* Bass Knob — half circle with unified gradient */}
                <View style={styles.knobWithStackedTextRow}>
                  <TouchableOpacity
                    onPress={() => handleBassPercentChange(0)}
                    style={styles.knobLabelColumn}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.knobSideTitle}>Bass</Text>
                    <Text
                      style={[
                        styles.knobSidePercent,
                        { color: bassPercent === 0 ? '#64748B' : '#38BDF8' },
                      ]}
                    >
                      {bassPercent}%
                    </Text>
                    <Text
                      style={[
                        styles.knobSideDb,
                        { color: '#94A3B8' },
                      ]}
                    >
                      {bassDb.toFixed(1)} dB
                    </Text>
                  </TouchableOpacity>
                  <RotaryKnob
                    value={bassPercent}
                    min={0}
                    max={100}
                    step={1}
                    size={knobSizeBassTreble}
                    defaultValue={0}
                    isSemiCircle
                    topIndicator
                    arcColor={bassPercent === 0 ? '#64748B' : '#38BDF8'}
                    onChange={handleBassPercentChange}
                  />
                </View>

                {/* Treble Knob — half circle with unified gradient */}
                <View style={styles.knobWithStackedTextRow}>
                  <TouchableOpacity
                    onPress={() => handleTreblePercentChange(0)}
                    style={styles.knobLabelColumn}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.knobSideTitle}>Treble</Text>
                    <Text
                      style={[
                        styles.knobSidePercent,
                        { color: treblePercent === 0 ? '#64748B' : '#38BDF8' },
                      ]}
                    >
                      {treblePercent}%
                    </Text>
                    <Text
                      style={[
                        styles.knobSideDb,
                        { color: '#94A3B8' },
                      ]}
                    >
                      {trebleDb.toFixed(1)} dB
                    </Text>
                  </TouchableOpacity>
                  <RotaryKnob
                    value={treblePercent}
                    min={0}
                    max={100}
                    step={1}
                    size={knobSizeBassTreble}
                    defaultValue={0}
                    isSemiCircle
                    topIndicator
                    arcColor={treblePercent === 0 ? '#64748B' : '#38BDF8'}
                    onChange={handleTreblePercentChange}
                  />
                </View>
              </View>
            </View>
          </View>
        </View>
      )}

      {/* TAB 2: SOUND / KNOBS (BALANCE, STEREO EXPAND, TEMPO, MONO, VOLUME) */}
      {activeTab === 'knobs' && (
        <View style={styles.tab2Body}>
          {/* Row 1: Balance (Left) & Stereo Expand (Right) with rich colors */}
          <View style={styles.tab2TopRow}>
            {/* Balance Knob with unified dynamic gradient */}
            <View style={styles.tab2KnobItem}>
              <RotaryKnob
                value={dsp.balance ?? 0}
                min={-1.0}
                max={1.0}
                step={0.05}
                size={knobSizeTab2Top}
                leftSubLabel="L"
                leftSubColor="#94A3B8"
                rightSubLabel="R"
                rightSubColor="#94A3B8"
                topIndicator
                defaultValue={0}
                isBalance
                onChange={(val) => onUpdateDSP({ ...dsp, balance: val })}
              />
              <Text style={styles.tab2KnobTitle}>Balance</Text>
              <Text
                style={[
                  styles.tab2KnobValue,
                  { color: getUnifiedBalanceColor(dsp.balance ?? 0) },
                ]}
              >
                {formatBalance(dsp.balance ?? 0)}
              </Text>
            </View>

            {/* Stereo Expand Knob */}
            <View style={styles.tab2KnobItem}>
              <RotaryKnob
                value={dsp.stereoExpansion ?? 0}
                min={0}
                max={100}
                step={5}
                size={knobSizeTab2Top}
                topIndicator
                defaultValue={0}
                arcColor={getUnifiedPercentColor(dsp.stereoExpansion ?? 0)}
                onChange={(val) => onUpdateDSP({ ...dsp, stereoExpansion: val })}
              />
              <Text style={styles.tab2KnobTitle}>Stereo Expand</Text>
              <Text
                style={[
                  styles.tab2KnobValue,
                  { color: getUnifiedPercentColor(dsp.stereoExpansion ?? 0) },
                ]}
              >
                {Math.round(dsp.stereoExpansion ?? 0)}%
              </Text>
            </View>

            {/*
              Crossfeed : mélange croisé L→R / R→L, le geste qui rend l'écoute
              casque_support naturel. Placé en face de Stereo Expand parce que
              les deux settings s'annulent partiellement : le moteur Native réduit
              le crossfeed quand la largeur monte (`1 - width/100`), donc les deux
              knobs se répondent au lieu de se contredire.
            */}
            <View style={styles.tab2KnobItem}>
              <RotaryKnob
                value={dsp.crossfeed ?? 0}
                min={0}
                max={100}
                step={5}
                size={knobSizeTab2Top}
                topIndicator
                defaultValue={0}
                arcColor={getUnifiedPercentColor(dsp.crossfeed ?? 0)}
                onChange={(val) => onUpdateDSP({ ...dsp, crossfeed: val })}
              />
              <Text style={styles.tab2KnobTitle}>Crossfeed</Text>
              <Text
                style={[
                  styles.tab2KnobValue,
                  { color: getUnifiedPercentColor(dsp.crossfeed ?? 0) },
                ]}
              >
                {Math.round(dsp.crossfeed ?? 0)}%
              </Text>
            </View>
          </View>

          {/* Row 2: TEMPO Pill Button (Left) + Center Tempo Knob (Amber Gold) */}
          <View style={styles.tab2TempoRow}>
            <TouchableOpacity
              onPress={() => {
                triggerHaptic();
                onUpdateDSP({ ...dsp, tempoEnabled: !dsp.tempoEnabled });
              }}
              style={[
                styles.tempoPillBtn,
                dsp.tempoEnabled && styles.tempoPillBtnActive,
              ]}
              activeOpacity={0.7}
            >
              <View style={styles.btnWithDotRow}>
                <View
                  style={[
                    styles.indicatorDot,
                    { backgroundColor: dsp.tempoEnabled ? '#38BDF8' : '#475569' },
                  ]}
                />
                <Text
                  style={[
                    styles.tempoPillText,
                    dsp.tempoEnabled && styles.tempoPillTextActive,
                  ]}
                >
                  {dsp.tempoEnabled ? 'TEMPO • ON' : 'TEMPO • OFF'}
                </Text>
              </View>
            </TouchableOpacity>

            <View style={styles.centerTempoKnobWrapper}>
              <RotaryKnob
                value={dsp.tempo ?? 1.0}
                min={0.5}
                max={2.0}
                step={0.05}
                size={knobSizeTab2Center}
                leftSubLabel="0.5x"
                leftSubColor="#94A3B8"
                rightSubLabel="2x"
                rightSubColor="#94A3B8"
                topIndicator
                defaultValue={1.0}
                centerValue={1.0}
                arcColor={dsp.tempo === 1.0 ? '#64748B' : '#38BDF8'}
                onChange={(val) =>
                  onUpdateDSP({
                    ...dsp,
                    tempo: val,
                    tempoEnabled: val !== 1.0 ? true : dsp.tempoEnabled,
                  })
                }
              />
              <Text
                style={[
                  styles.tab2KnobValue,
                  {
                    color: dsp.tempo === 1.0 ? '#64748B' : '#38BDF8',
                  },
                ]}
              >
                {(dsp.tempo ?? 1.0).toFixed(2)}x
              </Text>
            </View>

            <View style={{ width: 68 }} />
          </View>

          {/* Row 3: MONO Pill Button (Left) & RESET Pill Button (Right) */}
          <View style={styles.tab2MonoResetRow}>
            <TouchableOpacity
              onPress={() => {
                triggerHaptic();
                onUpdateDSP({ ...dsp, mono: !dsp.mono });
              }}
              style={[styles.monoPillBtn, dsp.mono && styles.monoPillBtnActive]}
              activeOpacity={0.7}
            >
              <View style={styles.btnWithDotRow}>
                <View
                  style={[
                    styles.indicatorDot,
                    { backgroundColor: dsp.mono ? '#38BDF8' : '#475569' },
                  ]}
                />
                <Text
                  style={[styles.monoPillText, dsp.mono && styles.monoPillTextActive]}
                >
                  {dsp.mono ? 'MONO • ON' : 'MONO • OFF'}
                </Text>
              </View>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={handleResetKnobs}
              style={styles.monoPillBtn}
              activeOpacity={0.7}
            >
              <Text style={styles.monoPillText}>RESET</Text>
            </TouchableOpacity>
          </View>

          {/* Row 4: Large Centered Volume Rotary Knob */}
          <View style={styles.tab2VolumeArea}>
            <RotaryKnob
              value={dsp.volume ?? systemVolume ?? 100}
              min={0}
              max={100}
              step={1}
              size={knobSizeVolume}
              topIndicator
              defaultValue={100}
              readOnly={false}
              arcColor={getUnifiedPercentColor(dsp.volume ?? systemVolume ?? 100)}
              onChange={(val) => onUpdateDSP({ ...dsp, volume: val })}
            />
            <Text style={styles.tab2KnobTitle}>
              {systemVolume !== null ? 'Volume appareil' : 'Volume'}
            </Text>
            <Text
              style={[
                styles.tab2KnobValue,
                {
                  color: getUnifiedPercentColor(dsp.volume ?? systemVolume ?? 100),
                  fontSize: 14,
                },
              ]}
            >
              {Math.round(dsp.volume ?? systemVolume ?? 100)}%
            </Text>
            {systemVolume === null && (
              <Text style={styles.tab2KnobHint}>
                100 % = transparent. Les boutons de l'appareil restent masters.
              </Text>
            )}
          </View>
        </View>
      )}

      {/* TAB 3: FX & REVERB */}
      {activeTab === 'fx' && (
        <View style={styles.tab3Body}>
          <View style={styles.fxToggleRow}>
            <TouchableOpacity
              onPress={handleToggleReverb}
              style={[
                styles.fxPillToggle,
                dsp.reverbEnabled && styles.fxPillToggleActive,
              ]}
              activeOpacity={0.7}
            >
              <View style={styles.fxPillInner}>
                <Ionicons
                  name={dsp.reverbEnabled ? 'sparkles' : 'sparkles-outline'}
                  size={18}
                  color={dsp.reverbEnabled ? '#38BDF8' : '#64748B'}
                />
                <Text
                  style={[
                    styles.fxPillText,
                    dsp.reverbEnabled && styles.fxPillTextActive,
                  ]}
                >
                  {dsp.reverbEnabled
                    ? 'RÉVERBÉRATION SPATIALE • ACTIVE'
                    : 'RÉVERBÉRATION SPATIALE • DÉSACTIVÉE'}
                </Text>
                <View
                  style={[
                    styles.fxPowerDot,
                    dsp.reverbEnabled && styles.fxPowerDotActive,
                  ]}
                />
              </View>
            </TouchableOpacity>
          </View>

          <View style={styles.tab2TopRow}>
            <View style={styles.tab2KnobItem}>
              <RotaryKnob
                value={dsp.roomSize}
                min={0}
                max={100}
                step={5}
                size={knobSizeTab2Top}
                defaultValue={40}
                arcColor="#38BDF8"
                onChange={(val) => handleSetReverb('roomSize', val)}
              />
              <Text style={styles.tab2KnobTitle}>Room Size</Text>
              <Text style={[styles.tab2KnobValue, { color: '#38BDF8' }]}>
                {dsp.roomSize}%
              </Text>
            </View>

            <View style={styles.tab2KnobItem}>
              <RotaryKnob
                value={dsp.damping}
                min={0}
                max={100}
                step={5}
                size={knobSizeTab2Top}
                defaultValue={50}
                arcColor="#38BDF8"
                onChange={(val) => handleSetReverb('damping', val)}
              />
              <Text style={styles.tab2KnobTitle}>Damping</Text>
              <Text style={[styles.tab2KnobValue, { color: '#38BDF8' }]}>
                {dsp.damping}%
              </Text>
            </View>
          </View>

          <View style={styles.tab2TopRow}>
            <View style={styles.tab2KnobItem}>
              <RotaryKnob
                value={dsp.reverbMix}
                min={0}
                max={100}
                step={5}
                size={knobSizeTab2Top}
                defaultValue={25}
                arcColor="#38BDF8"
                onChange={(val) => handleSetReverb('reverbMix', val)}
              />
              <Text style={styles.tab2KnobTitle}>Reverb Mix</Text>
              <Text style={[styles.tab2KnobValue, { color: '#38BDF8' }]}>
                {dsp.reverbMix}%
              </Text>
            </View>

            {/*
              La décroissance affichée est calculée ici, et non affichée en dur.
              C'est la seule information qui dit ce que fait réellement le knob
              « Room Size » : la taille perçue d'une pièce, c'est la longueur de
              sa queue, pas son retard brut. `-1/ln(0.52) ≈ 1.53` vient de la
              normalisation des gains de boucle (voir `presets.ts`).
            */}
            <View style={styles.tab2KnobItem}>
              <Text style={styles.tab2KnobTitle}>Decay</Text>
              <Text style={[styles.tab2KnobValue, { color: '#38BDF8' }]}>
                {Math.round(reverbDecayMs(dsp.roomSize))} ms
              </Text>
            </View>
          </View>

          <View style={styles.hiResPillRow}>
            <View style={styles.hiResPill}>
              <Text style={styles.hiResPillText}>
                32-BIT FLOATING POINT REVERB ENGINE
              </Text>
            </View>
          </View>
        </View>
      )}

      {/* SAVE PRESET MODAL */}
      <Modal
        visible={isSaveModalVisible}
        animationType="fade"
        transparent
        onRequestClose={() => setIsSaveModalVisible(false)}
      >
        <View style={styles.saveModalOverlay}>
          <View style={styles.saveModalBox}>
            <View style={styles.saveModalHeader}>
              <View style={styles.saveModalTitleRow}>
                <Ionicons name="save" size={22} color="#38BDF8" />
                <Text style={styles.saveModalTitle}>SAUVEGARDER LE PRÉRÉGLAGE</Text>
              </View>
              <TouchableOpacity onPress={() => setIsSaveModalVisible(false)}>
                <Ionicons name="close" size={22} color="#94A3B8" />
              </TouchableOpacity>
            </View>

            <Text style={styles.saveModalSubtitle}>
              Enregistrez vos réglages d'égalisation et de tonalité actuels :
            </Text>

            {/* Quick summary badges */}
            <View style={styles.saveSummaryBadgesRow}>
              <View style={styles.summaryBadge}>
                <Text style={styles.summaryBadgeLabel}>BASS</Text>
                <Text style={[styles.summaryBadgeVal, { color: '#38BDF8' }]}>
                  {bassPercent}% · {bassDb.toFixed(1)} dB
                </Text>
              </View>
              <View style={styles.summaryBadge}>
                <Text style={styles.summaryBadgeLabel}>TREBLE</Text>
                <Text style={[styles.summaryBadgeVal, { color: '#38BDF8' }]}>
                  {treblePercent}% · {trebleDb.toFixed(1)} dB
                </Text>
              </View>
              <View style={styles.summaryBadge}>
                <Text style={styles.summaryBadgeLabel}>PREAMP</Text>
                <Text style={styles.summaryBadgeVal}>
                  {dsp.preamp > 0 ? `+${dsp.preamp}` : dsp.preamp} dB
                </Text>
              </View>
            </View>

            {/* TextInput for preset name */}
            <View style={styles.saveInputWrapper}>
              <TextInput
                value={savePresetName}
                onChangeText={setSavePresetName}
                placeholder="Nom du préréglage..."
                placeholderTextColor="#64748B"
                style={styles.saveTextInput}
                autoFocus
                maxLength={32}
              />
              {savePresetName.length > 0 && (
                <TouchableOpacity onPress={() => setSavePresetName('')}>
                  <Ionicons name="close-circle" size={18} color="#94A3B8" />
                </TouchableOpacity>
              )}
            </View>

            {/* Quick tag suggestions */}
            <View style={styles.quickTagsRow}>
              {['Mega Bass', 'V-Shape', 'Club Sound', 'Voix Claire', 'Mastering'].map(
                (tag) => (
                  <TouchableOpacity
                    key={tag}
                    onPress={() => setSavePresetName(tag)}
                    style={styles.quickTagBtn}
                  >
                    <Text style={styles.quickTagText}>{tag}</Text>
                  </TouchableOpacity>
                )
              )}
            </View>

            {/* Action Buttons */}
            <View style={styles.saveActionsRow}>
              <TouchableOpacity
                onPress={() => setIsSaveModalVisible(false)}
                style={styles.saveCancelBtn}
                activeOpacity={0.7}
              >
                <Text style={styles.saveCancelText}>Annuler</Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={handleConfirmSavePreset}
                style={styles.saveConfirmBtn}
                activeOpacity={0.8}
              >
                <Ionicons name="checkmark" size={18} color="#000000" />
                <Text style={styles.saveConfirmText}>Enregistrer</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
    justifyContent: 'space-between',
  },
  topTabBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    backgroundColor: '#121417',
    marginHorizontal: 12,
    borderRadius: 10,
    paddingVertical: 5,
    borderWidth: 1,
    borderColor: '#1C1F24',
    marginBottom: 4,
  },
  topTabBtn: {
    paddingVertical: 4,
    paddingHorizontal: 22,
    borderRadius: 8,
  },
  topTabBtnActive: {
    backgroundColor: '#1F242C',
  },
  tab1Body: {
    flex: 1,
    justifyContent: 'space-between',
    paddingBottom: 4,
  },
  fadersContainer: {
    flexDirection: 'row',
    marginTop: 2,
    paddingHorizontal: 8,
    alignItems: 'center',
  },
  preampOuterColumn: {
    width: 48,
    alignItems: 'center',
    marginRight: 6,
  },
  preampCapsule: {
    backgroundColor: '#0E1014',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#1C222B',
  },
  preampSeparator: {
    width: 1,
    height: '75%',
    backgroundColor: '#1A2028',
    marginRight: 6,
  },
  bandsScrollContent: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 2,
  },
  bandColumn: {
    width: 44,
    alignItems: 'center',
    marginHorizontal: 3,
  },
  faderTrackWrapper: {
    flex: 1,
    width: 32,
    alignItems: 'center',
    position: 'relative',
    justifyContent: 'center',
    backgroundColor: '#0D1014',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#181E27',
    overflow: 'hidden',
  },
  faderCenterLine: {
    position: 'absolute',
    width: 2,
    height: '92%',
    backgroundColor: '#1E2530',
  },
  tickMark: {
    position: 'absolute',
    width: 12,
    height: 1,
    backgroundColor: '#262F3D',
  },
  centerZeroTick: {
    position: 'absolute',
    width: 18,
    height: 2,
    backgroundColor: '#475569',
    borderRadius: 1,
  },
  faderActiveGlowBar: {
    position: 'absolute',
    width: 3.5,
    borderRadius: 2,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.9,
    shadowRadius: 5,
    elevation: 3,
  },
  faderThumb: {
    position: 'absolute',
    width: 30,
    height: 44,
    borderRadius: 10,
    backgroundColor: '#181C22',
    borderWidth: 1.5,
    borderColor: '#334155',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.9,
    shadowRadius: 4,
    elevation: 5,
  },
  faderIndicatorLine: {
    width: 16,
    height: 2.5,
    borderRadius: 1.5,
  },
  preampLabel: {
    color: '#ECEFF4',
    fontSize: 10.5,
    fontWeight: '700',
    marginTop: 4,
  },
  frequencyLabel: {
    color: '#8A9AA8',
    fontSize: 10,
    fontWeight: '700',
    marginTop: 4,
  },
  faderGainLabel: {
    fontSize: 9.5,
    fontWeight: '800',
    marginTop: 1,
  },
  gainPositive: {
    color: '#38BDF8',
  },
  gainNegative: {
    color: '#38BDF8',
  },
  gainZero: {
    color: '#64748B',
  },
  spectrumCard: {
    backgroundColor: '#0A0C0E',
    marginHorizontal: 12,
    marginTop: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#191C22',
    justifyContent: 'flex-end',
    position: 'relative',
    overflow: 'hidden',
  },
  spectrumBarsRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
    height: '100%',
  },
  spectrumBar: {
    flex: 1,
    marginHorizontal: 1,
    backgroundColor: '#282F3A',
    borderRadius: 1,
    opacity: 0.85,
  },
  hiResPillRow: {
    alignItems: 'center',
    marginTop: 4,
  },
  hiResPill: {
    backgroundColor: '#090A0D',
    paddingVertical: 2,
    paddingHorizontal: 12,
    borderRadius: 10,
  },
  hiResPillText: {
    color: '#818E9B',
    fontSize: 9.5,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  lowerControlsSection: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    marginTop: 4,
    alignItems: 'center',
  },
  verticalPillsCol: {
    width: 68,
    gap: 6,
  },
  leftPillBtn: {
    backgroundColor: '#121418',
    paddingVertical: 9,
    borderRadius: 15,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#1C2026',
  },
  leftPillBtnActive: {
    borderColor: '#38BDF8',
    backgroundColor: 'rgba(56, 189, 248, 0.15)',
    shadowColor: '#38BDF8',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.35,
    shadowRadius: 5,
  },
  leftPillText: {
    color: '#68737D',
    fontSize: 10.5,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  leftPillTextActive: {
    color: '#38BDF8',
  },
  rightKnobsArea: {
    flex: 1,
    marginLeft: 10,
  },
  presetButtonsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
  },
  presetMainBtn: {
    flex: 1.4,
    backgroundColor: '#0B0D10',
    borderWidth: 1.5,
    borderColor: '#38BDF8',
    paddingVertical: 5,
    borderRadius: 15,
    alignItems: 'center',
  },
  presetMainBtnText: {
    color: '#38BDF8',
    fontSize: 10.5,
    fontWeight: '800',
    letterSpacing: 1,
  },
  presetSecondaryBtn: {
    flex: 1,
    backgroundColor: '#0B0D10',
    borderWidth: 1,
    borderColor: '#242A34',
    paddingVertical: 5,
    borderRadius: 15,
    alignItems: 'center',
  },
  presetSecondaryBtnText: {
    color: '#A0AEC0',
    fontSize: 10.5,
    fontWeight: '700',
  },
  saveToastBadge: {
    backgroundColor: '#0C2333',
    borderWidth: 1,
    borderColor: '#38BDF8',
    borderRadius: 6,
    paddingVertical: 3,
    paddingHorizontal: 8,
    alignSelf: 'center',
    marginBottom: 4,
  },
  saveToastText: {
    color: '#38BDF8',
    fontSize: 10,
    fontWeight: '700',
  },
  knobsRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
  },
  knobWithStackedTextRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  knobLabelColumn: {
    alignItems: 'flex-start',
    marginRight: 6,
  },
  knobSideTitle: {
    color: '#8A9AA8',
    fontSize: 12,
    fontWeight: '600',
  },
  knobSidePercent: {
    fontSize: 13,
    fontWeight: '800',
    marginTop: 2,
  },
  knobSideDb: {
    color: '#64748B',
    fontSize: 10,
    fontWeight: '700',
    marginTop: 1,
  },
  rotaryKnobOuter: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  knobWithLabelsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  knobSubLabelLeft: {
    color: '#9EABB8',
    fontSize: 12,
    fontWeight: '800',
    marginRight: 6,
  },
  knobSubLabelRight: {
    color: '#9EABB8',
    fontSize: 12,
    fontWeight: '800',
    marginLeft: 6,
  },
  rotaryDisc: {
    backgroundColor: '#12151B',
    borderWidth: 2,
    borderColor: '#262E3B',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.9,
    shadowRadius: 5,
    elevation: 6,
    position: 'relative',
  },
  rotaryTopDetent: {
    position: 'absolute',
    top: 4,
    width: 3,
    height: 3,
    borderRadius: 1.5,
    backgroundColor: '#475569',
  },
  rotaryNeedleWrapper: {
    position: 'absolute',
    width: '100%',
    height: '100%',
    justifyContent: 'flex-start',
    alignItems: 'center',
  },
  rotaryNeedle: {
    width: 2.5,
    height: '38%',
    borderRadius: 1.5,
    marginTop: 3,
  },

  // TAB 2 STYLES
  tab2Body: {
    flex: 1,
    paddingHorizontal: 16,
    paddingVertical: 6,
    justifyContent: 'space-between',
  },
  tab2TopRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    marginTop: 4,
  },
  tab2KnobItem: {
    alignItems: 'center',
  },
  tab2KnobTitle: {
    color: '#ECEFF4',
    fontSize: 13,
    fontWeight: '700',
    marginTop: 6,
  },
  tab2KnobValue: {
    fontSize: 12,
    fontWeight: '800',
    marginTop: 2,
  },
  // Précis important quand le volume système est illisible (web, Android) : sans
  // lui, le knob laisse croire à une synchronisation avec l'appareil qui n'existe pas.
  tab2KnobHint: {
    fontSize: 10,
    color: '#6B7280',
    textAlign: 'center',
    marginTop: 4,
    paddingHorizontal: 12,
  },
  btnWithDotRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  indicatorDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 6,
  },
  tab2TempoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
  },
  tempoPillBtn: {
    backgroundColor: '#121418',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: '#1C2026',
  },
  tempoPillBtnActive: {
    borderColor: '#38BDF8',
    backgroundColor: 'rgba(56, 189, 248, 0.15)',
    shadowColor: '#38BDF8',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.35,
    shadowRadius: 6,
  },
  tempoPillText: {
    color: '#68737D',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  tempoPillTextActive: {
    color: '#38BDF8',
  },
  centerTempoKnobWrapper: {
    alignItems: 'center',
  },
  tab2MonoResetRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    marginVertical: 4,
  },
  monoPillBtn: {
    backgroundColor: '#121418',
    paddingVertical: 7,
    paddingHorizontal: 16,
    borderRadius: 15,
    borderWidth: 1.5,
    borderColor: '#1C2026',
  },
  monoPillBtnActive: {
    borderColor: '#38BDF8',
    backgroundColor: 'rgba(56, 189, 248, 0.15)',
    shadowColor: '#38BDF8',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.35,
    shadowRadius: 6,
  },
  monoPillText: {
    color: '#8A9AA8',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  monoPillTextActive: {
    color: '#38BDF8',
  },
  tab2VolumeArea: {
    alignItems: 'center',
    marginBottom: 8,
  },

  // TAB 3 STYLES
  tab3Body: {
    flex: 1,
    paddingHorizontal: 16,
    paddingVertical: 12,
    justifyContent: 'space-between',
  },
  fxToggleRow: {
    alignItems: 'center',
    marginVertical: 8,
  },
  fxPillToggle: {
    backgroundColor: '#121418',
    paddingVertical: 10,
    paddingHorizontal: 22,
    borderRadius: 20,
    borderWidth: 1.5,
    borderColor: '#1C2026',
  },
  fxPillToggleActive: {
    borderColor: '#38BDF8',
    backgroundColor: 'rgba(56, 189, 248, 0.15)',
    shadowColor: '#38BDF8',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.45,
    shadowRadius: 8,
  },
  fxPillInner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  fxPillText: {
    color: '#68737D',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  fxPillTextActive: {
    color: '#38BDF8',
  },
  fxPowerDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: '#334155',
    marginLeft: 8,
  },
  fxPowerDotActive: {
    backgroundColor: '#38BDF8',
    shadowColor: '#38BDF8',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.9,
    shadowRadius: 6,
  },

  // SAVE PRESET MODAL STYLES
  saveModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.82)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  saveModalBox: {
    width: '100%',
    maxWidth: 400,
    backgroundColor: '#111419',
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: '#242C38',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.8,
    shadowRadius: 15,
    elevation: 10,
  },
  saveModalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  saveModalTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  saveModalTitle: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  saveModalSubtitle: {
    color: '#8A9AA8',
    fontSize: 12,
    marginBottom: 12,
  },
  saveSummaryBadgesRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 14,
  },
  summaryBadge: {
    flex: 1,
    backgroundColor: '#171C24',
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 8,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#222A36',
  },
  summaryBadgeLabel: {
    color: '#64748B',
    fontSize: 10,
    fontWeight: '700',
  },
  summaryBadgeVal: {
    color: '#F1F5F9',
    fontSize: 12,
    fontWeight: '800',
    marginTop: 2,
  },
  saveInputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0B0D10',
    borderWidth: 1.5,
    borderColor: '#38BDF8',
    borderRadius: 10,
    paddingHorizontal: 12,
    marginBottom: 12,
  },
  saveTextInput: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: 14,
    paddingVertical: 10,
  },
  quickTagsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 16,
  },
  quickTagBtn: {
    backgroundColor: '#171C24',
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#262F3D',
  },
  quickTagText: {
    color: '#94A3B8',
    fontSize: 11,
    fontWeight: '600',
  },
  saveActionsRow: {
    flexDirection: 'row',
    gap: 10,
  },
  saveCancelBtn: {
    flex: 1,
    backgroundColor: '#1A202A',
    paddingVertical: 11,
    borderRadius: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#2B3545',
  },
  saveCancelText: {
    color: '#94A3B8',
    fontSize: 13,
    fontWeight: '700',
  },
  saveConfirmBtn: {
    flex: 1.3,
    backgroundColor: '#38BDF8',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 11,
    borderRadius: 10,
  },
  saveConfirmText: {
    color: '#000000',
    fontSize: 13,
    fontWeight: '800',
  },
  expoGoBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(245, 158, 11, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.28)',
    borderRadius: 8,
    marginHorizontal: 16,
    marginTop: 6,
    marginBottom: 4,
    paddingVertical: 5,
    paddingHorizontal: 10,
  },
  expoGoBannerText: {
    color: '#FBBF24',
    fontSize: 11,
    fontWeight: '600',
    flexShrink: 1,
  },
});
