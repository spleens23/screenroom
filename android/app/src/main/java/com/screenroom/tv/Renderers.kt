package com.screenroom.tv

import android.content.Context
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.audio.AudioCapabilities
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.DefaultAudioSink
import androidx.media3.exoplayer.mediacodec.MediaCodecInfo
import androidx.media3.exoplayer.mediacodec.MediaCodecSelector

/**
 * How Screenroom plays sound and picture on Google TV / Android TV:
 *
 *  - DTS (DTS, DTS-HD, DTS:X) is always decoded by Screenroom itself (FFmpeg), never by the TV. Most TVs with
 *    Google TV have no DTS decoder, and some claim they can pass DTS through and then stutter or fail. Decoded DTS
 *    plays as normal surround/stereo sound on any TV or soundbar.
 *  - Dolby (Dolby Digital, DD+, Atmos, TrueHD) still goes to the TV/soundbar untouched when it supports it;
 *    otherwise FFmpeg decodes it too.
 *  - Video only uses the TV's hardware decoders when it has one for the format: a software decoder can't keep up
 *    with HD/4K and just plays in slow motion. (Software is still used when there is no hardware decoder at all.)
 */
@OptIn(UnstableApi::class)
class Renderers(context: Context) : DefaultRenderersFactory(context) {
    init {
        setEnableDecoderFallback(true)
        setExtensionRendererMode(EXTENSION_RENDERER_MODE_ON) // platform first, FFmpeg for what the TV can't do
        setMediaCodecSelector(selector)
    }

    companion object {
        private fun isDts(mime: String) = mime.startsWith("audio/vnd.dts")

        private val selector = MediaCodecSelector { mime, secure, tunneling ->
            if (isDts(mime)) return@MediaCodecSelector emptyList() // FFmpeg handles DTS
            val all: List<MediaCodecInfo> = MediaCodecSelector.DEFAULT.getDecoderInfos(mime, secure, tunneling)
            if (mime.startsWith("video/")) {
                val hw = all.filter { it.hardwareAccelerated && !it.softwareOnly }
                if (hw.isNotEmpty()) hw else all
            } else all
        }

        private val DTS_ENCODINGS = setOf(C.ENCODING_DTS, C.ENCODING_DTS_HD, C.ENCODING_DTS_UHD_P2)
        private val PASSTHROUGH = intArrayOf(
            C.ENCODING_PCM_16BIT, C.ENCODING_AC3, C.ENCODING_E_AC3, C.ENCODING_E_AC3_JOC, C.ENCODING_AC4, C.ENCODING_DOLBY_TRUEHD,
            C.ENCODING_DTS, C.ENCODING_DTS_HD, C.ENCODING_DTS_UHD_P2,
        )
    }

    @Suppress("DEPRECATION")
    override fun buildAudioSink(context: Context, enableFloatOutput: Boolean, enableAudioTrackPlaybackParams: Boolean): AudioSink {
        // What the TV says it can take untouched, minus DTS (see above).
        val caps = AudioCapabilities.getCapabilities(context)
        val keep = PASSTHROUGH.filter { it !in DTS_ENCODINGS && caps.supportsEncoding(it) }.toIntArray()
        return DefaultAudioSink.Builder(context)
            .setAudioCapabilities(AudioCapabilities(keep, caps.maxChannelCount))
            .setEnableFloatOutput(enableFloatOutput)
            .setEnableAudioTrackPlaybackParams(enableAudioTrackPlaybackParams)
            .build()
    }
}
