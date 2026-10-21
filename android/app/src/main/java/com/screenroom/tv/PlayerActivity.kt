package com.screenroom.tv

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.StateListDrawable
import android.media.AudioManager
import android.net.Uri
import android.os.Bundle
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.SeekBar
import android.widget.TextView
import android.widget.Toast
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.analytics.AnalyticsListener
import androidx.media3.exoplayer.DecoderReuseEvaluation
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import org.json.JSONObject
import java.io.File
import java.util.Locale
import kotlin.math.max
import kotlin.math.min

/**
 * Full-screen player. ExoPlayer uses the box's hardware decoders (4K H.265/H.264, HDR, Dolby Vision) and
 * sends Dolby/DTS straight to the receiver when the HDMI device supports it. The overlay mimics Netflix:
 * title up top, a red progress bar, skip ±10 s, audio & subtitles, and "Next Episode".
 */
@OptIn(UnstableApi::class)
class PlayerActivity : Activity() {

    companion object {
        @Volatile var current: PlayerActivity? = null
        @Volatile var pending: JSONObject? = null
        @Volatile var closedSinceResume = false

        fun launch(from: Activity, request: JSONObject) {
            pending = request
            from.runOnUiThread { from.startActivity(Intent(from, PlayerActivity::class.java)) }
        }
    }

    private class Entry(val id: String, val path: String, val title: String, val sub: String, val name: String, val desc: String)

    private lateinit var player: ExoPlayer
    private lateinit var playerView: PlayerView
    private val queue = ArrayList<Entry>()
    private var initialAudio: Int? = null
    private var initialAudioDone = false

    private lateinit var topBar: LinearLayout
    private lateinit var bottomBar: LinearLayout
    private lateinit var titleText: TextView
    private lateinit var subText: TextView
    private lateinit var seek: SeekBar
    private lateinit var timeText: TextView
    private lateinit var playBtn: TextView
    private lateinit var nextBtn: TextView
    private lateinit var nextCard: TextView
    private lateinit var pauseInfo: LinearLayout
    private lateinit var pauseTitle: TextView
    private lateinit var pauseSub: TextView
    private lateinit var pauseDesc: TextView
    private lateinit var spinner: ProgressBar

    private var controlsShown = false
    private var lastInteraction = 0L
    private var lastSave = 0L
    private var pausedSince = 0L
    private var lastId: String? = null
    private val red = Color.parseColor("#E50914")

    // ---- setup -------------------------------------------------------------------------------------------

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        App.init(this)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val req = pending
        pending = null
        if (req == null) { finish(); return }
        val q = req.optJSONArray("queue")
        if (q != null) for (i in 0 until q.length()) {
            val o = q.getJSONObject(i)
            queue.add(Entry(o.getString("id"), o.getString("path"), o.optString("title"), o.optString("sub"), o.optString("name"), o.optString("desc")))
        }
        if (queue.isEmpty()) { finish(); return }
        initialAudio = if (req.has("audioTrack") && !req.isNull("audioTrack")) req.optInt("audioTrack") else null
        val fromStart = req.optBoolean("fromStart", false)

        buildUi()

        val renderers = Renderers(this)
        player = ExoPlayer.Builder(this, renderers)
            .setAudioAttributes(
                AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(),
                true
            )
            .setSeekBackIncrementMs(10_000)
            .setSeekForwardIncrementMs(10_000)
            .build()
        playerView.player = player

        val cfg = App.store.config
        val prof = App.store.currentProfile()
        val audioLang = prof?.optString("preferredLang")?.takeIf { it.isNotBlank() } ?: cfg.optString("preferredLang")
        val subLang = prof?.optString("subLang")?.takeIf { it.isNotBlank() } ?: cfg.optString("subLang")
        val params = player.trackSelectionParameters.buildUpon()
        audioLang.takeIf { it.isNotBlank() }?.let { params.setPreferredAudioLanguage(it) }
        subLang.takeIf { it.isNotBlank() }?.let { params.setPreferredTextLanguage(it) }
        // Dolby first when a film has both Dolby and DTS (the TV/soundbar takes Dolby as it is); DTS still works
        // (decoded by Screenroom) and can be picked under Audio & Subtitles.
        params.setPreferredAudioMimeTypes(MimeTypes.AUDIO_E_AC3_JOC, MimeTypes.AUDIO_TRUEHD, MimeTypes.AUDIO_E_AC3, MimeTypes.AUDIO_AC3)
        player.trackSelectionParameters = params.build()

