import React from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Platform,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Ionicons, MaterialCommunityIcons, Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useScreenInsets, insetPadding } from '../theme/insets';
import { APP_VERSION, APP_NAME, APP_AUTHOR, APP_COPYRIGHT } from '../constants/version';
import { getTranslation, LanguageCode } from '../i18n/translations';

export const POWERAMP_TEAL = '#FFFFFF';

interface AboutModalProps {
  visible: boolean;
  onClose: () => void;
  language?: LanguageCode;
  onOpenChangelog?: () => void;
}

export const AboutModal: React.FC<AboutModalProps> = ({
  visible,
  onClose,
  language = 'fr',
  onOpenChangelog,
}) => {
  const insets = useScreenInsets();
  const t = (key: string, fallback?: string): string =>
    getTranslation(language, key, fallback);

  const handleClose = () => {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {}
    onClose();
  };

  const handleChangelogPress = () => {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {}
    onOpenChangelog?.();
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      statusBarTranslucent={true}
      onRequestClose={handleClose}
    >
      <StatusBar style="light" />
      <View style={styles.overlay}>
        {/* Backdrop pour fermer au toucher en dehors */}
        <TouchableOpacity
          style={styles.backdropTouch}
          activeOpacity={1}
          onPress={handleClose}
        />

        {/* Boîte de dialogue À propos - BottomSheet identique au Changelog */}
        <View
          style={[
            styles.dialogBox,
            {
              paddingBottom: insetPadding(insets, 'bottom', 18),
            },
          ]}
        >
          {/* Poignée indicatrice de glissement */}
          <View style={styles.dragHandleBar} />

          {/* En-tête */}
          <View style={styles.headerRow}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Text style={styles.titleText}>{t('cat_about_title')}</Text>
              <View style={styles.versionBadge}>
                <Text style={styles.versionBadgeText}>v{APP_VERSION}</Text>
              </View>
            </View>

            <TouchableOpacity
              onPress={handleClose}
              style={styles.closeIconBtn}
              activeOpacity={0.7}
            >
              <Ionicons name="close" size={22} color="#94A3B8" />
            </TouchableOpacity>
          </View>

          {/* Contenu défilant */}
          <ScrollView
            style={styles.scrollArea}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={true}
            indicatorStyle="white"
          >
            {/* Carte Hero d'identité */}
            <View style={styles.heroCard}>
              <View style={styles.heroTitleRow}>
                <Text style={styles.heroTitle}>{APP_NAME}</Text>
                <View style={styles.proBadge}>
                  <Text style={styles.proBadgeText}>PRO RELEASE</Text>
                </View>
              </View>
              <Text style={styles.heroTagline}>{t('aboutAppTagline')}</Text>
            </View>

            {/* Section Description */}
            <View style={styles.sectionBlock}>
              <Text style={styles.sectionTitle}>À propos de {APP_NAME}</Text>
              <Text style={styles.descriptionText}>{t('aboutAppDescription')}</Text>

              {/* Pastilles technologiques */}
              <View style={styles.pillsRow}>
                <View style={styles.techPill}>
                  <MaterialCommunityIcons name="waveform" size={13} color={POWERAMP_TEAL} />
                  <Text style={styles.techPillText}>32-Bit Float DSP</Text>
                </View>
                <View style={styles.techPill}>
                  <Ionicons name="hardware-chip-outline" size={13} color={POWERAMP_TEAL} />
                  <Text style={styles.techPillText}>Hi-Res 96kHz</Text>
                </View>
                <View style={styles.techPill}>
                  <MaterialCommunityIcons name="equalizer" size={13} color={POWERAMP_TEAL} />
                  <Text style={styles.techPillText}>10-Band EQ</Text>
                </View>
                <View style={styles.techPill}>
                  <MaterialCommunityIcons name="shield-check-outline" size={13} color={POWERAMP_TEAL} />
                  <Text style={styles.techPillText}>Zero Distortion</Text>
                </View>
              </View>
            </View>

            {/* Spécifications Audio & Moteur DSP */}
            <View style={styles.specsCard}>
              <Text style={styles.specsCardTitle}>{t('aboutSpecsTitle')}</Text>
              <View style={styles.specRow}>
                <Text style={styles.specLabel}>Architecture Audio :</Text>
                <Text style={styles.specValue}>MAS Native 32-bit Float Core</Text>
              </View>
              <View style={styles.specRow}>
                <Text style={styles.specLabel}>Taux d'échantillonnage :</Text>
                <Text style={styles.specValue}>96.0 kHz / 192.0 kHz Hi-Res</Text>
              </View>
              <View style={styles.specRow}>
                <Text style={styles.specLabel}>Égaliseur DSP :</Text>
                <Text style={styles.specValue}>10 bandes paramétriques + Tone</Text>
              </View>
              <View style={styles.specRow}>
                <Text style={styles.specLabel}>Effets intégrés :</Text>
                <Text style={styles.specValue}>Bass Boost, Reverb Studio, Limiteur</Text>
              </View>
              <View style={styles.specRow}>
                <Text style={styles.specLabel}>Formats supportés :</Text>
                <Text style={styles.specValue}>FLAC, MP3, WAV, AAC, M4A, OGG</Text>
              </View>
              <View style={styles.specRow}>
                <Text style={styles.specLabel}>Protection dynamique :</Text>
                <Text style={styles.specValue}>Brickwall Anti-Clipping Actif</Text>
              </View>
            </View>

            {/* Bouton d'accès au Changelog */}
            {onOpenChangelog && (
              <TouchableOpacity
                style={styles.changelogRowBtn}
                onPress={handleChangelogPress}
                activeOpacity={0.75}
              >
                <View style={styles.changelogIconBox}>
                  <MaterialCommunityIcons
                    name="clipboard-text-clock-outline"
                    size={20}
                    color={POWERAMP_TEAL}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.changelogRowTitle}>{t('changelogBtn')}</Text>
                  <Text style={styles.changelogRowSub}>
                    Consulter l'historique des versions (Builds 1026-1032)
                  </Text>
                </View>
                <Feather name="chevron-right" size={18} color="#94A3B8" />
              </TouchableOpacity>
            )}

            {/* Informations Développeur & Légal */}
            <View style={styles.legalBlock}>
              <View style={styles.specRow}>
                <Text style={styles.specLabel}>Développeur :</Text>
                <Text style={styles.specValue}>{APP_AUTHOR}</Text>
              </View>
              <View style={styles.specRow}>
                <Text style={styles.specLabel}>Version :</Text>
                <Text style={styles.specValue}>v{APP_VERSION} (Build 1032)</Text>
              </View>
              <View style={styles.specRow}>
                <Text style={styles.specLabel}>Édition :</Text>
                <Text style={styles.specValue}>Production Release</Text>
              </View>
              <View style={styles.specRow}>
                <Text style={styles.specLabel}>Copyright :</Text>
                <Text style={styles.specValue}>{APP_COPYRIGHT}</Text>
              </View>
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.78)',
    justifyContent: 'flex-end',
    alignItems: 'center',
    paddingHorizontal: 0,
    paddingBottom: 0,
  },
  backdropTouch: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  dragHandleBar: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255, 255, 255, 0.28)',
    alignSelf: 'center',
    marginBottom: 12,
  },
  dialogBox: {
    width: '100%',
    maxWidth: 600,
    maxHeight: '88%',
    backgroundColor: '#16171C',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: 'rgba(255, 255, 255, 0.12)',
    paddingHorizontal: 22,
    paddingTop: 14,
    ...Platform.select({
      ios: {
        shadowColor: '#000000',
        shadowOffset: { width: 0, height: 12 },
        shadowOpacity: 0.5,
        shadowRadius: 20,
      },
      android: {
        elevation: 16,
      },
    }),
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  titleText: {
    fontSize: 20,
    fontWeight: '700',
    color: '#FFFFFF',
    letterSpacing: -0.2,
  },
  versionBadge: {
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.25)',
  },
  versionBadgeText: {
    color: '#FFFFFF',
    fontSize: 11.5,
    fontWeight: '700',
  },
  closeIconBtn: {
    padding: 4,
  },
  scrollArea: {
    flexGrow: 0,
    maxHeight: '80%',
  },
  scrollContent: {
    paddingBottom: 16,
    gap: 14,
  },
  heroCard: {
    backgroundColor: '#1E2028',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  heroTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  heroTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#FFFFFF',
    letterSpacing: -0.2,
  },
  proBadge: {
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.25)',
  },
  proBadgeText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  heroTagline: {
    fontSize: 12,
    color: POWERAMP_TEAL,
    fontWeight: '600',
    marginTop: 4,
  },
  sectionBlock: {
    backgroundColor: '#1E2028',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    gap: 8,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#F1F5F9',
    letterSpacing: 0.3,
  },
  descriptionText: {
    fontSize: 12.5,
    color: '#94A3B8',
    lineHeight: 18,
  },
  pillsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 4,
  },
  techPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.2)',
  },
  techPillText: {
    color: '#FFFFFF',
    fontSize: 10.5,
    fontWeight: '700',
  },
  specsCard: {
    backgroundColor: '#1E2028',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    gap: 8,
  },
  specsCardTitle: {
    fontSize: 12.5,
    fontWeight: '700',
    color: POWERAMP_TEAL,
    letterSpacing: 0.4,
    marginBottom: 2,
  },
  specRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  specLabel: {
    color: '#71717A',
    fontSize: 12,
  },
  specValue: {
    color: '#E4E4E7',
    fontSize: 12,
    fontWeight: '500',
    flexShrink: 1,
    textAlign: 'right',
  },
  changelogRowBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1E2028',
    borderRadius: 14,
    padding: 12,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    gap: 12,
  },
  changelogIconBox: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  changelogRowTitle: {
    fontSize: 13.5,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  changelogRowSub: {
    fontSize: 11,
    color: '#94A3B8',
    marginTop: 2,
  },
  legalBlock: {
    backgroundColor: '#1E2028',
    borderRadius: 14,
    padding: 12,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    gap: 6,
  },
});
