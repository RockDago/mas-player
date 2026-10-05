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
  const glowAnim = useRef(new Animated.Value(0.4)).current;

  // Animation de pulsation du logo
  useEffect(() => {
    const pulseLoop = Animated.loop(
      Animated.sequence([
        Animated.parallel([
          Animated.timing(pulseAnim, {
            toValue: 1.05,
            duration: 1200,
            useNativeDriver: true,
          }),
          Animated.timing(glowAnim, {
            toValue: 0.85,
            duration: 1200,
            useNativeDriver: true,
          }),
        ]),
        Animated.parallel([
          Animated.timing(pulseAnim, {
            toValue: 0.98,
            duration: 1200,
            useNativeDriver: true,
          }),
          Animated.timing(glowAnim, {
            toValue: 0.4,
            duration: 1200,
            useNativeDriver: true,
          }),
        ]),
      ])
    );
    pulseLoop.start();

    return () => {
      pulseLoop.stop();
    };
  }, [pulseAnim, glowAnim]);

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
        {/* Halo lumineux en arrière-plan du logo */}
        <Animated.View
          style={[
            styles.glowRing,
            {
              opacity: glowAnim,
              transform: [{ scale: pulseAnim }],
            },
          ]}
        />

        {/* Logo MAS Player animé */}
        <Animated.View
          style={[
            styles.logoWrapper,
            {
              transform: [{ scale: pulseAnim }],
            },
          ]}
        >
          <Image
            source={require('../../assets/mas_icon_square.png')}
            style={styles.logoImage}
            resizeMode="cover"
          />
        </Animated.View>

        {/* Titre & Identité Visuelle */}
        <Text style={styles.brandTitle}>MAS PLAYER</Text>
        <View style={styles.badgeRow}>
          <Text style={styles.badgeText}>HI-RES AUDIOPHILE</Text>
        </View>

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
const LOGO_SIZE = Math.min(130, Math.round(SCREEN_WIDTH * 0.32));

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFill,
    backgroundColor: '#080B10',
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
  glowRing: {
    position: 'absolute',
    top: -15,
    width: LOGO_SIZE + 50,
    height: LOGO_SIZE + 50,
    borderRadius: (LOGO_SIZE + 50) / 2,
    backgroundColor: 'rgba(56, 189, 248, 0.25)',
  },
  logoWrapper: {
    width: LOGO_SIZE,
    height: LOGO_SIZE,
    borderRadius: Math.round(LOGO_SIZE * 0.22),
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: 'rgba(56, 189, 248, 0.4)',
    shadowColor: '#38BDF8',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5,
    shadowRadius: 16,
    elevation: 12,
    backgroundColor: '#0C0D11',
  },
  logoImage: {
    width: '100%',
    height: '100%',
  },
  brandTitle: {
    color: '#FFFFFF',
    fontSize: 24,
    fontWeight: '800',
    letterSpacing: 2.5,
    marginTop: 24,
    textAlign: 'center',
  },
  badgeRow: {
    backgroundColor: '#121620',
    borderColor: '#1E2536',
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 8,
    marginTop: 8,
    marginBottom: 28,
  },
  badgeText: {
    color: '#38BDF8',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.2,
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  spinner: {
    marginRight: 4,
  },
  loadingText: {
    color: '#F1F5F9',
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: 0.8,
  },
  subtext: {
    color: '#64748B',
    fontSize: 12,
    marginTop: 10,
    textAlign: 'center',
  },
});
