import React from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  Platform,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { MaterialCommunityIcons, Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useScreenInsets, insetPadding, insetPaddingBelow } from '../theme/insets';
import { Track } from '../types/audio';
import { formatTime } from '../services/audioService';
import { AnimeBackground } from './AnimeBackground';
import { LanguageCode, getTranslation } from '../i18n/translations';

interface QueueDrawerModalProps {
  visible: boolean;
  queue: Track[];
  onClose: () => void;
  onPlayQueuedTrack: (track: Track, index: number) => void;
  onRemoveFromQueue: (index: number) => void;
  onClearQueue: () => void;
  onMoveQueueItem: (fromIndex: number, toIndex: number) => void;
  language?: LanguageCode;
}

export const QueueDrawerModal: React.FC<QueueDrawerModalProps> = ({
  visible,
  queue,
  onClose,
  onPlayQueuedTrack,
  onRemoveFromQueue,
  onClearQueue,
  onMoveQueueItem,
  language = 'fr',
}) => {
  const lang = language || 'fr';
  const t = (k: string, fb?: string, params?: Record<string, string | number>) =>
    getTranslation(lang, k, fb, params);

  // Marge système mesurée, lue par contexte : le tiroir est monté hors de
  // l'écran et n'en hérite pas. Voir src/theme/insets.ts.
  const insets = useScreenInsets();
  return (
    <Modal
      visible={visible}
      animationType="fade"
      transparent
      statusBarTranslucent={true}
      onRequestClose={onClose}
    >
      <StatusBar style="light" />
      <View style={styles.overlay}>
        {/* Backdrop to tap to close */}
        <TouchableOpacity
          style={styles.backdrop}
          activeOpacity={1}
          onPress={onClose}
        />

        {/* Drawer sliding in from left */}
        <SafeAreaView
          style={styles.drawerContainer}
          edges={['left', 'right', 'bottom']}
        >
          <AnimeBackground
            backgroundStyle="oled"
          />
          <View
            style={[
              styles.header,
              {
                paddingTop: insetPadding(insets, 'top', 14),
              },
            ]}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <MaterialCommunityIcons name="clock-outline" size={26} color="#FFFFFF" />
              <View>
                <Text style={styles.headerTitle}>{t('queueTitle', 'Lire plus tard')}</Text>
                <Text style={styles.headerSub}>
                  {t('queueSub', "File d'attente ({count})", { count: queue.length })}
                </Text>
              </View>
            </View>

            <View style={styles.headerActions}>
              {queue.length > 0 && (
                <TouchableOpacity
                  style={styles.clearBtn}
                  onPress={() => {
                    try {
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                    } catch {}
                    onClearQueue();
                  }}
                >
                  <Text style={styles.clearBtnText}>{t('clearQueue', 'Vider')}</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity style={styles.closeBtn} onPress={onClose}>
                <Ionicons name="close" size={24} color="#FFFFFF" />
              </TouchableOpacity>
            </View>
          </View>

          <View style={styles.divider} />

          {/* Queue List */}
          {queue.length === 0 ? (
            <View style={styles.emptyContainer}>
              <MaterialCommunityIcons
                name="playlist-remove"
                size={54}
                color="#52525B"
              />
              <Text style={styles.emptyTitle}>{t('queueEmpty', "File d'attente vide")}</Text>
              <Text style={styles.emptySub}>
                {t(
                  'queueEmptySub',
                  'Pour programmer des morceaux à lire plus tard, maintenez votre doigt appuyé sur un morceau et sélectionnez "Lire plus tard" ou "Lire ensuite".'
                )}
              </Text>
            </View>
          ) : (
            <FlatList
              data={queue}
              keyExtractor={(item, idx) => `${item.id}-${idx}`}
              contentContainerStyle={[
                styles.listContent,
                {
                  // Aucune marge basse n'était prévue : la dernière ligne de la
                  // file se retrouvait sous la barre de navigation. Le tiroir est
                  // bord à bord, donc c'est la seule protection possible ici.
                  paddingBottom: insetPaddingBelow(insets, 20),
                },
              ]}
              renderItem={({ item, index }) => (
                <View style={styles.queueItemRow}>
                  {/* Order Index */}
                  <View style={styles.indexBox}>
                    <Text style={styles.indexText}>{index + 1}</Text>
                  </View>

                  {/* Thumbnail / Icon */}
                  <View style={styles.thumbBox}>
                    {item.artwork ? (
                      <Image source={{ uri: item.artwork }} style={styles.thumb} />
                    ) : (
                      <MaterialCommunityIcons
                        name="music-note"
                        size={20}
                        color="#FFFFFF"
                      />
                    )}
                  </View>

                  {/* Metadata */}
                  <TouchableOpacity
                    style={styles.metaBox}
                    onPress={() => {
                      try {
                        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      } catch {}
                      onPlayQueuedTrack(item, index);
                      onClose();
                    }}
                  >
                    <Text numberOfLines={1} style={styles.trackTitle}>
                      {item.title}
                    </Text>
                    <Text numberOfLines={1} style={styles.trackArtist}>
                      {item.artist} • {item.duration && item.duration > 0 ? formatTime(item.duration) : '--:--'}
                    </Text>
                  </TouchableOpacity>

                  {/* Item Actions: Move Up, Move Down, Delete */}
                  <View style={styles.itemActions}>
                    {index > 0 && (
                      <TouchableOpacity
                        style={styles.actionBtn}
                        onPress={() => onMoveQueueItem(index, index - 1)}
                      >
                        <Ionicons name="chevron-up" size={18} color="#94A3B8" />
                      </TouchableOpacity>
                    )}
                    {index < queue.length - 1 && (
                      <TouchableOpacity
                        style={styles.actionBtn}
                        onPress={() => onMoveQueueItem(index, index + 1)}
                      >
                        <Ionicons name="chevron-down" size={18} color="#94A3B8" />
                      </TouchableOpacity>
                    )}
                    <TouchableOpacity
                      style={styles.actionBtn}
                      onPress={() => {
                        try {
                          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                        } catch {}
                        onRemoveFromQueue(index);
                      }}
                    >
                      <Ionicons name="trash-outline" size={18} color="#F87171" />
                    </TouchableOpacity>
                  </View>
                </View>
              )}
            />
          )}
        </SafeAreaView>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    flexDirection: 'row',
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
  },
  drawerContainer: {
    width: '84%',
    maxWidth: 380,
    height: '100%',
    backgroundColor: '#000000',
    borderRightWidth: 1,
    borderRightColor: 'rgba(255, 255, 255, 0.25)',
    shadowColor: '#FFFFFF',
    shadowOffset: { width: 4, height: 0 },
    shadowOpacity: 0.15,
    shadowRadius: 16,
    elevation: 20,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  headerSub: {
    fontSize: 12,
    color: '#94A3B8',
    marginTop: 1,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  clearBtn: {
    backgroundColor: '#27262E',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
  },
  clearBtnText: {
    color: '#F87171',
    fontSize: 12.5,
    fontWeight: '600',
  },
  closeBtn: {
    padding: 6,
  },
  divider: {
    height: 1,
    backgroundColor: '#222127',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 28,
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#E4E4E7',
    marginTop: 16,
  },
  emptySub: {
    fontSize: 13,
    color: '#71717A',
    textAlign: 'center',
    marginTop: 8,
    lineHeight: 18,
  },
  listContent: {
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  queueItemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRadius: 10,
    marginBottom: 4,
    backgroundColor: '#19181E',
  },
  indexBox: {
    width: 24,
    justifyContent: 'center',
    alignItems: 'center',
  },
  indexText: {
    color: '#71717A',
    fontSize: 12,
    fontWeight: '600',
  },
  thumbBox: {
    width: 38,
    height: 38,
    borderRadius: 6,
    backgroundColor: '#24232B',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 10,
    overflow: 'hidden',
  },
  thumb: {
    width: '100%',
    height: '100%',
  },
  metaBox: {
    flex: 1,
  },
  trackTitle: {
    fontSize: 14.5,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  trackArtist: {
    fontSize: 12,
    color: '#94A3B8',
    marginTop: 2,
  },
  itemActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  actionBtn: {
    padding: 6,
  },
});
