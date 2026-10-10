package expo.modules.audiodsp

import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.BaseAudioProcessor
import androidx.media3.common.util.UnstableApi
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.max
import kotlin.math.min

@UnstableApi
class AudioDSPProcessor : BaseAudioProcessor() {
  private data class Settings(
    val enabled: Boolean,
    val bands: List<Double>,
    val preamp: Double,
    val balance: Double,
    val stereoExpansion: Double,
    val limitEnabled: Boolean,
    val reverbEnabled: Boolean,
    val roomSize: Double,
    val damping: Double,
    val reverbMix: Double,
    val revision: Long
  )

  private data class Coefficients(
    val b0: Double,
    val b1: Double,
    val b2: Double,
    val a1: Double,
    val a2: Double
  )

  private class ChannelState {
    var z1 = 0.0
    var z2 = 0.0
  }

  private class DelayLine(val length: Int) {
    val buffer = DoubleArray(length)
    var index = 0

    fun processComb(input: Double, feedback: Double, damp: Double, store: DoubleArray, storeIndex: Int): Double {
      val output = buffer[index]
      store[storeIndex] = (output * (1.0 - damp)) + (store[storeIndex] * damp)
      buffer[index] = input + (store[storeIndex] * feedback)
      index = (index + 1) % length
      return output
    }

    fun processAllpass(input: Double): Double {
      val bufout = buffer[index]
      val output = -input + bufout
      buffer[index] = input + (bufout * 0.5)
      index = (index + 1) % length
      return output
    }
  }

  companion object {
    private val frequencies = doubleArrayOf(31.0, 62.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0)

    /**
     * Delai moyen des 4 peignes, en secondes (44,1 kHz : 1116, 1188, 1277, 1356).
     *
     * C'est ce delai qui commande la decroissance : `RT60 = -D·ln(1000)/ln(fb)`.
     * Doit entrer dans la conversion knob -> feedback, sinon le RT60 demande
     * n'est pas celui qu'on obtient. Doit rester egal a
     * `MASAudioDSPCombDelaySeconds` (MASAudioDSP.m) : `sync-check.cjs` echoue
     * si les deux plateformes divergent.
     */
    private const val COMB_DELAY_SECONDS = 0.0280

    /**
     * Normalisation appliquee au wet apres la somme des 4 peignes.
     *
     * Quatre peignes en parallele ont un gain de boucle qui diverge quand `fb`
     * approche 1 : sans cette division, le knob Room *ajoutait* du niveau au
     * lieu d'elargir la piece, et la queue ne redescendait jamais. 1/4 ramene
     * ce gain sous 0 dB pour toute la plage du knob. Equivalent a la
     * compensation de gain du Freeverb canonique, absente ici.
     */
    private const val COMB_NORMALIZATION = 0.25

    private val settings = AtomicReference(Settings(false, List(10) { 0.0 }, 0.0, 0.0, 0.0, false, false, 0.0, 0.0, 0.0, 0))

    fun update(
      enabled: Boolean, bands: List<Double>, preamp: Double,
      balance: Double, stereoExpansion: Double, limitEnabled: Boolean,
      reverbEnabled: Boolean, roomSize: Double, damping: Double, reverbMix: Double
    ) {
      val safeBands = List(10) { index ->
        bands.getOrNull(index)?.takeIf { it.isFinite() }?.coerceIn(-12.0, 12.0) ?: 0.0
      }
      val safePreamp = if (preamp.isFinite()) preamp.coerceIn(-6.0, 6.0) else 0.0
      val previous = settings.get()
      settings.set(Settings(
        enabled, safeBands, safePreamp,
        if (balance.isFinite()) balance.coerceIn(-1.0, 1.0) else 0.0,
        if (stereoExpansion.isFinite()) stereoExpansion.coerceIn(-1.0, 1.0) else 0.0,
        limitEnabled,
        reverbEnabled,
        if (roomSize.isFinite()) (roomSize.coerceIn(0.0, 100.0) / 100.0) else 0.0,
        if (damping.isFinite()) (damping.coerceIn(0.0, 100.0) / 100.0) else 0.0,
        if (reverbMix.isFinite()) (reverbMix.coerceIn(0.0, 100.0) / 100.0) else 0.0,
        previous.revision + 1
      ))
    }
  }

