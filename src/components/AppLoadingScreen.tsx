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
      <View style={styles.content}>
        {/* Logo MAS Player rond animé sans ombre bleu ciel */}
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

        {/* Section Chargement : Spinner + Mot "Chargement..." */}
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color="#38BDF8" style={styles.spinner} />
          <Text style={styles.loadingText}>{statusText}</Text>
        </View>

        <Text style={styles.subtext}>Initialisation du moteur audio & bibliothèque...</Text>
      </View>
    </Animated.View>
  );
};

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const LOGO_SIZE = Math.min(136, Math.round(SCREEN_WIDTH * 0.34));

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFill,
    backgroundColor: '#07090E',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 99999,
    elevation: 99999,
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
    borderWidth: 1.5,
    borderColor: '#1E293B',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.6,
    shadowRadius: 14,
    elevation: 8,
    backgroundColor: '#090B10',
  },
  logoImage: {
    width: '100%',
    height: '100%',
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 36,
    gap: 10,
  },
  spinner: {
    marginRight: 4,
  },
  loadingText: {
    color: '#F8FAFC',
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: 0.8,
  },
  subtext: {
    color: '#64748B',
    fontSize: 12,
    marginTop: 10,
    textAlign: 'center',
    letterSpacing: 0.3,
  },
});
