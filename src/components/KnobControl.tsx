import React, { useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  PanResponder,
  TouchableOpacity,
} from 'react-native';
import * as Haptics from 'expo-haptics';

interface KnobControlProps {
  label: string;
  value: number; // Value in dB, typically -12 to +12
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  accentColor?: string;
  onChange: (val: number) => void;
  size?: number;
}

export const KnobControl: React.FC<KnobControlProps> = ({
  label,
  value,
  min = -12,
  max = 12,
  step = 1,
  unit = 'dB',
  accentColor = '#81A1C1',
  onChange,
  size = 90,
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

  const startYRef = useRef<number>(0);
  const startValRef = useRef<number>(value);

  // Normalize angle between -135deg and +135deg (270deg total sweep)
  const range = max - min;
  const normalized = Math.max(0, Math.min(1, (value - min) / range));
  const angle = -135 + normalized * 270;

  const triggerHaptic = () => {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {
      // Haptics fallback on unsupported platforms
    }
  };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, gs) =>
        Math.abs(gs.dx) > 1 || Math.abs(gs.dy) > 1,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        startValRef.current = valRef.current;
      },
      onPanResponderMove: (_, gestureState) => {
        // Dragging UP (-dy) or RIGHT (+dx) turns clockwise (increases value)
        // Dragging DOWN (+dy) or LEFT (-dx) turns counter-clockwise (decreases value)
        const combinedDelta = (-gestureState.dy * 1.0) + (gestureState.dx * 0.8);
        const totalDistance = 130;
        const totalRange = maxRef.current - minRef.current;
        const deltaVal = (combinedDelta / totalDistance) * totalRange;
        const rawNewVal = startValRef.current + deltaVal;
        const currentStep = stepRef.current;
        const steppedVal = Math.round(rawNewVal / currentStep) * currentStep;
        const clampedVal = Math.max(minRef.current, Math.min(maxRef.current, steppedVal));

        if (clampedVal !== valRef.current) {
          triggerHaptic();
          valRef.current = clampedVal;
          onChangeRef.current(clampedVal);
        }
      },
    })
  ).current;

  const handleIncrement = () => {
    const next = Math.min(max, value + step);
    if (next !== value) {
      triggerHaptic();
      onChange(next);
    }
  };

  const handleDecrement = () => {
    const prev = Math.max(min, value - step);
    if (prev !== value) {
      triggerHaptic();
      onChange(prev);
    }
  };

  const formattedValue = value > 0 ? `+${value}` : `${value}`;

  return (
    <View style={styles.container}>
      <Text style={styles.label}>{label}</Text>

      {/* Main Knob Wheel */}
      <View
        style={[
          styles.knobOuter,
          { width: size, height: size, borderRadius: size / 2 },
        ]}
        {...panResponder.panHandlers}
      >
        {/* Glow indicator track */}
        <View
          style={[
            styles.glowTrack,
            {
              borderColor:
                value !== 0 ? accentColor : '#1E232D',
            },
          ]}
        />

        {/* Center Disc with Marker */}
        <View
          style={[
            styles.knobInner,
            {
              width: size - 16,
              height: size - 16,
              borderRadius: (size - 16) / 2,
              transform: [{ rotate: `${angle}deg` }],
            },
          ]}
        >
          {/* Marker notch */}
          <View
            style={[
              styles.marker,
              {
                backgroundColor: '#FFFFFF',
              },
            ]}
          />
        </View>
      </View>

      {/* Numerical Value display with +/- quick step buttons */}
      <View style={styles.valueRow}>
        <TouchableOpacity
          onPress={handleDecrement}
          style={styles.stepButton}
          activeOpacity={0.7}
        >
          <Text style={styles.stepText}>-</Text>
        </TouchableOpacity>

        <Text style={[styles.valueText, { color: accentColor }]}>
          {formattedValue}
          <Text style={styles.unitText}> {unit}</Text>
        </Text>

        <TouchableOpacity
          onPress={handleIncrement}
          style={styles.stepButton}
          activeOpacity={0.7}
        >
          <Text style={styles.stepText}>+</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    marginHorizontal: 12,
  },
  label: {
    color: '#81A1C1',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.2,
    marginBottom: 8,
    textTransform: 'uppercase',
  },
  knobOuter: {
    backgroundColor: '#0D0F14',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: '#191C24',
  },
  glowTrack: {
    position: 'absolute',
    width: '100%',
    height: '100%',
    borderRadius: 999,
    borderWidth: 1.5,
  },
  knobInner: {
    backgroundColor: '#141822',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#222834',
  },
  marker: {
    width: 3,
    height: 10,
    borderRadius: 1.5,
    marginTop: 4,
  },
  valueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
  },
  stepButton: {
    backgroundColor: '#141822',
    borderRadius: 6,
    width: 24,
    height: 24,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#222834',
  },
  stepText: {
    color: '#ECEFF4',
    fontSize: 14,
    fontWeight: 'bold',
    lineHeight: 16,
  },
  valueText: {
    fontSize: 13,
    fontWeight: '800',
    marginHorizontal: 8,
    fontVariant: ['tabular-nums'],
  },
  unitText: {
    fontSize: 10,
    color: '#64748B',
    fontWeight: '600',
  },
});
