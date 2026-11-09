package com.screenroom.phone

import android.app.Activity
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.annotation.OptIn
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import java.io.File

/**
 * Screenroom's film player on a phone: full screen and sideways, with Android's own touch controls (play / pause,
 * scrub, skip, audio and subtitle tracks), the film's name over them, and "Up Next" for the following episode.
 * Where you got to is told to the page (which keeps it per profile, as on the iPhone), so a film picks up where it
 * stopped. FFmpeg's decoders play the sound most phones can't (DTS, TrueHD, Dolby on a Pixel).
 */
@OptIn(UnstableApi::class)
class PlayerActivity : Activity() {
    companion object {
        @Volatile var pending: Map<String, Any?>? = null
    }

    private class Entry(val id: String, val path: String, val start: Double, val title: String, val sub: String, val name: String)

    private lateinit var player: ExoPlayer
    private lateinit var view: PlayerView
    private lateinit var titles: LinearLayout
    private lateinit var title: TextView
    private lateinit var sub: TextView
    private val queue = ArrayList<Entry>()
    private val main = Handler(Looper.getMainLooper())
    private var lastId: String? = null
    private var ended = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Storage.prepare(this)
        val req = pending.also { pending = null }
        @Suppress("UNCHECKED_CAST") val q = req?.get("queue") as? List<Map<String, Any?>>
        q?.forEach { o -> queue.add(Entry(o["id"] as? String ?: "", o["path"] as? String ?: "", o["start"].asNum() ?: 0.0,
            o["title"] as? String ?: "", o["sub"] as? String ?: "", o["name"] as? String ?: "")) }
        if (queue.isEmpty()) { finish(); return }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }

        val renderers = DefaultRenderersFactory(this).setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_ON)
        player = ExoPlayer.Builder(this, renderers)
            .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(), true)
            .setHandleAudioBecomingNoisy(true)
            .setSeekBackIncrementMs(10_000).setSeekForwardIncrementMs(10_000)
            .build()
        val audioLang = (req?.get("audioLang") as? String).orEmpty()
        val subLang = (req?.get("subLang") as? String).orEmpty()
        val params = player.trackSelectionParameters.buildUpon()
        if (audioLang.isNotBlank()) params.setPreferredAudioLanguage(audioLang)
        if (subLang.isNotBlank()) params.setPreferredTextLanguage(subLang)
        // no subtitle language chosen: subtitles stay off even if the file marks a track "default" (forced ones still show)
        else params.setIgnoredTextSelectionFlags(C.SELECTION_FLAG_DEFAULT)
        params.setPreferredAudioMimeTypes(MimeTypes.AUDIO_E_AC3_JOC, MimeTypes.AUDIO_TRUEHD, MimeTypes.AUDIO_E_AC3, MimeTypes.AUDIO_AC3)
        player.trackSelectionParameters = params.build()

        view = PlayerView(this).apply {
            player = this@PlayerActivity.player
            setShowSubtitleButton(true)
            setShowNextButton(queue.size > 1)
            setShowPreviousButton(false)
            setBackgroundColor(Color.BLACK)
            keepScreenOn = true
        }
        title = TextView(this).apply { textSize = 20f; setTextColor(Color.WHITE); setShadowLayer(8f, 0f, 1f, Color.BLACK); paint.isFakeBoldText = true }
        sub = TextView(this).apply { textSize = 14f; setTextColor(0xccffffff.toInt()); setShadowLayer(8f, 0f, 1f, Color.BLACK) }
        titles = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(28), dp(18), dp(28), dp(18)); addView(title); addView(sub) }
        val back = TextView(this).apply {
            text = "✕"; textSize = 22f; setTextColor(Color.WHITE); setPadding(dp(20), dp(14), dp(20), dp(14)); setShadowLayer(8f, 0f, 1f, Color.BLACK)
            contentDescription = "Close"; setOnClickListener { close() }
        }
        val root = FrameLayout(this)
        root.addView(view, FrameLayout.LayoutParams(-1, -1))
        root.addView(titles, FrameLayout.LayoutParams(-2, -2, Gravity.TOP or Gravity.START))
        root.addView(back, FrameLayout.LayoutParams(-2, -2, Gravity.TOP or Gravity.END))
        view.setControllerVisibilityListener(PlayerView.ControllerVisibilityListener { v -> titles.visibility = v; back.visibility = v })
        setContentView(root)

        player.addListener(listener)
        player.setMediaItems(queue.map(::item), 0, (queue[0].start * 1000).toLong())
        player.prepare()
        player.playWhenReady = true
        showTitles(0)
        lastId = queue[0].id
        tick.run()
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun item(e: Entry): MediaItem {
        // subtitles beside the film (Film.srt, Film.en.srt …)
        val subs = VideoScanner.sidecarSubtitles(File(e.path)).mapNotNull { f ->
            val mime = when (f.extension.lowercase()) { "srt" -> MimeTypes.APPLICATION_SUBRIP; "vtt" -> MimeTypes.TEXT_VTT; "ass", "ssa" -> MimeTypes.TEXT_SSA; else -> null } ?: return@mapNotNull null
            val lang = f.name.removePrefix(File(e.path).nameWithoutExtension).trim('.').substringBeforeLast('.').takeIf { it.length in 2..3 }
            MediaItem.SubtitleConfiguration.Builder(Uri.fromFile(f)).setMimeType(mime).setLanguage(lang).setLabel(lang?.uppercase() ?: f.name).build()
        }
        return MediaItem.Builder().setUri(Uri.fromFile(File(e.path))).setMediaId(e.id).setSubtitleConfigurations(subs).build()
    }

    private fun showTitles(i: Int) {
        val e = queue.getOrNull(i) ?: return
        title.text = e.title
        sub.text = listOf(e.sub, e.name).filter { it.isNotBlank() }.joinToString(" · ")
        sub.visibility = if (sub.text.isNullOrBlank()) View.GONE else View.VISIBLE
    }

    private val listener = object : Player.Listener {
        override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
            // the last film finished (or was skipped past): it's watched
            lastId?.let { id -> if (id != mediaItem?.mediaId) report(id, done = true) }
            lastId = mediaItem?.mediaId
            showTitles(player.currentMediaItemIndex)
        }
        override fun onPlaybackStateChanged(state: Int) {
            if (state == Player.STATE_ENDED && !ended) {
                ended = true
                lastId?.let { report(it, done = true) }
                Bridge.current?.emit("video-ended", null)
                finish()
            }
        }
        override fun onIsPlayingChanged(isPlaying: Boolean) { if (!isPlaying) save() }
        override fun onPlayerError(error: PlaybackException) {
            val e = queue.getOrNull(player.currentMediaItemIndex)
            Bridge.current?.emit("playback-error", mapOf("message" to "${e?.title ?: "That film"} couldn't be played (${error.errorCodeName}).",
                "title" to (e?.title ?: ""), "code" to error.errorCodeName, "details" to (error.cause?.toString() ?: error.message ?: "")))
            finish()
        }
    }

    /** Where the film is, for the page (every few seconds, and when it stops). */
    private fun save() {
        if (!::player.isInitialized) return
        val id = player.currentMediaItem?.mediaId ?: return
        val dur = if (player.duration > 0) player.duration / 1000.0 else 0.0
        val pos = player.currentPosition / 1000.0
        report(id, pos, dur, done = dur > 0 && pos > dur - 30 && dur > 120)
    }

    private fun report(id: String, pos: Double = 0.0, dur: Double = 0.0, done: Boolean) {
        Bridge.current?.emit("video-progress", mapOf("id" to id, "pos" to pos, "dur" to dur, "done" to done))
    }

    private val tick = object : Runnable {
        override fun run() { if (::player.isInitialized && player.isPlaying) save(); main.postDelayed(this, 5000) }
    }

    private fun close() { save(); finish() }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() = close()

    override fun onPause() {
        super.onPause()
        if (::player.isInitialized) { save(); player.pause() }
    }

    override fun onDestroy() {
        main.removeCallbacks(tick)
        if (::player.isInitialized) player.release()
        super.onDestroy()
    }
}
