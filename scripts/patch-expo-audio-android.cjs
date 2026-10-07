const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Patch Android d'expo-audio — contrôles complets (Précédent, Pause/Play, Suivant)
 * dans la notification système et sur l'écran verrouillé pour TOUTES les versions d'Android (8 à 15).
 */

console.log('[patch-expo-audio-android] Starting robust patch for Android transport controls...');

const expoAudioDir = path.resolve(__dirname, '../node_modules/expo-audio/android/src/main/java/expo/modules/audio');

const controlsServicePath = path.join(expoAudioDir, 'service', 'AudioControlsService.kt');
const sessionCallbackPath = path.join(expoAudioDir, 'service', 'AudioMediaSessionCallback.kt');

if (!fs.existsSync(controlsServicePath) || !fs.existsSync(sessionCallbackPath)) {
  console.log('[patch-expo-audio-android] expo-audio service files not found, skipping.');
  process.exit(0);
}

// ── 1. Patch AudioControlsService.kt ─────────────────────────────────────────
let controlsService = fs.readFileSync(controlsServicePath, 'utf8');

// 1a. Constantes d'action
if (!controlsService.includes('ACTION_NEXT')) {
  controlsService = controlsService.replace(
    /(\s*const val SEEK_INTERVAL_MS = 10000L)/,
    `
    const val ACTION_NEXT = "expo.modules.audio.action.NEXT"
    const val ACTION_PREVIOUS = "expo.modules.audio.action.PREVIOUS"
$1`
  );
}

// 1b. Traitement des actions dans onStartCommand
if (!controlsService.includes('ACTION_NEXT ->')) {
  controlsService = controlsService.replace(
    /(ACTION_SEEK_BACKWARD -> currentPlayerRef\.seekTo\(currentPlayerRef\.currentPosition - SEEK_INTERVAL_MS\))/,
    `$1
        ACTION_PLAY -> {
          if (shouldPlayInSilentMode()) {
            currentPlayerRef.play()
            currentPlayerRef.notifyRemoteCommand("play")
          }
        }
        ACTION_PAUSE -> {
          currentPlayerRef.pause()
          currentPlayerRef.notifyRemoteCommand("pause")
        }
        ACTION_NEXT -> currentPlayerRef.notifyRemoteCommand("next")
        ACTION_PREVIOUS -> currentPlayerRef.notifyRemoteCommand("previous")`
  );
}

// 1c. Helper notifyRemoteCommand
if (!controlsService.includes('notifyRemoteCommand')) {
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

// 1d. Remplacement de buildNotification pour garantir l'affichage de [Précédent, Pause/Play, Suivant] sur TOUS les Android
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

// 1e. Remplacement de updateSessionCustomLayout pour synchroniser MediaSession
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

// 1f. Prévention de la coupure brutale du service d'arrière-plan
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
import expo.modules.audio.AudioPlayer

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
          val player = session.player as? AudioPlayer
          player?.notifyRemoteCommand("previous")
        } catch (_: Exception) {}
      }
      AudioControlsService.ACTION_NEXT -> {
        try {
          val player = session.player as? AudioPlayer
          player?.notifyRemoteCommand("next")
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
          val player = session.player as? AudioPlayer
          player?.notifyRemoteCommand("next")
        } catch (_: Exception) {}
        return MediaSession.ConnectionResult.RESULT_SUCCESS
      }
      Player.COMMAND_SEEK_TO_PREVIOUS,
      Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM -> {
        try {
          val player = session.player as? AudioPlayer
          player?.notifyRemoteCommand("previous")
        } catch (_: Exception) {}
        return MediaSession.ConnectionResult.RESULT_SUCCESS
      }
      Player.COMMAND_PLAY_PAUSE -> {
        if (session.player.isPlaying) {
          session.player.pause()
        } else {
          session.player.play()
        }
        return MediaSession.ConnectionResult.RESULT_SUCCESS
      }
    }
    return super.onPlayerCommandRequest(session, controller, playerCommand)
  }
}
`;

fs.writeFileSync(sessionCallbackPath, newSessionCallbackContent, 'utf8');
console.log('[patch-expo-audio-android] AudioMediaSessionCallback.kt updated successfully.');

// ── 3. Patch AudioPlayer.kt and AudioModule.kt to expose audioSessionId ─────────
const audioPlayerPath = path.join(expoAudioDir, 'AudioPlayer.kt');
const audioRenderersFactoryPath = path.join(expoAudioDir, 'MASAudioRenderersFactory.kt');
const audioRenderersFactory = `package expo.modules.audio

import android.content.Context
import android.util.Log
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.DefaultAudioSink

