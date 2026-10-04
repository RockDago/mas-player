import React, { useEffect, useRef } from 'react';
import { View, Animated, StyleSheet, Image, Dimensions, Platform } from 'react-native';
import { beatStore } from '../services/beatStore';

const { width: windowWidth } = Dimensions.get('window');
const LOGO_SIZE = Math.min(210, Math.max(160, Math.round(windowWidth * 0.5)));

/**
 * Logo MAS Player officiel, animé et réactif en temps réel au rythme de la musique.
 *
 * Utilise la boucle ultra-légère synchronisée avec `beatStore` (60 fps direct sans re-render React).
 */
export const BeatLogo: React.FC = () => {
  const containerRef = useRef<any>(null);
  const glowRef = useRef<any>(null);
  const ring1Ref = useRef<any>(null);
  const ring2Ref = useRef<any>(null);
  const breathRef = useRef(0);

  useEffect(() => {
    let rafId: number;
    let cancelled = false;

    const tick = () => {
      if (cancelled) return;

      const { pulse, energy } = beatStore.read();
      breathRef.current += 0.02;

      // Respiration douce au repos
      const idleBreath = Math.sin(breathRef.current) * 0.015;
      const beatScale = 1 + idleBreath + pulse * 0.07;

      // Anneau 1 d'onde acoustique
      const r1Scale = 1 + idleBreath * 0.5 + pulse * 0.14;
      const r1Opacity = Math.min(0.85, 0.15 + pulse * 0.65 + energy * 0.15);

      // Anneau 2 d'onde acoustique plus large
      const r2Scale = 1 + idleBreath * 0.3 + pulse * 0.24;
      const r2Opacity = Math.min(0.65, 0.08 + pulse * 0.45 + energy * 0.1);

      // Halo lumineux derrière le logo
      const glowOpacity = Math.min(0.9, 0.3 + pulse * 0.5 + energy * 0.25);

      if (containerRef.current) {
        containerRef.current.setNativeProps?.({
          style: {
            transform: [{ scale: beatScale }],
          },
        });
      }

      if (glowRef.current) {
        glowRef.current.setNativeProps?.({
          style: {
            opacity: glowOpacity,
            transform: [{ scale: 1 + pulse * 0.1 }],
          },
        });
      }

      if (ring1Ref.current) {
        ring1Ref.current.setNativeProps?.({
          style: {
            opacity: r1Opacity,
            transform: [{ scale: r1Scale }],
          },
        });
      }

      if (ring2Ref.current) {
        ring2Ref.current.setNativeProps?.({
          style: {
            opacity: r2Opacity,
            transform: [{ scale: r2Scale }],
          },
        });
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
    };
  }, []);

  return (
    <View style={styles.wrapper}>
      {/* Anneaux d'ondes acoustiques réactives (inspirées des ondes du logo MAS) */}
      <View
        ref={ring2Ref}
        style={[styles.waveRing, styles.waveRingOuter]}
        pointerEvents="none"
      />
      <View
        ref={ring1Ref}
        style={[styles.waveRing, styles.waveRingInner]}
        pointerEvents="none"
      />

      {/* Halo néon violet / cyan / ambre derrière le logo */}
      <View
        ref={glowRef}
        style={styles.ambientGlow}
        pointerEvents="none"
      />

      {/* Badge central du logo MAS Player */}
      <Animated.View
        ref={containerRef}
        style={styles.logoContainer}
        pointerEvents="none"
      >
        <Image
          source={require('../../assets/mas_icon_square.png')}
          style={styles.logoImage}
          resizeMode="cover"
        />
        {/* Bordure subtile en verre néon */}
        <View style={styles.neonBorderOverlay} />
      </Animated.View>
    </View>
  );
};

const styles = StyleSheet.create({
  wrapper: {
    width: LOGO_SIZE + 70,
    height: LOGO_SIZE + 70,
    justifyContent: 'center',
    alignItems: 'center',
    position: 'relative',
  },
  ambientGlow: {
    position: 'absolute',
    width: LOGO_SIZE + 40,
    height: LOGO_SIZE + 40,
    borderRadius: (LOGO_SIZE + 40) / 2,
    backgroundColor: '#7C3AED',
    opacity: 0.4,
    shadowColor: '#38BDF8',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.9,
    shadowRadius: 35,
    elevation: 20,
    ...(Platform.OS === 'web'
      ? {
          filter: 'blur(30px)',
          background: 'radial-gradient(circle, rgba(56, 189, 248, 0.45) 0%, rgba(139, 92, 246, 0.35) 45%, rgba(249, 115, 22, 0.2) 75%, transparent 100%)',
        }
      : {}),
  },
  waveRing: {
    position: 'absolute',
    borderRadius: 9999,
    borderWidth: 1.5,
  },
  waveRingInner: {
    width: LOGO_SIZE + 32,
    height: LOGO_SIZE + 32,
    borderColor: 'rgba(56, 189, 248, 0.45)',
    borderStyle: 'solid',
  },
  waveRingOuter: {
    width: LOGO_SIZE + 64,
    height: LOGO_SIZE + 64,
    borderColor: 'rgba(168, 85, 247, 0.3)',
    borderStyle: 'solid',
  },
  logoContainer: {
    width: LOGO_SIZE,
    height: LOGO_SIZE,
    borderRadius: 36,
    overflow: 'hidden',
    backgroundColor: '#0A0C10',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.7,
    shadowRadius: 20,
    elevation: 15,
  },
  logoImage: {
    width: '100%',
    height: '100%',
    borderRadius: 36,
  },
  neonBorderOverlay: {
    ...StyleSheet.absoluteFill,
    borderRadius: 36,
    borderWidth: 1.2,
    borderColor: 'rgba(255, 255, 255, 0.15)',
    pointerEvents: 'none',
  },
});
