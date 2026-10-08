package expo.modules.audiodsp

import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.BaseAudioProcessor
import androidx.media3.common.util.UnstableApi
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt
import java.nio.ByteBuffer
import java.nio.ByteOrder

internal data class BiquadCoefficients(
  val b0: Float,
  val b1: Float,
  val b2: Float,
  val a1: Float,
  val a2: Float
)

internal data class ProcessorSettings(
  val bandsDb: DoubleArray = DoubleArray(10),
  val preampDb: Double = 0.0,
  val balance: Double = 0.0,
  val mono: Boolean = false,
  val stereoExpansion: Double = 0.0,
  val enabled: Boolean = true,
  val crossfeed: Double = 0.0,
  val reverbEnabled: Boolean = false,
  val roomSize: Double = 0.0,
  val damping: Double = 0.0,
  val reverbWet: Double = 0.0,
  val reverbDry: Double = 1.0,
  val limitEnabled: Boolean = true,
  val sampleRate: Int = 48_000,
  val filters: Array<BiquadCoefficients> = emptyArray()
) {
  val preampGain: Float
    get() = 10.0.pow(preampDb / 20.0).toFloat()
}

object AudioDSPProcessorState {
  @Volatile
  private var settings = compile(ProcessorSettings())

  @Volatile
  private var sampleRate = 48_000

  fun update(
    bandsDb: List<Double>,
    preampDb: Double,
    balance: Double,
    mono: Boolean,
    stereoExpansion: Double,
    enabled: Boolean,
    crossfeed: Double,
    reverbEnabled: Boolean,
    roomSize: Double,
    damping: Double,
    reverbWet: Double,
    reverbDry: Double,
    limitEnabled: Boolean
  ) {
    val next = ProcessorSettings(
      bandsDb = DoubleArray(10) { bandsDb.getOrElse(it) { 0.0 } },
      preampDb = preampDb,
      balance = balance,
      mono = mono,
      stereoExpansion = stereoExpansion,
      enabled = enabled,
      crossfeed = crossfeed,
      reverbEnabled = reverbEnabled,
      roomSize = roomSize,
      damping = damping,
      reverbWet = reverbWet,
      reverbDry = reverbDry,
      limitEnabled = limitEnabled,
      sampleRate = sampleRate
    )
    settings = compile(next)
  }

  internal fun current(): ProcessorSettings = settings

  fun configure(sampleRate: Int) {
    this.sampleRate = sampleRate.coerceAtLeast(8_000)
    settings = compile(settings.copy(sampleRate = this.sampleRate))
  }

  private fun compile(source: ProcessorSettings): ProcessorSettings {
    val frequencies = doubleArrayOf(250.0, 125.0, 250.0, 500.0, 1_000.0, 2_000.0, 4_000.0, 6_000.0, 8_000.0, 8_000.0)
    val filters = Array(10) { index ->
      val gain = if (source.enabled) source.bandsDb[index] else 0.0
      val type = when (index) {
        0 -> 0
        9 -> 2
        else -> 1
      }
      coefficients(type, frequencies[index], gain, source.sampleRate)
    }
    return source.copy(filters = filters)
  }

  private fun coefficients(type: Int, frequency: Double, gainDb: Double, sampleRate: Int): BiquadCoefficients {
    val nyquist = sampleRate / 2.0
    if (frequency >= nyquist || gainDb == 0.0) {
      return BiquadCoefficients(1f, 0f, 0f, 0f, 0f)
    }
    val amplitude = 10.0.pow(gainDb / 40.0)
    val omega = 2.0 * PI * frequency / sampleRate
    val cosine = cos(omega)
    val sine = sin(omega)
    val alpha = sine / 2.0 * sqrt(amplitude + 1.0 / amplitude) * sqrt(2.0)
    val tangent = 2.0 * sqrt(amplitude) * alpha
    val a0: Double
    val b0: Double
    val b1: Double
    val b2: Double
    when (type) {
      0 -> {
        b0 = amplitude * ((amplitude + 1) - (amplitude - 1) * cosine + tangent)
        b1 = 2 * amplitude * ((amplitude - 1) - (amplitude + 1) * cosine)
        b2 = amplitude * ((amplitude + 1) - (amplitude - 1) * cosine - tangent)
        a0 = (amplitude + 1) + (amplitude - 1) * cosine + tangent
        val denominator1 = -2 * ((amplitude - 1) + (amplitude + 1) * cosine)
        val denominator2 = (amplitude + 1) + (amplitude - 1) * cosine - tangent
        return BiquadCoefficients(
          (b0 / a0).toFloat(),
          (b1 / a0).toFloat(),
          (b2 / a0).toFloat(),
          (denominator1 / a0).toFloat(),
          (denominator2 / a0).toFloat()
        )
      }
      2 -> {
        b0 = amplitude * ((amplitude + 1) + (amplitude - 1) * cosine + tangent)
        b1 = -2 * amplitude * ((amplitude - 1) + (amplitude + 1) * cosine)
        b2 = amplitude * ((amplitude + 1) + (amplitude - 1) * cosine - tangent)
        a0 = (amplitude + 1) - (amplitude - 1) * cosine + tangent
        val denominator1 = 2 * ((amplitude - 1) - (amplitude + 1) * cosine)
        val denominator2 = (amplitude + 1) - (amplitude - 1) * cosine - tangent
        return BiquadCoefficients(
          (b0 / a0).toFloat(),
          (b1 / a0).toFloat(),
          (b2 / a0).toFloat(),
          (denominator1 / a0).toFloat(),
          (denominator2 / a0).toFloat()
        )
      }
      else -> {
        b0 = 1 + alpha * amplitude
        val numerator1 = -2 * cosine
        b2 = 1 - alpha * amplitude
        a0 = 1 + alpha / amplitude
        val denominator1 = -2 * cosine
        val denominator2 = 1 - alpha / amplitude
        return BiquadCoefficients(
          (b0 / a0).toFloat(),
          (numerator1 / a0).toFloat(),
          (b2 / a0).toFloat(),
          (denominator1 / a0).toFloat(),
          (denominator2 / a0).toFloat()
        )
      }
    }
  }
}

