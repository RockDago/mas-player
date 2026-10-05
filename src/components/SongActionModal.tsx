import React, { useState } from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  TextInput,
  Image,
  Alert,
} from 'react-native';
import { useScreenInsets, insetPadding } from '../theme/insets';
import { MaterialCommunityIcons, Ionicons, Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Track, Playlist } from '../types/audio';
import { formatTime } from '../services/audioService';

interface SongActionModalProps {
  visible: boolean;
  track: Track | null;
  playlists: Playlist[];
  currentPlaylistId?: string | null;
  onClose: () => void;
  onPlayNext: (track: Track) => void;
  onAddToQueue: (track: Track) => void;
  onAddToPlaylist: (track: Track, playlistId: string) => void;
  onRemoveFromPlaylist?: (track: Track, playlistId: string) => void;
  onCreatePlaylistWithTrack: (track: Track, playlistName: string) => void;
  onUpdateTrackTags: (updatedTrack: Track) => void;
  onDeleteTrack: (track: Track) => void;
  onToggleFavorite: (track: Track) => void;
}

export const SongActionModal: React.FC<SongActionModalProps> = ({
  visible,
  track,
  playlists,
  currentPlaylistId,
  onClose,
  onPlayNext,
  onAddToQueue,
  onAddToPlaylist,
  onRemoveFromPlaylist,
  onCreatePlaylistWithTrack,
  onUpdateTrackTags,
  onDeleteTrack,
  onToggleFavorite,
}) => {
  // Marge système mesurée. La modale est montée hors du `SafeAreaProvider`
  // de l'écran, elle la lit donc par contexte — voir src/theme/insets.ts.
  const insets = useScreenInsets();
  const [subModal, setSubModal] = useState<'none' | 'editTags' | 'addToPlaylist' | 'trackInfo'>('none');
  const [editTitle, setEditTitle] = useState<string>('');
  const [editArtist, setEditArtist] = useState<string>('');
  const [editAlbum, setEditAlbum] = useState<string>('');
  const [editYear, setEditYear] = useState<string>('');
  const [editGenre, setEditGenre] = useState<string>('');
  const [newPlaylistName, setNewPlaylistName] = useState<string>('');
  const [isCreatingNewPlaylist, setIsCreatingNewPlaylist] = useState<boolean>(false);

  React.useEffect(() => {
    if (track) {
      setEditTitle(track.title || '');
      setEditArtist(track.artist || '');
      setEditAlbum(track.album || '');
      setEditYear(track.year || '');
      setEditGenre(track.genre || '');
    }
  }, [track]);

  if (!track) return null;

  const handleSaveTags = () => {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    } catch {}
    const updated: Track = {
      ...track,
      title: editTitle.trim() || track.title,
      artist: editArtist.trim() || track.artist,
      album: editAlbum.trim() || track.album,
      year: editYear.trim() || track.year,
      genre: editGenre.trim() || track.genre,
    };
    onUpdateTrackTags(updated);
    setSubModal('none');
    onClose();
  };

  const handleConfirmDelete = () => {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    } catch {}
    Alert.alert(
      'Supprimer le morceau',
      `Êtes-vous sûr de vouloir supprimer "${track.title}" de la bibliothèque ?`,
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Supprimer',
          style: 'destructive',
          onPress: () => {
            onDeleteTrack(track);
            onClose();
          },
        },
      ]
    );
  };

  return (
    <Modal
      visible={visible}
      animationType="fade"
      transparent
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <TouchableOpacity
          style={styles.backdrop}
          activeOpacity={1}
          onPress={onClose}
        />

        <View
          style={[
            styles.actionSheet,
            // La feuille se collerait au bord bas de l'écran, sous la barre de
            // navigation du système. La marge mesurée s'ajoute à l'espacement.
            { paddingBottom: insetPadding(insets, 'bottom', 24) },
          ]}
        >
          {/* Header with track preview */}
          <View style={styles.trackHeader}>
            <View style={styles.trackThumbBox}>
              {track.artwork ? (
                <Image source={{ uri: track.artwork }} style={styles.trackThumb} />
              ) : (
                <MaterialCommunityIcons name="music-box" size={32} color="#38BDF8" />
              )}
            </View>

            <View style={styles.trackMeta}>
              <Text numberOfLines={1} style={styles.trackTitle}>
                {track.title}
              </Text>
              <Text numberOfLines={1} style={styles.trackArtist}>
                {track.artist} • {track.album}
              </Text>
              <Text style={styles.trackBadge}>
                {track.format || 'FLAC'} • {formatTime(track.duration || 0)} •{' '}
                {track.sampleRate || '44.1 kHz'}
              </Text>
            </View>

            <TouchableOpacity
              style={styles.favoriteBtn}
              onPress={() => {
                try {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                } catch {}
                onToggleFavorite(track);
              }}
            >
              <Ionicons
                name={track.isFavorite ? 'heart' : 'heart-outline'}
                size={24}
                color={track.isFavorite ? '#EF4444' : '#94A3B8'}
              />
            </TouchableOpacity>
          </View>

          <View style={styles.divider} />

          {/* Action List */}
          <ScrollView style={styles.actionsList} showsVerticalScrollIndicator={false}>
            {/* 1. Play Next */}
            <TouchableOpacity
              style={styles.actionItem}
              onPress={() => {
                try {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                } catch {}
                onPlayNext(track);
                onClose();
              }}
            >
              <MaterialCommunityIcons name="playlist-play" size={24} color="#38BDF8" />
              <View style={styles.actionTextWrapper}>
                <Text style={styles.actionTitle}>Lire ensuite</Text>
                <Text style={styles.actionSub}>Placer au début de la file d'attente</Text>
              </View>
            </TouchableOpacity>

            {/* 2. Play Later / Add to Queue */}
            <TouchableOpacity
              style={styles.actionItem}
              onPress={() => {
                try {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                } catch {}
                onAddToQueue(track);
                onClose();
              }}
            >
              <MaterialCommunityIcons name="clock-outline" size={24} color="#A78BFA" />
              <View style={styles.actionTextWrapper}>
                <Text style={styles.actionTitle}>Lire plus tard</Text>
                <Text style={styles.actionSub}>Programmer dans la file d'attente</Text>
              </View>
            </TouchableOpacity>

            {/* 3. Add to Playlist */}
            <TouchableOpacity
              style={styles.actionItem}
              onPress={() => setSubModal('addToPlaylist')}
            >
              <MaterialCommunityIcons name="playlist-plus" size={24} color="#34D399" />
              <View style={styles.actionTextWrapper}>
                <Text style={styles.actionTitle}>Ajouter à une playlist</Text>
                <Text style={styles.actionSub}>Sélectionner ou créer une liste de lecture</Text>
              </View>
            </TouchableOpacity>

            {/* 3b. Remove from Current Playlist (si applicable) */}
            {currentPlaylistId && onRemoveFromPlaylist && track && playlists.find(p => p.id === currentPlaylistId)?.trackIds.includes(track.id) && (
              <TouchableOpacity
                style={styles.actionItem}
                onPress={() => {
                  onRemoveFromPlaylist(track, currentPlaylistId);
                  onClose();
                }}
              >
                <MaterialCommunityIcons name="playlist-remove" size={24} color="#FB7185" />
                <View style={styles.actionTextWrapper}>
                  <Text style={[styles.actionTitle, { color: '#FB7185' }]}>
                    Retirer de cette playlist
                  </Text>
                  <Text style={styles.actionSub}>Enlever ce morceau de la playlist actuelle</Text>
                </View>
              </TouchableOpacity>
            )}

            {/* 4. Edit Tags */}
            <TouchableOpacity
              style={styles.actionItem}
              onPress={() => setSubModal('editTags')}
            >
              <MaterialCommunityIcons name="tag-edit-outline" size={24} color="#FBBF24" />
              <View style={styles.actionTextWrapper}>
                <Text style={styles.actionTitle}>Éditer les tags</Text>
                <Text style={styles.actionSub}>Modifier titre, artiste, album, genre, année</Text>
              </View>
            </TouchableOpacity>

            {/* 5. Track Info */}
            <TouchableOpacity
              style={styles.actionItem}
              onPress={() => setSubModal('trackInfo')}
            >
              <MaterialCommunityIcons name="information-outline" size={24} color="#94A3B8" />
              <View style={styles.actionTextWrapper}>
                <Text style={styles.actionTitle}>Informations détaillées</Text>
                <Text style={styles.actionSub}>Fréquence, débit binaire, chemin de fichier</Text>
              </View>
            </TouchableOpacity>

            {/* 6. Delete Song */}
            <TouchableOpacity
              style={styles.actionItem}
              onPress={handleConfirmDelete}
            >
              <MaterialCommunityIcons name="trash-can-outline" size={24} color="#F87171" />
              <View style={styles.actionTextWrapper}>
                <Text style={[styles.actionTitle, { color: '#F87171' }]}>
                  Supprimer le morceau
                </Text>
                <Text style={styles.actionSub}>Retirer de la bibliothèque musicale</Text>
              </View>
            </TouchableOpacity>
          </ScrollView>

          {/* Close Cancel button */}
          <TouchableOpacity style={styles.cancelBtn} onPress={onClose}>
            <Text style={styles.cancelBtnText}>Fermer</Text>
          </TouchableOpacity>
        </View>

        {/* SUB-MODAL 1: EDIT TAGS */}
        {subModal === 'editTags' && (
          <Modal visible transparent animationType="slide">
            <View style={styles.subOverlay}>
              <View style={styles.subBox}>
                <View style={styles.subHeader}>
                  <Text style={styles.subTitle}>Éditeur de Tags MAS Player</Text>
                  <TouchableOpacity onPress={() => setSubModal('none')}>
                    <Ionicons name="close" size={24} color="#FFFFFF" />
                  </TouchableOpacity>
                </View>

                <ScrollView style={{ maxHeight: 380 }}>
                  <Text style={styles.inputLabel}>Titre</Text>
                  <TextInput
                    style={styles.inputField}
                    value={editTitle}
                    onChangeText={setEditTitle}
                    placeholder="Titre de la chanson"
                    placeholderTextColor="#64748B"
                  />

                  <Text style={styles.inputLabel}>Artiste</Text>
                  <TextInput
                    style={styles.inputField}
                    value={editArtist}
                    onChangeText={setEditArtist}
                    placeholder="Artiste"
                    placeholderTextColor="#64748B"
                  />

                  <Text style={styles.inputLabel}>Album</Text>
                  <TextInput
                    style={styles.inputField}
                    value={editAlbum}
                    onChangeText={setEditAlbum}
                    placeholder="Nom de l'album"
                    placeholderTextColor="#64748B"
                  />

                  <View style={{ flexDirection: 'row', gap: 12 }}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.inputLabel}>Année</Text>
                      <TextInput
                        style={styles.inputField}
                        value={editYear}
                        onChangeText={setEditYear}
                        placeholder="Ex: 2024"
                        placeholderTextColor="#64748B"
                        keyboardType="numeric"
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.inputLabel}>Genre</Text>
                      <TextInput
                        style={styles.inputField}
                        value={editGenre}
                        onChangeText={setEditGenre}
                        placeholder="Ex: Electronic"
                        placeholderTextColor="#64748B"
                      />
                    </View>
                  </View>
                </ScrollView>

                <View style={styles.subFooterBtns}>
                  <TouchableOpacity
                    style={styles.subCancelBtn}
                    onPress={() => setSubModal('none')}
                  >
                    <Text style={styles.subCancelBtnText}>Annuler</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.subSaveBtn}
                    onPress={handleSaveTags}
                  >
                    <Text style={styles.subSaveBtnText}>Enregistrer</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          </Modal>
        )}

        {/* SUB-MODAL 2: ADD TO PLAYLIST */}
        {subModal === 'addToPlaylist' && (
          <Modal visible transparent animationType="slide">
            <View style={styles.subOverlay}>
              <View style={styles.subBox}>
                <View style={styles.subHeader}>
                  <Text style={styles.subTitle}>Ajouter à une playlist</Text>
                  <TouchableOpacity onPress={() => setSubModal('none')}>
                    <Ionicons name="close" size={24} color="#FFFFFF" />
                  </TouchableOpacity>
                </View>

                {isCreatingNewPlaylist ? (
                  <View style={{ marginBottom: 16 }}>
                    <Text style={styles.inputLabel}>Nom de la nouvelle playlist</Text>
                    <TextInput
                      style={styles.inputField}
                      value={newPlaylistName}
                      onChangeText={setNewPlaylistName}
                      placeholder="Ex: Mes Favoris 2026"
                      placeholderTextColor="#64748B"
                      autoFocus
                    />
                    <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
                      <TouchableOpacity
                        style={styles.subCancelBtn}
                        onPress={() => setIsCreatingNewPlaylist(false)}
                      >
                        <Text style={styles.subCancelBtnText}>Annuler</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={styles.subSaveBtn}
                        onPress={() => {
                          if (newPlaylistName.trim().length > 0) {
                            onCreatePlaylistWithTrack(track, newPlaylistName.trim());
                            setNewPlaylistName('');
                            setIsCreatingNewPlaylist(false);
                            setSubModal('none');
                            onClose();
                          }
                        }}
                      >
                        <Text style={styles.subSaveBtnText}>Créer & Ajouter</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                ) : (
                  <>
                    <TouchableOpacity
                      style={styles.createPlaylistTriggerBtn}
                      onPress={() => setIsCreatingNewPlaylist(true)}
                    >
                      <Ionicons name="add-circle" size={22} color="#38BDF8" />
                      <Text style={styles.createPlaylistTriggerText}>
                        Créer une nouvelle playlist
                      </Text>
                    </TouchableOpacity>

                    <ScrollView style={{ maxHeight: 260 }}>
                      {playlists.length === 0 ? (
                        <Text style={styles.emptyPlaylistText}>
                          Aucune playlist existante. Créez-en une ci-dessus !
                        </Text>
                      ) : (
                        playlists.map((pl) => (
                          <TouchableOpacity
                            key={pl.id}
                            style={styles.playlistRow}
                            onPress={() => {
                              onAddToPlaylist(track, pl.id);
                              setSubModal('none');
                              onClose();
                            }}
                          >
                            <MaterialCommunityIcons
                              name="playlist-music"
                              size={22}
                              color="#38BDF8"
                            />
                            <View style={{ flex: 1, marginLeft: 12 }}>
                              <Text style={styles.playlistRowName}>{pl.name}</Text>
                              <Text style={styles.playlistRowCount}>
                                {pl.trackIds.length} morceaux
                              </Text>
                            </View>
                            <Ionicons name="chevron-forward" size={18} color="#64748B" />
                          </TouchableOpacity>
                        ))
                      )}
                    </ScrollView>
                  </>
                )}
              </View>
            </View>
          </Modal>
        )}

        {/* SUB-MODAL 3: TRACK INFO */}
        {subModal === 'trackInfo' && (
          <Modal visible transparent animationType="fade">
            <View style={styles.subOverlay}>
              <View style={styles.subBox}>
                <View style={styles.subHeader}>
                  <Text style={styles.subTitle}>Détails Techniques Audio</Text>
                  <TouchableOpacity onPress={() => setSubModal('none')}>
                    <Ionicons name="close" size={24} color="#FFFFFF" />
                  </TouchableOpacity>
                </View>

                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Titre :</Text>
                  <Text style={styles.infoVal}>{track.title}</Text>
                </View>
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Artiste :</Text>
                  <Text style={styles.infoVal}>{track.artist}</Text>
                </View>
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Album :</Text>
                  <Text style={styles.infoVal}>{track.album}</Text>
                </View>
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Format :</Text>
                  <Text style={styles.infoVal}>{track.format || 'FLAC (Lossless)'}</Text>
                </View>
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Fréquence :</Text>
                  <Text style={styles.infoVal}>{track.sampleRate || '44.1 kHz'}</Text>
                </View>
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Débit binaire :</Text>
                  <Text style={styles.infoVal}>{track.bitrate || '1116 kbps'}</Text>
                </View>
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Durée :</Text>
                  <Text style={styles.infoVal}>{formatTime(track.duration || 0)}</Text>
                </View>
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Moteur :</Text>
                  <Text style={styles.infoVal}>MAS DVC 32-bit Float</Text>
                </View>

                <TouchableOpacity
                  style={[styles.subSaveBtn, { marginTop: 20 }]}
                  onPress={() => setSubModal('none')}
                >
                  <Text style={styles.subSaveBtnText}>Fermer</Text>
                </TouchableOpacity>
              </View>
            </View>
          </Modal>
        )}
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    justifyContent: 'flex-end',
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  actionSheet: {
    backgroundColor: '#161519',
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 24,
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: '#2A2930',
  },
  trackHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  trackThumbBox: {
    width: 48,
    height: 48,
    borderRadius: 8,
    backgroundColor: '#24232A',
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
  },
  trackThumb: {
    width: '100%',
    height: '100%',
  },
  trackMeta: {
    flex: 1,
    marginLeft: 14,
  },
  trackTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  trackArtist: {
    fontSize: 13,
    color: '#94A3B8',
    marginTop: 2,
  },
  trackBadge: {
    fontSize: 11,
    color: '#38BDF8',
    marginTop: 3,
    fontWeight: '500',
  },
  favoriteBtn: {
    padding: 8,
  },
  divider: {
    height: 1,
    backgroundColor: '#27262D',
    marginVertical: 14,
  },
  actionsList: {
    maxHeight: 340,
  },
  actionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 13,
  },
  actionTextWrapper: {
    marginLeft: 16,
    flex: 1,
  },
  actionTitle: {
    fontSize: 15.5,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  actionSub: {
    fontSize: 12,
    color: '#94A3B8',
    marginTop: 2,
  },
  cancelBtn: {
    backgroundColor: '#222128',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 14,
  },
  cancelBtnText: {
    color: '#E4E4E7',
    fontSize: 15,
    fontWeight: '600',
  },
  subOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  subBox: {
    width: '100%',
    maxWidth: 400,
    backgroundColor: '#1C1B20',
    borderRadius: 18,
    padding: 20,
    borderWidth: 1,
    borderColor: '#302E38',
  },
  subHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  subTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  inputLabel: {
    fontSize: 12.5,
    fontWeight: '600',
    color: '#94A3B8',
    marginTop: 10,
    marginBottom: 5,
  },
  inputField: {
    backgroundColor: '#121115',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: '#FFFFFF',
    fontSize: 14.5,
    borderWidth: 1,
    borderColor: '#2B2933',
  },
  subFooterBtns: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 20,
  },
  subCancelBtn: {
    flex: 1,
    backgroundColor: '#26242D',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  subCancelBtnText: {
    color: '#A1A1AA',
    fontSize: 14.5,
    fontWeight: '600',
  },
  subSaveBtn: {
    flex: 1,
    backgroundColor: '#0284C7',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  subSaveBtnText: {
    color: '#FFFFFF',
    fontSize: 14.5,
    fontWeight: '600',
  },
  createPlaylistTriggerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#24222B',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    gap: 10,
    marginBottom: 14,
  },
  createPlaylistTriggerText: {
    color: '#38BDF8',
    fontSize: 14.5,
    fontWeight: '600',
  },
  emptyPlaylistText: {
    color: '#71717A',
    textAlign: 'center',
    marginVertical: 20,
    fontSize: 13.5,
  },
  playlistRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#25232C',
  },
  playlistRowName: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  playlistRowCount: {
    color: '#71717A',
    fontSize: 12,
    marginTop: 2,
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#24222A',
  },
  infoLabel: {
    color: '#71717A',
    fontSize: 13.5,
  },
  infoVal: {
    color: '#E4E4E7',
    fontSize: 13.5,
    fontWeight: '500',
    maxWidth: '65%',
    textAlign: 'right',
  },
});
