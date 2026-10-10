package expo.modules.audio

import android.content.Context
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.DefaultAudioSink
import expo.modules.audiodsp.AudioDSPProcessor

@UnstableApi
internal class MASAudioRenderersFactory(context: Context) : DefaultRenderersFactory(context) {
  override fun buildAudioSink(
    context: Context,
    enableFloatOutput: Boolean,
    enableAudioOutputPlaybackParams: Boolean
  ): AudioSink {
    val processor: AudioProcessor = AudioDSPProcessor()
    return DefaultAudioSink.Builder(context)
      .setAudioProcessors(arrayOf(processor))
      .setEnableFloatOutput(enableFloatOutput)
      .setEnableAudioOutputPlaybackParameters(enableAudioOutputPlaybackParams)
      .build()
  }
}
