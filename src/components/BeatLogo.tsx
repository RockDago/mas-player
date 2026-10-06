import React, { useEffect, useRef, useMemo } from 'react';
import { View, Animated, StyleSheet, Image, useWindowDimensions, Platform, AppState } from 'react-native';
import { beatStore } from '../services/beatStore';

interface BeatLogoProps {
  size?: number;
}

/**
 * Logo MAS Player officiel, animé et réactif en temps réel au rythme de la musique.
 *
 * S'adapte dynamiquement à la taille de l'écran (smartphone compact, grand écran, tablette).
 * Utilise la boucle ultra-légère synchronisée avec `beatStore` (60 fps direct sans re-render React).
 */
export const BeatLogo: React.FC<BeatLogoProps> = ({ size: propSize }) => {
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();

  // Calcul adaptatif : prend en compte la largeur ET la hauteur disponible
  const logoSize = useMemo(() => {
    if (propSize && propSize > 0) return propSize;
    // Sur petits écrans verticaux (Android 16:9 / 18:9), on borne par la hauteur pour ne pas étouffer les contrôles
    const maxByHeight = Math.round(windowHeight * 0.22);
    const maxByWidth = Math.round(windowWidth * 0.46);
    return Math.min(205, Math.max(115, Math.min(maxByWidth, maxByHeight)));
  }, [propSize, windowWidth, windowHeight]);

  const containerRef = useRef<any>(null);
  const glowRef = useRef<any>(null);
  const ring1Ref = useRef<any>(null);
  const ring2Ref = useRef<any>(null);
  const breathRef = useRef(0);

  useEffect(() => {
    let rafId: number | null = null;
    let cancelled = false;

    const stopLoop = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    };

    const startLoop = () => {
      if (cancelled || rafId !== null) return;
      if (Platform.OS !== 'web' && AppState.currentState !== 'active') return;
      rafId = requestAnimationFrame(tick);
    };

    const tick = () => {
      if (cancelled) return;
      if (Platform.OS !== 'web' && AppState.currentState !== 'active') {
        rafId = null;
        return;
      }

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

    startLoop();

    const appStateSub = Platform.OS !== 'web'
      ? AppState.addEventListener('change', (state) => {
          if (state === 'active') {
            startLoop();
          } else {
            stopLoop();
          }
        })
      : null;

    return () => {
      cancelled = true;
      stopLoop();
      appStateSub?.remove();
    };
  }, []);

  // Dimensions proportionnelles fluides
  const radius = Math.round(logoSize * 0.18);
  const ring1Size = logoSize + Math.round(logoSize * 0.18);
  const ring2Size = logoSize + Math.round(logoSize * 0.36);
  const glowSize = logoSize + Math.round(logoSize * 0.22);
  const wrapperSize = logoSize + Math.round(logoSize * 0.38);

  return (
    <View style={[styles.wrapper, { width: wrapperSize, height: wrapperSize }]}>
      {/* Anneaux d'ondes acoustiques réactives */}
      <View
        ref={ring2Ref}
        style={[
          styles.waveRing,
          styles.waveRingOuter,
          { width: ring2Size, height: ring2Size, borderRadius: ring2Size / 2 },
        ]}
      />
      <View
        ref={ring1Ref}
        style={[
          styles.waveRing,
          styles.waveRingInner,
          { width: ring1Size, height: ring1Size, borderRadius: ring1Size / 2 },
        ]}
      />

      {/* Halo néon violet / cyan / ambre derrière le logo */}
      <View
        ref={glowRef}
        style={[
          styles.ambientGlow,
          { width: glowSize, height: glowSize, borderRadius: glowSize / 2 },
        ]}
      />

      {/* Badge central du logo MAS Player */}
      <Animated.View
        ref={containerRef}
        style={[
          styles.logoContainer,
          {
            width: logoSize,
            height: logoSize,
            borderRadius: radius,
          },
        ]}
      >
        <Image
          source={require('../../assets/mas_icon_square.png')}
          style={[styles.logoImage, { borderRadius: radius }]}
          resizeMode="cover"
        />
        {/* Bordure subtile en verre néon */}
        <View style={[styles.neonBorderOverlay, { borderRadius: radius }]} />
      </Animated.View>
    </View>
  );
};

const styles = StyleSheet.create({
  wrapper: {
    justifyContent: 'center',
    alignItems: 'center',
    position: 'relative',
  },
  ambientGlow: {
    position: 'absolute',
    backgroundColor: '#7C3AED',
    opacity: 0.4,
    shadowColor: '#38BDF8',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.9,
    shadowRadius: 35,
    elevation: 20,
    pointerEvents: 'none',
    ...(Platform.OS === 'web'
      ? ({
          filter: 'blur(30px)',
          backgroundImage:
            'radial-gradient(circle, rgba(56, 189, 248, 0.45) 0%, rgba(139, 92, 246, 0.35) 45%, rgba(249, 115, 22, 0.2) 75%, transparent 100%)',
        } as any)
      : {}),
  },
  waveRing: {
    position: 'absolute',
    borderWidth: 1.5,
    pointerEvents: 'none',
  },
  waveRingInner: {
    borderColor: 'rgba(56, 189, 248, 0.45)',
    borderStyle: 'solid',
  },
  waveRingOuter: {
    borderColor: 'rgba(168, 85, 247, 0.3)',
    borderStyle: 'solid',
  },
  logoContainer: {
    overflow: 'hidden',
    backgroundColor: '#0A0C10',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.7,
    shadowRadius: 20,
    elevation: 15,
    pointerEvents: 'none',
  },
  logoImage: {
    width: '100%',
    height: '100%',
  },
  neonBorderOverlay: {
    ...StyleSheet.absoluteFill,
    borderWidth: 1.2,
    borderColor: 'rgba(255, 255, 255, 0.15)',
    pointerEvents: 'none',
  },
});
