import React, { useState, useRef, useEffect } from 'react';
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
  ActivityIndicator,
  Animated,
  Image,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { Ionicons, MaterialCommunityIcons, Feather } from '@expo/vector-icons';
import { useScreenInsets, insetPadding, insetPaddingBelow } from '../theme/insets';
import * as Haptics from 'expo-haptics';

import { AppSettings, DEFAULT_APP_SETTINGS } from '../services/storageService';
import { APP_VERSION, APP_NAME, APP_AUTHOR, APP_COPYRIGHT } from '../constants/version';
import { getTranslation, LANGUAGES, LanguageCode } from '../i18n/translations';
import { ChangelogModal } from './ChangelogModal';
import { AboutModal } from './AboutModal';
import { CountryFlag } from './CountryFlag';
import { AnimeBackground } from './AnimeBackground';
import { Track } from '../types/audio';
import {
  downloadMissingArtworks,
  clearArtworkCache,
} from '../services/albumArtService';

export const POWERAMP_TEAL = '#FFFFFF';

interface SettingsModalProps {
  visible: boolean;
  onClose: () => void;
  onRescanLibrary?: () => Promise<number>;
  settings?: AppSettings;
  onUpdateSettings?: (newSettings: Partial<AppSettings>) => void;
  tracks?: Track[];
  onUpdateTracks?: (newTracks: Track[]) => Promise<void> | void;
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
    id: 'look_and_feel',
    titleKey: 'cat_look_title',
    subtitleKey: 'cat_look_sub',
    icon: 'translate',
    iconColor: '#38BDF8',
  },
  {
    id: 'audio',
    titleKey: 'cat_audio_title',
    subtitleKey: 'cat_audio_sub',
    icon: 'volume-high',
    iconColor: '#E27690',
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
  {
    id: 'about',
    titleKey: 'cat_about_title',
    subtitleKey: 'cat_about_sub',
    icon: 'information-outline',
    iconColor: POWERAMP_TEAL,
  },
];