  private var sampleRate = 44100
  private var channelCount = 0
  private var configuredRevision = -1L
  private var coefficients = emptyArray<Coefficients>()
  private var channelStates = emptyArray<Array<ChannelState>>()

  private var combsL = Array(4) { DelayLine(1) }
  private var combsR = Array(4) { DelayLine(1) }
  private var allpassesL = Array(2) { DelayLine(1) }
  private var allpassesR = Array(2) { DelayLine(1) }
  private var dampStateL = DoubleArray(4)
  private var dampStateR = DoubleArray(4)

  override fun onConfigure(inputAudioFormat: AudioProcessor.AudioFormat): AudioProcessor.AudioFormat {
    if (inputAudioFormat.encoding != C.ENCODING_PCM_FLOAT &&
      inputAudioFormat.encoding != C.ENCODING_PCM_16BIT
    ) {
      throw AudioProcessor.UnhandledAudioFormatException(inputAudioFormat)
    }
    sampleRate = inputAudioFormat.sampleRate
    channelCount = inputAudioFormat.channelCount

    combsL = arrayOf(DelayLine(1116), DelayLine(1188), DelayLine(1277), DelayLine(1356))
    combsR = arrayOf(DelayLine(1139), DelayLine(1211), DelayLine(1300), DelayLine(1379))
    allpassesL = arrayOf(DelayLine(225), DelayLine(341))
    allpassesR = arrayOf(DelayLine(248), DelayLine(364))

    configuredRevision = -1L
    return inputAudioFormat
  }

