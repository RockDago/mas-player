import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Animated,
  Easing,
  Image,
  Platform,
  useWindowDimensions,
  TouchableOpacity,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Track } from '../types/audio';
import { beatStore } from '../services/beatStore';

export interface VinylVisualizerProps {
  track?: Track | null;
  isPlaying?: boolean;
  hasTrack?: boolean;
  height?: number;
  onPress?: () => void;
}

export const VinylVisualizer: React.FC<VinylVisualizerProps> = ({
  track,
  isPlaying = false,
  hasTrack = false,
  height: propHeight,
  onPress,
}) => {
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();

  // Calcul dynamique du diamètre selon la hauteur disponible
  const containerHeight = propHeight && propHeight > 0
    ? propHeight
    : Math.min(270, Math.max(170, Math.round(windowHeight * 0.28)));
  
  const discSize = Math.min(containerHeight - 16, Math.min(windowWidth - 48, 250));
  const centerLabelSize = Math.round(discSize * 0.46);
  const centerHoleSize = Math.round(discSize * 0.08);

  // Rotation continue 33 1/3 RPM
  const rotationAnim = useRef(new Animated.Value(0)).current;
  const rotationLoop = useRef<Animated.CompositeAnimation | null>(null);
  const currentAngle = useRef(0);

  // Pulsation réactive au beat (léger bounce dynamique sur les basses)
  const beatScaleAnim = useRef(new Animated.Value(1)).current;

  // Suivi de l'angle courant pour reprise fluide
  useEffect(() => {
    const id = rotationAnim.addListener(({ value }) => {
      currentAngle.current = value;
    });
    return () => rotationAnim.removeListener(id);
  }, [rotationAnim]);

  useEffect(() => {
    if (isPlaying && hasTrack) {
      // Démarre ou poursuit la rotation
      const startSpinning = () => {
        rotationLoop.current = Animated.loop(
          Animated.timing(rotationAnim, {
            toValue: currentAngle.current + 1,
            duration: 3600, // ~1 tour toutes les 3.6 secondes (vitesse 33 RPM fidèle)
            easing: Easing.linear,
            useNativeDriver: Platform.OS !== 'web',
          })
        );
        rotationLoop.current.start();
      };

      startSpinning();
    } else {
      // Pause : décélération douce
      if (rotationLoop.current) {
        rotationLoop.current.stop();
        rotationLoop.current = null;
      }
    }

    return () => {
      if (rotationLoop.current) {
        rotationLoop.current.stop();
        rotationLoop.current = null;
      }
    };
  }, [isPlaying, hasTrack]);

  // Boucle de pulsation au rythme des basses
  useEffect(() => {
    let animId: number | null = null;
    let cancelled = false;

    const tick = () => {
      if (cancelled) return;
      if (isPlaying && hasTrack) {
        const { pulse } = beatStore.read();
        const targetScale = 1.0 + Math.min(0.045, pulse * 0.04);
        Animated.spring(beatScaleAnim, {
          toValue: targetScale,
          friction: 6,
          tension: 100,
          useNativeDriver: Platform.OS !== 'web',
        }).start();
      } else {
        Animated.timing(beatScaleAnim, {
          toValue: 1.0,
          duration: 200,
          useNativeDriver: Platform.OS !== 'web',
        }).start();
      }
      animId = requestAnimationFrame(tick);
    };

    animId = requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      if (animId !== null) cancelAnimationFrame(animId);
    };
  }, [isPlaying, hasTrack]);

  const rotateInterpolate = rotationAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  const artworkUri = track?.artwork && track.artwork.trim() !== '' ? track.artwork : null;

  return (
    <TouchableOpacity
      activeOpacity={0.9}
      onPress={onPress}
      style={[styles.container, { height: containerHeight }]}
    >
      <Animated.View
        style={[
          styles.discShadowWrap,
          {
            width: discSize,
            height: discSize,
            transform: [{ scale: beatScaleAnim }],
          },
        ]}
      >
        <Animated.View
          style={[
            styles.vinylDisc,
            {
              width: discSize,
              height: discSize,
              borderRadius: discSize / 2,
              transform: [{ rotate: rotateInterpolate }],
            },
          ]}
        >
          {/* Sillons du vinyle (rainures concentriques réalistes) */}
          <View style={[styles.grooveRing, { width: discSize * 0.92, height: discSize * 0.92, borderRadius: (discSize * 0.92) / 2 }]} />
          <View style={[styles.grooveRing, { width: discSize * 0.82, height: discSize * 0.82, borderRadius: (discSize * 0.82) / 2 }]} />
          <View style={[styles.grooveRing, { width: discSize * 0.72, height: discSize * 0.72, borderRadius: (discSize * 0.72) / 2 }]} />
          <View style={[styles.grooveRing, { width: discSize * 0.62, height: discSize * 0.62, borderRadius: (discSize * 0.62) / 2 }]} />
          <View style={[styles.grooveRing, { width: discSize * 0.54, height: discSize * 0.54, borderRadius: (discSize * 0.54) / 2 }]} />

          {/* Reflets de lumière vinyle (Specular Sheen) */}
          <View style={[styles.specularShine, { width: discSize, height: discSize }]} pointerEvents="none" />
          <View style={[styles.specularShineInverted, { width: discSize, height: discSize }]} pointerEvents="none" />

          {/* Macaron / Étiquette centrale (Album Art) */}
          <View
            style={[
              styles.centerLabel,
              {
                width: centerLabelSize,
                height: centerLabelSize,
                borderRadius: centerLabelSize / 2,
              },
            ]}
          >
            {artworkUri ? (
              <Image
                source={{ uri: artworkUri }}
                style={[
                  styles.labelImage,
                  {
                    width: centerLabelSize,
                    height: centerLabelSize,
                    borderRadius: centerLabelSize / 2,
                  },
                ]}
                resizeMode="cover"
              />
            ) : (
              <View style={styles.fallbackLabel}>
                <MaterialCommunityIcons name="music-note" size={24} color="#FFFFFF" />
                <Text numberOfLines={1} style={styles.fallbackLabelText}>
                  {track?.title ? track.title.substring(0, 14) : 'MAS AUDIO'}
                </Text>
                <Text style={styles.fallbackRpmText}>33 ⅓ RPM</Text>
              </View>
            )}

            {/* Trou central du vinyle avec bague argentée */}
            <View
              style={[
                styles.spindleHoleRing,
                {
                  width: centerHoleSize + 4,
                  height: centerHoleSize + 4,
                  borderRadius: (centerHoleSize + 4) / 2,
                },
              ]}
            >
              <View
                style={[
                  styles.spindleHole,
                  {
                    width: centerHoleSize,
                    height: centerHoleSize,
                    borderRadius: centerHoleSize / 2,
                  },
                ]}
              />
            </View>
          </View>
        </Animated.View>
      </Animated.View>
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  container: {
    width: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    position: 'relative',
  },
  discShadowWrap: {
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.85,
    shadowRadius: 18,
    elevation: 16,
  },
  vinylDisc: {
    backgroundColor: '#0c0d10',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: '#22252c',
    position: 'relative',
    overflow: 'hidden',
  },
  grooveRing: {
    position: 'absolute',
    borderWidth: 0.6,
    borderColor: 'rgba(255, 255, 255, 0.06)',
  },
  specularShine: {
    position: 'absolute',
    top: 0,
    left: 0,
    backgroundColor: 'transparent',
    borderTopWidth: 2,
    borderTopColor: 'rgba(255, 255, 255, 0.12)',
    borderBottomWidth: 2,
    borderBottomColor: 'rgba(255, 255, 255, 0.08)',
    transform: [{ rotate: '45deg' }],
  },
  specularShineInverted: {
    position: 'absolute',
    top: 0,
    left: 0,
    backgroundColor: 'transparent',
    borderLeftWidth: 1.5,
    borderLeftColor: 'rgba(255, 255, 255, 0.07)',
    borderRightWidth: 1.5,
    borderRightColor: 'rgba(255, 255, 255, 0.05)',
    transform: [{ rotate: '-45deg' }],
  },
  centerLabel: {
    backgroundColor: '#1E293B',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#334155',
    overflow: 'hidden',
    position: 'relative',
  },
  labelImage: {
    position: 'absolute',
    top: 0,
    left: 0,
  },
  fallbackLabel: {
    justifyContent: 'center',
    alignItems: 'center',
    padding: 6,
  },
  fallbackLabelText: {
    color: '#F8FAFC',
    fontSize: 9,
    fontWeight: '700',
    marginTop: 2,
    letterSpacing: 0.5,
    textAlign: 'center',
  },
  fallbackRpmText: {
    color: '#94A3B8',
    fontSize: 7,
    fontWeight: '600',
    marginTop: 1,
    letterSpacing: 1,
  },
  spindleHoleRing: {
    position: 'absolute',
    backgroundColor: '#64748B',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 0.8,
    borderColor: '#94A3B8',
  },
  spindleHole: {
    backgroundColor: '#090A0F',
  },
});
