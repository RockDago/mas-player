export interface ChangelogSubItem {
  prefix?: string;
  boldTitle?: string;
  underlined?: boolean;
  text: string;
}

export interface ChangelogItem {
  prefix?: string;
  isCheck?: boolean;
  boldTitle?: string;
  underlinedTitle?: boolean;
  text: string;
  subItems?: ChangelogSubItem[];
}

export interface ChangelogSection {
  header: string;
  items: ChangelogItem[];
}

export interface ChangelogRelease {
  buildRange: string;
  version: string;
  date?: string;
  sections: ChangelogSection[];
}

export const CHANGELOG_DATA: Record<'fr' | 'en', ChangelogRelease[]> = {
  fr: [
    {
      buildRange: 'Builds 1033-1040',
      version: '1.1.0',
      date: 'Octobre 2026',
      sections: [
        {
          header: 'Améliorations de l’Expérience Visuelle et Stabilité :',
          items: [
            {
              isCheck: true,
              text: 'Arrière-plan noir absolu OLED pur (#000000) sur toutes les pages pour un confort visuel optimal',
            },
            {
              isCheck: true,
              text: 'Démarrage instantané et sécurisé sur les builds natifs iOS (.ipa) et Android (.apk)',
            },
            {
              boldTitle: 'Moteur de Rendu :',
              text: 'contraste équilibré et lisibilité accrue sur tous les écrans AMOLED et LCD',
            },
          ],
        },
      ],
    },
    {
      buildRange: 'Builds 1026-1032',
      version: '1.0.0',
      date: 'Octobre 2026',
      sections: [
        {
          header: 'Mise à jour majeure du Moteur Audio :',
          items: [
            {
              isCheck: true,
              text: 'la fonctionnalité n°1 plébiscitée : Pipeline Audio 64-bit Float Ultra HD',
            },
            {
              boldTitle: 'Pilote USB Exclusif & Sortie Hi-Res :',
              text: 'accès direct au DAC USB connecté en contournant le mixeur Android/système, supportant PCM 44.1-192kHz, FLAC, WAV, ALAC, et contrôle matériel du volume',
            },
            {
              boldTitle: 'Modes Bit Perfect',
              underlinedTitle: true,
              text: ' - conçu pour DACs nomades, amplis audiophiles et écoute haute fidélité :',
              subItems: [
                {
                  boldTitle: 'Follow Track :',
                  underlined: true,
                  text: 'reconfigure dynamiquement la fréquence d’échantillonnage selon la piste source',
                },
                {
                  boldTitle: 'Perfect Bit Perfect :',
                  underlined: true,
                  text: 'désactive le DSP, les gains et le fondu pour envoyer l’audio décodé pur directement au DAC',
                },
                {
                  boldTitle: 'Pipeline 64-bit :',
                  underlined: true,
                  text: 'étend le traitement interne au format Float64 pour un rendu sans perte de bits, sans distorsion ni saturation numérique',
                },
                {
                  boldTitle: 'Égaliseur 10 & 31 Bandes :',
                  underlined: true,
                  text: 'égalisation paramétrique & graphique avec bandes ISO, facteur Q adaptatif et pré-amplification ±15 dB',
                },
                {
                  boldTitle: 'Reverb Studio Pro :',
                  underlined: true,
                  text: 'simulation acoustique paramétrable (taille de salle, damping, pré-délai, diffusion et mix Wet/Dry)',
                },
                {
                  boldTitle: 'Élargisseur Stéréo & Spatialisation :',
                  underlined: true,
                  text: 'contrôle continu du champ stéréo de 0% à 200% et spatialisation 3D binaurale',
                },
              ],
            },
          ],
        },
        {
          header: 'Visualiseur NeonWave & Spectre Temps Réel :',
          items: [
            {
              isCheck: true,
              text: 'Oscilloscope néon réactif fluide à 60 FPS synchronisé sur l’onde sonore',
            },
            {
              boldTitle: 'Analyse Spectrale FFT :',
              text: 'pulsation dynamique réactive au spectre de basses et sous-basses',
            },
            {
              boldTitle: 'Thèmes Visuels Élégants :',
              text: 'Noir Absolu OLED, Bleu Cyber, Violet Néon et Carbone Sombre',
            },
          ],
        },
        {
          header: 'Mémorisation & Confort de Lecture :',
          items: [
            {
              boldTitle: 'Reprise Intelligente de Session :',
              text: 'reprise instantanée à la seconde près, avec sauvegarde automatique du morceau et du preset d’égalisation',
            },
            {
              boldTitle: 'Fondu Enchaîné (Crossfade) :',
              text: 'transition fluide sans coupure entre les titres avec gestion des silences',
            },
            {
              boldTitle: 'Normalisation ReplayGain RG2 :',
              text: 'égalisation automatique du niveau sonore par piste ou par album sans compression',
            },
            {
              boldTitle: 'Détection des Métadonnées :',
              text: 'extraction instantanée des tags ID3v2 et affichage des pochettes HD avec effet de flou dynamique',
            },
          ],
        },
      ],
    },
    {
      buildRange: 'Builds 1018-1025',
      version: '0.9.8',
      date: 'Septembre 2026',
      sections: [
        {
          header: 'Améliorations du Moteur & Codecs :',
          items: [
            {
              boldTitle: 'Décodage Lossless Multi-formats :',
              text: 'support optimisé FLAC, ALAC, WAV, AAC, MP3, OGG et Opus',
            },
            {
              boldTitle: 'Direct Volume Control (DVC 32-bit) :',
              text: 'étage de volume numérique ultra-précis éliminant le bruit de quantification',
            },
            {
              boldTitle: 'Minuterie de Veille Intelligente :',
              text: 'extinction automatique avec fondu sonore progressif en fin de lecture',
            },
            {
              boldTitle: 'Compatibilité Système :',
              text: 'optimisation bord-à-bord Android 15 et gestion des interruptions d’appels',
            },
          ],
        },
      ],
    },
    {
      buildRange: 'Builds 1000-1017',
      version: '0.9.0',
      date: 'Août 2026',
      sections: [
        {
          header: 'Lancement initial de MAS Player :',
          items: [
            {
              boldTitle: 'Architecture Audio Basse Latence :',
              text: 'moteur réactif avec scrubbing audio instantané et contrôle gestuel',
            },
            {
              boldTitle: 'Gestionnaire de Bibliothèque :',
              text: 'analyse rapide des dossiers locaux et gestionnaire de listes de lecture',
            },
          ],
        },
      ],
    },
  ],
  en: [
    {
      buildRange: 'Builds 1033-1040',
      version: '1.1.0',
      date: 'October 2026',
      sections: [
        {
          header: 'Visual Experience & Stability Improvements:',
          items: [
            {
              isCheck: true,
              text: 'Pure OLED absolute black background (#000000) across all screens for optimal visual comfort',
            },
            {
              isCheck: true,
              text: 'Instant, reliable startup on iOS (.ipa) and Android (.apk) production builds',
            },
            {
              boldTitle: 'Display Engine:',
              text: 'balanced contrast and enhanced readability across AMOLED and LCD screens',
            },
          ],
        },
      ],
    },
    {
      buildRange: 'Builds 1026-1032',
      version: '1.0.0',
      date: 'October 2026',
      sections: [
        {
          header: 'major Audio Engine update:',
          items: [
            {
              isCheck: true,
              text: 'the top voted feature from the MAS Player Features list: 64-bit Float DSP pipeline',
            },
            {
              boldTitle: 'USB Exclusive Driver: ',
              text: 'direct access to the attached USB DAC bypassing Android audio, supporting PCM 44.1-192kHz, FLAC, WAV, ALAC, and hardware volume control',
            },
            {
              boldTitle: 'Bit Perfect Modes',
              underlinedTitle: true,
              text: ' - intended for DAPs/USB DACs; supported for Hi-Res, USB Exclusive, and low-latency audio:',
              subItems: [
                {
                  boldTitle: 'Follow Track:',
                  underlined: true,
                  text: 'dynamically reconfigures to match the track’s native sample rate and bit depth',
                },
                {
                  boldTitle: 'Perfect Bit Perfect:',
                  underlined: true,
                  text: 'disables DSP, gains, and crossfade to send decoded audio directly to the output',
                },
                {
                  boldTitle: '64-bit Pipeline:',
                  underlined: true,
                  text: 'extends internal format to Float64 for bit-lossless processing, zero saturation and high precision DSP accuracy',
                },
                {
                  boldTitle: '10 & 31-Band Parametric EQ:',
                  underlined: true,
                  text: 'ISO frequency bands with adaptive Q factor and ±15dB precision preamp gain',
                },
                {
                  boldTitle: 'Pro Studio Reverb:',
                  underlined: true,
                  text: 'acoustic room simulation with room size, damping, pre-delay, diffusion and Wet/Dry mix',
                },
                {
                  boldTitle: 'Stereo Width & 3D Spatializer:',
                  underlined: true,
                  text: 'continuous 0% to 200% stereo image control with binaural spatialization',
                },
              ],
            },
          ],
        },
        {
          header: 'NeonWave Real-Time Visualizer:',
          items: [
            {
              isCheck: true,
              text: '60 FPS ultra-smooth neon oscilloscope reacting to sound waveforms',
            },
            {
              boldTitle: 'FFT Spectrum Analysis:',
              text: 'high-precision dynamic frequency pulse synchronized with bass & sub-bass',
            },
            {
              boldTitle: 'Premium Visual Themes:',
              text: 'Pure Black OLED, Cyber Blue, Neon Violet, and Dark Carbon',
            },
          ],
        },
        {
          header: 'Session Memory & Playback Engine:',
          items: [
            {
              boldTitle: 'Smart Resume Memory:',
              text: 'automatically recalls exact second, track, and active DSP preset across app restarts',
            },
            {
              boldTitle: 'Seamless Crossfade:',
              text: 'millisecond-accurate gapless transition between songs',
            },
            {
              boldTitle: 'ReplayGain RG2:',
              text: 'automatic track and album loudness leveling without digital compression',
            },
            {
              boldTitle: 'Fast Metadata Extraction:',
              text: 'instant local ID3v2 tags and HD album artwork extraction with dynamic blur background',
            },
          ],
        },
      ],
    },
    {
      buildRange: 'Builds 1018-1025',
      version: '0.9.8',
      date: 'September 2026',
      sections: [
        {
          header: 'Audio Engine & Codec Updates:',
          items: [
            {
              boldTitle: 'Lossless Codec Engine:',
              text: 'optimized FLAC, ALAC, WAV, AAC, MP3, OGG, and Opus decoding',
            },
            {
              boldTitle: 'Direct Volume Control (DVC 32-bit):',
              text: 'ultra-precise digital volume stage eliminating quantization noise',
            },
            {
              boldTitle: 'Smart Sleep Timer:',
              text: 'auto power-off with progressive audio fade-out',
            },
            {
              boldTitle: 'System Compatibility:',
              text: 'Android 15 edge-to-edge support and graceful call interruption handling',
            },
          ],
        },
      ],
    },
    {
      buildRange: 'Builds 1000-1017',
      version: '0.9.0',
      date: 'August 2026',
      sections: [
        {
          header: 'Initial MAS Player Release:',
          items: [
            {
              boldTitle: 'Low-Latency Audio Architecture:',
              text: 'reactive sound engine with instant track scrubbing and gesture controls',
            },
            {
              boldTitle: 'Music Library Manager:',
              text: 'high-speed local folder scanning and playlist management',
            },
          ],
        },
      ],
    },
  ],
};
