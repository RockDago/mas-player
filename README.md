# 🎵 MAS Player (iOS & Android) - React Native

Application de lecture audio audiophile haute fidélité **MAS Player**, développée avec **React Native (TypeScript)** et **Expo** par John Saina.


## 🎛️ Fonctionnalités Implémentées

1. **Lecteur Audio Haute Définition** :
   - Support des formats : **FLAC, MP3, WAV, AAC, ALAC**.
   - Lecture continue en arrière-plan sous iOS (`UIBackgroundModes: audio`).
   - Contrôles de lecture complets : Play/Pause, Morceau Précédent, Suivant, Répétition (Tout / Morceau unique), Aléatoire (Shuffle).
   - Bibliothèque vide au premier lancement : importez votre musique (dossier complet en un clic, ou fichiers individuels).

2. **Égaliseur audio 10 bandes** :
   - Les faders, le préampli, les réglages graves/aigus et les préréglages modifient le son lu sur Android et iOS.
   - Les versions natives doivent être reconstruites pour intégrer les filtres audio Kotlin/Swift. `npm ci` applique les patches natifs avant le prebuild.
   - Les commandes d'effets qui ne font pas partie de l'égaliseur restent des réglages d'interface.

3. **Visualiseur audio animé** :
   - L'analyse rythmique et le visualiseur restent actifs pendant la lecture.

4. **Importation de Morceaux Locaux** :
   - Importez vos propres musiques (MP3, FLAC, WAV, AAC) depuis l'application Fichiers d'iOS ou iCloud Drive via le bouton *Importer*.
