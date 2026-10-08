# 🎵 MAS Player (iOS & Android) - React Native

Application de lecture audio audiophile haute fidélité **MAS Player**, développée avec **React Native (TypeScript)** et **Expo** par John Saina.


## 🎛️ Fonctionnalités Implémentées

1. **Lecteur Audio Haute Définition** :
   - Support des formats : **FLAC, MP3, WAV, AAC, ALAC**.
   - Lecture continue en arrière-plan sous iOS (`UIBackgroundModes: audio`).
   - Contrôles de lecture complets : Play/Pause, Morceau Précédent, Suivant, Répétition (Tout / Morceau unique), Aléatoire (Shuffle).
   - Bibliothèque vide au premier lancement : importez votre musique (dossier complet en un clic, ou fichiers individuels).

2. **Interface égaliseur et effets conservée** :
   - Les faders, boutons, effets et préréglages restent présents dans l'interface.
   - Le traitement audio DSP a été retiré : ces réglages ne modifient plus le son. Le volume et la vitesse de lecture restent actifs.

3. **Visualiseur audio animé** :
   - L'analyse rythmique et le visualiseur restent actifs pendant la lecture.

4. **Importation de Morceaux Locaux** :
   - Importez vos propres musiques (MP3, FLAC, WAV, AAC) depuis l'application Fichiers d'iOS ou iCloud Drive via le bouton *Importer*.