@UnstableApi
internal class MASAudioRenderersFactory(context: Context) : DefaultRenderersFactory(context) {
  override fun buildAudioSink(
    context: Context,
    enableFloatOutput: Boolean,
    enableAudioOutputPlaybackParams: Boolean
  ): AudioSink {
    val processor = try {
      Class.forName("expo.modules.audiodsp.AudioDSPProcessor")
        .getDeclaredConstructor()
        .newInstance() as AudioProcessor
    } catch (error: ReflectiveOperationException) {
      Log.e("MASPlayer.AudioDSP", "Could not load the native PCM processor; using the default audio sink.", error)
      return super.buildAudioSink(context, enableFloatOutput, enableAudioOutputPlaybackParams)
    } catch (error: ClassCastException) {
      Log.e("MASPlayer.AudioDSP", "Native PCM processor does not implement Media3 AudioProcessor; using the default audio sink.", error)
      return super.buildAudioSink(context, enableFloatOutput, enableAudioOutputPlaybackParams)
    }

    return DefaultAudioSink.Builder(context)
      .setAudioProcessors(arrayOf(processor))
      .setEnableFloatOutput(enableFloatOutput)
      .setEnableAudioOutputPlaybackParameters(enableAudioOutputPlaybackParams)
      .build()
  }
}
`;
if (!fs.existsSync(audioRenderersFactoryPath) ||
    fs.readFileSync(audioRenderersFactoryPath, 'utf8') !== audioRenderersFactory) {
  fs.writeFileSync(audioRenderersFactoryPath, audioRenderersFactory, 'utf8');
  console.log('[patch-expo-audio-android] MASAudioRenderersFactory.kt created.');
}
if (fs.existsSync(audioPlayerPath)) {
  let playerContent = fs.readFileSync(audioPlayerPath, 'utf8');
  if (!playerContent.includes('MASAudioRenderersFactory(context)')) {
    playerContent = playerContent.replace(
      'ExoPlayer.Builder(context).apply {',
      'ExoPlayer.Builder(context, MASAudioRenderersFactory(context)).apply {'
    );
    if (!playerContent.includes('MASAudioRenderersFactory(context)')) {
      throw new Error('[patch-expo-audio-android] Could not wire MASAudioRenderersFactory into AudioPlayer.kt.');
    }
  }
  if (!playerContent.includes('setAudioSessionId')) {
    playerContent = playerContent.replace(
      'player = ExoPlayer.Builder(context)',
      `player = run {
    val am = context.getSystemService(Context.AUDIO_SERVICE) as? android.media.AudioManager
    val sid = am?.generateAudioSessionId() ?: androidx.media3.common.C.AUDIO_SESSION_ID_UNSET
    ExoPlayer.Builder(context).apply {
      if (sid != androidx.media3.common.C.AUDIO_SESSION_ID_UNSET && sid > 0) {
        setAudioSessionId(sid)
      }
    }
  }`
    );
    console.log('[patch-expo-audio-android] AudioPlayer.kt patched with setAudioSessionId on ExoPlayer.Builder.');
  }
  if (!playerContent.includes('val audioSessionId: Int')) {
    playerContent = playerContent.replace(
      'var preservesPitch = true',
      'var preservesPitch = true\n  val audioSessionId: Int\n    get() = ref.audioSessionId'
    );
    playerContent = playerContent.replace(
      '"id" to id,',
      '"id" to id,\n      "audioSessionId" to ref.audioSessionId,'
    );
  }
  if (!playerContent.includes('WAKE_MODE_LOCAL')) {
    playerContent = playerContent.replace(
      '.setAudioAttributes(AudioAttributes.DEFAULT, false)',
      `.setWakeMode(androidx.media3.common.C.WAKE_MODE_LOCAL)
    .setHandleAudioBecomingNoisy(true)
    .setAudioAttributes(
      androidx.media3.common.AudioAttributes.Builder()
        .setContentType(androidx.media3.common.C.AUDIO_CONTENT_TYPE_MUSIC)
        .setUsage(androidx.media3.common.C.USAGE_MEDIA)
        .build(),
      true
    )`
    );
    console.log('[patch-expo-audio-android] AudioPlayer.kt patched with WAKE_MODE_LOCAL & proper AudioAttributes.');
  }
  fs.writeFileSync(audioPlayerPath, playerContent, 'utf8');
  console.log('[patch-expo-audio-android] AudioPlayer.kt patched with audioSessionId.');
}

const audioModulePath = path.join(expoAudioDir, 'AudioModule.kt');
if (fs.existsSync(audioModulePath)) {
  let moduleContent = fs.readFileSync(audioModulePath, 'utf8');
  if (!moduleContent.includes('Property("audioSessionId")')) {
    moduleContent = moduleContent.replace(
      'Property("id") { player ->',
      'Property("audioSessionId") { player ->\n        runOnMain {\n          player.ref.audioSessionId\n        }\n      }\n\n      Function("getAudioSessionId") { player: AudioPlayer ->\n        runOnMain {\n          player.ref.audioSessionId\n        }\n      }\n\n      Property("id") { player ->'
    );
    fs.writeFileSync(audioModulePath, moduleContent, 'utf8');
    console.log('[patch-expo-audio-android] AudioModule.kt patched with audioSessionId property.');
  } else if (!moduleContent.includes('Function("getAudioSessionId")')) {
    moduleContent = moduleContent.replace(
      'Property("audioSessionId") { player ->\n        runOnMain {\n          player.ref.audioSessionId\n        }\n      }',
      'Property("audioSessionId") { player ->\n        runOnMain {\n          player.ref.audioSessionId\n        }\n      }\n\n      Function("getAudioSessionId") { player: AudioPlayer ->\n        runOnMain {\n          player.ref.audioSessionId\n        }\n      }'
    );
    fs.writeFileSync(audioModulePath, moduleContent, 'utf8');
    console.log('[patch-expo-audio-android] AudioModule.kt patched with getAudioSessionId function.');
  }
}

console.log('[patch-expo-audio-android] All Android audio & notification patches applied.');