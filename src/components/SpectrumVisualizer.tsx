import React, { useEffect, useRef, useState } from 'react';
import { View, StyleSheet, Dimensions } from 'react-native';

interface SpectrumProps {
  isPlaying: boolean;
  bassGain?: number;
  trebleGain?: number;
  barCount?: number;
}

export const SpectrumVisualizer: React.FC<SpectrumProps> = ({
  isPlaying,
  bassGain = 0,
  trebleGain = 0,
  barCount = 28,
}) => {
  const [heights, setHeights] = useState<number[]>(
    Array(barCount).fill(6)
  );
  const animationFrame = useRef<number | null>(null);

  useEffect(() => {
    let phase = 0;

    const updateSpectrum = () => {
      phase += 0.12;

      setHeights(() => {
        return Array.from({ length: barCount }, (_, index) => {
          if (!isPlaying) {
            return 4 + Math.sin(phase * 0.5 + index * 0.2) * 2;
          }

          // Ratio: 0 = deepest bass, 1 = highest treble
          const ratio = index / (barCount - 1);
          let eqModifier = 1;

          if (ratio < 0.35) {
            // Bass zone modifier
            eqModifier += (bassGain / 12) * 0.55;
          } else if (ratio > 0.65) {
            // Treble zone modifier
            eqModifier += (trebleGain / 12) * 0.45;
          }

          // Combined sine wave harmonics for lively dancing visualizer
          const wave1 = Math.sin(phase * 2.2 + index * 0.45);
          const wave2 = Math.cos(phase * 1.5 - index * 0.3);
          const noise = (Math.random() - 0.5) * 0.3;

          const rawIntensity = Math.abs(wave1 * 0.6 + wave2 * 0.4 + noise);
          const computedHeight = Math.max(
            5,
            Math.min(52, rawIntensity * 48 * Math.max(0.4, eqModifier))
          );
          return computedHeight;
        });
      });

      animationFrame.current = requestAnimationFrame(updateSpectrum);
    };

    animationFrame.current = requestAnimationFrame(updateSpectrum);

    return () => {
      if (animationFrame.current !== null) {
        cancelAnimationFrame(animationFrame.current);
      }
    };
  }, [isPlaying, bassGain, trebleGain, barCount]);

  return (
    <View style={styles.container}>
      <View style={styles.barsContainer}>
        {heights.map((h, i) => {
          const ratio = i / barCount;
          // Gradient tone: Cyan for bass, Aqua/Blue for mid, Violet/Pink for treble
          const barColor =
            ratio < 0.35
              ? '#00E5FF' // Electric Cyan
              : ratio < 0.7
              ? '#3D8BFF' // Deep Cobalt Blue
              : '#A855F7'; // Neon Purple

          return (
            <View
              key={i}
              style={[
                styles.bar,
                {
                  height: h,
                  backgroundColor: barColor,
                  shadowColor: barColor,
                },
              ]}
            />
          );
        })}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    height: 60,
    width: '100%',
    justifyContent: 'flex-end',
    paddingHorizontal: 16,
    marginVertical: 8,
  },
  barsContainer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    height: 52,
  },
  bar: {
    width: Dimensions.get('window').width / 42,
    borderRadius: 3,
    shadowOffset: { width: 0, height: -1 },
    shadowOpacity: 0.7,
    shadowRadius: 3,
    elevation: 3,
  },
});
