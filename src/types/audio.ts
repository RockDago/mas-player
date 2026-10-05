export interface Track {
  id: string;
  title: string;
  artist: string;
  album: string;
  duration: number; // in seconds
  uri: string;
  artwork?: string;
  format?: 'FLAC' | 'MP3' | 'WAV' | 'AAC' | 'ALAC';
  sampleRate?: string;
  bitrate?: string;
  year?: string;
  genre?: string;
  isFavorite?: boolean;
  folder?: string;
  folderPath?: string;
}

export interface Playlist {
  id: string;
  name: string;
  description?: string;
  trackIds: string[];
  createdAt: number;
  coverUri?: string;
}

export interface EqualizerBand {
  id: string;
  frequencyLabel: string;
  gain: number; // in dB (-12 to +12)
}

export interface EqualizerPreset {
  id: string;
  name: string;
  description: string;
  bass: number; // -12 to +12 dB
  treble: number; // -12 to +12 dB
  preamp: number; // -6 to +6 dB
  bands: number[]; // 10 bands gains in dB
}

export interface DSPState {
  enabled: boolean;
  presetId: string;
  bass: number; // -12 to +12 dB
  treble: number; // -12 to +12 dB
  preamp: number; // -6 to +6 dB
  stereoExpansion: number; // 0 to 100% — élargit l'image stéréo, sans changer le niveau
  crossfeed: number; // 0 to 100% — rapproche les canaux, pour l'écoute casque
  tempo: number; // 0.5x to 2.0x
  bands: number[]; // 10 bands
  balance: number; // -1.0 to +1.0 (-1=L, 0=center, +1=R)
  volume: number; // 0 to 100%
  mono: boolean; // mono downmix toggle
  tempoEnabled: boolean; // tempo button toggle

  // ── Réverbération ────────────────────────────────────────────────────────
  // Ces trois champs pilotaient un `useState` local dans l'onglet FX, sans
  // qu'aucun moteur audio ne les lise : la réverbération n'existait nulle part,
  // ni en Swift, ni en Web Audio. Les knobs étaient manipulables sans produire
  // le moindre son.
  //
  // Ils vivent désormais dans `DSPState` — donc dans le préréglage persisté et
  // dans le pont natif — et sont réellement appliqués par `SpatialState`
  // (côté iOS) et par un réseau de retard à séparateur (côté web).
  //
  // `roomSize` 0–100 : taille de la pièce. Piloté par le même exposant que la
  //   largeur stéréo (`REVERB_MAX_ROOM_SIZE`), pour que les deux knobs obéissent
  //   à une courbe lisible et que `sync-check.cjs` puisse les comparer.
  // `damping` 0–100 : atténuation des aigus par le temps. 0 = pièce métallique,
  //   100 = pièce sourde et étouffée. N'agit que sur la boucle de retour, pas
  //   sur le signal direct — atténuer ce dernier rendrait la pièce inaudible.
  // `reverbMix` 0–100 : dosage du signal reverbéré contre le signal sec.
  reverbEnabled: boolean;
  roomSize: number;
  damping: number;
  reverbMix: number;

  // ── TONE et LIMIT ───────────────────────────────────────────────────────
  // Ces deux pastilles étaient, comme les trois knobs de réverbération, un
  // `useState` local : manœuvrables, sans aucun effet sonore.
  //
  // `toneEnabled` ne pilote pas un étage qui n'existe pas. Il commande la
  // **contribution bass/treble**, celle qui vient s'ajouter aux 10 bandes : à
  // `false`, les bandes restent et la pente disparaît. C'est la seule lecture
  // honnête du mot « TONE » à côté d'un « EQU » qui régit, lui, les bandes.
  //
  // `limitEnabled` commute réellement le limiteur, qui tournait en permanence à
  // −3 dBFS. Il vaut `true` par défaut : le limiteur est la garantie que la
  // chaîne ne dépasse jamais le zéro numérique, et le désactiver par défaut
  // reviendrait à retirer cette garantie à un utilisateur qui ne l'a pas
  // demandée.
  toneEnabled: boolean;
  limitEnabled: boolean;
}
