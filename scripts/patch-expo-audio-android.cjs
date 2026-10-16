const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Patch Android & iOS d'expo-audio — contrôles complets (Précédent, Pause/Play, Suivant)
 * dans la notification système et sur l'écran verrouillé pour TOUTES les versions d'Android (8 à 15)
 * et pour iOS (MPRemoteCommandCenter / NowPlaying).
 *
 * Ce patch est le câblage complet de l'événement `onRemoteCommand` :
 * `playerManager.subscribeRemoteCommands` s'y abonne pour piloter la file.
 * Installe aussi le traitement d'égaliseur PCM natif iOS et Android.
 */

console.log('[patch-expo-audio-android] Starting robust patch for transport controls (Android & iOS)...');

const expoAudioAndroidDir = path.resolve(__dirname, '../node_modules/expo-audio/android/src/main/java/expo/modules/audio');
const expoAudioIosDir = path.resolve(__dirname, '../node_modules/expo-audio/ios');

const controlsServicePath = path.join(expoAudioAndroidDir, 'service', 'AudioControlsService.kt');
const sessionCallbackPath = path.join(expoAudioAndroidDir, 'service', 'AudioMediaSessionCallback.kt');
const iosMediaControllerPath = path.join(expoAudioIosDir, 'MediaController.swift');

if (!fs.existsSync(controlsServicePath) || !fs.existsSync(sessionCallbackPath)) {
  console.warn('[patch-expo-audio-android] expo-audio Android service files not found — notification controls will be left untouched.');
}

