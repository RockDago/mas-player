import React, { useState } from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  SafeAreaView,
  Platform,
  TextInput,
  Switch,
  Alert,
  Image,
} from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';

import { Track, DSPState } from '../types/audio';
import { AppSettings, DEFAULT_APP_SETTINGS } from '../services/storageService';
import { formatTime } from '../services/audioService';
import { APP_VERSION } from '../constants/version';

interface SettingsModalProps {
  visible: boolean;
  onClose: () => void;
  onRescanLibrary?: () => void;
  settings?: AppSettings;
  onUpdateSettings?: (newSettings: Partial<AppSettings>) => void;
  currentTrack?: Track;
  positionMillis?: number;
  durationMillis?: number;
  dsp?: DSPState;
  onClearSession?: () => void;
}

interface SettingCategory {
  id: string;
  title: string;
  subtitle: string;
  icon: keyof typeof MaterialCommunityIcons.glyphMap;
  iconColor: string;
}

const SETTING_ITEMS: SettingCategory[] = [
  {
    id: 'resume_playback',
    title: 'Mémorisation & Reprise',
    subtitle: 'Dernière musique, position de lecture, réglages persistants',
    icon: 'history',
    iconColor: '#38BDF8',
  },
  {
    id: 'look_and_feel',
    title: 'Look and Feel',
    subtitle: 'Skin, player interface, language, notifications',
    icon: 'layers-outline',
    iconColor: '#93A4BA',
  },
  {
    id: 'audio',
    title: 'Audio',
    subtitle: 'Crossfade, replay gain, volume, output',
    icon: 'volume-high',
    iconColor: '#E27690',
  },
  {
    id: 'visualization',
    title: 'Visualization',
    subtitle: 'Faded controls opacity, preset duration',
    icon: 'chart-bell-curve-cumulative',
    iconColor: '#C084FC',
  },
  {
    id: 'background',
    title: 'Background',
    subtitle: 'Blur, details, intensity, saturation',
    icon: 'cellphone',
    iconColor: '#38B2AC',
  },
  {
    id: 'album_art',
    title: 'Album Art',
    subtitle: 'Download, quality, cache cleanup',
    icon: 'image-outline',
    iconColor: '#4ADE80',
  },
  {
    id: 'library',
    title: 'Library',
    subtitle: 'Rescan, music folders, list, queue options',
    icon: 'folder-music',
    iconColor: '#60A5FA',
  },
  {
    id: 'headset_bluetooth',
    title: 'Headset/Bluetooth',
    subtitle: 'Pause/resume on connection, headset buttons',
    icon: 'headphones',
    iconColor: '#CBD5E1',
  },
  {
    id: 'lock_screen',
    title: 'Lock Screen',
    subtitle: 'MAS Player lock screen options',
    icon: 'lock-outline',
    iconColor: '#FB923C',
  },
  {
    id: 'misc',
    title: 'Misc',
    subtitle: 'Scrobbling, Android Auto, other tweaks',
    icon: 'dots-horizontal',
    iconColor: '#38BDF8',
  },
];