export const SettingsModal: React.FC<SettingsModalProps> = ({
  visible,
  onClose,
  onRescanLibrary,
  settings = DEFAULT_APP_SETTINGS,
  onUpdateSettings,
  tracks = [],
  onUpdateTracks,
}) => {
  // Marge système mesurée, lue par contexte : la modale est montée hors de
  // l'écran et n'en hérite pas. Voir src/theme/insets.ts.
  const insets = useScreenInsets();
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isSearchActive, setIsSearchActive] = useState<boolean>(false);
  const [selectedSetting, setSelectedSetting] = useState<SettingCategory | null>(null);
  const [subSearchQuery, setSubSearchQuery] = useState<string>('');
  const [isSubSearchActive, setIsSubSearchActive] = useState<boolean>(false);
  const [showChangelog, setShowChangelog] = useState<boolean>(false);
  const [showAbout, setShowAbout] = useState<boolean>(false);

  // `rescanSuccess` porte le nombre de morceaux ajoutés — `null` tant que le
  // scan n'a rien donné. Un booléen separate ne suffirait pas : « actualisée »
  // sans dire combien de morceaux ont réellement été trouvés est exactement le
  // vide que ce handler vient de combler.
  const [rescanSuccess, setRescanSuccess] = useState<number | null>(null);
  const [rescanError, setRescanError] = useState<boolean>(false);
  const [rescanLoading, setRescanLoading] = useState<boolean>(false);

  // Gestion des pochettes d'album
  const [artDownloading, setArtDownloading] = useState<boolean>(false);
  const [artDownloadResult, setArtDownloadResult] = useState<string | null>(null);
  const [artClearResult, setArtClearResult] = useState<boolean>(false);

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
    if (item.id === 'changelog') {
      setShowChangelog(true);
      return;
    }
    if (item.id === 'about') {
      setShowAbout(true);
      return;
    }
    setSelectedSetting(item);
  };

  const handleBack = () => {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {}
    if (selectedSetting) {
      setSelectedSetting(null);
      setIsSubSearchActive(false);
      setSubSearchQuery('');
    } else {
      onClose();
    }
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

  const handleDownloadAlbumArt = async () => {
    if (!tracks || tracks.length === 0) {
      setArtDownloadResult(t('artDownloadNone'));
      return;
    }
    setArtDownloading(true);
    setArtDownloadResult(null);
    setArtClearResult(false);
    try {
      const { updatedTracks, addedCount } = await downloadMissingArtworks(
        tracks,
        settings.highQualityArt !== false
      );
      if (addedCount > 0) {
        await onUpdateTracks?.(updatedTracks);
        try {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        } catch {}
        setArtDownloadResult(t('artDownloadSuccess', undefined, { count: addedCount }));
      } else {
        setArtDownloadResult(t('artDownloadNone'));
      }
    } catch (e) {
      console.warn('Erreur téléchargement pochettes:', e);
    } finally {
      setArtDownloading(false);
    }
  };

  const handleClearAlbumArt = async () => {
    if (!tracks || tracks.length === 0) return;
    Alert.alert(
      t('artClearCacheBtn', 'Vider les pochettes'),
      t('artClearConfirm', 'Voulez-vous supprimer les pochettes téléchargées pour la bibliothèque ?'),
      [
        { text: t('cancel', 'Annuler'), style: 'cancel' },
        {
          text: t('delete', 'Supprimer'),
          style: 'destructive',
          onPress: async () => {
            try {
              clearArtworkCache();
              // Ne retire que les pochettes téléchargées sur internet (http/https) pour préserver les fichiers locaux
              const clearedTracks = tracks.map((t) => {
                if (t.artwork && (t.artwork.startsWith('http://') || t.artwork.startsWith('https://'))) {
                  return { ...t, artwork: undefined };
                }
                return t;
              });
              await onUpdateTracks?.(clearedTracks);
              try {
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
              } catch {}
              setArtClearResult(true);
              setArtDownloadResult(null);
            } catch (e) {
              console.warn('Erreur effacement pochettes:', e);
            }
          },
        },
      ]
    );
  };

  const renderCategoryContent = () => {
    if (!selectedSetting) return null;

    switch (selectedSetting.id) {
      case 'look_and_feel':
        return (
          <View style={styles.subModalOptions}>
            <View style={styles.languageGroup}>
              {LANGUAGES.map((l, index) => {
                const isActive = settings.language === l.code;
                const isLast = index === LANGUAGES.length - 1;
                return (
                  <TouchableOpacity
                    key={l.code}
                    style={[
                      styles.languageRow,
                      isActive && styles.languageRowActive,
                      !isLast && styles.languageRowBorder,
                    ]}
                    onPress={() => {
                      try {
                        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      } catch {}
                      onUpdateSettings?.({ language: l.code });
                    }}
                    activeOpacity={0.7}
                  >
                    <View style={styles.languageRowLeft}>
                      <CountryFlag code={l.code} width={28} height={19} />
                      <Text
                        style={[
                          styles.languageRowLabel,
                          isActive && styles.languageRowLabelActive,
                        ]}
                      >
                        {l.label}
                      </Text>
                    </View>

                    {isActive && (
                      <Ionicons name="checkmark" size={20} color="#FFFFFF" />
                    )}
                  </TouchableOpacity>
                );
              })}
            </View>

            <Text style={styles.languageFootnote}>
              {t('languageFootnote')}
            </Text>
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
                trackColor={{ false: '#27272A', true: POWERAMP_TEAL }}
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
                trackColor={{ false: '#27272A', true: POWERAMP_TEAL }}
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
                trackColor={{ false: '#27272A', true: POWERAMP_TEAL }}
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
                trackColor={{ false: '#27272A', true: POWERAMP_TEAL }}
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
                trackColor={{ false: '#27272A', true: POWERAMP_TEAL }}
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
                trackColor={{ false: '#27272A', true: POWERAMP_TEAL }}
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
                trackColor={{ false: '#27272A', true: POWERAMP_TEAL }}
                thumbColor="#FFFFFF"
              />
            </View>
          </View>
        );

      case 'album_art': {
        const tracksWithArt = tracks.filter((t) => Boolean(t.artwork && t.artwork.trim() !== '')).length;
        const totalTracks = tracks.length;

        return (
          <View style={styles.subModalOptions}>
            {/* Bouton d'action principal : Téléchargement des pochettes manquantes */}
            <TouchableOpacity
              style={styles.primaryActionBtn}
              onPress={handleDownloadAlbumArt}
              disabled={artDownloading}
              activeOpacity={0.8}
            >
              {artDownloading ? (
                <ActivityIndicator size="small" color="#000000" />
              ) : (
                <Ionicons name="cloud-download-outline" size={18} color="#000000" />
              )}
              <Text style={styles.primaryActionBtnText}>
                {artDownloading ? t('artDownloading') : t('artDownloadBtn')}
              </Text>
            </TouchableOpacity>

            {artDownloadResult && (
              <View style={styles.resetSuccessBox}>
                <Ionicons name="checkmark-circle" size={16} color="#4ADE80" />
                <Text style={styles.resetSuccessText}>{artDownloadResult}</Text>
              </View>
            )}

            {artClearResult && (
              <View style={styles.resetSuccessBox}>
                <Ionicons name="trash-outline" size={16} color="#38BDF8" />
                <Text style={styles.resetSuccessText}>{t('artClearSuccess')}</Text>
              </View>
            )}

            {/* Réglages à bascule */}
            <View style={styles.toggleRow}>
              <View style={styles.toggleTextCol}>
                <Text style={styles.toggleLabel}>{t('artAutoDl')}</Text>
                <Text style={styles.toggleSubLabel}>{t('artAutoDlSub')}</Text>
              </View>
              <Switch
                value={settings.autoDownloadArt}
                onValueChange={(val) => onUpdateSettings?.({ autoDownloadArt: val })}
                trackColor={{ false: '#27272A', true: POWERAMP_TEAL }}
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
                trackColor={{ false: '#27272A', true: POWERAMP_TEAL }}
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
                trackColor={{ false: '#27272A', true: POWERAMP_TEAL }}
                thumbColor="#FFFFFF"
              />
            </View>

            {/* Carte de statut des pochettes */}
            <View style={styles.statusCard}>
              <Text style={styles.statusCardTitle}>{t('artStatusTitle')}</Text>
              <View style={styles.statusCardRow}>
                <Text style={styles.statusCardLabel}>{t('artCountLabel')}</Text>
                <Text style={styles.statusCardValue}>
                  {tracksWithArt} / {totalTracks}
                </Text>
              </View>
              <View style={styles.statusCardRow}>
                <Text style={styles.statusCardLabel}>{t('artQualityLabel')}</Text>
                <Text style={styles.statusCardValue}>
                  {settings.highQualityArt !== false ? 'HD 600×600 px' : '300×300 px'}
                </Text>
              </View>
            </View>

            {/* Action secondaire : vider les pochettes */}
            {tracksWithArt > 0 && (
              <TouchableOpacity
                style={styles.dangerSecondaryBtn}
                onPress={handleClearAlbumArt}
                activeOpacity={0.75}
              >
                <Ionicons name="trash-outline" size={16} color="#EF4444" />
                <Text style={styles.dangerSecondaryBtnText}>
                  {t('artClearCacheBtn')}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        );
      }

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
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Ionicons name="refresh" size={18} color="#FFFFFF" />
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
                trackColor={{ false: '#27272A', true: POWERAMP_TEAL }}
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
                trackColor={{ false: '#27272A', true: POWERAMP_TEAL }}
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
                trackColor={{ false: '#27272A', true: POWERAMP_TEAL }}
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
                trackColor={{ false: '#27272A', true: POWERAMP_TEAL }}
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
                trackColor={{ false: '#27272A', true: POWERAMP_TEAL }}
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
                trackColor={{ false: '#27272A', true: POWERAMP_TEAL }}
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
                trackColor={{ false: '#27272A', true: POWERAMP_TEAL }}
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
                trackColor={{ false: '#27272A', true: POWERAMP_TEAL }}
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
                trackColor={{ false: '#27272A', true: POWERAMP_TEAL }}
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
      onRequestClose={handleBack}
    >
      <StatusBar style="light" />
      <SafeAreaView
        style={styles.safeContainer}
        edges={['left', 'right', 'bottom']}
      >
        {/* Arrière-plan réactif appliquant en temps réel les réglages de l'utilisateur */}
        <AnimeBackground
          backgroundStyle={settings.backgroundStyle}
          blurIntensity={settings.blurIntensity}
          colorSaturation={settings.colorSaturation}
          ambientParticles={settings.ambientParticles}
        />

        {selectedSetting ? (
          /* ==============================================================
             VUE PLEIN ÉCRAN DU SOUS-MENU — STYLE POWERAMP EXACT
             (Flèche retour teal, titre teal, recherche teal, croix teal, pas de modale)
             ============================================================== */
          <View style={styles.subPageContainer}>
            {/* Header Poweramp fidèle à la capture */}
            <View
              style={[
                styles.header,
                {
                  paddingTop: insetPadding(insets, 'top', 14),
                },
              ]}
            >
              <TouchableOpacity
                style={styles.headerIconBtn}
                onPress={handleBack}
                activeOpacity={0.7}
              >
                <Ionicons name="arrow-back" size={24} color={POWERAMP_TEAL} />
              </TouchableOpacity>

              {isSubSearchActive ? (
                <TextInput
                  style={styles.headerSearchInput}
                  placeholder={t('searchSettings')}
                  placeholderTextColor="#71717A"
                  value={subSearchQuery}
                  onChangeText={setSubSearchQuery}
                  autoFocus
                />
              ) : (
                <Text style={styles.subPageHeaderTitle} numberOfLines={1}>
                  {t(selectedSetting.titleKey)}
                </Text>
              )}

              <View style={styles.headerRightActions}>
                <TouchableOpacity
                  style={styles.headerIconBtn}
                  onPress={() => {
                    setIsSubSearchActive(!isSubSearchActive);
                    if (isSubSearchActive) setSubSearchQuery('');
                  }}
                  activeOpacity={0.7}
                >
                  <Ionicons
                    name={isSubSearchActive ? 'close-circle' : 'search'}
                    size={22}
                    color={POWERAMP_TEAL}
                  />
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.headerIconBtn}
                  onPress={() => {
                    setSelectedSetting(null);
                    setIsSubSearchActive(false);
                    setSubSearchQuery('');
                    onClose();
                  }}
                  activeOpacity={0.7}
                >
                  <Ionicons name="close" size={26} color={POWERAMP_TEAL} />
                </TouchableOpacity>
              </View>
            </View>

            {/* Contenu plein écran défilant */}
            <ScrollView
              style={styles.subPageScroll}
              contentContainerStyle={[
                styles.subPageScrollContent,
                {
                  paddingBottom: insetPaddingBelow(insets, 32),
                },
              ]}
              showsVerticalScrollIndicator={false}
            >
              <Text style={styles.subPageDescription}>
                {t(selectedSetting.subtitleKey)}
              </Text>
              <View style={styles.subPageDivider} />

              {renderCategoryContent()}
            </ScrollView>
          </View>
        ) : (
          /* ==============================================================
             LISTE PRINCIPALE DES PARAMÈTRES
             ============================================================== */
          <>
            <View
              style={[
                styles.header,
                {
                  paddingTop: insetPadding(insets, 'top', 14),
                },
              ]}
            >
              <TouchableOpacity
                style={styles.headerIconBtn}
                onPress={onClose}
                activeOpacity={0.7}
              >
                <Ionicons name="arrow-back" size={24} color={POWERAMP_TEAL} />
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
                    color={POWERAMP_TEAL}
                  />
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.headerIconBtn}
                  onPress={onClose}
                  activeOpacity={0.7}
                >
                  <Ionicons name="close" size={26} color={POWERAMP_TEAL} />
                </TouchableOpacity>
              </View>
            </View>

            {/* Rescan Notification Banner */}
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


            </ScrollView>
          </>
        )}

        {/* Modal À propos avec le design du Changelog */}
        <AboutModal
          visible={showAbout}
          onClose={() => setShowAbout(false)}
          language={lang}
          onOpenChangelog={() => {
            setShowAbout(false);
            setShowChangelog(true);
          }}
        />

        {/* Modal Changelog dédié inspiré de Poweramp (Bottom sheet glissant du bas vers le haut) */}
        <ChangelogModal
          visible={showChangelog}
          onClose={() => setShowChangelog(false)}
          language={lang}
        />
      </SafeAreaView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  safeContainer: {
    flex: 1,
    backgroundColor: '#000000',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.1)',
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
    color: '#94A3B8',
    marginTop: 3,
    lineHeight: 17,
  },
  subPageContainer: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.72)',
  },
  subPageHeaderTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#FFFFFF',
    marginLeft: 18,
    flex: 1,
    letterSpacing: -0.2,
  },
  subPageScroll: {
    flex: 1,
  },
  subPageScrollContent: {
    paddingHorizontal: 20,
    paddingTop: 16,
  },
  subPageDescription: {
    fontSize: 13.5,
    color: '#94A3B8',
    lineHeight: 19,
    marginBottom: 16,
  },
  subPageDivider: {
    height: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    marginBottom: 18,
  },
  subModalOptions: {
    gap: 18,
  },
  optionSection: {
    gap: 10,
    paddingVertical: 4,
  },
  sectionLabel: {
    fontSize: 11.5,
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
    backgroundColor: '#111317',
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#262626',
  },
  choiceChipActive: {
    backgroundColor: '#FFFFFF',
    borderColor: '#FFFFFF',
  },
  choiceChipText: {
    color: '#94A3B8',
    fontSize: 12.5,
    fontWeight: '600',
  },
  choiceChipTextActive: {
    color: '#000000',
  },
  languageGroup: {
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    overflow: 'hidden',
    marginTop: 4,
  },
  languageRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    paddingHorizontal: 16,
    backgroundColor: 'transparent',
  },
  languageRowActive: {
    backgroundColor: 'rgba(255, 255, 255, 0.07)',
  },
  languageRowBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255, 255, 255, 0.08)',
  },
  languageRowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  languageRowLabel: {
    fontSize: 16,
    fontWeight: '500',
    color: '#D4D4D8',
    letterSpacing: -0.2,
  },
  languageRowLabelActive: {
    color: '#FFFFFF',
    fontWeight: '700',
  },
  languageFootnote: {
    fontSize: 12.5,
    color: '#71717A',
    lineHeight: 18,
    paddingHorizontal: 4,
    marginTop: 4,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomWidth: 0.5,
    borderBottomColor: 'rgba(255, 255, 255, 0.05)',
  },
  toggleTextCol: {
    flex: 1,
    paddingRight: 14,
  },
  toggleLabel: {
    color: '#F4F4F5',
    fontSize: 15.5,
    fontWeight: '600',
  },
  toggleSubLabel: {
    color: '#94A3B8',
    fontSize: 12.5,
    marginTop: 3,
    lineHeight: 17,
  },
  statusCard: {
    backgroundColor: 'rgba(12, 14, 18, 0.88)',
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: '#262626',
    gap: 8,
    marginTop: 6,
  },
  statusCardTitle: {
    fontSize: 11.5,
    fontWeight: '700',
    color: '#FFFFFF',
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
    color: '#94A3B8',
    fontSize: 12.5,
  },
  statusCardValue: {
    color: '#FFFFFF',
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
    backgroundColor: '#FFFFFF',
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
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.22)',
    borderRadius: 10,
    paddingVertical: 10,
    marginTop: 4,
  },
  actionBtnText: {
    color: '#FFFFFF',
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
  dangerSecondaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 11,
    borderRadius: 10,
    backgroundColor: 'rgba(239, 68, 68, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.25)',
    marginTop: 6,
  },
  dangerSecondaryBtnText: {
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
  // Styles À Propos & Spécifications (Vue Sub-Page)
  aboutHeroCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#141820',
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: '#222834',
    gap: 14,
  },
  aboutHeroIcon: {
    width: 46,
    height: 46,
    borderRadius: 12,
  },
  aboutHeroInfo: {
    flex: 1,
  },
  aboutHeroTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  aboutHeroTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#FFFFFF',
    letterSpacing: -0.2,
  },
  aboutHeroTagline: {
    fontSize: 12,
    color: POWERAMP_TEAL,
    fontWeight: '600',
    marginTop: 3,
  },
  aboutSectionCard: {
    backgroundColor: '#141820',
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: '#222834',
    gap: 10,
  },
  aboutSectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#F1F5F9',
    letterSpacing: 0.3,
  },
  aboutDescriptionText: {
    fontSize: 13,
    color: '#94A3B8',
    lineHeight: 19,
  },
  aboutPillsRow: {
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
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.2)',
  },
  techPillText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
  },
  aboutChangelogLargeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#141820',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: '#222834',
    gap: 12,
  },
  aboutChangelogIconBox: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  aboutChangelogTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  aboutChangelogSub: {
    fontSize: 11.5,
    color: '#94A3B8',
    marginTop: 2,
  },
  aboutLegalCard: {
    backgroundColor: '#141820',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: '#222834',
    gap: 8,
  },

  // Styles Signature Professionnelle (Bas de la liste principale)
  aboutVersionCard: {
    backgroundColor: '#10141C',
    borderRadius: 16,
    padding: 16,
    marginTop: 22,
    borderWidth: 1,
    borderColor: '#1D2432',
  },
  aboutVersionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  aboutAppIcon: {
    width: 34,
    height: 34,
    borderRadius: 8,
  },
  aboutAppName: {
    color: '#F3F4F6',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  aboutVersionBadge: {
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.25)',
  },
  aboutVersionBadgeText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
  },
  aboutAppTaglineText: {
    fontSize: 11.5,
    color: '#94A3B8',
    fontWeight: '500',
    marginTop: 2,
  },
  aboutOpenBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.25)',
  },
  aboutOpenBadgeText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
  },
  aboutBadgesRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 4,
    marginBottom: 8,
  },
  aboutMiniBadge: {
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 0.5,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  aboutMiniBadgeText: {
    color: '#94A3B8',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  aboutAppShortDesc: {
    fontSize: 12,
    color: '#64748B',
    lineHeight: 17,
    marginBottom: 12,
  },
  aboutActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
    marginBottom: 8,
  },
  aboutDetailsBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.25)',
    gap: 6,
  },
  aboutDetailsBtnText: {
    color: '#FFFFFF',
    fontSize: 12.5,
    fontWeight: '600',
  },
  changelogBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.2)',
    gap: 6,
  },
  changelogBtnText: {
    color: '#F1F5F9',
    fontSize: 12.5,
    fontWeight: '600',
  },
  changelogBadge: {
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
  },
  changelogBadgeText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '700',
  },
  aboutCopyrightText: {
    color: '#64748B',
    fontSize: 11.5,
    fontWeight: '500',
    marginTop: 4,
    textAlign: 'center',
    letterSpacing: 0.2,
  },
});