@UnstableApi
class AudioDSPProcessor : BaseAudioProcessor() {
  private var format = AudioProcessor.AudioFormat.NOT_SET
  private var z1Left = FloatArray(10)
  private var z2Left = FloatArray(10)
  private var z1Right = FloatArray(10)
  private var z2Right = FloatArray(10)
  private var delayLeft = FloatArray(0)
  private var delayRight = FloatArray(0)
  private var delayWriteIndex = 0
  private var dampingLeft = 0f
  private var dampingRight = 0f
  private var limiterEnvelope = 1f

  override fun onConfigure(inputAudioFormat: AudioProcessor.AudioFormat): AudioProcessor.AudioFormat {
    if (inputAudioFormat.encoding != C.ENCODING_PCM_16BIT &&
      inputAudioFormat.encoding != C.ENCODING_PCM_FLOAT
    ) {
      format = AudioProcessor.AudioFormat.NOT_SET
      return AudioProcessor.AudioFormat.NOT_SET
    }
    format = inputAudioFormat
    AudioDSPProcessorState.configure(inputAudioFormat.sampleRate)
    val maximumDelay = (inputAudioFormat.sampleRate * MAX_REVERB_DELAY_SECONDS).roundToInt() + 2
    if (delayLeft.size < maximumDelay) {
      delayLeft = FloatArray(maximumDelay)
      delayRight = FloatArray(maximumDelay)
    }
    return inputAudioFormat
  }

