import React, { useState, useMemo, useEffect, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ScrollView,
  FlatList,
  Platform,
  Image,
  TextInput,
  Alert,
  Modal,
} from 'react-native';
import { MaterialCommunityIcons, Ionicons, Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { pickAudioFolder, pickAudioFiles, isIOSDevice } from '../services/filePickerService';
import { Track, Playlist } from '../types/audio';
import { sortTracks, filterShortTracks, LibrarySort } from '../utils/trackSort';
import { formatTime } from '../services/audioService';
import { useScreenInsets, insetPadding } from '../theme/insets';

interface LibraryViewProps {
  tracks: Track[];
  currentTrack: Track;
  isPlaying: boolean;
  playlists: Playlist[];
  activePlaylistId?: string | null;
  activeCategory?: string | null;
  selectedGroupKey?: string | null;
  isVisible?: boolean;
  onPlayPause: () => void;
  onSelectTrack: (track: Track, playlist?: Playlist | null, category?: string | null, groupKey?: string | null) => void;
  onAddTracks: (newTracks: Track[]) => void;
  onBackToPlayer: () => void;
  onTrackAction: (track: Track, playlistId?: string | null) => void;
  onCreatePlaylist: (name: string) => void;
  onDeletePlaylist: (id: string) => void;
  onDeleteFolder?: (folderName: string) => void;
  onRenameFolder?: (oldFolderName: string, newFolderName: string) => void;
  onOpenQueueDrawer: () => void;
  onNavigateCategory?: (category: string | null, groupKey?: string | null, playlist?: Playlist | null) => void;
  /** Tri de la bibliothèque, appliqué APRÈS le filtrage playlist/groupe. */
  sort?: LibrarySort;
  /**
   * Masque les morceaux dont la durée connue est sous 30 s. Les morceaux à la
   * durée inconnue (`0` sur natif) ne sont jamais masqués — voir
   * `filterShortTracks`.
   */
  ignoreShortAudio?: boolean;
}

interface CategoryItem {
  id: string;
  name: string;
  icon: keyof typeof MaterialCommunityIcons.glyphMap;
}

const CATEGORIES: CategoryItem[] = [
  { id: 'all_songs', name: 'All Songs', icon: 'music-note' },
  { id: 'playlists', name: 'Playlists', icon: 'playlist-music' },
  { id: 'folders', name: 'Folders', icon: 'folder' },
  { id: 'folders_hierarchy', name: 'Folders Hierarchy', icon: 'folder-multiple' },
  { id: 'albums', name: 'Albums', icon: 'disc' },
  { id: 'artists', name: 'Artists', icon: 'account' },
  { id: 'album_artists', name: 'Album Artists', icon: 'account-circle' },
  { id: 'albums_by_artist', name: 'Albums by Artist', icon: 'disc' },
  { id: 'genres', name: 'Genres', icon: 'glass-cocktail' },
  { id: 'years', name: 'Years', icon: 'calendar-month' },
  { id: 'composers', name: 'Composers', icon: 'account-group' },
];

export const LibraryView: React.FC<LibraryViewProps> = ({
  tracks,
  currentTrack,
  isPlaying,
  playlists,
  activePlaylistId,
  activeCategory: propActiveCategory,
  selectedGroupKey: propSelectedGroupKey,
  isVisible,
  onPlayPause,
  onSelectTrack,
  onAddTracks,
  onBackToPlayer,
  onTrackAction,
  onCreatePlaylist,
  onDeletePlaylist,
  onDeleteFolder,
  onRenameFolder,
  onOpenQueueDrawer,
  onNavigateCategory,
  sort = 'title',
  ignoreShortAudio,
}) => {
  // Marge système mesurée (encoche / barre d'état). Remplace
  // `StatusBar.currentHeight` — voir src/theme/insets.ts.
  const insets = useScreenInsets();
  // Respiration sous la dernière ligne de chaque liste.
  //
  // C'était un spacer fixe de 90 px, choisi à l'œil. Sous Android 15 bord à
  // bord il est plus court que la barre de navigation : la dernière catégorie,
  // ou le dernier morceau d'une playlist, passait dessous sans que rien ne le
  // signale — la liste continuait simplement sous la barre, inatteignable au
  // doigt. La marge mesurée s'ajoute à l'esthétique au lieu de la remplacer.
  //
  // La vue est un `<View>` nu, sans SafeAreaView : c'est donc la seule
  // compensation possible, sur les deux plateformes.
  const bottomSpacer = insetPadding(insets, 'bottom', 28);
  const [activeCategory, setActiveCategory] = useState<string | null>(propActiveCategory ?? null);
  const [selectedGroupKey, setSelectedGroupKey] = useState<string | null>(propSelectedGroupKey ?? null);
  // La playlist ouverte dans la vue ne part JAMAIS de `activePlaylistId` : cet
  // identifiant décrit le *contexte de lecture* (ce que lit le lecteur), pas la
  // position dans l'arborescence. Au démarrage on affiche donc la racine.
  const [selectedPlaylist, setSelectedPlaylist] = useState<Playlist | null>(null);
  const [showMenuPopup, setShowMenuPopup] = useState<boolean>(false);
  const [isCreatingPlaylist, setIsCreatingPlaylist] = useState<boolean>(false);
  const [newPlaylistTitle, setNewPlaylistTitle] = useState<string>('');
  const [importSuccessMessage, setImportSuccessMessage] = useState<string | null>(null);

  // Folder 3-dots menu & rename states
  const [folderMenuTarget, setFolderMenuTarget] = useState<{
    id: string;
    title: string;
    trackCount: number;
  } | null>(null);
  const [isRenamingFolder, setIsRenamingFolder] = useState<boolean>(false);
  const [renameFolderText, setRenameFolderText] = useState<string>('');
  const [isConfirmingDeleteFolder, setIsConfirmingDeleteFolder] = useState<boolean>(false);

  // Synchronisation automatique lorsqu'on navigue ou revient depuis l'accueil
  useEffect(() => {
    // `activePlaylistId` n'ouvre plus rien ici : c'est le contexte de lecture,
    // pas la navigation. Sans ce retour, relancer l'app avec une lecture en
    // cours dans une playlist réouvrait directement SON contenu au lieu de la
    // racine de la bibliothèque.
    if (propActiveCategory) {
      setActiveCategory(propActiveCategory);
      setSelectedGroupKey(propSelectedGroupKey ?? null);
      if (propActiveCategory !== 'playlists') {
        setSelectedPlaylist(null);
      }
    }
  }, [propActiveCategory, propSelectedGroupKey, isVisible]);

  // IMPORTATION D'UN DOSSIER COMPLET EN UN SEUL CLIC
  const handlePickFolder = async () => {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      const res = await pickAudioFolder(tracks);
      if (res && res.tracks.length > 0) {
        onAddTracks(res.tracks);
        setImportSuccessMessage(
          `Dossier "${res.folderName}" importé : ${res.count} musique${res.count > 1 ? 's' : ''} ajoutée${res.count > 1 ? 's' : ''} !`
        );
        setTimeout(() => setImportSuccessMessage(null), 5000);
      } else if (res && res.count === 0) {
        Alert.alert(
          'Aucun nouveau fichier audio',
          'Aucun nouveau morceau n\'a été importé (fichiers absents ou morceaux déjà présents dans la bibliothèque).'
        );
      }
    } catch (err) {
      console.warn('Erreur sélection dossier:', err);
    }
  };

  // IMPORTATION DE FICHIERS INDIVIDUELS
  const handlePickFiles = async () => {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      const res = await pickAudioFiles(tracks);
      if (res && res.tracks.length > 0) {
        onAddTracks(res.tracks);
        setImportSuccessMessage(
          `${res.count} musique${res.count > 1 ? 's' : ''} importée${res.count > 1 ? 's' : ''} avec succès !`
        );
        setTimeout(() => setImportSuccessMessage(null), 5000);
      }
    } catch (err) {
      console.warn('Erreur sélection fichiers:', err);
    }
  };

  const handleCategoryPress = (category: CategoryItem) => {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {}
    setSelectedGroupKey(null);
    setSelectedPlaylist(null);
    setActiveCategory(category.id);
    onNavigateCategory?.(category.id, null, null);
  };

  // Grouped data for albums, artists, genres, years, folders
  const groupedData = useMemo(() => {
    if (activeCategory === 'folders' || activeCategory === 'folders_hierarchy') {
      const map = new Map<string, Track[]>();
      tracks.forEach((t) => {
        // « Démos MAS Player » désignait le dossier des pistes de démonstration,
        // retirées de l'application : ce repli rangerait aujourd'hui tout
        // fichier importé sans dossier sous un nom qui n'existe plus.
        const key = t.folder || 'Musique importée';
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push(t);
      });
      return Array.from(map.entries()).map(([name, list]) => ({
        id: name,
        title: name,
        subtitle: `${list.length} morceau${list.length > 1 ? 'x' : ''} • ${list[0]?.folderPath || '/Music/' + name}`,
        tracks: list,
      }));
    }

    if (activeCategory === 'albums' || activeCategory === 'albums_by_artist') {
      const map = new Map<string, Track[]>();
      tracks.forEach((t) => {
        const key = t.album || 'Album Inconnu';
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push(t);
      });
      return Array.from(map.entries()).map(([name, list]) => ({
        id: name,
        title: name,
        subtitle: `${list.length} morceaux • ${list[0]?.artist || ''}`,
        tracks: list,
      }));
    }

    if (activeCategory === 'artists' || activeCategory === 'album_artists') {
      const map = new Map<string, Track[]>();
      tracks.forEach((t) => {
        const key = t.artist || 'Artiste Inconnu';
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push(t);
      });
      return Array.from(map.entries()).map(([name, list]) => ({
        id: name,
        title: name,
        subtitle: `${list.length} morceaux`,
        tracks: list,
      }));
    }

    if (activeCategory === 'genres') {
      const map = new Map<string, Track[]>();
      tracks.forEach((t) => {
        const key = t.genre || 'Electronic / Rock';
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push(t);
      });
      return Array.from(map.entries()).map(([name, list]) => ({
        id: name,
        title: name,
        subtitle: `${list.length} morceaux`,
        tracks: list,
      }));
    }

    if (activeCategory === 'years') {
      const map = new Map<string, Track[]>();
      tracks.forEach((t) => {
        const key = t.year || '2024';
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push(t);
      });
      return Array.from(map.entries()).map(([name, list]) => ({
        id: name,
        title: name,
        subtitle: `${list.length} morceaux`,
        tracks: list,
      }));
    }

    return [];
  }, [activeCategory, tracks]);

  // Tracks for the currently selected group (or playlist, or all songs)
  // Tri et filtre court s'appliquent APRÈS la sélection playlist/groupe, jamais
  // avant : trier d'abord, puis re-sélectionner par `trackIds`, laisserait les
  // groupes incohérents entre eux — un groupe d'artiste rangerait ses morceaux
  // dans l'ordre du titre, un autre dans celui de l'album.
  //
  // Le filtrage passe par `filterShortTracks` et non par un `!t.duration < 30`
  // direct : sur natif, `duration` vaut 0 tant que le morceau n'a pas été joué,
  // et un prédicat naïf masquerait la bibliothèque entière.
  const displayTracks = useMemo(() => {
    let base: Track[];
    if (selectedPlaylist) {
      // `Set` plutôt que `includes` : ce filtre est O(n·m), donc 25 millions de
      // comparaisons de chaînes sur une playlist et une bibliothèque de 5000
      // morceaux — plusieurs centaines de ms de gel à l'ouverture.
      const wanted = new Set(selectedPlaylist.trackIds);
      base = tracks.filter((t) => wanted.has(t.id));
    } else if (selectedGroupKey) {
      const found = groupedData.find((g) => g.id === selectedGroupKey);
      base = found ? found.tracks : [];
    } else {
      base = tracks;
    }
    return sortTracks(filterShortTracks(base, !!ignoreShortAudio), sort);
  }, [selectedPlaylist, selectedGroupKey, groupedData, tracks, sort, ignoreShortAudio]);

  const getHeaderTitle = () => {
    if (selectedPlaylist) return selectedPlaylist.name;
    if (selectedGroupKey) return selectedGroupKey;
    if (activeCategory) {
      const cat = CATEGORIES.find((c) => c.id === activeCategory);
      return cat ? cat.name : 'Library';
    }
    return 'Library';
  };

  const handleHeaderBack = () => {
    if (selectedPlaylist) {
      setSelectedPlaylist(null);
      onNavigateCategory?.('playlists', null, null);
    } else if (selectedGroupKey) {
      setSelectedGroupKey(null);
      onNavigateCategory?.(activeCategory, null, null);
    } else {
      setActiveCategory(null);
      onNavigateCategory?.(null, null, null);
    }
  };

  const flatListRef = useRef<FlatList<Track>>(null);

  const currentIndex = useMemo(() => {
    if (!currentTrack?.id || displayTracks.length === 0) return -1;
    return displayTracks.findIndex((t) => t.id === currentTrack.id);
  }, [displayTracks, currentTrack?.id]);

  // Changer de tri réordonne `displayTracks` sans changer le nombre de lignes :
  // la position de scroll garde donc son offset en pixels alors que la ligne
  // sous l'écran n'est plus la même. Sans cette remise à zéro, l'utilisateur
  // reste figé au milieu d'une liste qui a bougé sous ses doigts, et il ne
  // voit plus où il se trouve.
  useEffect(() => {
    try {
      flatListRef.current?.scrollToOffset({ offset: 0, animated: false });
    } catch {
      // Liste pas encore montée : rien à réinitialiser.
    }
  }, [sort, ignoreShortAudio]);

  const scrollToCurrentTrack = (animated: boolean = false) => {
    if (currentIndex >= 0 && flatListRef.current) {
      try {
        flatListRef.current.scrollToIndex({
          index: currentIndex,
          animated,
          viewPosition: 0.35,
        });
      } catch {
        const headerHeight = (selectedPlaylist || selectedGroupKey || activeCategory === 'all_songs') ? 56 : 0;
        flatListRef.current?.scrollToOffset({
          offset: Math.max(0, headerHeight + currentIndex * 66 - 60),
          animated,
        });
      }
    }
  };

  useEffect(() => {
    if (isVisible && currentIndex >= 0) {
      const timer = setTimeout(() => {
        scrollToCurrentTrack(false);
      }, 120);
      return () => clearTimeout(timer);
    }
  }, [isVisible, currentIndex, selectedPlaylist?.id, activeCategory]);

  return (
    <View style={styles.container}>
      {/* Top Header matching Screenshot 1 */}
      <View
        style={[
          styles.header,
          {
            paddingTop:
              Platform.OS === 'android'
                ? insetPadding(insets, 'top', 10)
                : Platform.OS === 'ios'
                ? 12
                : 20,
          },
        ]}
      >
        {activeCategory ? (
          <TouchableOpacity
            style={styles.backCategoryBtn}
            onPress={handleHeaderBack}
            activeOpacity={0.7}
          >
            <Ionicons name="arrow-back" size={24} color="#FFFFFF" />
            <Text numberOfLines={1} style={styles.headerTitle}>
              {getHeaderTitle()}
            </Text>
          </TouchableOpacity>
        ) : (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Image
              source={require('../../assets/mas_icon_square.png')}
              style={{ width: 28, height: 28, borderRadius: 7 }}
              resizeMode="contain"
            />
            <Text style={styles.headerTitle}>MAS Player</Text>
          </View>
        )}

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          {/* Quick Queue / Play Later Icon button */}
          <TouchableOpacity
            style={styles.circleMenuBtn}
            onPress={onOpenQueueDrawer}
            activeOpacity={0.7}
          >
            <MaterialCommunityIcons name="clock-outline" size={20} color="#38BDF8" />
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.circleMenuBtn}
            onPress={() => setShowMenuPopup(!showMenuPopup)}
            activeOpacity={0.7}
          >
            <MaterialCommunityIcons name="dots-vertical" size={22} color="#FFFFFF" />
          </TouchableOpacity>
        </View>
      </View>

      {/* Mini 3-dots Context Menu */}
      {showMenuPopup && (
        <View style={styles.menuPopup}>
          <TouchableOpacity
            style={styles.menuPopupItem}
            onPress={() => {
              setShowMenuPopup(false);
              onOpenQueueDrawer();
            }}
          >
            <MaterialCommunityIcons name="clock-outline" size={18} color="#38BDF8" />
            <Text style={styles.menuPopupText}>File d'attente (Lire plus tard)</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.menuPopupItem}
            onPress={() => {
              setShowMenuPopup(false);
              handlePickFolder();
            }}
          >
            <MaterialCommunityIcons name="folder-plus" size={18} color="#34D399" />
            <Text style={styles.menuPopupText}>📁 Importer un dossier complet</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.menuPopupItem}
            onPress={() => {
              setShowMenuPopup(false);
              handlePickFiles();
            }}
          >
            <MaterialCommunityIcons name="file-music-outline" size={18} color="#38BDF8" />
            <Text style={styles.menuPopupText}>🎵 Ajouter des fichiers audio</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.menuPopupItem}
            onPress={() => {
              setShowMenuPopup(false);
              setActiveCategory('playlists');
              setIsCreatingPlaylist(true);
            }}
          >
            <MaterialCommunityIcons name="playlist-plus" size={18} color="#FBBF24" />
            <Text style={styles.menuPopupText}>Nouvelle Playlist</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.menuPopupItem}
            onPress={() => {
              setShowMenuPopup(false);
              setActiveCategory('all_songs');
            }}
          >
            <MaterialCommunityIcons name="playlist-music" size={18} color="#E4E4E7" />
            <Text style={styles.menuPopupText}>Toutes les pistes ({tracks.length})</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* MAIN CONTENT */}
      {!activeCategory ? (
        /* Root Categories List matching Screenshot 1 */
        <ScrollView
          style={styles.categoryScroll}
          contentContainerStyle={styles.categoryContent}
          showsVerticalScrollIndicator={false}
        >
          {CATEGORIES.map((cat) => (
            <TouchableOpacity
              key={cat.id}
              style={styles.categoryRow}
              onPress={() => handleCategoryPress(cat)}
              activeOpacity={0.75}
            >
              {/* Circular Anime Badge with Cyan Glowing Icon */}
              <View style={styles.iconCircleBadge}>
                <MaterialCommunityIcons name={cat.icon} size={24} color="#00F0FF" />
              </View>

              {/* Category Name */}
              <View style={{ flex: 1, marginLeft: 20 }}>
                <Text style={styles.categoryNameText}>{cat.name}</Text>
                {cat.id === 'playlists' && (
                  <Text style={styles.categoryCountSub}>
                    {playlists.length} playlists
                  </Text>
                )}
                {cat.id === 'all_songs' && (
                  <Text style={styles.categoryCountSub}>
                    {tracks.length} titres
                  </Text>
                )}
              </View>

              <Ionicons name="chevron-forward" size={18} color="#52525B" />
            </TouchableOpacity>
          ))}
          <View style={{ height: bottomSpacer }} />
        </ScrollView>
      ) : activeCategory === 'playlists' && !selectedPlaylist ? (
        /* PLAYLISTS MANAGEMENT VIEW */
        <ScrollView
          style={styles.categoryScroll}
          contentContainerStyle={styles.categoryContent}
          showsVerticalScrollIndicator={false}
        >
          {/* Create Playlist trigger */}
          <TouchableOpacity
            style={styles.createPlaylistBar}
            onPress={() => setIsCreatingPlaylist(true)}
            activeOpacity={0.7}
          >
            <Ionicons name="add-circle" size={26} color="#38BDF8" />
            <Text style={styles.createPlaylistBarText}>Créer une nouvelle playlist</Text>
          </TouchableOpacity>

          {isCreatingPlaylist && (
            <View style={styles.createPlaylistForm}>
              <TextInput
                style={styles.createPlaylistInput}
                placeholder="Nom de la playlist (ex: Bass Boost, Roadtrip)"
                placeholderTextColor="#71717A"
                value={newPlaylistTitle}
                onChangeText={setNewPlaylistTitle}
                autoFocus
              />
              <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
                <TouchableOpacity
                  style={styles.formCancelBtn}
                  onPress={() => {
                    setNewPlaylistTitle('');
                    setIsCreatingPlaylist(false);
                  }}
                >
                  <Text style={styles.formCancelText}>Annuler</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.formConfirmBtn}
                  onPress={() => {
                    if (newPlaylistTitle.trim()) {
                      onCreatePlaylist(newPlaylistTitle.trim());
                      setNewPlaylistTitle('');
                      setIsCreatingPlaylist(false);
                    }
                  }}
                >
                  <Text style={styles.formConfirmText}>Créer</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {playlists.length === 0 ? (
            <View style={styles.emptyViewBox}>
              <MaterialCommunityIcons name="playlist-music" size={48} color="#52525B" />
              <Text style={styles.emptyViewTitle}>Aucune playlist pour le moment</Text>
              <Text style={styles.emptyViewSub}>
                Créez une playlist ci-dessus ou maintenez votre doigt appuyé sur un morceau pour l'ajouter.
              </Text>
            </View>
          ) : (
            playlists.map((pl) => {
              const isPlActive = activePlaylistId === pl.id;
              return (
                <TouchableOpacity
                  key={pl.id}
                  style={[styles.playlistItemCard, isPlActive && styles.playlistItemCardActive]}
                  onPress={() => {
                    setSelectedPlaylist(pl);
                    onNavigateCategory?.('playlists', null, pl);
                  }}
                  activeOpacity={0.7}
                >
                  <View style={[styles.playlistIconBox, isPlActive && styles.playlistIconBoxActive]}>
                    <MaterialCommunityIcons
                      name={isPlActive ? 'volume-high' : 'playlist-music'}
                      size={26}
                      color={isPlActive ? '#38BDF8' : '#FFFFFF'}
                    />
                  </View>

                  <View style={{ flex: 1, marginLeft: 16 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <Text style={[styles.playlistCardTitle, isPlActive && styles.playlistCardTitleActive]}>
                        {pl.name}
                      </Text>
                      {isPlActive && (
                        <View style={styles.activePillBadge}>
                          <Text style={styles.activePillBadgeText}>EN LECTURE</Text>
                        </View>
                      )}
                    </View>
                    <Text style={styles.playlistCardSub}>
                      {pl.trackIds.length} morceau{pl.trackIds.length > 1 ? 'x' : ''}
                    </Text>
                  </View>

                  <TouchableOpacity
                    style={{ padding: 8 }}
                    onPress={() => {
                      Alert.alert(
                        'Supprimer la playlist',
                        `Supprimer la playlist "${pl.name}" ?`,
                        [
                          { text: 'Annuler', style: 'cancel' },
                          {
                            text: 'Supprimer',
                            style: 'destructive',
                            onPress: () => onDeletePlaylist(pl.id),
                          },
                        ]
                      );
                    }}
                  >
                    <Ionicons name="trash-outline" size={20} color="#71717A" />
                  </TouchableOpacity>
                </TouchableOpacity>
              );
            })
          )}
          <View style={{ height: bottomSpacer }} />
        </ScrollView>
      ) : (activeCategory === 'folders' || activeCategory === 'folders_hierarchy') && !selectedGroupKey ? (
        /* FOLDERS VIEW (1-CLIC FOLDER SELECTION) */
        <ScrollView
          style={styles.categoryScroll}
          contentContainerStyle={styles.categoryContent}
          showsVerticalScrollIndicator={false}
        >
          {/* Main 1-Click Folder Import Card */}
          <TouchableOpacity
            style={styles.importFolderPrimaryCard}
            onPress={handlePickFolder}
            activeOpacity={0.8}
          >
            <View style={styles.importFolderIconBox}>
              <MaterialCommunityIcons name="folder-plus" size={28} color="#10B981" />
            </View>
            <View style={{ flex: 1, marginLeft: 14 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={styles.importFolderPrimaryTitle}>
                  Importer un dossier complet
                </Text>
                <View style={styles.oneClickBadge}>
                  <Text style={styles.oneClickBadgeText}>1 SEUL CLIC</Text>
                </View>
              </View>
              <Text style={styles.importFolderPrimarySub}>
                Sélectionnez 1 seul dossier pour ajouter automatiquement toutes ses musiques
              </Text>
            </View>
          </TouchableOpacity>

          {/* Secondary File Import Button */}
          <TouchableOpacity
            style={styles.importFilesSecondaryBtn}
            onPress={handlePickFiles}
            activeOpacity={0.7}
          >
            <Ionicons name="document-text-outline" size={18} color="#94A3B8" />
            <Text style={styles.importFilesSecondaryText}>
              Ou importer des fichiers individuels
            </Text>
          </TouchableOpacity>



          {/* Success Banner */}
          {importSuccessMessage && (
            <View style={styles.successBanner}>
              <Ionicons name="checkmark-circle" size={18} color="#34D399" />
              <Text style={styles.successBannerText}>{importSuccessMessage}</Text>
            </View>
          )}

          <View style={styles.foldersSectionHeader}>
            <Text style={styles.sectionHeaderTitle}>
              DOSSIERS DÉTECTÉS ({groupedData.length})
            </Text>
            <Text style={styles.sectionHeaderCount}>
              {tracks.length} morceau{tracks.length > 1 ? 'x' : ''} au total
            </Text>
          </View>

          {groupedData.length === 0 ? (
            <View style={styles.emptyViewBox}>
              <MaterialCommunityIcons name="folder-music" size={48} color="#52525B" />
              <Text style={styles.emptyViewTitle}>Aucun dossier audio</Text>
              <Text style={styles.emptyViewSub}>
                Cliquez sur "Importer un dossier complet" ci-dessus pour sélectionner un dossier de musique en un clic.
              </Text>
            </View>
          ) : (
            groupedData.map((f) => (
              <TouchableOpacity
                key={f.id}
                style={styles.folderCard}
                onPress={() => setSelectedGroupKey(f.id)}
                activeOpacity={0.7}
              >
                <View style={styles.folderIconBox}>
                  <MaterialCommunityIcons name="folder-music" size={28} color="#60A5FA" />
                </View>
                <View style={{ flex: 1, marginLeft: 14 }}>
                  <Text style={styles.folderTitle} numberOfLines={1}>
                    {f.title}
                  </Text>
                  <Text style={styles.folderPath} numberOfLines={1}>
                    {f.subtitle}
                  </Text>
                </View>

                {/* Quick play all button */}
                <TouchableOpacity
                  style={styles.quickPlayFolderBtn}
                  onPress={() => {
                    if (f.tracks.length > 0) {
                      onSelectTrack(f.tracks[0]);
                      onBackToPlayer();
                    }
                  }}
                  activeOpacity={0.7}
                >
                  <Ionicons name="play" size={16} color="#38BDF8" />
                </TouchableOpacity>

                {/* 3-dots Folder Menu Button */}
                <TouchableOpacity
                  style={styles.folderMenuBtn}
                  onPress={(e) => {
                    e.stopPropagation();
                    try {
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    } catch {}
                    setFolderMenuTarget({ id: f.id, title: f.title, trackCount: f.tracks.length });
                    setRenameFolderText(f.title);
                    setIsRenamingFolder(false);
                    setIsConfirmingDeleteFolder(false);
                  }}
                  activeOpacity={0.7}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <MaterialCommunityIcons name="dots-vertical" size={20} color="#CBD5E1" />
                </TouchableOpacity>

                <Ionicons name="chevron-forward" size={18} color="#52525B" style={{ marginLeft: 6 }} />
              </TouchableOpacity>
            ))
          )}
          <View style={{ height: bottomSpacer }} />
        </ScrollView>
      ) : (groupedData.length > 0 && !selectedGroupKey) ? (
        /* GROUPED CATEGORIES VIEW (Albums, Artists, Genres, Years) */
        <FlatList
          data={groupedData}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.categoryContent}
          showsVerticalScrollIndicator={false}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.groupCard}
              onPress={() => setSelectedGroupKey(item.id)}
              activeOpacity={0.7}
            >
              <View style={styles.groupIconBox}>
                <MaterialCommunityIcons
                  name={
                    activeCategory === 'albums' || activeCategory === 'albums_by_artist'
                      ? 'album'
                      : activeCategory === 'artists' || activeCategory === 'album_artists'
                      ? 'account'
                      : activeCategory === 'genres'
                      ? 'guitar-acoustic'
                      : 'calendar-month'
                  }
                  size={24}
                  color="#FFFFFF"
                />
              </View>
              <View style={{ flex: 1, marginLeft: 16 }}>
                <Text numberOfLines={1} style={styles.groupTitleText}>
                  {item.title}
                </Text>
                <Text style={styles.groupSubtitleText}>{item.subtitle}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color="#52525B" />
            </TouchableOpacity>
          )}
          ListFooterComponent={<View style={{ height: bottomSpacer }} />}
        />
      ) : (
        /* SONGS LIST (All Songs, Playlist tracks, or Group tracks) */
        <FlatList
          ref={flatListRef}
          data={displayTracks}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.songsListContent}
          showsVerticalScrollIndicator={false}
          initialScrollIndex={currentIndex >= 0 && currentIndex < displayTracks.length ? currentIndex : undefined}
          onScrollToIndexFailed={(info) => {
            const headerHeight = (selectedPlaylist || selectedGroupKey || activeCategory === 'all_songs') ? 56 : 0;
            flatListRef.current?.scrollToOffset({
              offset: Math.max(0, headerHeight + info.index * 66 - 60),
              animated: false,
            });
            setTimeout(() => {
              try {
                flatListRef.current?.scrollToIndex({
                  index: info.index,
                  animated: true,
                  viewPosition: 0.35,
                });
              } catch {}
            }, 100);
          }}
          getItemLayout={(data, index) => {
            const headerHeight = (selectedPlaylist || selectedGroupKey || activeCategory === 'all_songs') ? 56 : 0;
            return {
              length: 66,
              offset: headerHeight + 66 * index,
              index,
            };
          }}
          ListHeaderComponent={
            (selectedPlaylist || selectedGroupKey || activeCategory === 'all_songs') ? (
              <View style={styles.groupDetailHeaderBar}>
                <TouchableOpacity
                  style={styles.groupPlayAllBtn}
                  onPress={() => {
                    if (displayTracks.length > 0) {
                      onSelectTrack(displayTracks[0], selectedPlaylist, activeCategory, selectedGroupKey);
                      onBackToPlayer();
                    }
                  }}
                  activeOpacity={0.7}
                >
                  <Ionicons name="play" size={16} color="#FFFFFF" />
                  <Text style={styles.groupPlayAllText}>
                    Tout lire ({displayTracks.length})
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.groupShuffleBtn}
                  onPress={() => {
                    if (displayTracks.length > 0) {
                      const randIdx = Math.floor(Math.random() * displayTracks.length);
                      onSelectTrack(displayTracks[randIdx], selectedPlaylist, activeCategory, selectedGroupKey);
                      onBackToPlayer();
                    }
                  }}
                  activeOpacity={0.7}
                >
                  <Ionicons name="shuffle" size={16} color="#94A3B8" />
                  <Text style={styles.groupShuffleText}>Aléatoire</Text>
                </TouchableOpacity>

                {selectedPlaylist && (
                  <TouchableOpacity
                    style={styles.groupDeleteHeaderBtn}
                    onPress={() => {
                      Alert.alert(
                        'Supprimer la playlist',
                        `Supprimer la playlist "${selectedPlaylist.name}" ?`,
                        [
                          { text: 'Annuler', style: 'cancel' },
                          {
                            text: 'Supprimer',
                            style: 'destructive',
                            onPress: () => {
                              onDeletePlaylist(selectedPlaylist.id);
                              setSelectedPlaylist(null);
                            },
                          },
                        ]
                      );
                    }}
                    activeOpacity={0.7}
                  >
                    <Ionicons name="trash-outline" size={15} color="#F87171" />
                    <Text style={styles.groupDeleteHeaderText}>Supprimer</Text>
                  </TouchableOpacity>
                )}

                {selectedGroupKey && (activeCategory === 'folders' || activeCategory === 'folders_hierarchy') && (
                  <TouchableOpacity
                    style={styles.groupDeleteHeaderBtn}
                    onPress={() => {
                      setFolderMenuTarget({
                        id: selectedGroupKey,
                        title: selectedGroupKey,
                        trackCount: displayTracks.length,
                      });
                      setRenameFolderText(selectedGroupKey);
                      setIsRenamingFolder(false);
                      setIsConfirmingDeleteFolder(false);
                    }}
                    activeOpacity={0.7}
                  >
                    <MaterialCommunityIcons name="dots-vertical" size={16} color="#38BDF8" />
                    <Text style={[styles.groupDeleteHeaderText, { color: '#38BDF8' }]}>Options</Text>
                  </TouchableOpacity>
                )}

                {currentIndex >= 0 && (
                  <TouchableOpacity
                    style={styles.jumpToActiveBtn}
                    onPress={() => scrollToCurrentTrack(true)}
                    activeOpacity={0.7}
                  >
                    <MaterialCommunityIcons name="crosshairs-gps" size={16} color="#38BDF8" />
                    <Text style={styles.jumpToActiveText}>En cours</Text>
                  </TouchableOpacity>
                )}
              </View>
            ) : null
          }
          renderItem={({ item }) => {
            const isPlayingThis = item.id === currentTrack.id;
            return (
              <TouchableOpacity
                style={[styles.trackRow, isPlayingThis && styles.trackRowActive]}
                onPress={() => {
                  try {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  } catch {}
                  onSelectTrack(item, selectedPlaylist, activeCategory, selectedGroupKey);
                  onBackToPlayer();
                }}
                onLongPress={() => {
                  try {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                  } catch {}
                  onTrackAction(item, selectedPlaylist?.id);
                }}
                delayLongPress={300}
                activeOpacity={0.7}
              >
                <View style={[styles.trackIconBox, isPlayingThis && styles.trackIconBoxActive]}>
                  {item.artwork ? (
                    <Image source={{ uri: item.artwork }} style={styles.trackThumb} />
                  ) : (
                    <MaterialCommunityIcons
                      name={isPlayingThis ? 'volume-high' : 'music-note'}
                      size={22}
                      color={isPlayingThis ? '#38BDF8' : '#71717A'}
                    />
                  )}
                </View>

                <View style={styles.trackMetaBox}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text
                      numberOfLines={1}
                      style={[styles.trackTitleText, isPlayingThis && styles.trackTitleTextActive, { flexShrink: 1 }]}
                    >
                      {item.title}
                    </Text>
                    {isPlayingThis && (
                      <View style={styles.playingBadgePill}>
                        <Text style={styles.playingBadgePillText}>EN LECTURE</Text>
                      </View>
                    )}
                  </View>
                  <Text numberOfLines={1} style={styles.trackArtistText}>
                    {item.artist} • {item.album}
                  </Text>
                </View>

                <Text style={[styles.trackDurationText, isPlayingThis && { color: '#38BDF8' }]}>
                  {formatTime(item.duration || 0)}
                </Text>

                {/* 3-dots Context menu trigger button */}
                <TouchableOpacity
                  style={styles.rowMenuBtn}
                  onPress={(e) => {
                    e.stopPropagation();
                    try {
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    } catch {}
                    onTrackAction(item, selectedPlaylist?.id);
                  }}
                >
                  <MaterialCommunityIcons name="dots-vertical" size={20} color="#71717A" />
                </TouchableOpacity>
              </TouchableOpacity>
            );
          }}
          ListEmptyComponent={
            <View style={styles.emptyViewBox}>
              <Text style={styles.emptyViewTitle}>Aucun morceau trouvé</Text>
            </View>
          }
          ListFooterComponent={<View style={{ height: bottomSpacer }} />}
        />
      )}

      {/* Mini Player Bar matching bottom of Image 1 */}
      <TouchableOpacity
        onPress={onBackToPlayer}
        style={styles.miniPlayerBar}
        activeOpacity={0.85}
      >
        {/* Left MAS Logo / Cover Icon */}
        <View style={styles.miniWaveIconBox}>
          {currentTrack.artwork ? (
            <Image
              source={{ uri: currentTrack.artwork }}
              style={{ width: 36, height: 36, borderRadius: 8 }}
            />
          ) : (
            <Image
              source={require('../../assets/mas_icon_square.png')}
              style={{ width: 36, height: 36, borderRadius: 8 }}
              resizeMode="cover"
            />
          )}
        </View>

        {/* Title & Artist/Skin info */}
        <View style={styles.miniInfoBox}>
          <Text numberOfLines={1} style={styles.miniTitleText}>
            {currentTrack.title}
          </Text>
          <Text numberOfLines={1} style={styles.miniSubText}>
            {currentTrack.artist} • MAS Player
          </Text>
        </View>

        {/* Right Play / Pause button */}
        <TouchableOpacity
          onPress={(e) => {
            e.stopPropagation();
            try {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            } catch {}
            onPlayPause();
          }}
          style={styles.miniPlayBtn}
          activeOpacity={0.7}
        >
          <Ionicons
            name={isPlaying ? 'pause' : 'play'}
            size={22}
            color="#FFFFFF"
          />
        </TouchableOpacity>
      </TouchableOpacity>
      {/* FOLDER ACTIONS MODAL (RENOMMER & SUPPRIMER) */}
      <Modal
        visible={!!folderMenuTarget}
        transparent
        animationType="fade"
        onRequestClose={() => setFolderMenuTarget(null)}
      >
        <TouchableOpacity
          style={styles.folderModalOverlay}
          activeOpacity={1}
          onPress={() => setFolderMenuTarget(null)}
        >
          <TouchableOpacity
            style={styles.folderModalCard}
            activeOpacity={1}
            onPress={(e) => e.stopPropagation()}
          >
            {/* EN-TÊTE DU DOSSIER */}
            <View style={styles.folderModalHeader}>
              <View style={styles.folderModalIconBox}>
                <MaterialCommunityIcons name="folder-music" size={26} color="#60A5FA" />
              </View>
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={styles.folderModalTitle} numberOfLines={1}>
                  {folderMenuTarget?.title}
                </Text>
                <Text style={styles.folderModalSub}>
                  {folderMenuTarget?.trackCount} morceau{folderMenuTarget && folderMenuTarget.trackCount > 1 ? 'x' : ''}
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => setFolderMenuTarget(null)}
                style={styles.folderModalCloseBtn}
              >
                <Ionicons name="close" size={20} color="#71717A" />
              </TouchableOpacity>
            </View>

            {/* CONTENU SELON L'ÉTAT DU MENU */}
            {isRenamingFolder ? (
              /* ÉCRAN DE RENOMMAGE DU DOSSIER */
              <View style={styles.folderModalBody}>
                <Text style={styles.folderModalSectionLabel}>
                  RENOMMER LE DOSSIER
                </Text>
                <TextInput
                  style={styles.folderRenameInput}
                  value={renameFolderText}
                  onChangeText={setRenameFolderText}
                  placeholder="Nouveau nom du dossier..."
                  placeholderTextColor="#64748B"
                  autoFocus
                  selectTextOnFocus
                />
                <View style={styles.folderModalActionRow}>
                  <TouchableOpacity
                    style={styles.folderModalCancelBtn}
                    onPress={() => setIsRenamingFolder(false)}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.folderModalCancelText}>Annuler</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.folderModalConfirmBtn}
                    onPress={() => {
                      const trimmed = renameFolderText.trim();
                      if (trimmed && folderMenuTarget && trimmed !== folderMenuTarget.title) {
                        onRenameFolder?.(folderMenuTarget.title, trimmed);
                      }
                      setFolderMenuTarget(null);
                      setIsRenamingFolder(false);
                    }}
                    activeOpacity={0.8}
                  >
                    <Text style={styles.folderModalConfirmText}>Enregistrer</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : isConfirmingDeleteFolder ? (
              /* ÉCRAN DE CONFIRMATION DE SUPPRESSION (100% FIABLE SUR MOBILE ET WEB) */
              <View style={styles.folderModalBody}>
                <View style={styles.folderDeleteWarningBox}>
                  <Ionicons name="warning-outline" size={28} color="#F87171" />
                  <Text style={styles.folderDeleteWarningTitle}>
                    Supprimer ce dossier ?
                  </Text>
                  <Text style={styles.folderDeleteWarningText}>
                    Cette action va retirer le dossier "{folderMenuTarget?.title}" et ses {folderMenuTarget?.trackCount} morceau{folderMenuTarget && folderMenuTarget.trackCount > 1 ? 'x' : ''} de votre bibliothèque musicale.
                  </Text>
                </View>

                <View style={styles.folderModalActionRow}>
                  <TouchableOpacity
                    style={styles.folderModalCancelBtn}
                    onPress={() => setIsConfirmingDeleteFolder(false)}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.folderModalCancelText}>Annuler</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.folderModalDangerBtn}
                    onPress={() => {
                      if (folderMenuTarget) {
                        const targetName = folderMenuTarget.title;
                        setFolderMenuTarget(null);
                        setIsConfirmingDeleteFolder(false);
                        onDeleteFolder?.(targetName);
                        if (selectedGroupKey === targetName) {
                          setSelectedGroupKey(null);
                        }
                      }
                    }}
                    activeOpacity={0.8}
                  >
                    <Ionicons name="trash-outline" size={16} color="#FFFFFF" style={{ marginRight: 6 }} />
                    <Text style={styles.folderModalDangerText}>Supprimer</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              /* MENU D'OPTIONS PRINCIPALES */
              <View style={styles.folderModalMenu}>
                <TouchableOpacity
                  style={styles.folderMenuItem}
                  onPress={() => {
                    setRenameFolderText(folderMenuTarget?.title || '');
                    setIsRenamingFolder(true);
                  }}
                  activeOpacity={0.7}
                >
                  <View style={[styles.folderMenuItemIconBox, { backgroundColor: 'rgba(56, 189, 248, 0.12)' }]}>
                    <MaterialCommunityIcons name="pencil-outline" size={20} color="#38BDF8" />
                  </View>
                  <View style={{ flex: 1, marginLeft: 14 }}>
                    <Text style={styles.folderMenuItemTitle}>Renommer le dossier</Text>
                    <Text style={styles.folderMenuItemSub}>Modifier l'étiquette de ce dossier</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={18} color="#52525B" />
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.folderMenuItem}
                  onPress={() => {
                    setIsConfirmingDeleteFolder(true);
                  }}
                  activeOpacity={0.7}
                >
                  <View style={[styles.folderMenuItemIconBox, { backgroundColor: 'rgba(239, 68, 68, 0.12)' }]}>
                    <MaterialCommunityIcons name="trash-can-outline" size={20} color="#F87171" />
                  </View>
                  <View style={{ flex: 1, marginLeft: 14 }}>
                    <Text style={[styles.folderMenuItemTitle, { color: '#F87171' }]}>
                      Supprimer le dossier
                    </Text>
                    <Text style={styles.folderMenuItemSub}>
                      Retirer le dossier et tous ses morceaux
                    </Text>
                  </View>
                  <Ionicons name="chevron-forward" size={18} color="#52525B" />
                </TouchableOpacity>
              </View>
            )}
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingBottom: 16,
  },
  headerTitle: {
    fontSize: 26,
    fontWeight: '700',
    color: '#FFFFFF',
    letterSpacing: -0.5,
    maxWidth: 240,
    textShadowColor: 'rgba(0, 212, 255, 0.4)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 8,
  },
  backCategoryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  circleMenuBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(10, 16, 32, 0.85)',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(0, 212, 255, 0.35)',
  },
  menuPopup: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 60 : 70,
    right: 20,
    backgroundColor: 'rgba(8, 14, 28, 0.96)',
    borderRadius: 14,
    paddingVertical: 8,
    paddingHorizontal: 6,
    zIndex: 999,
    borderWidth: 1,
    borderColor: 'rgba(0, 212, 255, 0.35)',
    shadowColor: '#00F0FF',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 10,
  },
  menuPopupItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  menuPopupText: {
    color: '#E4E4E7',
    fontSize: 14,
    fontWeight: '500',
  },
  categoryScroll: {
    flex: 1,
  },
  categoryContent: {
    paddingHorizontal: 20,
    paddingTop: 8,
  },
  categoryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
  },
  iconCircleBadge: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(8, 14, 28, 0.85)',
    borderWidth: 1.5,
    borderColor: 'rgba(0, 212, 255, 0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#00F0FF',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.6,
    shadowRadius: 8,
    elevation: 4,
  },
  categoryNameText: {
    fontSize: 18,
    fontWeight: '500',
    color: '#FFFFFF',
    letterSpacing: -0.2,
  },
  categoryCountSub: {
    fontSize: 12,
    color: '#71717A',
    marginTop: 2,
  },
  createPlaylistBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#18171E',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    gap: 12,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#292833',
  },
  createPlaylistBarText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  createPlaylistForm: {
    backgroundColor: '#1C1B22',
    borderRadius: 12,
    padding: 14,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#343240',
  },
  createPlaylistInput: {
    backgroundColor: '#121115',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#FFFFFF',
    fontSize: 14.5,
    borderWidth: 1,
    borderColor: '#2D2B38',
  },
  formCancelBtn: {
    flex: 1,
    backgroundColor: '#272630',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  formCancelText: {
    color: '#A1A1AA',
    fontSize: 14,
    fontWeight: '600',
  },
  formConfirmBtn: {
    flex: 1,
    backgroundColor: '#0284C7',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  formConfirmText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  playlistItemCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#141318',
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#23222B',
  },
  playlistIconBox: {
    width: 44,
    height: 44,
    borderRadius: 10,
    backgroundColor: '#22212B',
    justifyContent: 'center',
    alignItems: 'center',
  },
  playlistCardTitle: {
    color: '#FFFFFF',
    fontSize: 15.5,
    fontWeight: '600',
  },
  playlistCardSub: {
    color: '#71717A',
    fontSize: 12,
    marginTop: 2,
  },
  importFolderPrimaryCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#06281E',
    borderRadius: 14,
    padding: 16,
    borderWidth: 1.5,
    borderColor: '#059669',
    marginBottom: 10,
    shadowColor: '#10B981',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 10,
    elevation: 3,
  },
  importFolderIconBox: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.3)',
  },
  importFolderPrimaryTitle: {
    color: '#ECFDF5',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  oneClickBadge: {
    backgroundColor: '#10B981',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  oneClickBadgeText: {
    color: '#022C22',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  importFolderPrimarySub: {
    color: '#6EE7B7',
    fontSize: 12,
    marginTop: 4,
    lineHeight: 16,
  },
  importFilesSecondaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#18181B',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: '#27272A',
    marginBottom: 14,
  },
  importFilesSecondaryText: {
    color: '#CBD5E1',
    fontSize: 13,
    fontWeight: '600',
  },
  successBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(16, 185, 129, 0.12)',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 10,
    borderWidth: 1,
    borderColor: '#059669',
    marginBottom: 14,
  },
  successBannerText: {
    color: '#34D399',
    fontSize: 13,
    fontWeight: '600',
    flex: 1,
  },
  foldersSectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8,
    marginBottom: 10,
    paddingHorizontal: 2,
  },
  sectionHeaderCount: {
    color: '#71717A',
    fontSize: 12,
    fontWeight: '500',
  },
  folderCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#141318',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: '#23222B',
    marginBottom: 8,
  },
  folderIconBox: {
    width: 44,
    height: 44,
    borderRadius: 10,
    backgroundColor: '#1E232D',
    justifyContent: 'center',
    alignItems: 'center',
  },
  folderTitle: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  folderPath: {
    color: '#71717A',
    fontSize: 12,
    marginTop: 2,
  },
  folderMeta: {
    color: '#71717A',
    fontSize: 11.5,
    marginTop: 3,
  },
  quickPlayFolderBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#1E293B',
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 8,
    borderWidth: 1,
    borderColor: '#334155',
  },
  folderMenuBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#1E232D',
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 6,
    borderWidth: 1,
    borderColor: '#2A3441',
  },
  folderModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  folderModalCard: {
    width: '100%',
    maxWidth: 400,
    backgroundColor: '#161519',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#2A2930',
    overflow: 'hidden',
  },
  folderModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#232228',
  },
  folderModalIconBox: {
    width: 44,
    height: 44,
    borderRadius: 10,
    backgroundColor: '#1E232D',
    justifyContent: 'center',
    alignItems: 'center',
  },
  folderModalTitle: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  folderModalSub: {
    color: '#94A3B8',
    fontSize: 12.5,
    marginTop: 2,
  },
  folderModalCloseBtn: {
    padding: 6,
    borderRadius: 8,
  },
  folderModalMenu: {
    paddingVertical: 8,
  },
  folderMenuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 18,
  },
  folderMenuItemIconBox: {
    width: 38,
    height: 38,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  folderMenuItemTitle: {
    color: '#FFFFFF',
    fontSize: 14.5,
    fontWeight: '600',
  },
  folderMenuItemSub: {
    color: '#71717A',
    fontSize: 12,
    marginTop: 2,
  },
  folderModalBody: {
    padding: 18,
  },
  folderModalSectionLabel: {
    color: '#94A3B8',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.8,
    marginBottom: 8,
  },
  folderRenameInput: {
    backgroundColor: '#0F0E13',
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: '#38BDF8',
    color: '#FFFFFF',
    paddingHorizontal: 14,
    paddingVertical: 11,
    fontSize: 15,
    marginBottom: 16,
  },
  folderModalActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 10,
  },
  folderModalCancelBtn: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 10,
    backgroundColor: '#27272A',
  },
  folderModalCancelText: {
    color: '#E4E4E7',
    fontSize: 13.5,
    fontWeight: '600',
  },
  folderModalConfirmBtn: {
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 10,
    backgroundColor: '#0284C7',
  },
  folderModalConfirmText: {
    color: '#FFFFFF',
    fontSize: 13.5,
    fontWeight: '700',
  },
  folderModalDangerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 10,
    backgroundColor: '#DC2626',
  },
  folderModalDangerText: {
    color: '#FFFFFF',
    fontSize: 13.5,
    fontWeight: '700',
  },
  folderDeleteWarningBox: {
    alignItems: 'center',
    paddingVertical: 6,
    marginBottom: 14,
  },
  folderDeleteWarningTitle: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
    marginTop: 8,
    marginBottom: 6,
  },
  folderDeleteWarningText: {
    color: '#94A3B8',
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 18,
  },
  groupDeleteHeaderBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#27171A',
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#4C1D24',
  },
  groupDeleteHeaderText: {
    color: '#F87171',
    fontSize: 12,
    fontWeight: '700',
  },
  groupDetailHeaderBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    marginBottom: 8,
  },
  groupPlayAllBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#0284C7',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
  },
  groupPlayAllText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  groupShuffleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#18181B',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#27272A',
  },
  groupShuffleText: {
    color: '#D1D5DB',
    fontSize: 13,
    fontWeight: '600',
  },
  sectionHeaderTitle: {
    color: '#A1A1AA',
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  groupCard: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#1A1920',
  },
  groupIconBox: {
    width: 42,
    height: 42,
    borderRadius: 10,
    backgroundColor: '#1F1E26',
    justifyContent: 'center',
    alignItems: 'center',
  },
  groupTitleText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  groupSubtitleText: {
    color: '#71717A',
    fontSize: 12.5,
    marginTop: 2,
  },
  songsListContent: {
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  trackRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: 12,
    marginBottom: 4,
  },
  trackRowActive: {
    backgroundColor: 'rgba(56, 189, 248, 0.12)',
    paddingLeft: 10,
  },
  trackIconBoxActive: {
    backgroundColor: 'rgba(56, 189, 248, 0.2)',
    borderColor: '#38BDF8',
    borderWidth: 1,
  },
  playingBadgePill: {
    backgroundColor: '#38BDF8',
    paddingHorizontal: 6,
    paddingVertical: 1.5,
    borderRadius: 4,
  },
  playingBadgePillText: {
    color: '#000000',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  jumpToActiveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(56, 189, 248, 0.15)',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.4)',
    marginLeft: 'auto',
  },
  jumpToActiveText: {
    color: '#38BDF8',
    fontSize: 12.5,
    fontWeight: '700',
  },
  playlistItemCardActive: {
    borderColor: '#38BDF8',
    backgroundColor: 'rgba(56, 189, 248, 0.08)',
  },
  playlistIconBoxActive: {
    backgroundColor: 'rgba(56, 189, 248, 0.25)',
  },
  playlistCardTitleActive: {
    color: '#38BDF8',
  },
  activePillBadge: {
    backgroundColor: 'rgba(56, 189, 248, 0.2)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#38BDF8',
  },
  activePillBadgeText: {
    color: '#38BDF8',
    fontSize: 9.5,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  trackIconBox: {
    width: 42,
    height: 42,
    borderRadius: 8,
    backgroundColor: '#27272A',
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
  },
  trackThumb: {
    width: '100%',
    height: '100%',
  },
  trackMetaBox: {
    flex: 1,
    marginLeft: 14,
  },
  trackTitleText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#F4F4F5',
  },
  trackTitleTextActive: {
    color: '#38BDF8',
  },
  trackArtistText: {
    fontSize: 12.5,
    color: '#A1A1AA',
    marginTop: 2,
  },
  trackDurationText: {
    fontSize: 13,
    color: '#71717A',
    fontWeight: '500',
    marginLeft: 8,
  },
  rowMenuBtn: {
    padding: 8,
    marginLeft: 4,
  },
  emptyViewBox: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 40,
    paddingHorizontal: 20,
  },
  emptyViewTitle: {
    color: '#E4E4E7',
    fontSize: 16,
    fontWeight: '600',
    marginTop: 12,
  },
  emptyViewSub: {
    color: '#71717A',
    fontSize: 13,
    textAlign: 'center',
    marginTop: 6,
    lineHeight: 18,
  },
  miniPlayerBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    backgroundColor: 'rgba(0, 0, 0, 0.95)',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.08)',
  },
  miniWaveIconBox: {
    marginRight: 14,
  },
  miniInfoBox: {
    flex: 1,
  },
  miniTitleText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  miniSubText: {
    color: '#A1A1AA',
    fontSize: 11.5,
    marginTop: 1,
  },
  miniPlayBtn: {
    width: 36,
    height: 36,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 12,
  },
});
