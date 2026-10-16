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

const DEFAULT_ANIME_IMAGE = require('../../assets/4f2c947ea7f79ad4db4a99c26e6787eb.jpg');

export interface AnimeBackgroundProps {
  /** Style d'arrière-plan appliqué : 'oled' (contraste noir profond), 'blur' (flou réglable), 'gradient' (dégradé neutre). */
  backgroundStyle?: 'blur' | 'oled' | 'gradient';
  /** Intensité du flou de l'image : 'low', 'medium', 'deep'. */
  blurIntensity?: 'low' | 'medium' | 'deep';
  /** Saturation des couleurs (maintenu sans teinte colorée superposée). */
  colorSaturation?: boolean;
  /** Respiration animée de l'artwork. */
  ambientParticles?: boolean;
  /** Opacité personnalisée du calque noir superposé. */
  overlayOpacity?: number;
  /** Opacité minimale lors de la respiration. */
  minOpacity?: number;
  /** Opacité maximale lors de la respiration. */
  maxOpacity?: number;
  /** Durée d'une demi-période de respiration en ms (défaut: 3800). */
  duration?: number;
  /** Activer ou non la respiration animée (défaut: false). */
  animated?: boolean;
  /** Source d'image personnalisée (par défaut : artwork anime officiel). */
  source?: ImageSourcePropType;
  /** Style personnalisé pour le conteneur. */
  style?: StyleProp<ViewStyle>;
}

/**
 * Arrière-plan signature MAS Player (Artwork anime officiel 4f2c947ea7f79ad4db4a99c26e6787eb.jpg) :
 * - L'image d'anime est TOUJOURS conservée en arrière-plan.
 * - AUCUNE couleur artificielle ajoutée (aucun voile bleu, aucun filtre coloré).
 * - Calques de contraste neutres noirs (#000000 / rgba(0, 0, 0, x)) pour garantir une lisibilité parfaite.
 */
export const AnimeBackground: React.FC<AnimeBackgroundProps> = ({
  backgroundStyle = 'oled',
  blurIntensity = 'medium',
  colorSaturation = false,
  ambientParticles = false,
  overlayOpacity,
  minOpacity = 0.45,
  maxOpacity = 0.65,
  duration = 3800,
  animated = false,
  source,
  style,
}) => {
  const isAnimated = ambientParticles || animated;
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

  // L'artwork officiel de l'animé est toujours la référence conservée
  const imageSource = source || DEFAULT_ANIME_IMAGE;

  // Rayon de flou selon le réglage de l'utilisateur
  let blurRadius = 0;
  if (backgroundStyle === 'blur') {
    const blurRadiusMap = {
      low: 0,
      medium: Platform.OS === 'ios' ? 4 : 2,
      deep: Platform.OS === 'ios' ? 12 : 8,
    };
    blurRadius = blurRadiusMap[blurIntensity] ?? 2;
  }

  // Assombrissement neutre noir (sans ajout de couleur)
  let baseOverlay = 0.40;
  if (backgroundStyle === 'oled') {
    baseOverlay = 0.52;
  } else if (backgroundStyle === 'gradient') {
    baseOverlay = 0.35;
  } else {
    const overlayMap = {
      low: 0.28,
      medium: 0.40,
      deep: 0.55,
    };
    baseOverlay = overlayMap[blurIntensity] ?? 0.40;
  }

  const finalOverlay = overlayOpacity ?? baseOverlay;

  return (
    <View style={[styles.container, style]} pointerEvents="none">
      {/* 1. L'image de l'animé conservée en fond */}
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
                      outputRange: [1.0, 1.02],
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

      {/* 2. Dégradé sombre neutre (uniquement noir/transparence, AUCUNE couleur) */}
      {backgroundStyle === 'gradient' && (
        <LinearGradient
          colors={['rgba(0, 0, 0, 0.35)', 'rgba(0, 0, 0, 0.65)', 'rgba(0, 0, 0, 0.95)']}
          style={StyleSheet.absoluteFill}
          start={{ x: 0, y: 0 }}
          end={{ x: 0.8, y: 1 }}
        />
      )}

      {/* 3. Calque noir pour lisibilité et contraste OLED (AUCUNE couleur ajoutée) */}
      <View
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: `rgba(0, 0, 0, ${finalOverlay})` },
        ]}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    overflow: 'hidden',
    backgroundColor: '#000000',
    zIndex: 0,
  },
  image: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: '100%',
    height: '100%',
  },
});

export default AnimeBackground;