  override fun queueInput(inputBuffer: ByteBuffer) {
    val channels = format.channelCount
    if (channels !in 1..2) {
      val output = replaceOutputBuffer(inputBuffer.remaining())
      output.put(inputBuffer)
      output.flip()
      return
    }

    val settings = AudioDSPProcessorState.current()
    val bytesPerSample = if (format.encoding == C.ENCODING_PCM_FLOAT) 4 else 2
    val frames = inputBuffer.remaining() / (channels * bytesPerSample)
    val output = replaceOutputBuffer(frames * channels * bytesPerSample)
    inputBuffer.order(ByteOrder.LITTLE_ENDIAN)
    output.order(ByteOrder.LITTLE_ENDIAN)
    val stereo = channels == 2
    val widthPercent = settings.stereoExpansion.toFloat().coerceIn(0f, 100f)
    val width = if (settings.mono) 1f else 1f + widthPercent / 100f * MAX_WIDTH_EXPONENT
    val normalizer = max(1f, width)
    val crossfeed = if (settings.mono || !stereo) 0f else MAX_CROSSFEED *
      (settings.crossfeed.toFloat().coerceIn(0f, 100f) / 100f) *
      (1f - widthPercent / 100f)
    val balance = settings.balance.toFloat().coerceIn(-1f, 1f)
    val reverbActive = settings.reverbEnabled && delayLeft.isNotEmpty()
    val reverbDelayScale = 1.0 + settings.roomSize.coerceIn(0.0, 100.0) / 100.0 * 7.0
    val delaySamplesLeft = max(1, (format.sampleRate * REVERB_DELAY_LEFT * reverbDelayScale).roundToInt())
    val delaySamplesRight = max(1, (format.sampleRate * REVERB_DELAY_RIGHT * reverbDelayScale).roundToInt())
    val dampingCutoff = 80.0 * (3600.0 / 80.0).pow(settings.damping.coerceIn(0.0, 100.0) / 100.0)
    val dampingCoefficient = (1.0 - exp(-2.0 * PI * dampingCutoff / format.sampleRate)).toFloat()
    val feedback = REVERB_FEEDBACK / (1f + REVERB_CROSS_COUPLING)
    val coupling = REVERB_FEEDBACK * REVERB_CROSS_COUPLING / (1f + REVERB_CROSS_COUPLING)
    val dryGain = settings.reverbDry.toFloat().coerceIn(0f, 1f)
    val wetGain = settings.reverbWet.toFloat().coerceIn(0f, REVERB_WET_CAP)
    val limiterThreshold = if (settings.limitEnabled) LIMITER_THRESHOLD else 1f
    val limiterRelease = (1.0 - exp(-1.0 / (LIMITER_RELEASE_SECONDS * format.sampleRate))).toFloat()

    for (frame in 0 until frames) {
      var left: Float
      var right: Float
      if (format.encoding == C.ENCODING_PCM_FLOAT) {
        left = inputBuffer.float
        right = if (channels == 2) inputBuffer.float else left
      } else {
        left = inputBuffer.short / 32768f
        right = if (channels == 2) inputBuffer.short / 32768f else left
      }

      if (settings.enabled) {
        for (band in settings.filters.indices) {
          val c = settings.filters[band]
          val outL = c.b0 * left + z1Left[band]
          z1Left[band] = c.b1 * left - c.a1 * outL + z2Left[band]
          z2Left[band] = c.b2 * left - c.a2 * outL
          left = outL
          if (channels == 2) {
            val outR = c.b0 * right + z1Right[band]
            z1Right[band] = c.b1 * right - c.a1 * outR + z2Right[band]
            z2Right[band] = c.b2 * right - c.a2 * outR
            right = outR
          }
        }
      }

      left *= settings.preampGain
      right *= settings.preampGain
      if (stereo) {
        val mid = (left + right) * 0.5f
        val side = (left - right) * 0.5f
        val wideLeft = mid / normalizer + if (settings.mono) 0f else side * width / normalizer
        val wideRight = mid / normalizer - if (settings.mono) 0f else side * width / normalizer
        left = wideLeft + crossfeed * wideRight
        right = wideRight + crossfeed * wideLeft
      } else if (settings.mono) {
        right = left
      }

      if (reverbActive) {
        val readLeft = (delayWriteIndex - delaySamplesLeft + delayLeft.size) % delayLeft.size
        val readRight = (delayWriteIndex - delaySamplesRight + delayRight.size) % delayRight.size
        val tapLeft = delayLeft[readLeft]
        val tapRight = delayRight[readRight]
        dampingLeft += dampingCoefficient * (tapLeft - dampingLeft)
        dampingRight += dampingCoefficient * (tapRight - dampingRight)
        delayLeft[delayWriteIndex] = left + feedback * dampingLeft + coupling * dampingRight
        delayRight[delayWriteIndex] = right + feedback * dampingRight + coupling * dampingLeft
        left = dryGain * left + wetGain * dampingLeft
        right = dryGain * right + wetGain * dampingRight
        delayWriteIndex++
        if (delayWriteIndex == delayLeft.size) delayWriteIndex = 0
      }

      if (balance > 0f) left *= 1f - balance else if (balance < 0f) right *= 1f + balance

      val peak = max(kotlin.math.abs(left), kotlin.math.abs(right))
      val targetGain = if (peak > limiterThreshold) limiterThreshold / peak else 1f
      if (targetGain < limiterEnvelope) {
        limiterEnvelope = targetGain
      } else {
        val release = (1.0 - exp(-1.0 / (LIMITER_RELEASE_SECONDS * format.sampleRate))).toFloat()
        limiterEnvelope += (targetGain - limiterEnvelope) * limiterRelease
      }
      left = (left * limiterEnvelope).coerceIn(-1f, 1f)
      right = (right * limiterEnvelope).coerceIn(-1f, 1f)

      if (format.encoding == C.ENCODING_PCM_FLOAT) {
        output.putFloat(left)
        if (channels == 2) output.putFloat(right)
      } else {
        output.putShort((left * 32767f).roundToInt().coerceIn(-32768, 32767).toShort())
        if (channels == 2) {
          output.putShort((right * 32767f).roundToInt().coerceIn(-32768, 32767).toShort())
        }
      }
    }

    output.flip()
  }

  override fun onFlush() {
    z1Left.fill(0f)
    z2Left.fill(0f)
    z1Right.fill(0f)
    z2Right.fill(0f)
    delayLeft.fill(0f)
    delayRight.fill(0f)
    delayWriteIndex = 0
    dampingLeft = 0f
    dampingRight = 0f
    limiterEnvelope = 1f
  }

  override fun onReset() {
    format = AudioProcessor.AudioFormat.NOT_SET
    delayLeft = FloatArray(0)
    delayRight = FloatArray(0)
  }

  private companion object {
    const val MAX_WIDTH_EXPONENT = 1.2f
    const val MAX_CROSSFEED = 0.15f
    const val REVERB_DELAY_LEFT = 0.037
    const val REVERB_DELAY_RIGHT = 0.058
    const val MAX_REVERB_DELAY_SECONDS = 0.058 * 8.0
    const val REVERB_FEEDBACK = 0.78f
    const val REVERB_CROSS_COUPLING = 0.5f
    const val REVERB_WET_CAP = 0.6f
    const val LIMITER_THRESHOLD = 0.70794576f
    const val LIMITER_RELEASE_SECONDS = 0.12
  }
}
