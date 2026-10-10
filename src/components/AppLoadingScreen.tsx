import React, { useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Animated,
  ActivityIndicator,
  Image,
  Dimensions,
  Platform,
} from 'react-native';

interface AppLoadingScreenProps {
  visible: boolean;
  statusText?: string;
  onFinish?: () => void;
}

/**
 * Écran de chargement et démarrage officiel MAS Player.
 * Affiche le logo de l'application avec un halo néon pulsant,
 * le titre de l'application, l'indicateur de chargement et le mot "Chargement...".
 */
export const AppLoadingScreen: React.FC<AppLoadingScreenProps> = ({
  visible,
  statusText = 'Chargement...',
  onFinish,
}) => {
  const fadeAnim = useRef(new Animated.Value(1)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;

  // Animation de pulsation du logo
  useEffect(() => {
    const pulseLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.04,
          duration: 1200,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 0.98,
          duration: 1200,
          useNativeDriver: true,
        }),
      ])
    );
    pulseLoop.start();

    return () => {
      pulseLoop.stop();
    };
  }, [pulseAnim]);

  // Fondu de sortie quand le chargement est terminé
  useEffect(() => {
    if (!visible) {
      Animated.timing(fadeAnim, {
        toValue: 0,
        duration: 400,
        useNativeDriver: true,
      }).start(() => {
        onFinish?.();
      });
    }
  }, [visible, fadeAnim, onFinish]);

  return (
    <Animated.View
      style={[
        styles.container,
        {
          opacity: fadeAnim,
        },
      ]}
      pointerEvents={visible ? 'auto' : 'none'}
    >
      {/* Background artwork du Monarque de l'Ombre */}
      <Image
        source={require('../../assets/94b2251aac48c727fbc774cd57da9714.jpg')}
        style={StyleSheet.absoluteFill}
        resizeMode="cover"
      />
      <View style={styles.darkBackdrop} />

      <View style={styles.content}>
        {/* Blason animé */}
        <Animated.View
          style={[
            styles.logoWrapper,
            {
              transform: [{ scale: pulseAnim }],
            },
          ]}
        >
          <Image
            source={require('../../assets/mas_logo_circle.png')}
            style={styles.logoImage}
            resizeMode="cover"
          />
        </Animated.View>

        {/* Titre animé */}
        <View style={styles.titleContainer}>
          <Text style={styles.appTitle}>MAS PLAYER</Text>
        </View>

        {/* Section Chargement : Spinner néon + Statut */}
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color="#00f0ff" style={styles.spinner} />
          <Text style={styles.loadingText}>{statusText}</Text>
        </View>

      </View>
    </Animated.View>
  );
};

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const LOGO_SIZE = Math.min(136, Math.round(SCREEN_WIDTH * 0.34));

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFill,
    backgroundColor: '#040711',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 99999,
    elevation: 99999,
  },
  darkBackdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(3, 7, 18, 0.78)',
  },
  content: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  logoWrapper: {
    width: LOGO_SIZE,
    height: LOGO_SIZE,
    borderRadius: LOGO_SIZE / 2,
    overflow: 'hidden',
    backgroundColor: '#050a18',
  },
  logoImage: {
    width: '100%',
    height: '100%',
  },
  titleContainer: {
    alignItems: 'center',
    marginTop: 22,
  },
  appTitle: {
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: '900',
    letterSpacing: 3,
    textShadowColor: 'rgba(0, 212, 255, 0.8)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 12,
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 28,
    gap: 10,
    backgroundColor: 'rgba(10, 16, 32, 0.75)',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(0, 212, 255, 0.25)',
  },
  spinner: {
    marginRight: 4,
  },
  loadingText: {
    color: '#E0F2FE',
    fontSize: 14.5,
    fontWeight: '700',
    letterSpacing: 0.8,
  },
  subtext: {
    color: '#7DD3FC',
    fontSize: 11.5,
    marginTop: 14,
    textAlign: 'center',
    letterSpacing: 0.5,
    opacity: 0.85,
  },
});
