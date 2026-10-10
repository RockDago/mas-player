import React, { useState } from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Platform,
  TextInput,
  Switch,
  Image,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { Ionicons, MaterialCommunityIcons, Feather } from '@expo/vector-icons';
import { useScreenInsets, insetPadding, insetPaddingBelow } from '../theme/insets';
import * as Haptics from 'expo-haptics';

import { Track, DSPState } from '../types/audio';
import { AppSettings, DEFAULT_APP_SETTINGS } from '../services/storageService';
import { formatTime } from '../services/audioService';
import { APP_VERSION, APP_NAME, APP_AUTHOR, APP_COPYRIGHT } from '../constants/version';
import { getTranslation, LANGUAGES, LanguageCode } from '../i18n/translations';

interface SettingsModalProps {
  visible: boolean;
  onClose: () => void;
  onRescanLibrary?: () => Promise<number>;
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
  titleKey: string;
  subtitleKey: string;
  icon: keyof typeof MaterialCommunityIcons.glyphMap;
  iconColor: string;
}

const SETTING_ITEMS: SettingCategory[] = [
  {
    id: 'resume_playback',
    titleKey: 'cat_resume_title',
    subtitleKey: 'cat_resume_sub',
    icon: 'history',
    iconColor: '#38BDF8',
  },
  {
    id: 'look_and_feel',
    titleKey: 'cat_look_title',
    subtitleKey: 'cat_look_sub',
    icon: 'layers-outline',
    iconColor: '#93A4BA',
  },
  {
    id: 'audio',
    titleKey: 'cat_audio_title',
    subtitleKey: 'cat_audio_sub',
    icon: 'volume-high',
    iconColor: '#E27690',
  },
  {
    id: 'visualization',
    titleKey: 'cat_visu_title',
    subtitleKey: 'cat_visu_sub',
    icon: 'chart-bell-curve-cumulative',
    iconColor: '#C084FC',
  },
  {
    id: 'background',
    titleKey: 'cat_bg_title',
    subtitleKey: 'cat_bg_sub',
    icon: 'cellphone',
    iconColor: '#38B2AC',
  },
  {
    id: 'album_art',
    titleKey: 'cat_art_title',
    subtitleKey: 'cat_art_sub',
    icon: 'image-outline',
    iconColor: '#4ADE80',
  },
  {
    id: 'library',
    titleKey: 'cat_lib_title',
    subtitleKey: 'cat_lib_sub',
    icon: 'folder-music',
    iconColor: '#60A5FA',
  },
  {
    id: 'headset_bluetooth',
    titleKey: 'cat_headset_title',
    subtitleKey: 'cat_headset_sub',
    icon: 'headphones',
    iconColor: '#CBD5E1',
  },
  {
    id: 'lock_screen',
    titleKey: 'cat_lock_title',
    subtitleKey: 'cat_lock_sub',
    icon: 'lock-outline',
    iconColor: '#FB923C',
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
  // Marge système mesurée, lue par contexte : la modale est montée hors de
  // l'écran et n'en hérite pas. Voir src/theme/insets.ts.
  const insets = useScreenInsets();
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isSearchActive, setIsSearchActive] = useState<boolean>(false);
  const [selectedSetting, setSelectedSetting] = useState<SettingCategory | null>(null);
  const [resetSuccess, setResetSuccess] = useState<boolean>(false);
  // `rescanSuccess` porte le nombre de morceaux ajoutés — `null` tant que le
  // scan n'a rien donné. Un booléen separate ne suffirait pas : « actualisée »
  // sans dire combien de morceaux ont réellement été trouvés est exactement le
  // vide que ce handler vient de combler.
  const [rescanSuccess, setRescanSuccess] = useState<number | null>(null);
  const [rescanError, setRescanError] = useState<boolean>(false);
  const [rescanLoading, setRescanLoading] = useState<boolean>(false);

  const lang: LanguageCode = (settings.language as LanguageCode) || 'fr';
  // `params` est relayé tel quel : les libellés qui interpolent `{count}`
  // (le décompte réel du rescan) passent par ici comme par `getTranslation`.
  const t = (
    key: string,
    fallback?: string,
    params?: Record<string, string | number>
  ): string => getTranslation(lang, key, fallback, params);

  const filteredItems = SETTING_ITEMS.filter((item) => {
    const title = t(item.titleKey);
    const subtitle = t(item.subtitleKey);
    return (
      title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      subtitle.toLowerCase().includes(searchQuery.toLowerCase())
    );
  });

  const handleItemPress = (item: SettingCategory) => {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {}
    setSelectedSetting(item);
  };

  /**
   * Rescan réel de la bibliothèque.
   *
   * Ce handler affichait auparavant un bandeau « Bibliothèque actualisée » après
   * un `setTimeout` de 800 ms, sans avoir rien scanné : `onRescanLibrary` n'était
   * qu'un `console.log`. Le bandeau vert annonçait donc un succès fabriqué — le
   * pire genre de retour, puisque l'utilisateur ne peut pas le contester.
   *
   * On attend maintenant la promesse réellement retournée par l'appelant, et on
   * n'affiche un succès que si elle résout. Une annulation du sélecteur système
   * et une erreur sont deux résultats distincts, tous deux honnêtes.
   */
  const handleTriggerRescan = async () => {
    setRescanLoading(true);
    setRescanSuccess(null);
    setRescanError(false);
    try {
      const added = await onRescanLibrary?.();
      try {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch {}
      setRescanSuccess(added ?? 0);
    } catch (e) {
      console.warn('Échec du rescan de la bibliothèque:', e);
      try {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      } catch {}
      setRescanError(true);
    } finally {
      setRescanLoading(false);
    }
  };

  const renderCategoryContent = () => {
    if (!selectedSetting) return null;

    switch (selectedSetting.id) {
      case 'resume_playback':
        return (
          <View style={styles.subModalOptions}>
            <View style={styles.toggleRow}>
              <View style={styles.toggleTextCol}>
                <Text style={styles.toggleLabel}>{t('rememberLastTrack')}</Text>
                <Text style={styles.toggleSubLabel}>{t('rememberLastTrackSub')}</Text>
              </View>
              <Switch
                value={settings.rememberLastTrack}
                onValueChange={(val) => onUpdateSettings?.({ rememberLastTrack: val })}
                trackColor={{ false: '#27272A', true: '#38BDF8' }}
                thumbColor="#FFFFFF"
              />
            </View>

            <View style={styles.toggleRow}>
              <View style={styles.toggleTextCol}>
                <Text style={styles.toggleLabel}>{t('rememberPlaybackPos')}</Text>
                <Text style={styles.toggleSubLabel}>{t('rememberPlaybackPosSub')}</Text>
              </View>
              <Switch
                value={settings.rememberPlaybackPosition}
                onValueChange={(val) => onUpdateSettings?.({ rememberPlaybackPosition: val })}
                trackColor={{ false: '#27272A', true: '#38BDF8' }}
                thumbColor="#FFFFFF"
              />
            </View>

            <View style={styles.toggleRow}>
              <View style={styles.toggleTextCol}>
                <Text style={styles.toggleLabel}>{t('autoPlayLaunch')}</Text>
                <Text style={styles.toggleSubLabel}>{t('autoPlayLaunchSub')}</Text>
              </View>
              <Switch
                value={settings.autoPlayOnLaunch}
                onValueChange={(val) => onUpdateSettings?.({ autoPlayOnLaunch: val })}
                trackColor={{ false: '#27272A', true: '#38BDF8' }}
                thumbColor="#FFFFFF"
              />
            </View>

            <View style={styles.toggleRow}>
              <View style={styles.toggleTextCol}>
                <Text style={styles.toggleLabel}>{t('resumeAfterInterruption')}</Text>
                <Text style={styles.toggleSubLabel}>{t('resumeAfterInterruptionSub')}</Text>
              </View>
              <Switch
                value={settings.resumeOnHeadset}
                onValueChange={(val) => onUpdateSettings?.({ resumeOnHeadset: val })}
                trackColor={{ false: '#27272A', true: '#38BDF8' }}
                thumbColor="#FFFFFF"
              />
            </View>

            {/* Carte d'état actuel */}
            <View style={styles.statusCard}>
              <Text style={styles.statusCardTitle}>{t('memoryStateTitle')}</Text>
              <View style={styles.statusCardRow}>
                <Text style={styles.statusCardLabel}>{t('memoryTrack')}</Text>
                <Text numberOfLines={1} style={styles.statusCardValue}>
                  {currentTrack ? `${currentTrack.title} (${currentTrack.artist})` : t('none')}
                </Text>
              </View>
              <View style={styles.statusCardRow}>
                <Text style={styles.statusCardLabel}>{t('memoryPosition')}</Text>
                <Text style={styles.statusCardValue}>
                  {formatTime(positionMillis / 1000)} / {formatTime(durationMillis / 1000)}
                </Text>
              </View>
              <View style={styles.statusCardRow}>
                <Text style={styles.statusCardLabel}>{t('memoryEqualizer')}</Text>
                <Text style={styles.statusCardValue}>
                  Preset "{dsp?.presetId || 'Défaut'}" • Vol {dsp?.volume ?? 75}%
                </Text>
              </View>
            </View>

            {resetSuccess ? (
              <View style={styles.resetSuccessBox}>
                <Ionicons name="checkmark-circle" size={16} color="#4ADE80" />
                <Text style={styles.resetSuccessText}>{t('resetSessionSuccess')}</Text>
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
                <Text style={styles.resetSessionBtnText}>{t('resetSessionBtn')}</Text>
              </TouchableOpacity>
            )}
          </View>
        );

      case 'look_and_feel':
        return (
          <View style={styles.subModalOptions}>
            {/* SÉLECTEUR DE LANGUE (Fonctionnel et réactif) */}
            <View style={styles.optionSection}>
              <Text style={styles.sectionLabel}>{t('languageSection')}</Text>
              <View style={styles.chipRow}>
                {LANGUAGES.map((l) => (
                  <TouchableOpacity
                    key={l.code}
                    style={[
                      styles.choiceChip,
                      settings.language === l.code && styles.choiceChipActive,
                    ]}
                    onPress={() => {
                      try {
                        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                      } catch {}
                      onUpdateSettings?.({ language: l.code });
                    }}
                  >
                    <Text
                      style={[
                        styles.choiceChipText,
                        settings.language === l.code && styles.choiceChipTextActive,
                      ]}
                    >
                      {l.flag} {l.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            <View style={styles.optionSection}>
              <Text style={styles.sectionLabel}>{t('themeSection')}</Text>
              <View style={styles.chipRow}>
                {[
                  { id: 'oled', label: t('themeOled') },
                  { id: 'cyber', label: t('themeCyber') },
                  { id: 'violet', label: t('themeViolet') },
                  { id: 'carbon', label: t('themeCarbon') },
                ].map((th) => (
                  <TouchableOpacity
                    key={th.id}
                    style={[
                      styles.choiceChip,
                      settings.theme === th.id && styles.choiceChipActive,
                    ]}
                    onPress={() => onUpdateSettings?.({ theme: th.id as any })}
                  >
                    <Text
                      style={[
                        styles.choiceChipText,
                        settings.theme === th.id && styles.choiceChipTextActive,
                      ]}
                    >
                      {th.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            <View style={styles.optionSection}>
              <Text style={styles.sectionLabel}>{t('visualizerSection')}</Text>
              <View style={styles.chipRow}>
                {[
                  { id: 'vinyl', label: t('visuVinyl') },
                  { id: 'bars', label: t('visuBars') },
                  { id: 'wave', label: t('visuWave') },
                ].map((v) => (
                  <TouchableOpacity
                    key={v.id}
                    style={[
                      styles.choiceChip,
                      settings.visualizerStyle === v.id && styles.choiceChipActive,
                    ]}
                    onPress={() => onUpdateSettings?.({ visualizerStyle: v.id as any })}
                  >
                    <Text
                      style={[
                        styles.choiceChipText,
                        settings.visualizerStyle === v.id && styles.choiceChipTextActive,
                      ]}
                    >
                      {v.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            <View style={styles.toggleRow}>
              <View style={styles.toggleTextCol}>
                <Text style={styles.toggleLabel}>{t('techSpecsBadge')}</Text>
                <Text style={styles.toggleSubLabel}>{t('techSpecsBadgeSub')}</Text>
              </View>
              <Switch
                value={settings.showTrackDetails}
                onValueChange={(val) => onUpdateSettings?.({ showTrackDetails: val })}
                trackColor={{ false: '#27272A', true: '#38BDF8' }}
                thumbColor="#FFFFFF"
              />
            </View>

            <View style={styles.toggleRow}>
              <View style={styles.toggleTextCol}>
                <Text style={styles.toggleLabel}>{t('richNotifs')}</Text>
                <Text style={styles.toggleSubLabel}>{t('richNotifsSub')}</Text>
              </View>
              <Switch
                value={settings.richNotifications}
                onValueChange={(val) => onUpdateSettings?.({ richNotifications: val })}
                trackColor={{ false: '#27272A', true: '#38BDF8' }}
                thumbColor="#FFFFFF"
              />
            </View>
          </View>
        );

      case 'audio':
        return (
          <View style={styles.subModalOptions}>
            <View style={styles.toggleRow}>
              <View style={styles.toggleTextCol}>
                <Text style={styles.toggleLabel}>{t('crossfadeTitle')}</Text>
                <Text style={styles.toggleSubLabel}>{t('crossfadeSub')}</Text>
              </View>
              <Switch
                value={settings.crossfade}
                onValueChange={(val) => onUpdateSettings?.({ crossfade: val })}
                trackColor={{ false: '#27272A', true: '#38BDF8' }}
                thumbColor="#FFFFFF"
              />
            </View>

            {settings.crossfade && (
              <View style={styles.optionSection}>
                <Text style={styles.sectionLabel}>{t('crossfadeDurationSection')}</Text>
                <View style={styles.chipRow}>
                  {[1, 2, 4, 6].map((sec) => (
                    <TouchableOpacity
                      key={sec}
                      style={[
                        styles.choiceChip,
                        settings.crossfadeDuration === sec && styles.choiceChipActive,
                      ]}
                      onPress={() => onUpdateSettings?.({ crossfadeDuration: sec })}
                    >
                      <Text
                        style={[
                          styles.choiceChipText,
                          settings.crossfadeDuration === sec && styles.choiceChipTextActive,
                        ]}
                      >
                        {sec}s
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            )}

            <View style={styles.toggleRow}>
              <View style={styles.toggleTextCol}>
                <Text style={styles.toggleLabel}>{t('replayGainTitle')}</Text>
                <Text style={styles.toggleSubLabel}>{t('replayGainSub')}</Text>
              </View>
              <Switch
                value={settings.replayGain}
                onValueChange={(val) => onUpdateSettings?.({ replayGain: val })}
                trackColor={{ false: '#27272A', true: '#38BDF8' }}
                thumbColor="#FFFFFF"
              />
            </View>

            {settings.replayGain && (
              <View style={styles.optionSection}>
                <Text style={styles.sectionLabel}>{t('replayGainModeSection')}</Text>
                <View style={styles.chipRow}>
                  {[
                    { id: 'track', label: t('replayTrack') },
                    { id: 'album', label: t('replayAlbum') },
                  ].map((m) => (
                    <TouchableOpacity
                      key={m.id}
                      style={[
                        styles.choiceChip,
                        settings.replayGainMode === m.id && styles.choiceChipActive,
                      ]}
                      onPress={() => onUpdateSettings?.({ replayGainMode: m.id as any })}
                    >
                      <Text
                        style={[
                          styles.choiceChipText,
                          settings.replayGainMode === m.id && styles.choiceChipTextActive,
                        ]}
                      >
                        {m.label}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            )}

            <View style={styles.toggleRow}>
              <View style={styles.toggleTextCol}>
                <Text style={styles.toggleLabel}>{t('dvcTitle')}</Text>
                <Text style={styles.toggleSubLabel}>{t('dvcSub')}</Text>
              </View>
              <Switch
                value={settings.dvc32Bit}
                onValueChange={(val) => onUpdateSettings?.({ dvc32Bit: val })}
                trackColor={{ false: '#27272A', true: '#38BDF8' }}
                thumbColor="#FFFFFF"
              />
            </View>

            <View style={styles.toggleRow}>
              <View style={styles.toggleTextCol}>
                <Text style={styles.toggleLabel}>{t('hiResTitle')}</Text>
                <Text style={styles.toggleSubLabel}>{t('hiResSub')}</Text>
              </View>
              <Switch
                value={settings.hiResOutput}
                onValueChange={(val) => onUpdateSettings?.({ hiResOutput: val })}
                trackColor={{ false: '#27272A', true: '#38BDF8' }}
                thumbColor="#FFFFFF"
              />
            </View>

            <View style={styles.toggleRow}>
              <View style={styles.toggleTextCol}>
                <Text style={styles.toggleLabel}>{t('lowLatencyTitle')}</Text>
                <Text style={styles.toggleSubLabel}>{t('lowLatencySub')}</Text>
              </View>
              <Switch
                value={settings.ultraLowLatency}
                onValueChange={(val) => onUpdateSettings?.({ ultraLowLatency: val })}
                trackColor={{ false: '#27272A', true: '#38BDF8' }}
                thumbColor="#FFFFFF"
              />
            </View>

            <View style={styles.statusCard}>
              <Text style={styles.statusCardTitle}>{t('engineTitle')}</Text>
              <View style={styles.statusCardRow}>
                <Text style={styles.statusCardLabel}>{t('engineArch')}</Text>
                <Text style={styles.statusCardValue}>{t('engineArchVal')}</Text>
              </View>
              <View style={styles.statusCardRow}>
                <Text style={styles.statusCardLabel}>{t('engineSampleRate')}</Text>
                <Text style={styles.statusCardValue}>96.0 kHz / 32-bit Float</Text>
              </View>
              <View style={styles.statusCardRow}>
                <Text style={styles.statusCardLabel}>{t('engineDspState')}</Text>
                <Text style={styles.statusCardValue}>{t('engineActive')}</Text>
              </View>
            </View>
          </View>
        );

      case 'visualization':
        return (
          <View style={styles.subModalOptions}>
            <View style={styles.optionSection}>
              <Text style={styles.sectionLabel}>{t('spectrumSection')}</Text>
              <View style={styles.chipRow}>
                {[
                  { id: 'low', label: t('specLow') },
                  { id: 'normal', label: t('specNormal') },
                  { id: 'ultra', label: t('specUltra') },
                ].map((s) => (
                  <TouchableOpacity
                    key={s.id}
                    style={[
                      styles.choiceChip,
                      settings.spectrumReactive === s.id && styles.choiceChipActive,
                    ]}
                    onPress={() => onUpdateSettings?.({ spectrumReactive: s.id as any })}
                  >
                    <Text
                      style={[
                        styles.choiceChipText,
                        settings.spectrumReactive === s.id && styles.choiceChipTextActive,
                      ]}
                    >
                      {s.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            <View style={styles.toggleRow}>
              <View style={styles.toggleTextCol}>
                <Text style={styles.toggleLabel}>{t('autoFadeTitle')}</Text>
                <Text style={styles.toggleSubLabel}>{t('autoFadeSub')}</Text>
              </View>
              <Switch
                value={settings.autoFadeControls}
                onValueChange={(val) => onUpdateSettings?.({ autoFadeControls: val })}
                trackColor={{ false: '#27272A', true: '#38BDF8' }}
                thumbColor="#FFFFFF"
              />
            </View>

            {settings.autoFadeControls && (
              <View style={styles.optionSection}>
                <Text style={styles.sectionLabel}>{t('opacitySection')}</Text>
                <View style={styles.chipRow}>
                  {[
                    { val: 0.2, label: t('op20') },
                    { val: 0.4, label: t('op40') },
                    { val: 0.7, label: t('op70') },
                  ].map((o) => (
                    <TouchableOpacity
                      key={o.val}
                      style={[
                        styles.choiceChip,
                        settings.fadedOpacity === o.val && styles.choiceChipActive,
                      ]}
                      onPress={() => onUpdateSettings?.({ fadedOpacity: o.val })}
                    >
                      <Text
                        style={[
                          styles.choiceChipText,
                          settings.fadedOpacity === o.val && styles.choiceChipTextActive,
                        ]}
                      >
                        {o.label}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            )}
          </View>
        );

      case 'background':
        return (
          <View style={styles.subModalOptions}>
            <View style={styles.optionSection}>
              <Text style={styles.sectionLabel}>{t('bgStyleSection')}</Text>
              <View style={styles.chipRow}>
                {[
                  { id: 'blur', label: t('bgBlur') },
                  { id: 'oled', label: t('bgOled') },
                  { id: 'gradient', label: t('bgGradient') },
                ].map((b) => (
                  <TouchableOpacity
                    key={b.id}
                    style={[
                      styles.choiceChip,
                      settings.backgroundStyle === b.id && styles.choiceChipActive,
                    ]}
                    onPress={() => onUpdateSettings?.({ backgroundStyle: b.id as any })}
                  >
                    <Text
                      style={[
                        styles.choiceChipText,
                        settings.backgroundStyle === b.id && styles.choiceChipTextActive,
                      ]}
                    >
                      {b.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            {settings.backgroundStyle === 'blur' && (
              <View style={styles.optionSection}>
                <Text style={styles.sectionLabel}>{t('blurSection')}</Text>
                <View style={styles.chipRow}>
                  {[
                    { id: 'low', label: t('blurLow') },
                    { id: 'medium', label: t('blurMed') },
                    { id: 'deep', label: t('blurDeep') },
                  ].map((bi) => (
                    <TouchableOpacity
                      key={bi.id}
                      style={[
                        styles.choiceChip,
                        settings.blurIntensity === bi.id && styles.choiceChipActive,
                      ]}
                      onPress={() => onUpdateSettings?.({ blurIntensity: bi.id as any })}
                    >
                      <Text
                        style={[
                          styles.choiceChipText,
                          settings.blurIntensity === bi.id && styles.choiceChipTextActive,
                        ]}
                      >
                        {bi.label}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            )}

            <View style={styles.toggleRow}>
              <View style={styles.toggleTextCol}>
                <Text style={styles.toggleLabel}>{t('satTitle')}</Text>
                <Text style={styles.toggleSubLabel}>{t('satSub')}</Text>
              </View>
              <Switch
                value={settings.colorSaturation}
                onValueChange={(val) => onUpdateSettings?.({ colorSaturation: val })}
                trackColor={{ false: '#27272A', true: '#38BDF8' }}
                thumbColor="#FFFFFF"
              />
            </View>

            <View style={styles.toggleRow}>
              <View style={styles.toggleTextCol}>
                <Text style={styles.toggleLabel}>{t('particlesTitle')}</Text>
                <Text style={styles.toggleSubLabel}>{t('particlesSub')}</Text>
              </View>
              <Switch
                value={settings.ambientParticles}
                onValueChange={(val) => onUpdateSettings?.({ ambientParticles: val })}
                trackColor={{ false: '#27272A', true: '#38BDF8' }}
                thumbColor="#FFFFFF"
              />
            </View>
          </View>
        );

      case 'album_art':
        return (
          <View style={styles.subModalOptions}>
            <View style={styles.toggleRow}>
              <View style={styles.toggleTextCol}>
                <Text style={styles.toggleLabel}>{t('artAutoDl')}</Text>
                <Text style={styles.toggleSubLabel}>{t('artAutoDlSub')}</Text>
              </View>
              <Switch
                value={settings.autoDownloadArt}
                onValueChange={(val) => onUpdateSettings?.({ autoDownloadArt: val })}
                trackColor={{ false: '#27272A', true: '#38BDF8' }}
                thumbColor="#FFFFFF"
              />
            </View>

            <View style={styles.toggleRow}>
              <View style={styles.toggleTextCol}>
                <Text style={styles.toggleLabel}>{t('artId3')}</Text>
                <Text style={styles.toggleSubLabel}>{t('artId3Sub')}</Text>
              </View>
              <Switch
                value={settings.preferEmbeddedArt}
                onValueChange={(val) => onUpdateSettings?.({ preferEmbeddedArt: val })}
                trackColor={{ false: '#27272A', true: '#38BDF8' }}
                thumbColor="#FFFFFF"
              />
            </View>

            <View style={styles.toggleRow}>
              <View style={styles.toggleTextCol}>
                <Text style={styles.toggleLabel}>{t('artLossless')}</Text>
                <Text style={styles.toggleSubLabel}>{t('artLosslessSub')}</Text>
              </View>
              <Switch
                value={settings.highQualityArt}
                onValueChange={(val) => onUpdateSettings?.({ highQualityArt: val })}
                trackColor={{ false: '#27272A', true: '#38BDF8' }}
                thumbColor="#FFFFFF"
              />
            </View>

            {/* La carte « cache de pochettes » et son bouton « vider » ont été
                retirés : il n'existe aucun cache. Les pistes importées n'ont pas
                de pochette sur natif, et la carte annonçait « 18 pochettes ·
                3.2 Mo » avec un bouton de purge qui vidait rien. Un compteur de
                cache qui ne compte rien est un mensonge d'interface ; il est plus
                utile de ne pas avoir de bouton du tout. */}
          </View>
        );

      case 'library':
        return (
          <View style={styles.subModalOptions}>
            <TouchableOpacity
              style={styles.primaryActionBtn}
              onPress={handleTriggerRescan}
              disabled={rescanLoading}
              activeOpacity={0.8}
            >
              {rescanLoading ? (
                <ActivityIndicator size="small" color="#000000" />
              ) : (
                <Ionicons name="refresh" size={18} color="#000000" />
              )}
              <Text style={styles.primaryActionBtnText}>
                {rescanLoading ? t('libRescanning') : t('libRescanBtn')}
              </Text>
            </TouchableOpacity>

            {rescanSuccess !== null && (
              <View style={styles.resetSuccessBox}>
                <Ionicons name="checkmark-circle" size={16} color="#4ADE80" />
                <Text style={styles.resetSuccessText}>
                  {t('libRescanFound', undefined, { count: rescanSuccess })}
                </Text>
              </View>
            )}

            {rescanError && (
              <View style={styles.resetErrorBox}>
                <Ionicons name="alert-circle" size={16} color="#EF4444" />
                <Text style={styles.resetErrorText}>{t('libRescanFailed')}</Text>
              </View>
            )}

            <View style={styles.optionSection}>
              <Text style={styles.sectionLabel}>{t('libSortSection')}</Text>
              <View style={styles.chipRow}>
                {[
                  { id: 'title', label: t('sortTitle') },
                  { id: 'artist', label: t('sortArtist') },
                  { id: 'album', label: t('sortAlbum') },
                  { id: 'date', label: t('sortDate') },
                ].map((s) => (
                  <TouchableOpacity
                    key={s.id}
                    style={[
                      styles.choiceChip,
                      settings.librarySort === s.id && styles.choiceChipActive,
                    ]}
                    onPress={() => onUpdateSettings?.({ librarySort: s.id as any })}
                  >
                    <Text
                      style={[
                        styles.choiceChipText,
                        settings.librarySort === s.id && styles.choiceChipTextActive,
                      ]}
                    >
                      {s.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            <View style={styles.toggleRow}>
              <View style={styles.toggleTextCol}>
                <Text style={styles.toggleLabel}>{t('libIgnoreShort')}</Text>
                <Text style={styles.toggleSubLabel}>{t('libIgnoreShortSub')}</Text>
              </View>
              <Switch
                value={settings.ignoreShortAudio}
                onValueChange={(val) => onUpdateSettings?.({ ignoreShortAudio: val })}
                trackColor={{ false: '#27272A', true: '#38BDF8' }}
                thumbColor="#FFFFFF"
              />
            </View>

            <View style={styles.toggleRow}>
              <View style={styles.toggleTextCol}>
                <Text style={styles.toggleLabel}>{t('libClearQueue')}</Text>
                <Text style={styles.toggleSubLabel}>{t('libClearQueueSub')}</Text>
              </View>
              <Switch
                value={settings.clearQueueOnNewPlay}
                onValueChange={(val) => onUpdateSettings?.({ clearQueueOnNewPlay: val })}
                trackColor={{ false: '#27272A', true: '#38BDF8' }}
                thumbColor="#FFFFFF"
              />
            </View>

            <View style={styles.statusCard}>
              <Text style={styles.statusCardTitle}>{t('libFoldersTitle')}</Text>
              <View style={styles.statusCardRow}>
                <Text style={styles.statusCardLabel}>Dossier :</Text>
                <Text style={styles.statusCardValue}>{t('libFolderStorage')}</Text>
              </View>
              <View style={styles.statusCardRow}>
                <Text style={styles.statusCardLabel}>{t('libFormats')}</Text>
                <Text style={styles.statusCardValue}>MP3, FLAC, WAV, AAC, M4A, OGG</Text>
              </View>
            </View>
          </View>
        );

      case 'headset_bluetooth':
        return (
          <View style={styles.subModalOptions}>
            <View style={styles.toggleRow}>
              <View style={styles.toggleTextCol}>
                <Text style={styles.toggleLabel}>{t('hsPauseDisconnect')}</Text>
                <Text style={styles.toggleSubLabel}>{t('hsPauseDisconnectSub')}</Text>
              </View>
              <Switch
                value={settings.pauseOnDisconnect}
                onValueChange={(val) => onUpdateSettings?.({ pauseOnDisconnect: val })}
                trackColor={{ false: '#27272A', true: '#38BDF8' }}
                thumbColor="#FFFFFF"
              />
            </View>

            <View style={styles.toggleRow}>
              <View style={styles.toggleTextCol}>
                <Text style={styles.toggleLabel}>{t('hsResumeConnect')}</Text>
                <Text style={styles.toggleSubLabel}>{t('hsResumeConnectSub')}</Text>
              </View>
              <Switch
                value={settings.resumeOnConnect}
                onValueChange={(val) => onUpdateSettings?.({ resumeOnConnect: val })}
                trackColor={{ false: '#27272A', true: '#38BDF8' }}
                thumbColor="#FFFFFF"
              />
            </View>

            <View style={styles.toggleRow}>
              <View style={styles.toggleTextCol}>
                <Text style={styles.toggleLabel}>{t('hsButtons')}</Text>
                <Text style={styles.toggleSubLabel}>{t('hsButtonsSub')}</Text>
              </View>
              <Switch
                value={settings.headsetButtons}
                onValueChange={(val) => onUpdateSettings?.({ headsetButtons: val })}
                trackColor={{ false: '#27272A', true: '#38BDF8' }}
                thumbColor="#FFFFFF"
              />
            </View>

            <View style={styles.statusCard}>
              <Text style={styles.statusCardTitle}>{t('hsDeviceTitle')}</Text>
              <View style={styles.statusCardRow}>
                <Text style={styles.statusCardLabel}>{t('hsActiveOutput')}</Text>
                <Text style={styles.statusCardValue}>{t('hsActiveOutputVal')}</Text>
              </View>
              <View style={styles.statusCardRow}>
                <Text style={styles.statusCardLabel}>{t('hsProfile')}</Text>
                <Text style={styles.statusCardValue}>{t('hsProfileVal')}</Text>
              </View>
            </View>
          </View>
        );

      case 'lock_screen':
        return (
          <View style={styles.subModalOptions}>
            <View style={styles.toggleRow}>
              <View style={styles.toggleTextCol}>
                <Text style={styles.toggleLabel}>{t('lsControls')}</Text>
                <Text style={styles.toggleSubLabel}>{t('lsControlsSub')}</Text>
              </View>
              <Switch
                value={settings.lockScreenControls}
                onValueChange={(val) => onUpdateSettings?.({ lockScreenControls: val })}
                trackColor={{ false: '#27272A', true: '#38BDF8' }}
                thumbColor="#FFFFFF"
              />
            </View>

            <View style={styles.toggleRow}>
              <View style={styles.toggleTextCol}>
                <Text style={styles.toggleLabel}>{t('lsArt')}</Text>
                <Text style={styles.toggleSubLabel}>{t('lsArtSub')}</Text>
              </View>
              <Switch
                value={settings.lockScreenAlbumArt}
                onValueChange={(val) => onUpdateSettings?.({ lockScreenAlbumArt: val })}
                trackColor={{ false: '#27272A', true: '#38BDF8' }}
                thumbColor="#FFFFFF"
              />
            </View>

            <View style={styles.toggleRow}>
              <View style={styles.toggleTextCol}>
                <Text style={styles.toggleLabel}>{t('lsSeek')}</Text>
                <Text style={styles.toggleSubLabel}>{t('lsSeekSub')}</Text>
              </View>
              <Switch
                value={settings.lockScreenSeekButtons}
                onValueChange={(val) => onUpdateSettings?.({ lockScreenSeekButtons: val })}
                trackColor={{ false: '#27272A', true: '#38BDF8' }}
                thumbColor="#FFFFFF"
              />
            </View>

            <View style={styles.toggleRow}>
              <View style={styles.toggleTextCol}>
                <Text style={styles.toggleLabel}>{t('lsWakeLock')}</Text>
                <Text style={styles.toggleSubLabel}>{t('lsWakeLockSub')}</Text>
              </View>
              <Switch
                value={settings.keepScreenAwake}
                onValueChange={(val) => onUpdateSettings?.({ keepScreenAwake: val })}
                trackColor={{ false: '#27272A', true: '#38BDF8' }}
                thumbColor="#FFFFFF"
              />
            </View>
          </View>
        );

      default:
        return null;
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent={true}
      statusBarTranslucent={true}
      onRequestClose={onClose}
    >
      <StatusBar style="light" />
      <SafeAreaView
        style={styles.safeContainer}
        edges={['left', 'right', 'bottom']}
      >
        {/* Header */}
        <View
          style={[
            styles.header,
            {
              // Marge système mesurée : protège sous la barre d'état (notch/Dynamic Island/punch-hole)
              // sur iOS et Android et préserve 14 px d'aération esthétique.
              paddingTop: insetPadding(insets, 'top', 14),
            },
          ]}
        >
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
              placeholder={t('searchSettings')}
              placeholderTextColor="#71717A"
              value={searchQuery}
              onChangeText={setSearchQuery}
              autoFocus
            />
          ) : (
            <Text style={styles.headerTitle}>{t('settingsTitle')}</Text>
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

        {/* Rescan Notification Banner — refléte le compte réel, jamais un succès par défaut */}
        {rescanSuccess !== null && (
          <View style={styles.rescanBanner}>
            <Ionicons name="checkmark-circle" size={18} color="#4ADE80" />
            <Text style={styles.rescanBannerText}>
              {t('libRescanFound', undefined, { count: rescanSuccess })}
            </Text>
          </View>
        )}

        {/* Section Sub-header */}
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionHeaderText}>{t('sectionSettings')}</Text>
        </View>

        {/* Settings List */}
        <ScrollView
          style={styles.scrollList}
          contentContainerStyle={[
            styles.scrollContent,
            {
              // Le fond fixe de 40 px ne suffisait pas : sous Android 15 bord à bord il
              // est plus court que la barre de navigation, et la dernière ligne
              // passait dessous. `insetPaddingBelow` ajoute la marge mesurée
              // sur Android sans la doubler sur iOS, où le SafeAreaView la
              // pose déjà.
              paddingBottom: insetPaddingBelow(insets, 24),
            },
          ]}
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
                <Text style={styles.itemTitleText}>{t(item.titleKey)}</Text>
                <Text style={styles.itemSubtitleText}>{t(item.subtitleKey)}</Text>
              </View>

              <Feather name="chevron-right" size={18} color="#52525B" />
            </TouchableOpacity>
          ))}

          {/* Information & Version simple et professionnelle */}
          <View style={styles.aboutVersionCard}>
            <View style={styles.aboutVersionHeader}>
              <Image
                source={require('../../assets/mas_icon_square.png')}
                style={styles.aboutAppIcon}
                resizeMode="contain"
              />
              <Text style={styles.aboutAppName}>{APP_NAME}</Text>
              <View style={styles.aboutVersionBadge}>
                <Text style={styles.aboutVersionBadgeText}>v{APP_VERSION}</Text>
              </View>
            </View>

            <Text style={styles.aboutCopyrightText}>
              © 2026 {APP_AUTHOR} • {t('allRightsReserved')}
            </Text>
          </View>
        </ScrollView>

        {/* Detail Sub-Panel Modal */}
        {selectedSetting && (
          <Modal
            visible={!!selectedSetting}
            animationType="fade"
            transparent
            statusBarTranslucent={true}
            onRequestClose={() => setSelectedSetting(null)}
          >
            <View
              style={[
                styles.subModalOverlay,
                {
                  // La boîte est centrée et plafonnée à 88 % : la marge libre
                  // restante en bas vaut ~6 % de la hauteur, soit à peine la
                  // barre gestuelle Android. On réserve la marge système pour
                  // que le centrage se fasse dans la zone visible — un
                  // paddingBottom fixe ne réglerait qu'une barre de 16 px.
                  paddingBottom: insetPadding(insets, 'bottom', 16),
                },
              ]}
            >
              <View style={styles.subModalBox}>
                <View style={styles.subModalHeader}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                    <MaterialCommunityIcons
                      name={selectedSetting.icon}
                      size={24}
                      color={selectedSetting.iconColor}
                    />
                    <Text style={styles.subModalTitle}>{t(selectedSetting.titleKey)}</Text>
                  </View>
                  <TouchableOpacity
                    onPress={() => setSelectedSetting(null)}
                    style={{ padding: 4 }}
                  >
                    <Ionicons name="close" size={24} color="#FFFFFF" />
                  </TouchableOpacity>
                </View>

                <Text style={styles.subModalSubtitle}>
                  {t(selectedSetting.subtitleKey)}
                </Text>

                <View style={styles.subModalDivider} />

                <ScrollView
                  style={styles.subModalScroll}
                  contentContainerStyle={styles.subModalScrollContent}
                  showsVerticalScrollIndicator={false}
                >
                  {renderCategoryContent()}
                </ScrollView>

                <TouchableOpacity
                  style={styles.closeSubModalBtn}
                  onPress={() => setSelectedSetting(null)}
                  activeOpacity={0.8}
                >
                  <Text style={styles.closeSubModalBtnText}>{t('close')}</Text>
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
    backgroundColor: 'rgba(5, 9, 20, 0.96)',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(0, 212, 255, 0.25)',
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
    borderBottomWidth: 0.5,
    borderBottomColor: '#1C1B22',
  },
  iconWrapper: {
    width: 38,
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  textWrapper: {
    flex: 1,
    marginLeft: 12,
    paddingRight: 10,
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
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  subModalBox: {
    width: '100%',
    maxWidth: 440,
    maxHeight: '88%',
    backgroundColor: '#1A191E',
    borderRadius: 20,
    padding: 20,
    borderWidth: 1,
    borderColor: '#2F2E36',
  },
  subModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  subModalTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  subModalSubtitle: {
    fontSize: 12.5,
    color: '#9E98A6',
    marginBottom: 12,
  },
  subModalDivider: {
    height: 1,
    backgroundColor: '#2E2D33',
    marginBottom: 14,
  },
  subModalScroll: {
    // Cette zone ne doit pas avoir de hauteur en dur. La boîte qui la contient est
    // plafonnée à 88 % de l'écran, et 460 px fixes la dépassaient sur les écrans
    // bas : le ScrollView ne se réduisait pas (flexShrink vaut 0 par défaut dans
    // React Native), donc le bouton « Fermer » débordait sous la boîte — c'est-à-
    // dire sous la barre de navigation du téléphone, où il était rogné. En
    // paysage le panneau entier était tronqué.
    //
    // `flexShrink: 1` laisse le défilement absorber exactement l'espace restant
    // après l'en-tête et le bouton : court contenu → panneau compact, contenu
    // long → le panneau plafonne et défile, et le bouton reste toujours visible.
    flexShrink: 1,
  },
  subModalScrollContent: {
    paddingBottom: 12,
  },
  subModalOptions: {
    gap: 16,
  },
  optionSection: {
    gap: 8,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#94A3B8',
    letterSpacing: 0.8,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  choiceChip: {
    backgroundColor: '#27262D',
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#383742',
  },
  choiceChipActive: {
    backgroundColor: 'rgba(56, 189, 248, 0.15)',
    borderColor: '#38BDF8',
  },
  choiceChipText: {
    color: '#A1A1AA',
    fontSize: 12.5,
    fontWeight: '600',
  },
  choiceChipTextActive: {
    color: '#38BDF8',
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  toggleTextCol: {
    flex: 1,
    paddingRight: 14,
  },
  toggleLabel: {
    color: '#F4F4F5',
    fontSize: 14.5,
    fontWeight: '600',
  },
  toggleSubLabel: {
    color: '#71717A',
    fontSize: 12,
    marginTop: 2,
    lineHeight: 16,
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
  primaryActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#38BDF8',
    borderRadius: 12,
    paddingVertical: 12,
  },
  primaryActionBtnText: {
    color: '#000000',
    fontSize: 14,
    fontWeight: '700',
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: 'rgba(56, 189, 248, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.3)',
    borderRadius: 10,
    paddingVertical: 10,
    marginTop: 4,
  },
  actionBtnText: {
    color: '#38BDF8',
    fontSize: 13.5,
    fontWeight: '600',
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
  resetErrorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    borderRadius: 10,
    paddingVertical: 10,
    marginTop: 4,
  },
  resetErrorText: {
    color: '#EF4444',
    fontSize: 13,
    fontWeight: '600',
  },
  closeSubModalBtn: {
    backgroundColor: '#27272A',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 14,
  },
  closeSubModalBtnText: {
    color: '#FFFFFF',
    fontSize: 14.5,
    fontWeight: '600',
  },
  aboutVersionCard: {
    backgroundColor: '#0F1218',
    borderRadius: 16,
    padding: 18,
    marginTop: 22,
    borderWidth: 1,
    borderColor: '#1E2530',
    alignItems: 'center',
  },
  aboutVersionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
  },
  aboutAppIcon: {
    width: 24,
    height: 24,
    borderRadius: 6,
  },
  aboutAppName: {
    color: '#F3F4F6',
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  aboutVersionBadge: {
    backgroundColor: 'rgba(56, 189, 248, 0.15)',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.3)',
  },
  aboutVersionBadgeText: {
    color: '#38BDF8',
    fontSize: 11,
    fontWeight: '700',
  },
  aboutCopyrightText: {
    color: '#94A3B8',
    fontSize: 12.5,
    fontWeight: '500',
    marginTop: 6,
    textAlign: 'center',
    letterSpacing: 0.2,
  },
});
