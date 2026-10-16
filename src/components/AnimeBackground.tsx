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
  /** Style d'arrière-plan appliqué : 'oled' (noir pur absolu #000000), 'blur' (pochette floutée si disponible), 'gradient' (dégradé neutre). */
  backgroundStyle?: 'blur' | 'oled' | 'gradient';
  /** Intensité du flou de l'image : 'low', 'medium', 'deep'. */
  blurIntensity?: 'low' | 'medium' | 'deep';
  /** Saturation des couleurs / accentuation. */
  colorSaturation?: boolean;
  /** Respiration animée de la pochette. */
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
  /** Source d'image personnalisée (facultatif, ex: pochette d'album). */
  source?: ImageSourcePropType;
  /** Style personnalisé pour le conteneur. */
  style?: StyleProp<ViewStyle>;
}

/**
 * Arrière-plan MAS Player :
 * - Mode 'oled' (par défaut) ou absence de pochette : NOIR ABSOLU PUR (#000000).
 * - Tout bleu ou image imposée a été retiré.
 * - Si une pochette de morceau est fournie et que le mode n'est pas 'oled', elle peut être affichée en flou subtil.
 */
export const AnimeBackground: React.FC<AnimeBackgroundProps> = ({
  backgroundStyle = 'oled',
  blurIntensity = 'medium',
  colorSaturation = false,
  ambientParticles = false,
  overlayOpacity,
  minOpacity = 0.35,
  maxOpacity = 0.55,
  duration = 3800,
  animated = false,
  source,
  style,
}) => {
  const isAnimated = (ambientParticles || animated) && Boolean(source);
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

  // Si mode OLED ou aucune source d'image fournie : NOIR ABSOLU PUR garanti (#000000)
  if (backgroundStyle === 'oled' || !source) {
    return <View style={[styles.container, style]} pointerEvents="none" />;
  }

  // Rayon de flou selon le réglage de l'utilisateur
  let blurRadius = 0;
  if (backgroundStyle === 'blur') {
    const blurRadiusMap = {
      low: Platform.OS === 'ios' ? 12 : 8,
      medium: Platform.OS === 'ios' ? 24 : 16,
      deep: Platform.OS === 'ios' ? 44 : 28,
    };
    blurRadius = blurRadiusMap[blurIntensity] ?? 16;
  }

  let baseOverlay = 0.65;
  if (backgroundStyle === 'gradient') {
    baseOverlay = 0.55;
  } else {
    const overlayMap = {
      low: 0.50,
      medium: 0.65,
      deep: 0.78,
    };
    baseOverlay = overlayMap[blurIntensity] ?? 0.65;
  }

  const finalOverlay = overlayOpacity ?? baseOverlay;

  return (
    <View style={[styles.container, style]} pointerEvents="none">
      {/* Pochette de l'album en arrière-plan */}
      <Animated.Image
        source={source}
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

      {/* Dégradé sombre neutre (aucun bleu) */}
      {backgroundStyle === 'gradient' && (
        <LinearGradient
          colors={['rgba(15, 15, 18, 0.45)', 'rgba(8, 8, 10, 0.75)', 'rgba(0, 0, 0, 0.95)']}
          style={StyleSheet.absoluteFill}
          start={{ x: 0, y: 0 }}
          end={{ x: 0.8, y: 1 }}
        />
      )}

      {/* Calque d'assombrissement pour contraste noir */}
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
