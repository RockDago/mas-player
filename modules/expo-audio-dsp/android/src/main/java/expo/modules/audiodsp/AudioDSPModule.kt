package expo.modules.audiodsp

import android.content.Context
import android.media.AudioManager
import android.media.audiofx.BassBoost
import android.media.audiofx.Equalizer
import android.media.audiofx.LoudnessEnhancer
import android.media.audiofx.PresetReverb
import android.media.audiofx.Virtualizer
import android.os.Build
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlin.math.abs

class AudioDSPModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("React context is null")

  private var activeSessionId: Int = 0
  private var equalizer: Equalizer? = null
  private var bassBoost: BassBoost? = null
  private var virtualizer: Virtualizer? = null
  private var loudnessEnhancer: LoudnessEnhancer? = null
  private var presetReverb: PresetReverb? = null

  // Dernier état DSP mémorisé
  private var pendingBands: List<Double> = emptyList()
  private var pendingPreamp: Double = 0.0
  private var pendingBalance: Double = 0.0
  private var pendingMono: Boolean = false
  private var pendingStereoExpansion: Double = 0.0
  private var pendingEnabled: Boolean = true
  private var pendingCrossfeed: Double = 0.0
  private var pendingReverbEnabled: Boolean = false
  private var pendingRoomSize: Double = 0.0
  private var pendingDamping: Double = 0.0
  private var pendingReverbMix: Double = 0.0
  private var pendingLimitEnabled: Boolean = true

  // Les 10 fréquences canoniques de MAS Player
  private val canonicalFreqs = intArrayOf(250, 125, 250, 500, 1000, 2000, 4000, 6000, 8000, 8000)

  override fun definition() = ModuleDefinition {
    Name("AudioDSP")

    Events("onProgress", "onRemoteCommand", "onSystemVolume")

    OnCreate {
      // Les effets audio sur Android sont initialisés dynamiquement dès la réception
      // d'un activeSessionId valide (> 0) provenant du lecteur ExoPlayer.
    }

    OnDestroy {
      releaseEffects()
    }

    AsyncFunction("setAudioSessionIdAsync") { sessionId: Int ->
      val targetSessionId = if (sessionId > 0) sessionId else {
        try {
          val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
          audioManager?.generateAudioSessionId() ?: 0
        } catch (_: Exception) {
          0
        }
      }
      if (targetSessionId > 0) {
        if (targetSessionId != activeSessionId || equalizer == null) {
          activeSessionId = targetSessionId
          initEffects(targetSessionId)
        }
        applyCurrentDSP()
      }
    }

    AsyncFunction("setDSPAsync") {
      bands: List<Double>,
      preamp: Double,
      balance: Double,
      mono: Boolean,
      stereoExpansion: Double,
      enabled: Boolean,
      crossfeed: Double,
      reverbEnabled: Boolean,
      roomSize: Double,
      damping: Double,
      reverbMix: Double,
      reverbWet: Double,
      reverbDry: Double,
      limitEnabled: Boolean ->

      pendingBands = bands
      pendingPreamp = preamp
      pendingBalance = balance
      pendingMono = mono
      pendingStereoExpansion = stereoExpansion
      pendingEnabled = enabled
      pendingCrossfeed = crossfeed
      pendingReverbEnabled = reverbEnabled
      pendingRoomSize = roomSize
      pendingDamping = damping
      pendingReverbMix = reverbMix
      pendingLimitEnabled = limitEnabled

      applyCurrentDSP()
    }

    AsyncFunction("getSystemVolumeAsync") {
      try {
        val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
        if (audioManager != null) {
          val cur = audioManager.getStreamVolume(AudioManager.STREAM_MUSIC)
          val max = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
          if (max > 0) cur.toFloat() / max.toFloat() else 1.0f
        } else {
          1.0f
        }
      } catch (e: Exception) {
        1.0f
      }
    }

    AsyncFunction("setVolumeAsync") { value: Double ->
      try {
        val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
        if (audioManager != null) {
          val max = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
          val target = (value * max).toInt().coerceIn(0, max)
          audioManager.setStreamVolume(AudioManager.STREAM_MUSIC, target, 0)
        }
      } catch (e: Exception) {
        Log.w("AudioDSP", "setVolumeAsync failed: ${e.message}")
      }
    }

    AsyncFunction("clearNowPlayingAsync") {
      // Géré par expo-audio media session
    }

    AsyncFunction("loadTrackAsync") { uri: String, _: String?, _: String?, _: String?, _: String? ->
      mapOf(
        "duration" to 0.0,
        "uri" to uri,
        "cached" to true
      )
    }

    AsyncFunction("playAsync") { true }
    AsyncFunction("pauseAsync") { false }
    AsyncFunction("stopAsync") { }
    AsyncFunction("getStatusAsync") {
      mapOf("currentTime" to 0.0, "duration" to 0.0, "isPlaying" to false)
    }
    AsyncFunction("seekAsync") { _: Double -> }
  }

  private fun initEffects(sessionId: Int) {
    releaseEffects()
    if (sessionId <= 0) return

    try {
      equalizer = Equalizer(0, sessionId).apply {
        enabled = pendingEnabled
      }
    } catch (e: Exception) {
      try {
        equalizer = Equalizer(1000, sessionId).apply {
          enabled = pendingEnabled
        }
      } catch (e2: Exception) {
        Log.w("AudioDSP", "Failed to init Equalizer for session $sessionId: ${e2.message}")
      }
    }

    try {
      bassBoost = BassBoost(0, sessionId).apply {
        enabled = pendingEnabled
      }
    } catch (e: Exception) {
      try {
        bassBoost = BassBoost(1000, sessionId).apply {
          enabled = pendingEnabled
        }
      } catch (e2: Exception) {
        Log.w("AudioDSP", "Failed to init BassBoost for session $sessionId: ${e2.message}")
      }
    }

    try {
      virtualizer = Virtualizer(0, sessionId).apply {
        enabled = pendingEnabled
      }
    } catch (e: Exception) {
      try {
        virtualizer = Virtualizer(1000, sessionId).apply {
          enabled = pendingEnabled
        }
      } catch (e2: Exception) {
        Log.w("AudioDSP", "Failed to init Virtualizer for session $sessionId: ${e2.message}")
      }
    }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
      try {
        loudnessEnhancer = LoudnessEnhancer(sessionId).apply {
          enabled = pendingEnabled
        }
      } catch (e: Exception) {
        Log.w("AudioDSP", "Failed to init LoudnessEnhancer for session $sessionId: ${e.message}")
      }
    }

    try {
      presetReverb = PresetReverb(0, sessionId).apply {
        enabled = pendingReverbEnabled
      }
    } catch (e: Exception) {
      try {
        presetReverb = PresetReverb(1000, sessionId).apply {
          enabled = pendingReverbEnabled
        }
      } catch (e2: Exception) {
        Log.w("AudioDSP", "Failed to init PresetReverb for session $sessionId: ${e2.message}")
      }
    }
  }

  private fun releaseEffects() {
    try { equalizer?.release() } catch (_: Exception) {}
    try { bassBoost?.release() } catch (_: Exception) {}
    try { virtualizer?.release() } catch (_: Exception) {}
    try { loudnessEnhancer?.release() } catch (_: Exception) {}
    try { presetReverb?.release() } catch (_: Exception) {}
    equalizer = null
    bassBoost = null
    virtualizer = null
    loudnessEnhancer = null
    presetReverb = null
  }

  private fun applyCurrentDSP() {
    if (activeSessionId <= 0) {
      try {
        val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
        val fallback = audioManager?.generateAudioSessionId() ?: 0
        if (fallback > 0) {
          activeSessionId = fallback
          initEffects(fallback)
        } else {
          return
        }
      } catch (_: Exception) {
        return
      }
    }
    if (equalizer == null && bassBoost == null) {
      initEffects(activeSessionId)
    }

    // 1. Equalizer 10 bandes
    equalizer?.let { eq ->
      try {
        eq.enabled = pendingEnabled
        if (pendingEnabled) {
          val numBands = eq.numberOfBands.toInt()
          val levelRange = eq.bandLevelRange
          val minMb = levelRange[0].toInt()
          val maxMb = levelRange[1].toInt()

          for (b in 0 until numBands) {
            val centerHz = eq.getCenterFreq(b.toShort()) / 1000
            var bestIdx = 0
            var bestDist = Int.MAX_VALUE
            for (i in canonicalFreqs.indices) {
              val dist = abs(canonicalFreqs[i] - centerHz)
              if (dist < bestDist) {
                bestDist = dist
                bestIdx = i
              }
            }

            val gainDb = if (bestIdx < pendingBands.size) pendingBands[bestIdx] else 0.0
            val gainMb = (gainDb * 100.0).toInt().coerceIn(minMb, maxMb).toShort()
            eq.setBandLevel(b.toShort(), gainMb)
          }
        }
      } catch (e: Exception) {
        Log.w("AudioDSP", "Error applying equalizer: ${e.message}")
      }
    }

    // 2. Bass Boost
    bassBoost?.let { bb ->
      try {
        val lowGain = if (pendingBands.isNotEmpty()) pendingBands[0] else 0.0
        val effectiveBass = if (lowGain > 0) lowGain else 0.0
        val strength = ((effectiveBass / 12.0) * 1000.0).toInt().coerceIn(0, 1000).toShort()
        bb.enabled = pendingEnabled && strength > 0
        if (strength > 0 && bb.strengthSupported) {
          bb.setStrength(strength)
        }
      } catch (e: Exception) {
        Log.w("AudioDSP", "Error applying bassBoost: ${e.message}")
      }
    }

    // 3. Virtualizer (Largeur stéréo)
    virtualizer?.let { virt ->
      try {
        val strength = ((pendingStereoExpansion / 100.0) * 1000.0).toInt().coerceIn(0, 1000).toShort()
        virt.enabled = pendingEnabled && strength > 0
        if (strength > 0 && virt.strengthSupported) {
          virt.setStrength(strength)
        }
      } catch (e: Exception) {
        Log.w("AudioDSP", "Error applying virtualizer: ${e.message}")
      }
    }

    // 4. LoudnessEnhancer (Préampli)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
      loudnessEnhancer?.let { le ->
        try {
          val gainMb = (pendingPreamp * 100.0).toInt()
          le.enabled = pendingEnabled && gainMb > 0
          if (gainMb > 0) {
            le.setTargetGain(gainMb)
          }
        } catch (e: Exception) {
          Log.w("AudioDSP", "Error applying loudnessEnhancer: ${e.message}")
        }
      }
    }

    // 5. PresetReverb (Réverbération)
    presetReverb?.let { pr ->
      try {
        pr.enabled = pendingReverbEnabled && pendingReverbMix > 0
        if (pendingReverbEnabled && pendingReverbMix > 0) {
          val preset = when {
            pendingRoomSize < 20 -> PresetReverb.PRESET_SMALLROOM
            pendingRoomSize < 40 -> PresetReverb.PRESET_MEDIUMROOM
            pendingRoomSize < 60 -> PresetReverb.PRESET_LARGEROOM
            pendingRoomSize < 80 -> PresetReverb.PRESET_PLATE
            else -> PresetReverb.PRESET_LARGEHALL
          }
          pr.preset = preset
        }
      } catch (e: Exception) {
        Log.w("AudioDSP", "Error applying presetReverb: ${e.message}")
      }
    }
  }
}