// ── 1. Patch AudioControlsService.kt ─────────────────────────────────────────
if (fs.existsSync(controlsServicePath)) {
  let controlsService = fs.readFileSync(controlsServicePath, 'utf8');

  // 1a. Constantes d'action et référence activeService dans companion object
  if (!controlsService.includes('var activeService: AudioControlsService?')) {
    controlsService = controlsService.replace(
      /(\s*companion object \{)/,
      `$1
    @Volatile
    var activeService: AudioControlsService? = null
`
    );
  }

  if (!controlsService.includes('ACTION_NEXT')) {
    controlsService = controlsService.replace(
      /(\s*const val SEEK_INTERVAL_MS = 10000L)/,
      `
    const val ACTION_NEXT = "expo.modules.audio.action.NEXT"
    const val ACTION_PREVIOUS = "expo.modules.audio.action.PREVIOUS"
$1`
    );
  }

  // 1b. Cycle de vie activeService (onCreate / onDestroy)
  if (!controlsService.includes('activeService = this')) {
    controlsService = controlsService.replace(
      /(override fun onCreate\(\) \{[\s\S]*?super\.onCreate\(\))/,
      `$1\n    activeService = this`
    );
  }

  if (!controlsService.includes('if (activeService == this)')) {
    controlsService = controlsService.replace(
      /(override fun onDestroy\(\) \{[\s\S]*?super\.onDestroy\(\))/,
      `$1\n    if (activeService == this) {\n      activeService = null\n    }`
    );
  }

  // 1c. Helper notifyRemoteCommand
  if (!controlsService.includes('fun AudioPlayer.notifyRemoteCommand')) {
    controlsService = controlsService.replace(
      /(\n)([ \t]*)(private fun shouldPlayInSilentMode\(\): Boolean \{)/,
      `$1$2fun AudioPlayer.notifyRemoteCommand(action: String) {
$2  try {
$2    emit("onRemoteCommand", mapOf("action" to action))
$2  } catch (e: Exception) {
$2    appContext?.jsLogger?.error(
$2      getPlaybackServiceErrorMessage("Failed to forward remote command to JS"),
$2      e
$2    )
$2  }
$2}
$1$2$3`
    );
  }

  // 1d. Remplacement propre du bloc when (intent?.action) dans onStartCommand sans duplication
  const whenActionRegex = /when \(intent\?\.action\) \{[\s\S]*?\n    \}/;
  const newWhenAction = `when (intent?.action) {
        ACTION_PLAY -> {
          if (shouldPlayInSilentMode()) {
            currentPlayerRef.play()
            currentPlayer?.notifyRemoteCommand("play")
          }
        }
        ACTION_PAUSE -> {
          currentPlayerRef.pause()
          currentPlayer?.notifyRemoteCommand("pause")
        }
        ACTION_TOGGLE -> {
          if (currentPlayerRef.isPlaying) {
            currentPlayerRef.pause()
            currentPlayer?.notifyRemoteCommand("pause")
          } else if (shouldPlayInSilentMode()) {
            currentPlayerRef.play()
            currentPlayer?.notifyRemoteCommand("play")
          }
        }
        ACTION_SEEK_FORWARD -> currentPlayerRef.seekTo(currentPlayerRef.currentPosition + SEEK_INTERVAL_MS)
        ACTION_SEEK_BACKWARD -> currentPlayerRef.seekTo(currentPlayerRef.currentPosition - SEEK_INTERVAL_MS)
        ACTION_NEXT -> currentPlayer?.notifyRemoteCommand("next")
        ACTION_PREVIOUS -> currentPlayer?.notifyRemoteCommand("previous")
      }`;

  controlsService = controlsService.replace(whenActionRegex, newWhenAction);

  // 1e. Canal de notification avec visibilité écran verrouillé explicite
  const channelRegex = /private fun createNotificationChannelIfNeeded\(\) \{[\s\S]*?\n  \}/;
  const newChannel = `private fun createNotificationChannelIfNeeded() {
    val notificationManager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val existingChannel = notificationManager.getNotificationChannel(CHANNEL_ID)
      if (existingChannel == null) {
        val channel = NotificationChannel(
          CHANNEL_ID,
          "Audio Playback",
          NotificationManager.IMPORTANCE_LOW
        ).apply {
          description = "MAS Player Playback Controls"
          setShowBadge(false)
          lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        }
        notificationManager.createNotificationChannel(channel)
      } else {
        existingChannel.lockscreenVisibility = Notification.VISIBILITY_PUBLIC
      }
    }
  }`;
  controlsService = controlsService.replace(channelRegex, newChannel);

  // 1f. Notification de verrouillage avec boutons Précédent / Play-Pause / Suivant et visibilité publique
  const buildNotificationRegex = /private fun buildNotification\(\): Notification\? \{[\s\S]*?return builder\.build\(\)\n  \}/;
  const newBuildNotification = `private fun buildNotification(): Notification? {
    val session = mediaSession ?: return null

    val builder = NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(androidx.media3.session.R.drawable.media3_icon_circular_play)
      .setContentTitle(currentMetadata?.title ?: "\\u200E")
      .setContentText(currentMetadata?.artist)
      .setSubText(currentMetadata?.albumTitle)
      .setLargeIcon(currentArtwork)
      .setContentIntent(buildContentIntent())
      .setAutoCancel(false)
      .setOngoing(session.player.isPlaying)
      .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setPriority(NotificationCompat.PRIORITY_MAX)

    val style = MediaStyleNotificationHelper.MediaStyle(session)
    val compactViewIndices = mutableListOf<Int>()
    var currentIndex = 0

    // Bouton 1 : Précédent (toujours présent à gauche)
    builder.addAction(
      NotificationCompat.Action(
        androidx.media3.session.R.drawable.media3_icon_skip_previous,
        "Previous",
        buildActionPendingIntent(ACTION_PREVIOUS)
      )
    )
    compactViewIndices.add(currentIndex)
    currentIndex++

    // Bouton 2 : Lecture / Pause (toujours présent au centre)
    builder.addAction(
      NotificationCompat.Action(
        if (session.player.isPlaying) {
          androidx.media3.session.R.drawable.media3_icon_pause
        } else {
          androidx.media3.session.R.drawable.media3_icon_play
        },
        if (session.player.isPlaying) "Pause" else "Play",
        buildActionPendingIntent(if (session.player.isPlaying) ACTION_PAUSE else ACTION_PLAY)
      )
    )
    compactViewIndices.add(currentIndex)
    currentIndex++

    // Bouton 3 : Suivant (toujours présent à droite)
    builder.addAction(
      NotificationCompat.Action(
        androidx.media3.session.R.drawable.media3_icon_skip_next,
        "Next",
        buildActionPendingIntent(ACTION_NEXT)
      )
    )
    compactViewIndices.add(currentIndex)
    currentIndex++

    // Assure l'affichage des 3 boutons même en vue compacte / écran verrouillé
    style.setShowActionsInCompactView(*compactViewIndices.toIntArray())

    builder.setStyle(style)
    return builder.build()
  }`;
  controlsService = controlsService.replace(buildNotificationRegex, newBuildNotification);

  // 1g. Placeholder notification avec visibilité publique
  const placeholderRegex = /private fun buildPlaceholderNotification\(\): Notification =[\s\S]*?\.build\(\)/;
  const newPlaceholder = `private fun buildPlaceholderNotification(): Notification =
    NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(androidx.media3.session.R.drawable.media3_icon_circular_play)
      .setContentTitle("‎")
      .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setSilent(true)
      .setShowWhen(false)
      .build()`;
  controlsService = controlsService.replace(placeholderRegex, newPlaceholder);

  // 1h. Remplacement de updateSessionCustomLayout pour synchroniser MediaSession
  const updateLayoutRegex = /private fun updateSessionCustomLayout\(isPlaying: Boolean\) \{[\s\S]*?session\.setMediaButtonPreferences\(mediaButtons\)\n  \}/;
  const newUpdateLayout = `private fun updateSessionCustomLayout(isPlaying: Boolean) {
    val session = mediaSession ?: return
    val mediaButtons = mutableListOf<CommandButton>()

    mediaButtons.add(
      CommandButton.Builder(CommandButton.ICON_SKIP_PREVIOUS)
        .setDisplayName("Previous")
        .setEnabled(true)
        .setSessionCommand(SessionCommand(ACTION_PREVIOUS, Bundle.EMPTY))
        .setSlots(CommandButton.SLOT_BACK)
        .build()
    )

    mediaButtons.add(
      CommandButton.Builder(if (isPlaying) CommandButton.ICON_PAUSE else CommandButton.ICON_PLAY)
        .setDisplayName(if (isPlaying) "Pause" else "Play")
        .setEnabled(true)
        .setPlayerCommand(Player.COMMAND_PLAY_PAUSE)
        .setSlots(CommandButton.SLOT_CENTRAL)
        .build()
    )

    mediaButtons.add(
      CommandButton.Builder(CommandButton.ICON_SKIP_NEXT)
        .setDisplayName("Next")
        .setEnabled(true)
        .setSessionCommand(SessionCommand(ACTION_NEXT, Bundle.EMPTY))
        .setSlots(CommandButton.SLOT_FORWARD)
        .build()
    )

    session.setCustomLayout(mediaButtons)
    session.setMediaButtonPreferences(mediaButtons)
  }`;
  controlsService = controlsService.replace(updateLayoutRegex, newUpdateLayout);

  // 1i. Prévention de la coupure brutale du service d'arrière-plan
  if (controlsService.includes('stopForeground(STOP_FOREGROUND_REMOVE)\n      return super.onStartCommand(intent, flags, startId)')) {
    controlsService = controlsService.replace(
      'stopForeground(STOP_FOREGROUND_REMOVE)\n      return super.onStartCommand(intent, flags, startId)',
      'return super.onStartCommand(intent, flags, startId)'
    );
  }

  if (controlsService.includes('currentPlayer?.assignBasicMediaSession()\n    stopForeground(STOP_FOREGROUND_REMOVE)')) {
    controlsService = controlsService.replace(
      'currentPlayer?.assignBasicMediaSession()\n    stopForeground(STOP_FOREGROUND_REMOVE)',
      `currentPlayer?.assignBasicMediaSession()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(STOP_FOREGROUND_DETACH)
    }`
    );
  }

  fs.writeFileSync(controlsServicePath, controlsService, 'utf8');
  console.log('[patch-expo-audio-android] AudioControlsService.kt updated successfully.');
}

// ── 2. Patch AudioMediaSessionCallback.kt ─────────────────────────────────────
const newSessionCallbackContent = `package expo.modules.audio.service

import android.os.Bundle
import androidx.media3.common.Player
import androidx.media3.session.MediaSession
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionResult
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import com.google.common.util.concurrent.ListenableFuture

@OptIn(UnstableApi::class)
class AudioMediaSessionCallback : MediaSession.Callback {
  override fun onConnect(
    session: MediaSession,
    controller: MediaSession.ControllerInfo
  ): MediaSession.ConnectionResult {
    try {
      return MediaSession.ConnectionResult.AcceptedResultBuilder(session)
        .setAvailablePlayerCommands(
          MediaSession.ConnectionResult.DEFAULT_PLAYER_COMMANDS.buildUpon()
            .add(Player.COMMAND_PLAY_PAUSE)
            .add(Player.COMMAND_SEEK_TO_NEXT)
            .add(Player.COMMAND_SEEK_TO_PREVIOUS)
            .add(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
            .add(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
            .add(Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM)
            .add(Player.COMMAND_SEEK_FORWARD)
            .add(Player.COMMAND_SEEK_BACK)
            .build()
        )
        .setAvailableSessionCommands(
          MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS.buildUpon()
            .add(SessionCommand(AudioControlsService.ACTION_SEEK_BACKWARD, Bundle.EMPTY))
            .add(SessionCommand(AudioControlsService.ACTION_SEEK_FORWARD, Bundle.EMPTY))
            .add(SessionCommand(AudioControlsService.ACTION_PREVIOUS, Bundle.EMPTY))
            .add(SessionCommand(AudioControlsService.ACTION_NEXT, Bundle.EMPTY))
            .build()
        )
        .build()
    } catch (e: Exception) {
      return MediaSession.ConnectionResult.reject()
    }
  }

  override fun onCustomCommand(
    session: MediaSession,
    controller: MediaSession.ControllerInfo,
    command: SessionCommand,
    args: Bundle
  ): ListenableFuture<SessionResult> {
    when (command.customAction) {
      AudioControlsService.ACTION_SEEK_FORWARD -> {
        session.player.seekTo(session.player.currentPosition + AudioControlsService.SEEK_INTERVAL_MS)
      }
      AudioControlsService.ACTION_SEEK_BACKWARD -> {
        session.player.seekTo(session.player.currentPosition - AudioControlsService.SEEK_INTERVAL_MS)
      }
      AudioControlsService.ACTION_PREVIOUS -> {
        try {
          AudioControlsService.activeService?.currentPlayer?.notifyRemoteCommand("previous")
        } catch (_: Exception) {}
      }
      AudioControlsService.ACTION_NEXT -> {
        try {
          AudioControlsService.activeService?.currentPlayer?.notifyRemoteCommand("next")
        } catch (_: Exception) {}
      }
    }
    return super.onCustomCommand(session, controller, command, args)
  }

  override fun onPlayerCommandRequest(
    session: MediaSession,
    controller: MediaSession.ControllerInfo,
    playerCommand: Int
  ): Int {
    when (playerCommand) {
      Player.COMMAND_SEEK_TO_NEXT,
      Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM -> {
        try {
          AudioControlsService.activeService?.currentPlayer?.notifyRemoteCommand("next")
        } catch (_: Exception) {}
        return MediaSession.ConnectionResult.RESULT_SUCCESS
      }
      Player.COMMAND_SEEK_TO_PREVIOUS,
      Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM -> {
        try {
          AudioControlsService.activeService?.currentPlayer?.notifyRemoteCommand("previous")
        } catch (_: Exception) {}
        return MediaSession.ConnectionResult.RESULT_SUCCESS
      }
      Player.COMMAND_PLAY_PAUSE -> {
        if (session.player.isPlaying) {
          session.player.pause()
          try {
            AudioControlsService.activeService?.currentPlayer?.notifyRemoteCommand("pause")
          } catch (_: Exception) {}
        } else {
          session.player.play()
          try {
            AudioControlsService.activeService?.currentPlayer?.notifyRemoteCommand("play")
          } catch (_: Exception) {}
        }
        return MediaSession.ConnectionResult.RESULT_SUCCESS
      }
    }
    return super.onPlayerCommandRequest(session, controller, playerCommand)
  }
}
`;

if (fs.existsSync(sessionCallbackPath)) {
  fs.writeFileSync(sessionCallbackPath, newSessionCallbackContent, 'utf8');
  console.log('[patch-expo-audio-android] AudioMediaSessionCallback.kt updated successfully.');
}

// ── 3. Patch iOS MediaController.swift ────────────────────────────────────────
if (fs.existsSync(iosMediaControllerPath)) {
  let mediaController = fs.readFileSync(iosMediaControllerPath, 'utf8');

  // Ajout des commandes Next / Previous et propagation des événements vers JS
  if (!mediaController.includes('nextTrackCommand.isEnabled = true')) {
    const playPauseTargetRegex = /remoteCommandCenter\.playCommand\.addTarget \{[\s\S]*?player\.ref\.pause\(\)\s*return \.success\s*\}/;
    const newPlayPauseTarget = `remoteCommandCenter.playCommand.addTarget { [weak self] _ in
      guard let player = self?.activePlayer else {
        return .commandFailed
      }

      player.play(at: Float(player.currentRate > 0 ? player.currentRate : 1.0))
      player.emit(event: "onRemoteCommand", payload: ["action": "play"])
      return .success
    }

    remoteCommandCenter.pauseCommand.addTarget { [weak self] _ in
      guard let player = self?.activePlayer else {
        return .commandFailed
      }

      player.ref.pause()
      player.emit(event: "onRemoteCommand", payload: ["action": "pause"])
      return .success
    }

    remoteCommandCenter.nextTrackCommand.isEnabled = true
    remoteCommandCenter.nextTrackCommand.addTarget { [weak self] _ in
      guard let player = self?.activePlayer else {
        return .commandFailed
      }
      player.emit(event: "onRemoteCommand", payload: ["action": "next"])
      return .success
    }

    remoteCommandCenter.previousTrackCommand.isEnabled = true
    remoteCommandCenter.previousTrackCommand.addTarget { [weak self] _ in
      guard let player = self?.activePlayer else {
        return .commandFailed
      }
      player.emit(event: "onRemoteCommand", payload: ["action": "previous"])
      return .success
    }`;

    mediaController = mediaController.replace(playPauseTargetRegex, newPlayPauseTarget);

    // Dans disableRemoteCommands
    if (!mediaController.includes('nextTrackCommand.isEnabled = false')) {
      mediaController = mediaController.replace(
        /(remoteCommandCenter\.playCommand\.isEnabled = false)/,
        `remoteCommandCenter.nextTrackCommand.isEnabled = false\n    remoteCommandCenter.previousTrackCommand.isEnabled = false\n    $1`
      );
      mediaController = mediaController.replace(
        /(remoteCommandCenter\.playCommand\.removeTarget\(self\))/,
        `remoteCommandCenter.nextTrackCommand.removeTarget(self)\n    remoteCommandCenter.previousTrackCommand.removeTarget(self)\n    $1`
      );
    }

    fs.writeFileSync(iosMediaControllerPath, mediaController, 'utf8');
    console.log('[patch-expo-audio-android] iOS MediaController.swift updated successfully.');
  }
}

require('./patch-expo-audio-equalizer.cjs');
