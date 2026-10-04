import React, { useState } from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  SafeAreaView,
  Image,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Track } from '../types/audio';
import { formatTime } from '../services/audioService';
import { pickAudioFolder, pickAudioFiles, isIOSDevice } from '../services/filePickerService';

interface TrackListModalProps {
  visible: boolean;
  onClose: () => void;
  tracks: Track[];
  currentTrackId?: string;
  onSelectTrack: (track: Track) => void;
  onAddTracks: (newTracks: Track[]) => void;
  onTrackAction?: (track: Track) => void;
}

export const TrackListModal: React.FC<TrackListModalProps> = ({
  visible,
  onClose,
  tracks,
  currentTrackId,
  onSelectTrack,
  onAddTracks,
  onTrackAction,
}) => {
  const [importMessage, setImportMessage] = useState<string | null>(null);

  // IMPORTATION D'UN DOSSIER COMPLET (1 SEUL CLIC)
  const handlePickFolder = async () => {
    try {
      const res = await pickAudioFolder();
      if (res && res.tracks.length > 0) {
        onAddTracks(res.tracks);
        setImportMessage(`Dossier "${res.folderName}" : +${res.count} morceaux`);
        setTimeout(() => setImportMessage(null), 4000);
      }
    } catch (err) {
      console.warn('Erreur sélection dossier:', err);
    }
  };

  // IMPORTATION DE FICHIERS INDIVIDUELS
  const handlePickFiles = async () => {
    try {
      const res = await pickAudioFiles();
      if (res && res.tracks.length > 0) {
        onAddTracks(res.tracks);
        setImportMessage(`+${res.count} morceaux importés`);
        setTimeout(() => setImportMessage(null), 4000);
      }
    } catch (err) {
      console.warn('Erreur sélection fichiers:', err);
    }
  };

  const renderTrackItem = ({ item }: { item: Track }) => {
    const isPlayingCurrent = item.id === currentTrackId;

    return (
      <TouchableOpacity
        style={[styles.trackItem, isPlayingCurrent && styles.trackItemActive]}
        onPress={() => {
          onSelectTrack(item);
          onClose();
        }}
        onLongPress={() => {
          if (onTrackAction) onTrackAction(item);
        }}
        delayLongPress={300}
        activeOpacity={0.7}
      >
        <View style={styles.artworkPlaceholder}>
          <Ionicons
            name="musical-note"
            size={22}
            color={isPlayingCurrent ? '#FFFFFF' : '#64748B'}
          />
        </View>

        <View style={styles.trackInfo}>
          <Text
            numberOfLines={1}
            style={[
              styles.trackTitle,
              isPlayingCurrent && styles.trackTitleActive,
            ]}
          >
            {item.title}
          </Text>
          <Text numberOfLines={1} style={styles.trackArtist}>
            {item.artist} • {item.album}
          </Text>
        </View>

        <View style={styles.formatBadge}>
          <Text style={styles.formatText}>{item.format || 'MP3'}</Text>
        </View>

        {item.duration > 0 && (
          <Text style={styles.durationText}>{formatTime(item.duration)}</Text>
        )}

        {onTrackAction && (
          <TouchableOpacity
            style={{ padding: 6, marginLeft: 4 }}
            onPress={(e) => {
              e.stopPropagation();
              onTrackAction(item);
            }}
          >
            <Ionicons name="ellipsis-vertical" size={18} color="#71717A" />
          </TouchableOpacity>
        )}
      </TouchableOpacity>
    );
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
            <Ionicons name="close" size={26} color="#FFFFFF" />
          </TouchableOpacity>

          <Text style={styles.headerTitle}>DOSSIERS & MUSIQUES</Text>

          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <TouchableOpacity
              onPress={handlePickFolder}
              style={styles.addFolderBtn}
              activeOpacity={0.7}
            >
              <Ionicons name="folder" size={16} color="#10B981" />
              <Text style={styles.addFolderBtnText}>+ Dossier</Text>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={handlePickFiles}
              style={styles.addBtn}
              activeOpacity={0.7}
            >
              <Ionicons name="musical-notes" size={16} color="#38BDF8" />
              <Text style={styles.addBtnText}>+ Fichiers</Text>
            </TouchableOpacity>
          </View>
        </View>

        {importMessage && (
          <View style={styles.successMiniBanner}>
            <Ionicons name="checkmark-circle" size={16} color="#34D399" />
            <Text style={styles.successMiniBannerText}>{importMessage}</Text>
          </View>
        )}

        <View style={styles.infoBanner}>
          <Ionicons name="folder-open-outline" size={18} color="#94A3B8" />
          <Text style={styles.infoBannerText}>
            Formats supportés : FLAC, MP3, WAV, AAC, ALAC
          </Text>
        </View>

        {isIOSDevice() && (
          <View style={styles.iosTipMiniBox}>
            <Ionicons name="information-circle-outline" size={16} color="#38BDF8" />
            <Text style={styles.iosTipMiniText}>
              Sur iPhone/iPad : choisissez votre dossier, une archive .zip d'album, ou « Tout sélectionner » dans Fichiers.
            </Text>
          </View>
        )}

        <FlatList
          data={tracks}
          keyExtractor={(item) => item.id}
          renderItem={renderTrackItem}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Ionicons name="musical-notes-outline" size={48} color="#333333" />
              <Text style={styles.emptyText}>Aucun morceau audio chargé</Text>
              <View style={{ flexDirection: 'row', gap: 10, marginTop: 8 }}>
                <TouchableOpacity
                  style={styles.emptyImportFolderBtn}
                  onPress={handlePickFolder}
                >
                  <Ionicons name="folder-open" size={18} color="#10B981" />
                  <Text style={styles.emptyImportFolderText}>Importer un dossier (1 clic)</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.emptyImportBtn}
                  onPress={handlePickFiles}
                >
                  <Text style={styles.emptyImportText}>Fichiers</Text>
                </TouchableOpacity>
              </View>
            </View>
          }
        />
      </SafeAreaView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#1A1A1A',
  },
  closeBtn: {
    padding: 4,
  },
  headerTitle: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: 1.5,
  },
  addFolderBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#06281E',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#059669',
    gap: 4,
  },
  addFolderBtnText: {
    color: '#6EE7B7',
    fontSize: 12,
    fontWeight: '700',
  },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1E232D',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#303846',
    gap: 4,
  },
  addBtnText: {
    color: '#CBD5E1',
    fontSize: 12,
    fontWeight: '700',
  },
  successMiniBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
    marginHorizontal: 16,
    marginTop: 8,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    gap: 6,
    borderWidth: 1,
    borderColor: '#059669',
  },
  successMiniBannerText: {
    color: '#34D399',
    fontSize: 12,
    fontWeight: '600',
  },
  infoBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0D0F14',
    marginHorizontal: 16,
    marginTop: 12,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    gap: 8,
    borderWidth: 1,
    borderColor: '#191C24',
  },
  infoBannerText: {
    color: '#81A1C1',
    fontSize: 12,
    fontWeight: '500',
  },
  iosTipMiniBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#082F49',
    marginHorizontal: 16,
    marginTop: 8,
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#0284C7',
  },
  iosTipMiniText: {
    color: '#7DD3FC',
    fontSize: 11.5,
    flex: 1,
    lineHeight: 15,
  },
  listContent: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 40,
  },
  trackItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0D0F14',
    padding: 12,
    borderRadius: 8,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#191C24',
  },
  trackItemActive: {
    backgroundColor: '#161C26',
    borderColor: '#3B4252',
  },
  artworkPlaceholder: {
    width: 42,
    height: 42,
    borderRadius: 6,
    backgroundColor: '#161A22',
    justifyContent: 'center',
    alignItems: 'center',
  },
  trackInfo: {
    flex: 1,
    marginLeft: 12,
  },
  trackTitle: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 3,
  },
  trackTitleActive: {
    color: '#ECEFF4',
  },
  trackArtist: {
    color: '#64748B',
    fontSize: 12,
  },
  formatBadge: {
    backgroundColor: '#161A22',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    marginRight: 8,
    borderWidth: 1,
    borderColor: '#222834',
  },
  formatText: {
    color: '#81A1C1',
    fontSize: 9,
    fontWeight: '800',
  },
  durationText: {
    color: '#64748B',
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 80,
    gap: 12,
  },
  emptyText: {
    color: '#64748B',
    fontSize: 14,
  },
  emptyImportFolderBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#06281E',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#059669',
  },
  emptyImportFolderText: {
    color: '#6EE7B7',
    fontWeight: '700',
    fontSize: 13,
  },
  emptyImportBtn: {
    backgroundColor: '#1E232D',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#303846',
  },
  emptyImportText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 13,
  },
});
