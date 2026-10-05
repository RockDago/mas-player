# 🎵 MAS Player (iOS & Android) - React Native

Application de lecture audio audiophile haute fidélité **MAS Player**, développée avec **React Native (TypeScript)** et **Expo** par John Saina.


## 🎛️ Fonctionnalités Implémentées

1. **Lecteur Audio Haute Définition** :
   - Support des formats : **FLAC, MP3, WAV, AAC, ALAC**.
   - Lecture continue en arrière-plan sous iOS (`UIBackgroundModes: audio`).
   - Contrôles de lecture complets : Play/Pause, Morceau Précédent, Suivant, Répétition (Tout / Morceau unique), Aléatoire (Shuffle).
   - Bibliothèque vide au premier lancement : importez votre musique (dossier complet en un clic, ou fichiers individuels).

2. **Égaliseur Graphique 10 Bandes (DSP)** :
   - Fréquences d'égalisation : **31Hz, 62Hz, 125Hz, 250Hz, 500Hz, 1kHz, 2kHz, 4kHz, 8kHz, 16kHz**.
   - Gain précis de **-12 dB à +12 dB** avec graduation visuelle et faders verticaux.
   - Commutateur d'activation / Bypass direct.

3. **Contrôles Dédiés aux Basses & Aigus (Tone Knobs)** :
   - **Potentiomètre rotatif BASS** : Contrôle fin des fréquences graves (-12dB à +12dB).
   - **Potentiomètre rotatif TREBLE** : Contrôle fin des fréquences aiguës (-12dB à +12dB).
   - **Potentiomètre PRÉ-AMPLI** : Gain d'entrée master (-6dB à +6dB).
   - Rétroaction haptique réaliste sur iOS lors de la rotation des boutons.

4. **Préréglages d'Usine (Presets)** :
   - *Flat (Neutre Studio)*
   - *Mega Bass / Bass Boost*
   - *Rock & Metal*
   - *Pop / Modern Hits*
   - *Electro / EDM / Club*
   - *Jazz & Blues*
   - *Vocal Boost / Clarté*
   - *Acoustique & Classique*

5. **Visualiseur de Spectre Audio Animé** :
   - Spectre dynamique de fréquences réactif en temps réel à la lecture audio et aux modifications de l'égaliseur.

6. **Importation de Morceaux Locaux** :
   - Importez vos propres musiques (MP3, FLAC, WAV, AAC) depuis l'application Fichiers d'iOS ou iCloud Drive via le bouton *Importer*.