        player.addListener(listener)
        player.addAnalyticsListener(diag)
        val items = queue.map { mediaItem(it) }
        val first = queue[0]
        val prog = App.store.progress.optJSONObject(first.id)
        val resumeMs = if (!fromStart && prog != null && !prog.optBoolean("done") && prog.optDouble("pos", 0.0) > 5)
            (prog.optDouble("pos") * 1000).toLong() else 0L
        player.setMediaItems(items, 0, resumeMs)
        player.prepare()
        player.playWhenReady = true
        lastId = first.id
        showTitles(0)
        current = this
        showControls(playBtn)
        tick.run()
    }

    private fun mediaItem(e: Entry): MediaItem {
        val subs = ArrayList<MediaItem.SubtitleConfiguration>()
        val file = File(e.path)
        val base = file.nameWithoutExtension
        file.parentFile?.listFiles()?.forEach { f ->
            val ext = f.extension.lowercase()
            if ((ext == "srt" || ext == "vtt") && f.name.startsWith(base)) {
                // "Movie.en.srt" -> English
                val middle = f.name.removePrefix(base).removeSuffix(".$ext").trim('.', ' ', '_', '-')
                val lang = middle.takeIf { it.length in 2..3 && it.all { c -> c.isLetter() } }
                subs.add(
                    MediaItem.SubtitleConfiguration.Builder(Uri.fromFile(f))
                        .setMimeType(if (ext == "vtt") MimeTypes.TEXT_VTT else MimeTypes.APPLICATION_SUBRIP)
                        .setLanguage(lang)
                        .setLabel(if (middle.isNotEmpty()) middle else "Subtitles")
                        .build()
                )
            }
        }
        return MediaItem.Builder().setUri(Uri.fromFile(file)).setMediaId(e.id).setSubtitleConfigurations(subs).build()
    }

    // ---- the overlay -------------------------------------------------------------------------------------

    private fun dp(v: Int): Int = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()

    private fun text(size: Float, bold: Boolean = false, color: Int = Color.WHITE): TextView = TextView(this).apply {
        setTextSize(TypedValue.COMPLEX_UNIT_SP, size)
        setTextColor(color)
        if (bold) typeface = Typeface.DEFAULT_BOLD
        setShadowLayer(6f, 0f, 1f, Color.BLACK)
    }

    private fun rounded(color: Int) = GradientDrawable().apply { cornerRadius = dp(6).toFloat(); setColor(color) }

    private fun button(label: String, onClick: () -> Unit): TextView = text(17f, true).apply {
        text = label
        gravity = Gravity.CENTER
        setPadding(dp(16), dp(9), dp(16), dp(9))
        isFocusable = true
        isClickable = true
        setShadowLayer(0f, 0f, 0f, 0)
        background = StateListDrawable().apply {
            addState(intArrayOf(android.R.attr.state_focused), rounded(Color.WHITE))
            addState(intArrayOf(), rounded(0x33FFFFFF))
        }
        setTextColor(ColorStateList(arrayOf(intArrayOf(android.R.attr.state_focused), intArrayOf()), intArrayOf(Color.BLACK, Color.WHITE)))
        setOnClickListener { onClick(); poke() }
    }

    private fun lp(w: Int, h: Int, gravity: Int = Gravity.NO_GRAVITY) = FrameLayout.LayoutParams(w, h, gravity)

    private fun buildUi() {
        val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        playerView = PlayerView(this).apply {
            useController = false
            keepScreenOn = true
            isFocusable = false
        }
        root.addView(playerView, lp(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        spinner = ProgressBar(this).apply { isIndeterminate = true; visibility = View.GONE; indeterminateTintList = ColorStateList.valueOf(red) }
        root.addView(spinner, lp(dp(64), dp(64), Gravity.CENTER))

        // Top: series / movie title and episode line
        titleText = text(28f, true)
        subText = text(18f, color = Color.parseColor("#DDDDDD"))
        topBar = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(48), dp(28), dp(48), dp(56))
            background = GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, intArrayOf(0xCC000000.toInt(), Color.TRANSPARENT))
            addView(titleText)
            addView(subText)
        }
        root.addView(topBar, lp(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP))

        // "You're watching" panel shown while paused
        pauseTitle = text(40f, true)
        pauseSub = text(20f, true)
        pauseDesc = text(18f, color = Color.parseColor("#DDDDDD")).apply { maxLines = 4; ellipsize = TextUtils.TruncateAt.END }
        pauseInfo = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
            addView(text(16f, color = Color.parseColor("#AAAAAA")).apply { text = "You're watching" })
            addView(pauseTitle)
            addView(pauseSub)
            addView(pauseDesc)
        }
        root.addView(pauseInfo, lp(dp(620), ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.START or Gravity.CENTER_VERTICAL).apply { leftMargin = dp(64) })

        // Bottom: progress bar + buttons
        seek = SeekBar(this).apply {
            isFocusable = true
            progressTintList = ColorStateList.valueOf(red)
            thumbTintList = ColorStateList.valueOf(red)
            progressBackgroundTintList = ColorStateList.valueOf(Color.parseColor("#66FFFFFF"))
            setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(s: SeekBar, value: Int, fromUser: Boolean) {}
                override fun onStartTrackingTouch(s: SeekBar) {}
                override fun onStopTrackingTouch(s: SeekBar) { player.seekTo(s.progress * 1000L) }
            })
        }
        timeText = text(16f)
        val seekRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(seek, LinearLayout.LayoutParams(0, dp(36), 1f))
            addView(timeText, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { leftMargin = dp(12) })
        }
        playBtn = button("❚❚  Pause") { togglePause() }
        nextBtn = button("Next Episode  ▶▏") { next() }
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            val gap = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { rightMargin = dp(12) }
            addView(button("↺ 10") { seekBy(-10) }, LinearLayout.LayoutParams(gap))
            addView(playBtn, LinearLayout.LayoutParams(gap))
            addView(button("10 ↻") { seekBy(10) }, LinearLayout.LayoutParams(gap))
            addView(View(context), LinearLayout.LayoutParams(0, 1, 1f))
            addView(button("Audio & Subtitles") { showTracks() }, LinearLayout.LayoutParams(gap))
            addView(nextBtn, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        bottomBar = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(48), dp(64), dp(48), dp(28))
            background = GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP, intArrayOf(0xE6000000.toInt(), Color.TRANSPARENT))
            addView(seekRow)
            addView(row, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(10) })
        }
        root.addView(bottomBar, lp(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))

        // Netflix's "Next Episode" card in the last 30 seconds
        nextCard = button("Next Episode  ▶") { next() }.apply { visibility = View.GONE; textSize = 20f }
        root.addView(nextCard, lp(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.END).apply {
            rightMargin = dp(48); bottomMargin = dp(150)
        })

        setContentView(root)
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY)
    }

    private fun showTitles(index: Int) {
        val e = queue.getOrNull(index) ?: return
        titleText.text = e.title
        subText.text = listOf(e.sub, e.name).filter { it.isNotBlank() }.joinToString("  ·  ")
        pauseTitle.text = e.title
        pauseSub.text = listOf(e.sub, e.name).filter { it.isNotBlank() }.joinToString("  ")
        pauseDesc.text = e.desc
        nextBtn.visibility = if (index < queue.size - 1) View.VISIBLE else View.GONE
    }

    private fun showControls(focus: View?) {
        controlsShown = true
        topBar.visibility = View.VISIBLE
        bottomBar.visibility = View.VISIBLE
        (focus ?: playBtn).requestFocus()
        poke()
    }

    private fun hideControls() {
        controlsShown = false
        topBar.visibility = View.GONE
        bottomBar.visibility = View.GONE
    }

    private fun poke() { lastInteraction = System.currentTimeMillis() }

    // ---- actions ----------------------------------------------------------------------------------------

    private fun togglePause() {
        if (player.isPlaying) player.pause() else player.play()
    }

    private fun seekBy(sec: Int) {
        val dur = player.duration.takeIf { it > 0 } ?: Long.MAX_VALUE
        player.seekTo(min(dur, max(0L, player.currentPosition + sec * 1000L)))
        poke()
    }

    private fun next() {
        if (player.hasNextMediaItem()) {
            saveProgress(force = true)
            player.seekToNextMediaItem()
            nextCard.visibility = View.GONE
        }
    }

    private fun close() {
        saveProgress(force = true)
        finish()
    }

    private fun saveProgress(force: Boolean = false, done: Boolean = false) {
        val id = player.currentMediaItem?.mediaId ?: return
        val now = System.currentTimeMillis()
        if (!force && !done && now - lastSave < 10_000) return
        lastSave = now
        val pos = player.currentPosition / 1000.0
        val dur = if (player.duration > 0) player.duration / 1000.0 else 0.0
        if (pos <= 5 && !done) return
        val finished = done || (dur > 0 && pos / dur > 0.94)
        App.store.setProgress(id, if (finished) 0.0 else pos, dur, finished)
    }

    private fun langName(code: String?): String {
        if (code.isNullOrBlank() || code == "und") return ""
        val name = Locale.forLanguageTag(code).getDisplayLanguage(Locale.getDefault())
        return if (name.isNullOrBlank()) code else name
    }

    private fun audioLabel(f: Format): String {
        val codec = when (f.sampleMimeType) {
            MimeTypes.AUDIO_AC3 -> "Dolby Digital"
            MimeTypes.AUDIO_E_AC3 -> "Dolby Digital Plus"
            MimeTypes.AUDIO_E_AC3_JOC -> "Dolby Digital Plus Atmos"
            MimeTypes.AUDIO_TRUEHD -> "Dolby TrueHD"
            MimeTypes.AUDIO_DTS -> "DTS"
            MimeTypes.AUDIO_DTS_HD -> "DTS-HD"
            MimeTypes.AUDIO_DTS_X -> "DTS:X"
            MimeTypes.AUDIO_AAC -> "AAC"
            else -> f.sampleMimeType?.substringAfter('/')?.uppercase() ?: "Audio"
        }
        val ch = when (f.channelCount) { 1 -> "Mono"; 2 -> "Stereo"; 6 -> "5.1"; 8 -> "7.1"; Format.NO_VALUE -> ""; else -> "${f.channelCount}ch" }
        return listOf(langName(f.language), f.label ?: "", codec, ch).filter { it.isNotBlank() }.distinct().joinToString(" · ")
    }

    private fun showTracks() {
        val labels = ArrayList<String>()
        val actions = ArrayList<() -> Unit>()
        val groups = player.currentTracks.groups
        labels.add("AUDIO"); actions.add { showTracks() }
        for (g in groups) {
            if (g.type != C.TRACK_TYPE_AUDIO) continue
            for (i in 0 until g.length) {
                if (!g.isTrackSupported(i, true)) continue
                val f = g.getTrackFormat(i)
                labels.add((if (g.isTrackSelected(i)) "✓  " else "      ") + audioLabel(f))
                actions.add { pickTrack(g, i, C.TRACK_TYPE_AUDIO) }
            }
        }
        labels.add("SUBTITLES"); actions.add { showTracks() }
        val textDisabled = player.trackSelectionParameters.disabledTrackTypes.contains(C.TRACK_TYPE_TEXT)
        val anyTextSelected = groups.any { it.type == C.TRACK_TYPE_TEXT && it.isSelected }
        labels.add((if (textDisabled || !anyTextSelected) "✓  " else "      ") + "Off")
        actions.add {
            player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
                .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true).setPreferredTextLanguage(null).build()
        }
        for (g in groups) {
            if (g.type != C.TRACK_TYPE_TEXT) continue
            for (i in 0 until g.length) {
                val f = g.getTrackFormat(i)
                val name = listOf(langName(f.language), f.label ?: "").filter { it.isNotBlank() }.distinct().joinToString(" · ").ifBlank { "Subtitles" }
                labels.add((if (!textDisabled && g.isTrackSelected(i)) "✓  " else "      ") + name)
                actions.add { pickTrack(g, i, C.TRACK_TYPE_TEXT) }
            }
        }
        AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
            .setTitle("Audio & Subtitles")
            .setItems(labels.toTypedArray()) { _, which -> actions[which]() }
            .show()
    }

    private fun pickTrack(g: Tracks.Group, index: Int, type: Int) {
        val f = g.getTrackFormat(index)
        val b = player.trackSelectionParameters.buildUpon()
            .setOverrideForType(TrackSelectionOverride(g.mediaTrackGroup, index))
            .setTrackTypeDisabled(type, false)
        // Remember the language so the next episodes pick the same one.
        if (type == C.TRACK_TYPE_AUDIO) b.setPreferredAudioLanguage(f.language) else b.setPreferredTextLanguage(f.language)
        player.trackSelectionParameters = b.build()
    }

    private fun cycle(type: Int) {
        val options = ArrayList<Pair<Tracks.Group, Int>>()
        for (g in player.currentTracks.groups) if (g.type == type) for (i in 0 until g.length) if (g.isTrackSupported(i, true)) options.add(g to i)
        if (options.isEmpty()) return
        val cur = options.indexOfFirst { it.first.isTrackSelected(it.second) }
        if (type == C.TRACK_TYPE_TEXT && cur == options.size - 1) {
            player.trackSelectionParameters = player.trackSelectionParameters.buildUpon().setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true).build()
            toast("Subtitles off")
            return
        }
        val nxt = options[(cur + 1) % options.size]
        pickTrack(nxt.first, nxt.second, type)
        toast(if (type == C.TRACK_TYPE_AUDIO) audioLabel(nxt.first.getTrackFormat(nxt.second)) else langName(nxt.first.getTrackFormat(nxt.second).language).ifBlank { "Subtitles on" })
    }

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_SHORT).show()

    private fun applyInitialAudio() {
        val n = initialAudio ?: return
        if (initialAudioDone || player.currentMediaItemIndex != 0) return
        val all = ArrayList<Pair<Tracks.Group, Int>>()
        for (g in player.currentTracks.groups) if (g.type == C.TRACK_TYPE_AUDIO) for (i in 0 until g.length) all.add(g to i)
        if (all.isEmpty()) return
        initialAudioDone = true
        val pick = all.getOrNull(n - 1) ?: return
        if (pick.first.isTrackSupported(pick.second, true)) pickTrack(pick.first, pick.second, C.TRACK_TYPE_AUDIO)
    }

    // ---- player events ----------------------------------------------------------------------------------

    private val listener = object : Player.Listener {
        override fun onIsPlayingChanged(isPlaying: Boolean) {
            playBtn.text = if (isPlaying) "❚❚  Pause" else "▶  Play"
            pausedSince = if (isPlaying) 0L else System.currentTimeMillis()
            if (!isPlaying) { saveProgress(force = true); if (!controlsShown) showControls(playBtn) }
        }

        override fun onPlaybackStateChanged(state: Int) {
            spinner.visibility = if (state == Player.STATE_BUFFERING) View.VISIBLE else View.GONE
            if (state == Player.STATE_ENDED) { saveProgress(force = true, done = true); finish() }
        }

        override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
            val prev = lastId
            if (prev != null && reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO) {
                val o = App.store.progress.optJSONObject(prev)
                App.store.setProgress(prev, 0.0, o?.optDouble("dur", 0.0) ?: 0.0, true)
            }
            lastId = mediaItem?.mediaId
            showTitles(player.currentMediaItemIndex)
            nextCard.visibility = View.GONE
        }

        override fun onTracksChanged(tracks: Tracks) { applyInitialAudio() }

        override fun onPlayerError(error: PlaybackException) {
            val name = queue.getOrNull(player.currentMediaItemIndex)?.let { listOf(it.title, it.sub).filter { s -> s.isNotBlank() }.joinToString(" ") } ?: "this video"
            val msg = "Couldn't play $name (${error.errorCodeName})"
            val details = diagText() + (error.cause?.let { " · ${it.javaClass.simpleName}: ${it.message ?: ""}".take(200) } ?: "")
            App.store.addProblem(name, error.errorCodeName, details)
            toast(msg)
            App.emit("playback-error", "$msg. Details are in Settings → Playback problems.")
            finish()
        }
    }

    // ---- what is decoding what (for "Playback problems" in Settings) ------------------------------------
    private var videoInfo = ""
    private var audioInfo = ""
    private var videoDecoder = ""
    private var audioDecoder = ""
    private var dropped = 0

    private fun fmtVideo(f: Format): String {
        val codec = f.codecs ?: f.sampleMimeType?.substringAfter('/') ?: "video"
        val hdr = when (f.colorInfo?.colorTransfer) { C.COLOR_TRANSFER_ST2084 -> " HDR10"; C.COLOR_TRANSFER_HLG -> " HLG"; else -> "" }
        val fps = if (f.frameRate > 0) " %.3f fps".format(Locale.US, f.frameRate).replace(".000", "") else ""
        val mbps = if (f.bitrate > 0) " %.0f Mb/s".format(Locale.US, f.bitrate / 1e6) else ""
        return "$codec ${f.width}×${f.height}$hdr$fps$mbps"
    }

    private fun diagText(): String = listOf(
        if (videoInfo.isNotEmpty()) "video $videoInfo" + (if (videoDecoder.isNotEmpty()) " via $videoDecoder" else "") else "",
        if (audioInfo.isNotEmpty()) "audio $audioInfo" + (if (audioDecoder.isNotEmpty()) " via $audioDecoder" else "") else "",
        if (dropped > 0) "$dropped frames dropped" else "",
    ).filter { it.isNotEmpty() }.joinToString(" · ")

    @OptIn(UnstableApi::class)
    private val diag = object : AnalyticsListener {
        override fun onVideoInputFormatChanged(t: AnalyticsListener.EventTime, format: Format, reuse: DecoderReuseEvaluation?) { videoInfo = fmtVideo(format) }
        override fun onAudioInputFormatChanged(t: AnalyticsListener.EventTime, format: Format, reuse: DecoderReuseEvaluation?) { audioInfo = audioLabel(format) }
        override fun onVideoDecoderInitialized(t: AnalyticsListener.EventTime, decoderName: String, initializedTimestampMs: Long, initializationDurationMs: Long) { videoDecoder = decoderName }
        override fun onAudioDecoderInitialized(t: AnalyticsListener.EventTime, decoderName: String, initializedTimestampMs: Long, initializationDurationMs: Long) { audioDecoder = decoderName }
        override fun onDroppedVideoFrames(t: AnalyticsListener.EventTime, droppedFrames: Int, elapsedMs: Long) { dropped += droppedFrames }
        override fun onMediaItemTransition(t: AnalyticsListener.EventTime, mediaItem: MediaItem?, reason: Int) { dropped = 0 }
    }

    private val tick = object : Runnable {
        override fun run() {
            if (isFinishing || isDestroyed) return
            val pos = max(0L, player.currentPosition)
            val dur = player.duration
            if (dur > 0) {
                seek.max = (dur / 1000).toInt()
                if (!seek.isPressed) seek.progress = (pos / 1000).toInt()
                timeText.text = "-" + fmt((dur - pos) / 1000)
                val showNext = player.hasNextMediaItem() && dur - pos < 30_000 && player.isPlaying
                nextCard.visibility = if (showNext) View.VISIBLE else View.GONE
                if (showNext) nextCard.text = "Next Episode in ${max(0L, (dur - pos) / 1000)}  ▶"
            }
            // Netflix-style pause screen after a few seconds paused with the controls hidden
            pauseInfo.visibility = if (!player.isPlaying && pausedSince > 0 && System.currentTimeMillis() - pausedSince > 4000 && !controlsShown) View.VISIBLE else View.GONE
            if (controlsShown && player.isPlaying && System.currentTimeMillis() - lastInteraction > 5000) hideControls()
            if (player.isPlaying) saveProgress()
            App.main.postDelayed(this, 500)
        }
    }

    private fun fmt(totalSec: Long): String {
        val h = totalSec / 3600
        val m = (totalSec % 3600) / 60
        val s = totalSec % 60
        return if (h > 0) String.format(Locale.US, "%d:%02d:%02d", h, m, s) else String.format(Locale.US, "%d:%02d", m, s)
    }

    // ---- remote control ---------------------------------------------------------------------------------

    override fun dispatchKeyEvent(e: KeyEvent): Boolean {
        val code = e.keyCode
        if (e.action != KeyEvent.ACTION_DOWN) {
            return if (code == KeyEvent.KEYCODE_BACK) true else super.dispatchKeyEvent(e)
        }
        when (code) {
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_HEADSETHOOK -> { togglePause(); return true }
            KeyEvent.KEYCODE_MEDIA_PLAY -> { player.play(); return true }
            KeyEvent.KEYCODE_MEDIA_PAUSE -> { player.pause(); return true }
            KeyEvent.KEYCODE_MEDIA_FAST_FORWARD, KeyEvent.KEYCODE_BUTTON_R2 -> { seekBy(10); return true }
            KeyEvent.KEYCODE_MEDIA_REWIND, KeyEvent.KEYCODE_BUTTON_L2 -> { seekBy(-10); return true }
            KeyEvent.KEYCODE_MEDIA_NEXT, KeyEvent.KEYCODE_BUTTON_R1 -> { next(); return true }
            KeyEvent.KEYCODE_MEDIA_STOP -> { close(); return true }
            KeyEvent.KEYCODE_BUTTON_Y, KeyEvent.KEYCODE_CAPTIONS -> { showTracks(); return true }
            KeyEvent.KEYCODE_BACK, KeyEvent.KEYCODE_BUTTON_B, KeyEvent.KEYCODE_ESCAPE -> {
                if (controlsShown && player.isPlaying) hideControls() else close()
                return true
            }
        }
        if (!controlsShown) {
            when (code) {
                KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER, KeyEvent.KEYCODE_BUTTON_A, KeyEvent.KEYCODE_SPACE -> {
                    if (nextCard.visibility == View.VISIBLE) next() else { togglePause(); showControls(playBtn) }
                    return true
                }
                // Arrows just bring the controls up (Play/Pause highlighted); then they move between them.
                KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN,
                KeyEvent.KEYCODE_MENU -> { showControls(playBtn); return true }
            }
            return super.dispatchKeyEvent(e)
        }
        poke()
        if (seek.isFocused && (code == KeyEvent.KEYCODE_DPAD_LEFT || code == KeyEvent.KEYCODE_DPAD_RIGHT)) {
            seekBy(if (code == KeyEvent.KEYCODE_DPAD_LEFT) -10 else 10)
            return true
        }
        if (code == KeyEvent.KEYCODE_BUTTON_A) { currentFocus?.performClick(); return true }
        return super.dispatchKeyEvent(e)
    }

    /** Commands from the phone remote (see RemoteServer). Runs on the main thread. */
    fun remote(cmd: String) {
        val audio = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        // The phone's D-pad, OK and Back act like the TV remote's: they move around the on-screen controls.
        val key = when (cmd) {
            "up" -> KeyEvent.KEYCODE_DPAD_UP; "down" -> KeyEvent.KEYCODE_DPAD_DOWN
            "left" -> KeyEvent.KEYCODE_DPAD_LEFT; "right" -> KeyEvent.KEYCODE_DPAD_RIGHT
            "ok" -> KeyEvent.KEYCODE_DPAD_CENTER; "back" -> KeyEvent.KEYCODE_BACK
            else -> null
        }
        val dir = when (cmd) { "up" -> View.FOCUS_UP; "down" -> View.FOCUS_DOWN; "left" -> View.FOCUS_LEFT; "right" -> View.FOCUS_RIGHT; else -> null }
        // (Injected arrow keys don't move focus by themselves, so move it here, like the remote would.)
        if (dir != null && controlsShown && !(seek.isFocused && (dir == View.FOCUS_LEFT || dir == View.FOCUS_RIGHT))) {
            poke()
            val from = currentFocus ?: playBtn
            from.focusSearch(dir)?.requestFocus()
            return
        }
        if (key != null) {
            dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, key))
            dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, key))
            return
        }
        when (cmd) {
            "pause" -> togglePause()
            "seekback" -> seekBy(-10)
            "seekfwd" -> seekBy(10)
            "next" -> next()
            "stop", "home" -> close()
            "volup" -> audio.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_RAISE, AudioManager.FLAG_SHOW_UI)
            "voldown" -> audio.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_LOWER, AudioManager.FLAG_SHOW_UI)
            "mute" -> audio.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_TOGGLE_MUTE, AudioManager.FLAG_SHOW_UI)
            "audio" -> cycle(C.TRACK_TYPE_AUDIO)
            "subs" -> cycle(C.TRACK_TYPE_TEXT)
            "settings" -> showTracks()
        }
        if (cmd != "stop" && cmd != "home") showControls(playBtn)
    }

    override fun onPause() {
        super.onPause()
        if (::player.isInitialized) { saveProgress(force = true); player.pause() }
    }

    override fun onDestroy() {
        App.main.removeCallbacks(tick)
        if (::player.isInitialized) {
            saveProgress(force = true)
            player.removeListener(listener)
            player.release()
        }
        if (current === this) current = null
        closedSinceResume = true
        super.onDestroy()
    }
}