export const SettingsModal: React.FC<SettingsModalProps> = ({
  visible,
  onClose,
  onRescanLibrary,
  settings = DEFAULT_APP_SETTINGS,
  onUpdateSettings,
  currentTrack,
  positionMillis = 0,
  durationMillis = 0,
  dsp,
  onClearSession,
}) => {
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isSearchActive, setIsSearchActive] = useState<boolean>(false);
  const [selectedSetting, setSelectedSetting] = useState<SettingCategory | null>(null);
  const [resetSuccess, setResetSuccess] = useState<boolean>(false);
  const [rescanSuccess, setRescanSuccess] = useState<boolean>(false);

  const filteredItems = SETTING_ITEMS.filter(
    (item) =>
      item.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.subtitle.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleItemPress = (item: SettingCategory) => {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {}

    if (item.id === 'library') {
      if (onRescanLibrary) onRescanLibrary();
      setRescanSuccess(true);
      setTimeout(() => setRescanSuccess(false), 2500);
    } else {
      setSelectedSetting(item);
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent={false}
      onRequestClose={onClose}
    >
      <SafeAreaView style={styles.safeContainer}>
        {/* Header matching Screenshot 2 */}
        <View style={styles.header}>
          <TouchableOpacity
            style={styles.headerIconBtn}
            onPress={onClose}
            activeOpacity={0.7}
          >
            <Ionicons name="arrow-back" size={24} color="#FFFFFF" />
          </TouchableOpacity>

          {isSearchActive ? (
            <TextInput
              style={styles.headerSearchInput}
              placeholder="Rechercher des paramètres..."
              placeholderTextColor="#71717A"
              value={searchQuery}
              onChangeText={setSearchQuery}
              autoFocus
            />
          ) : (
            <Text style={styles.headerTitle}>Settings</Text>
          )}

          <View style={styles.headerRightActions}>
            <TouchableOpacity
              style={styles.headerIconBtn}
              onPress={() => {
                setIsSearchActive(!isSearchActive);
                if (isSearchActive) setSearchQuery('');
              }}
              activeOpacity={0.7}
            >
              <Ionicons
                name={isSearchActive ? 'close-circle' : 'search'}
                size={22}
                color="#FFFFFF"
              />
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.headerIconBtn}
              onPress={onClose}
              activeOpacity={0.7}
            >
              <Ionicons name="close" size={26} color="#FFFFFF" />
            </TouchableOpacity>
          </View>
        </View>

        {/* Rescan Notification Banner */}
        {rescanSuccess && (
          <View style={styles.rescanBanner}>
            <Ionicons name="checkmark-circle" size={18} color="#4ADE80" />
            <Text style={styles.rescanBannerText}>
              Bibliothèque actualisée avec succès !
            </Text>
          </View>
        )}

        {/* Branded MAS Player Hero Card */}
        <View style={styles.brandHeroCard}>
          <Image
            source={require('../../assets/mas_icon_square.png')}
            style={styles.brandHeroLogo}
            resizeMode="contain"
          />
          <View style={styles.brandHeroTextCol}>
            <Text style={styles.brandHeroTitle}>MAS PLAYER</Text>
            <Text style={styles.brandHeroSubtitle}>Moteur Audio HD 32-Bit DVC • v{APP_VERSION}</Text>
          </View>
        </View>

        {/* Section Sub-header */}
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionHeaderText}>Settings</Text>
        </View>

        {/* Settings List */}
        <ScrollView
          style={styles.scrollList}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {filteredItems.map((item) => (
            <TouchableOpacity
              key={item.id}
              style={styles.settingRow}
              onPress={() => handleItemPress(item)}
              activeOpacity={0.7}
            >
              {/* Left Colored Icon */}
              <View style={styles.iconWrapper}>
                <MaterialCommunityIcons
                  name={item.icon}
                  size={26}
                  color={item.iconColor}
                />
              </View>

              {/* Middle Title and Subtitle */}
              <View style={styles.textWrapper}>
                <Text style={styles.itemTitleText}>{item.title}</Text>
                <Text style={styles.itemSubtitleText}>{item.subtitle}</Text>
              </View>
            </TouchableOpacity>
          ))}
          {/* About & Version Card */}
          <View style={styles.aboutVersionCard}>
            <View style={styles.aboutVersionHeader}>
              <Text style={styles.aboutAppName}>MAS PLAYER</Text>
              <View style={styles.aboutVersionBadge}>
                <Text style={styles.aboutVersionBadgeText}>v{APP_VERSION}</Text>
              </View>
            </View>
            <Text style={styles.aboutVersionInfo}>
              Version {APP_VERSION} (Build 1.0.0 Release)
            </Text>
            <Text style={styles.aboutVersionTech}>
              DSP Audiophile 32-bit Float • 10 Bandes EQ • iOS & Web
            </Text>
          </View>

          <View style={{ height: 40 }} />
        </ScrollView>

        {/* Detail Sub-Panel Modal */}
        {selectedSetting && (
          <Modal
            visible={!!selectedSetting}
            animationType="fade"
            transparent
            onRequestClose={() => setSelectedSetting(null)}
          >
            <View style={styles.subModalOverlay}>
              <View style={styles.subModalBox}>
                <View style={styles.subModalHeader}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                    <MaterialCommunityIcons
                      name={selectedSetting.icon}
                      size={24}
                      color={selectedSetting.iconColor}
                    />
                    <Text style={styles.subModalTitle}>{selectedSetting.title}</Text>
                  </View>
                  <TouchableOpacity onPress={() => setSelectedSetting(null)}>
                    <Ionicons name="close" size={24} color="#FFFFFF" />
                  </TouchableOpacity>
                </View>

                <Text style={styles.subModalSubtitle}>
                  {selectedSetting.subtitle}
                </Text>

                <View style={styles.subModalDivider} />

                {selectedSetting.id === 'resume_playback' ? (
                  <View style={styles.subModalOptions}>
                    <View style={styles.toggleRow}>
                      <View style={{ flex: 1, paddingRight: 12 }}>
                        <Text style={styles.toggleLabel}>Mémoriser le dernier morceau</Text>
                        <Text style={styles.toggleSubLabel}>Recharge automatiquement le morceau écouté</Text>
                      </View>
                      <Switch
                        value={settings.rememberLastTrack}
                        onValueChange={(val) => onUpdateSettings?.({ rememberLastTrack: val })}
                        trackColor={{ false: '#27272A', true: '#38BDF8' }}
                        thumbColor="#FFFFFF"
                      />
                    </View>

                    <View style={styles.toggleRow}>
                      <View style={{ flex: 1, paddingRight: 12 }}>
                        <Text style={styles.toggleLabel}>Reprendre la position exacte</Text>
                        <Text style={styles.toggleSubLabel}>Repart de la seconde précise où vous étiez</Text>
                      </View>
                      <Switch
                        value={settings.rememberPlaybackPosition}
                        onValueChange={(val) => onUpdateSettings?.({ rememberPlaybackPosition: val })}
                        trackColor={{ false: '#27272A', true: '#38BDF8' }}
                        thumbColor="#FFFFFF"
                      />
                    </View>

                    <View style={styles.toggleRow}>
                      <View style={{ flex: 1, paddingRight: 12 }}>
                        <Text style={styles.toggleLabel}>Lecture auto au démarrage</Text>
                        <Text style={styles.toggleSubLabel}>Lance la lecture dès l'ouverture de l'application</Text>
                      </View>
                      <Switch
                        value={settings.autoPlayOnLaunch}
                        onValueChange={(val) => onUpdateSettings?.({ autoPlayOnLaunch: val })}
                        trackColor={{ false: '#27272A', true: '#38BDF8' }}
                        thumbColor="#FFFFFF"
                      />
                    </View>

                    {/* Carte d'état actuel */}
                    <View style={styles.statusCard}>
                      <Text style={styles.statusCardTitle}>ÉTAT EN MÉMOIRE</Text>
                      <View style={styles.statusCardRow}>
                        <Text style={styles.statusCardLabel}>Morceau :</Text>
                        <Text numberOfLines={1} style={styles.statusCardValue}>
                          {currentTrack ? `${currentTrack.title} (${currentTrack.artist})` : 'Aucun'}
                        </Text>
                      </View>
                      <View style={styles.statusCardRow}>
                        <Text style={styles.statusCardLabel}>Position :</Text>
                        <Text style={styles.statusCardValue}>
                          {formatTime(positionMillis / 1000)} / {formatTime(durationMillis / 1000)}
                        </Text>
                      </View>
                      <View style={styles.statusCardRow}>
                        <Text style={styles.statusCardLabel}>Égaliseur :</Text>
                        <Text style={styles.statusCardValue}>
                          Preset "{dsp?.presetId || 'Défaut'}" • Vol {dsp?.volume ?? 75}%
                        </Text>
                      </View>
                    </View>

                    {resetSuccess ? (
                      <View style={styles.resetSuccessBox}>
                        <Ionicons name="checkmark-circle" size={16} color="#4ADE80" />
                        <Text style={styles.resetSuccessText}>Historique réinitialisé !</Text>
                      </View>
                    ) : (
                      <TouchableOpacity
                        style={styles.resetSessionBtn}
                        onPress={() => {
                          try {
                            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                          } catch {}
                          onClearSession?.();
                          setResetSuccess(true);
                          setTimeout(() => setResetSuccess(false), 2500);
                        }}
                        activeOpacity={0.7}
                      >
                        <Ionicons name="trash-outline" size={16} color="#EF4444" />
                        <Text style={styles.resetSessionBtnText}>Réinitialiser la session</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                ) : selectedSetting.id === 'audio' ? (
                  <View style={styles.subModalOptions}>
                    <View style={styles.toggleRow}>
                      <Text style={styles.toggleLabel}>Crossfade (enchaînement)</Text>
                      <Switch
                        value={settings.crossfade}
                        onValueChange={(val) => onUpdateSettings?.({ crossfade: val })}
                        trackColor={{ false: '#27272A', true: '#38BDF8' }}
                        thumbColor="#FFFFFF"
                      />
                    </View>
                    <View style={styles.toggleRow}>
                      <Text style={styles.toggleLabel}>ReplayGain RG2</Text>
                      <Switch
                        value={settings.replayGain}
                        onValueChange={(val) => onUpdateSettings?.({ replayGain: val })}
                        trackColor={{ false: '#27272A', true: '#38BDF8' }}
                        thumbColor="#FFFFFF"
                      />
                    </View>
                    <View style={styles.infoRow}>
                      <Text style={styles.infoRowLabel}>Moteur Audio</Text>
                      <Text style={styles.infoRowValue}>MAS High-Res DVC 32-bit Float</Text>
                    </View>
                  </View>
                ) : (
                  <View style={styles.subModalOptions}>
                    <View style={styles.infoRow}>
                      <Text style={styles.infoRowLabel}>Version</Text>
                      <Text style={styles.infoRowValue}>MAS Player v{APP_VERSION} (iOS/Web)</Text>
                    </View>
                    <View style={styles.infoRow}>
                      <Text style={styles.infoRowLabel}>Thème actif</Text>
                      <Text style={styles.infoRowValue}>OLED Pure Black Dark</Text>
                    </View>
                  </View>
                )}

                <TouchableOpacity
                  style={styles.closeSubModalBtn}
                  onPress={() => setSelectedSetting(null)}
                >
                  <Text style={styles.closeSubModalBtnText}>Fermer</Text>
                </TouchableOpacity>
              </View>
            </View>
          </Modal>
        )}
      </SafeAreaView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  safeContainer: {
    flex: 1,
    backgroundColor: '#131215',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: Platform.OS === 'ios' ? 12 : 20,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#201E24',
  },
  headerIconBtn: {
    padding: 6,
  },
  headerTitle: {
    fontSize: 21,
    fontWeight: '700',
    color: '#FFFFFF',
    marginLeft: 18,
    flex: 1,
    letterSpacing: -0.3,
  },
  headerSearchInput: {
    flex: 1,
    marginLeft: 14,
    color: '#FFFFFF',
    fontSize: 16,
    paddingVertical: 4,
  },
  headerRightActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  rescanBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#1E293B',
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
  },
  rescanBannerText: {
    color: '#F1F5F9',
    fontSize: 13.5,
    fontWeight: '500',
  },
  sectionHeader: {
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 8,
  },
  sectionHeaderText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#9E98A6',
    letterSpacing: 0.2,
  },
  scrollList: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingTop: 4,
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
  },
  iconWrapper: {
    width: 38,
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  textWrapper: {
    flex: 1,
    marginLeft: 12,
  },
  itemTitleText: {
    fontSize: 16.5,
    fontWeight: '600',
    color: '#FFFFFF',
    letterSpacing: -0.2,
  },
  itemSubtitleText: {
    fontSize: 12.5,
    color: '#9E98A6',
    marginTop: 3,
    lineHeight: 17,
  },
  subModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  subModalBox: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: '#1C1B1F',
    borderRadius: 18,
    padding: 22,
    borderWidth: 1,
    borderColor: '#2F2E36',
  },
  subModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  subModalTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  subModalSubtitle: {
    fontSize: 13,
    color: '#9E98A6',
    marginBottom: 16,
  },
  subModalDivider: {
    height: 1,
    backgroundColor: '#2E2D33',
    marginBottom: 16,
  },
  subModalOptions: {
    gap: 16,
    marginBottom: 20,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  toggleLabel: {
    color: '#F4F4F5',
    fontSize: 15,
    fontWeight: '500',
  },
  toggleSubLabel: {
    color: '#71717A',
    fontSize: 12,
    marginTop: 2,
  },
  statusCard: {
    backgroundColor: '#121114',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: '#27272A',
    gap: 8,
    marginTop: 4,
  },
  statusCardTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: '#38BDF8',
    letterSpacing: 0.8,
    marginBottom: 2,
  },
  statusCardRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  statusCardLabel: {
    color: '#71717A',
    fontSize: 12.5,
  },
  statusCardValue: {
    color: '#E4E4E7',
    fontSize: 12.5,
    fontWeight: '500',
    flexShrink: 1,
    textAlign: 'right',
  },
  resetSessionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.3)',
    borderRadius: 10,
    paddingVertical: 10,
    marginTop: 4,
  },
  resetSessionBtnText: {
    color: '#EF4444',
    fontSize: 13.5,
    fontWeight: '600',
  },
  resetSuccessBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: 'rgba(74, 222, 128, 0.1)',
    borderRadius: 10,
    paddingVertical: 10,
    marginTop: 4,
  },
  resetSuccessText: {
    color: '#4ADE80',
    fontSize: 13,
    fontWeight: '600',
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  infoRowLabel: {
    color: '#71717A',
    fontSize: 14,
  },
  infoRowValue: {
    color: '#E4E4E7',
    fontSize: 14,
    fontWeight: '500',
  },
  closeSubModalBtn: {
    backgroundColor: '#27272A',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  closeSubModalBtnText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  brandHeroCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0F1218',
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 4,
    padding: 14,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#1E2530',
    gap: 14,
  },
  brandHeroLogo: {
    width: 48,
    height: 48,
    borderRadius: 12,
  },
  brandHeroTextCol: {
    flex: 1,
    justifyContent: 'center',
  },
  brandHeroTitle: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '800',
    letterSpacing: 1.2,
  },
  brandHeroSubtitle: {
    color: '#94A3B8',
    fontSize: 12,
    marginTop: 2,
    fontWeight: '500',
  },
  aboutVersionCard: {
    backgroundColor: '#0F1218',
    borderRadius: 14,
    padding: 16,
    marginTop: 20,
    borderWidth: 1,
    borderColor: '#1E2530',
    alignItems: 'center',
  },
  aboutVersionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
  },
  aboutAppName: {
    color: '#F3F4F6',
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 1.2,
  },
  aboutVersionBadge: {
    backgroundColor: 'rgba(56, 189, 248, 0.15)',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.3)',
  },
  aboutVersionBadgeText: {
    color: '#38BDF8',
    fontSize: 10,
    fontWeight: '700',
  },
  aboutVersionInfo: {
    color: '#CBD5E1',
    fontSize: 12.5,
    fontWeight: '500',
    marginBottom: 4,
  },
  aboutVersionTech: {
    color: '#64748B',
    fontSize: 11,
    textAlign: 'center',
  },
});
