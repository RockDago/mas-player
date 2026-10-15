import React, { useEffect, useRef } from 'react';
import {
  StyleSheet,
  View,
  Animated,
  StyleProp,
  ViewStyle,
  ImageSourcePropType,
  Platform,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

export interface AnimeBackgroundProps {
  /** Style d'arrière-plan appliqué sur l'image : 'blur' (flou réglable), 'oled' (contraste noir OLED), 'gradient' (dégradé superposé). */
  backgroundStyle?: 'blur' | 'oled' | 'gradient';
  /** Intensité du flou de l'image : 'low', 'medium', 'deep'. */
  blurIntensity?: 'low' | 'medium' | 'deep';
  /** Saturation des couleurs / accentuation du halo néon bleu. */
  colorSaturation?: boolean;
  /** Respiration animée et pulsation de l'aura. */
  ambientParticles?: boolean;
  /** Opacité personnalisée du calque noir superposé. */
  overlayOpacity?: number;
  /** Opacité minimale lors de la respiration. */
  minOpacity?: number;
  /** Opacité maximale lors de la respiration. */
  maxOpacity?: number;
  /** Durée d'une demi-période de respiration en ms (défaut: 3800). */
  duration?: number;
  /** Activer ou non la respiration animée (défaut: true). */
  animated?: boolean;
  /** Source d'image personnalisée (facultatif, par défaut artwork Solo Leveling officiel). */
  source?: ImageSourcePropType;
  /** Style personnalisé pour le conteneur. */
  style?: StyleProp<ViewStyle>;
}

/**
 * Arrière-plan signature MAS Player (Solo Leveling / Sung Jin-woo aux yeux bleus).
 * NOTRE IMAGE DE FOND RESTE TOUJOURS PRÉSENTE.
 * Les options personnalisent son rendu (flou, contraste OLED ou dégradé superposé).
 */
export const AnimeBackground: React.FC<AnimeBackgroundProps> = ({
  backgroundStyle = 'blur',
  blurIntensity = 'medium',
  colorSaturation = false,
  ambientParticles,
  overlayOpacity,
  minOpacity = 0.36,
  maxOpacity = 0.54,
  duration = 3800,
  animated = true,
  source,
  style,
}) => {
  const isAnimated = ambientParticles !== undefined ? ambientParticles : animated;
  const pulseAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!isAnimated) return;
    const pulseLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 0,
          duration,
          useNativeDriver: true,
        }),
      ])
    );
    pulseLoop.start();

    return () => {
      pulseLoop.stop();
    };
  }, [isAnimated, duration, pulseAnim]);

  // Notre image officielle reste TOUJOURS la base de l'application
  const imageSource = source || require('../../assets/4f2c947ea7f79ad4db4a99c26e6787eb.jpg');

  // Rayon de flou selon le réglage de l'utilisateur
  let blurRadius = 0;
  if (backgroundStyle === 'blur') {
    const blurRadiusMap = {
      low: Platform.OS === 'ios' ? 8 : 6,
      medium: Platform.OS === 'ios' ? 22 : 14,
      deep: Platform.OS === 'ios' ? 42 : 24,
    };
    blurRadius = blurRadiusMap[blurIntensity] || 22;
  }

  // Opacité d'assombrissement selon le style sélectionné
  let baseOverlay = 0.62;
  if (backgroundStyle === 'oled') {
    // Mode OLED : Image conservée avec assombrissement profond pour faire ressortir les contrastes purs
    baseOverlay = 0.78;
  } else if (backgroundStyle === 'gradient') {
    baseOverlay = 0.50;
  } else {
    // Mode blur
    const overlayMap = {
      low: 0.48,
      medium: 0.62,
      deep: 0.76,
    };
    baseOverlay = overlayMap[blurIntensity] || 0.62;
  }

  const finalOverlay = overlayOpacity ?? baseOverlay;

  return (
    <View style={[styles.container, style]} pointerEvents="none">
      {/* 1. NOTRE IMAGE DE FOND OFFICIELLE (TOUJOURS LÀ ET ANIMÉE) */}
      <Animated.Image
        source={imageSource}
        blurRadius={blurRadius}
        style={[
          styles.image,
          isAnimated
            ? {
                opacity: pulseAnim.interpolate({
                  inputRange: [0, 1],
                  outputRange: [minOpacity, maxOpacity],
                }),
                transform: [
                  {
                    scale: pulseAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [1.0, 1.03],
                    }),
                  },
                ],
              }
            : {
                opacity: (minOpacity + maxOpacity) / 2,
              },
        ]}
        resizeMode="cover"
      />

      {/* 2. DÉGRADÉ DYNAMIQUE SUPERPOSÉ SI LE MODE GRADIENT EST SÉLECTIONNÉ */}
      {backgroundStyle === 'gradient' && (
        <LinearGradient
          colors={
            colorSaturation
              ? ['rgba(8, 24, 43, 0.45)', 'rgba(3, 14, 27, 0.72)', 'rgba(0, 0, 0, 0.92)']
              : ['rgba(20, 20, 22, 0.45)', 'rgba(10, 10, 12, 0.75)', 'rgba(0, 0, 0, 0.94)']
          }
          style={StyleSheet.absoluteFillObject}
          start={{ x: 0, y: 0 }}
          end={{ x: 0.8, y: 1 }}
        />
      )}

      {/* 3. CALQUE DE SATURATION ET REHAUSSEMENT NÉON BLEU */}
      {colorSaturation && (
        <View
          style={[
            StyleSheet.absoluteFillObject,
            { backgroundColor: 'rgba(56, 189, 248, 0.10)' },
          ]}
        />
      )}

      {/* 4. CALQUE D'ASSOMBRISSEMENT POUR LA LISIBILITÉ DE L'INTERFACE */}
      <View
        style={[
          StyleSheet.absoluteFillObject,
          { backgroundColor: `rgba(0, 0, 0, ${finalOverlay})` },
        ]}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    overflow: 'hidden',
    backgroundColor: '#000000',
  },
  image: {
    ...StyleSheet.absoluteFillObject,
    width: '100%',
    height: '100%',
  },
});

export default AnimeBackground;