  override fun queueInput(inputBuffer: ByteBuffer) {
    val currentSettings = settings.get()
    
    val hasEqProcessing = currentSettings.enabled && (currentSettings.preamp != 0.0 || currentSettings.bands.any { it != 0.0 })
    val hasProcessing = hasEqProcessing || 
                        currentSettings.balance != 0.0 || 
                        currentSettings.stereoExpansion != 0.0 || 
                        currentSettings.limitEnabled || 
                        currentSettings.reverbEnabled

    if (!hasProcessing) {
      val position = inputBuffer.position()
      val limit = inputBuffer.limit()
      val outputBuffer = replaceOutputBuffer(limit - position)
      outputBuffer.put(inputBuffer)
      outputBuffer.flip()
      return
    }

    if (configuredRevision != currentSettings.revision) {
      updateCoefficients(currentSettings.bands)
      if (channelStates.size != channelCount) {
        channelStates = Array(channelCount) { Array(10) { ChannelState() } }
      }
      configuredRevision = currentSettings.revision
    }

    val eqActive = currentSettings.enabled
    val linearPreamp = if (eqActive) 10.0.pow(currentSettings.preamp / 20.0) else 1.0
    val balL = if (currentSettings.balance < 0) 1.0 else (1.0 - currentSettings.balance)
    val balR = if (currentSettings.balance > 0) 1.0 else (1.0 + currentSettings.balance)
    val stereo = currentSettings.stereoExpansion
    val limit = currentSettings.limitEnabled
    val reverb = currentSettings.reverbEnabled
    // Loi de duree : le knob pilote un RT60 de 0,30 s a 4,00 s (cf.
    // `reverbRt60Seconds` dans src/constants/presets.ts, la meme loi que celle
    // affichee dans l'interface et appliquee par le moteur web).
    //
    // La version anterieure derivait le feedback directement du knob
    // (`roomSize * 0.28 + 0.7`), sans borner le RT60 obtenu : a fond la queue
    // mesurait 9,6 s.
    //
    // ⚠ Le RT60 d'un peigne n'est PAS `exp(-6,908/RT60)` : cela suppose une
    // boucle d'une seconde. Or un peigne de ce reseau mesure ~28 ms (1116 a
    // 1356 echantillons a 44,1 kHz), donc la boucle qui commande la decroissance
    // fait ~36 tours en 1 s. Sans le delai, room 100 % donnait fb = 0,963 et
    // un RT60 reel de 0,14 s au lieu de 4 s — le reverb etait inexistant.
    // D'ou COMB_DELAY_SECONDS dans la conversion : `fb = exp(-ln(1000)·D/RT60)`.
    val rt60 = 0.3 + (4.0 - 0.3) * currentSettings.roomSize.pow(1.6)
    val roomSize = min(0.98, exp(-ln(1000.0) * COMB_DELAY_SECONDS / max(0.01, rt60)))
    val damp = currentSettings.damping * 0.4
    val mix = currentSettings.reverbMix * 0.5

    val position = inputBuffer.position()
    val limitBuffer = inputBuffer.limit()
    val frameCount = (limitBuffer - position) / (channelCount * 2)

    val outputBuffer = replaceOutputBuffer(limitBuffer - position)
    outputBuffer.order(ByteOrder.nativeOrder())

    var offset = position
    for (i in 0 until frameCount) {
      var l = inputBuffer.getShort(offset).toDouble() / 32768.0 * linearPreamp
      var r = if (channelCount > 1) inputBuffer.getShort(offset + 2).toDouble() / 32768.0 * linearPreamp else l

      if (eqActive) {
        l = filterSample(0, l)
        r = filterSample(if (channelCount > 1) 1 else 0, r)
      }

      if (stereo != 0.0 && channelCount > 1) {
        val m = (l + r) * 0.5
        var s = (l - r) * 0.5
        s *= (1.0 + stereo)
        l = m + s
        r = m - s
      }

      l *= balL
      r *= balR

      if (reverb && channelCount > 1) {
        var outL = 0.0
        var outR = 0.0
        for (c in 0 until 4) {
          outL += combsL[c].processComb(l, roomSize, damp, dampStateL, c)
          outR += combsR[c].processComb(r, roomSize, damp, dampStateR, c)
        }
        // Normalisation du wet : voir COMB_NORMALIZATION. Elle borne le gain du
        // reseau de peignes, que la somme des 4 laissait diverger quand le
        // feedback montait.
        outL *= COMB_NORMALIZATION
        outR *= COMB_NORMALIZATION
        for (a in 0 until 2) {
          outL = allpassesL[a].processAllpass(outL)
          outR = allpassesR[a].processAllpass(outR)
        }
        l = (l * (1.0 - mix)) + (outL * mix)
        r = (r * (1.0 - mix)) + (outR * mix)
      }

      if (limit) {
        l = if (l > 1.0) 1.0 else if (l < -1.0) -1.0 else l
        r = if (r > 1.0) 1.0 else if (r < -1.0) -1.0 else r
      }

      outputBuffer.putShort((l * 32767.0).toInt().coerceIn(-32768, 32767).toShort())
      if (channelCount > 1) {
        outputBuffer.putShort((r * 32767.0).toInt().coerceIn(-32768, 32767).toShort())
      }
      offset += channelCount * 2
    }

    inputBuffer.position(limitBuffer)
    outputBuffer.flip()
  }

  private fun updateCoefficients(gains: List<Double>) {
    val rate = max(8000.0, sampleRate.toDouble())
    coefficients = Array(10) { index ->
      val frequency = min(frequencies[index], rate * 0.49)
      val gain = gains[index]
      val amplitude = 10.0.pow(gain / 40.0)
      val omega = 2.0 * PI * frequency / rate
      val alpha = sin(omega) / (2.0 * 1.41421356237)
      val cosine = cos(omega)
      val a0 = 1.0 + alpha / amplitude

      Coefficients(
        (1.0 + alpha * amplitude) / a0,
        (-2.0 * cosine) / a0,
        (1.0 - alpha * amplitude) / a0,
        (-2.0 * cosine) / a0,
        (1.0 - alpha / amplitude) / a0
      )
    }
  }

  private fun filterSample(channel: Int, sample: Double): Double {
    var output = sample
    val states = channelStates[channel]
    val currentSettings = settings.get()
    
    for (i in 0 until 10) {
      if (currentSettings.bands[i] == 0.0) continue
      val c = coefficients[i]
      val s = states[i]
      val out = (c.b0 * output) + s.z1
      s.z1 = (c.b1 * output) - (c.a1 * out) + s.z2
      s.z2 = (c.b2 * output) - (c.a2 * out)
      output = out
    }
    return output
  }
}
