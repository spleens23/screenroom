package com.screenroom.phone

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import java.io.File

/**
 * Parlor's player (as on the iPhone, MusicPlayer.swift): a queue of songs that keeps playing with the screen
 * off, with the notification and lock screen controls. The phone plays the queue as a playlist (one song runs
 * into the next with no gap); FFmpeg's decoders play what the phone can't (Dolby Digital Plus on a Pixel, TrueHD,
 * DTS). On a Sonos room, the speaker plays the songs itself (Sonos.kt) and the phone just keeps time.
 * Everything here runs on the main thread.
 */
object MusicPlayer {
    var bridge: Bridge? = null
    private lateinit var app: Context
    lateinit var exo: ExoPlayer; private set
    lateinit var sessionPlayer: Player; private set

    private var queue = mutableListOf<Map<String, Any?>>()
    private var index = -1
    private var context: Any? = null
    private var volume = 1f
    private var muted = false
    private var shuffle = false
    private var unshuffled: List<Map<String, Any?>>? = null
    private var repeatMode = "off"
    private var link: SonosLink? = null
    private val main = Handler(Looper.getMainLooper())
    private var lastEmit = 0L
    private var failsInARow = 0
    private lateinit var silence: File

    fun init(ctx: Context) {
        if (::exo.isInitialized) return
        app = ctx.applicationContext
        silence = File(app.cacheDir, "silence.wav").also { if (!it.exists()) it.writeBytes(silentWav()) }
        val renderers = DefaultRenderersFactory(app).setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_ON)
        exo = ExoPlayer.Builder(app, renderers)
            .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), true)
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_LOCAL)
            .build()
        exo.addListener(object : Player.Listener {
            override fun onMediaItemTransition(item: MediaItem?, reason: Int) {
                if (link == null && exo.mediaItemCount > 0) { index = exo.currentMediaItemIndex; failsInARow = 0 }
                emit()
            }
            override fun onIsPlayingChanged(isPlaying: Boolean) { emit(); if (isPlaying) tick() }
            override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) = emit()
            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_ENDED && link == null) stop() else emit()
            }
            override fun onPlayerError(error: PlaybackException) {
                if (link != null) return
                // a song that can't be played (a damaged file) is skipped, with a word about it
                val title = queue.getOrNull(index)?.get("title") as? String ?: "That song"
                android.util.Log.w("Parlor", "can't play $title", error)
                bridge?.emit("notice", "$title can't be played")
                failsInARow++
                if (failsInARow >= maxOf(1, queue.size) || index + 1 >= queue.size) { failsInARow = 0; stop(); return }
                index += 1
                exo.prepare(); exo.seekTo(index, 0); exo.play()
            }
        })
        sessionPlayer = SessionPlayer(exo)
    }

    /** Every second while playing: the page's clock and bar (and, on a speaker, where it's got to). */
    private fun tick() {
        main.removeCallbacks(ticker)
        main.postDelayed(ticker, 1000)
    }
    private val ticker = Runnable { if (exo.isPlaying || link != null) { emit(throttled = true); tick() } }

    // ---- what the page sees ----------------------------------------------------------------------------------
    private val current get() = queue.getOrNull(index)

    fun snapshot(): Map<String, Any?> {
        var pos = exo.currentPosition / 1000.0
        var dur = if (exo.duration > 0) exo.duration / 1000.0 else 0.0
        var playing = index >= 0 && exo.mediaItemCount > 0
        var paused = playing && !exo.playWhenReady
        var vol = Math.round(volume * 100); var mute = muted
        var route: Map<String, Any?> = route()
        var output: Any? = null
        link?.let { l ->
            playing = index >= 0; paused = playing && l.paused
            pos = l.now; dur = l.dur; vol = l.volume; mute = l.muted
            route = mapOf("kind" to "sonos", "name" to l.room.name, "spatial" to false, "channels" to 0, "sonos" to true, "atmos" to l.room.atmos, "model" to l.room.model)
            output = mapOf("id" to l.room.id, "name" to l.room.name, "atmos" to l.room.atmos)
        }
        if (dur <= 0) dur = current?.get("duration").asNum() ?: 0.0
        return mapOf(
            "playing" to playing, "paused" to paused, "index" to index, "pos" to pos, "dur" to dur,
            "volume" to vol, "muted" to mute,
            "queue" to queue.map { it["id"] as? String ?: "" },
            "queued" to queue.map { it["queued"] == true },
            "shuffle" to shuffle, "repeat" to repeatMode, "context" to context,
            "route" to route, "output" to output,
        )
    }

    /** Where the sound is going: the phone's speaker or headphones (and whether Android spatializes it there). */
    private fun route(): Map<String, Any?> {
        val am = app.getSystemService(AudioManager::class.java)
        val outs = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
        val head = outs.firstOrNull { it.type in setOf(AudioDeviceInfo.TYPE_BLUETOOTH_A2DP, AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_USB_HEADSET) || (Build.VERSION.SDK_INT >= 31 && it.type == AudioDeviceInfo.TYPE_BLE_HEADSET) }
        val spatial = Build.VERSION.SDK_INT >= 32 && head != null && am.spatializer.isEnabled && am.spatializer.isAvailable
        return mapOf("spatial" to spatial, "name" to (head?.productName?.toString() ?: "Speaker"), "kind" to if (head != null) "Headphones" else "Speaker", "channels" to 2)
    }

    fun emit(throttled: Boolean = false) {
        val now = System.currentTimeMillis()
        if (throttled && now - lastEmit < 900) return
        lastEmit = now
        bridge?.emit("music-state", snapshot())
    }

    // ---- the phone's playlist ----------------------------------------------------------------------------------
    private fun item(t: Map<String, Any?>): MediaItem {
        val meta = MediaMetadata.Builder().setTitle(t["title"] as? String).setArtist(t["artist"] as? String).setAlbumTitle(t["album"] as? String)
        (t["art"] as? String)?.let { if (File(it).exists()) meta.setArtworkUri(Uri.fromFile(File(it))) }
        return MediaItem.Builder().setUri(Uri.fromFile(File(t["path"] as? String ?: ""))).setMediaId(t["id"] as? String ?: "").setMediaMetadata(meta.build()).build()
    }

    /** The phone's playlist put back in the queue's order around the song that's playing (which carries on). */
    private fun resync() {
        if (link != null || index < 0) return
        val cur = exo.currentMediaItemIndex
        if (cur + 1 < exo.mediaItemCount) exo.removeMediaItems(cur + 1, exo.mediaItemCount)
        if (cur > 0) exo.removeMediaItems(0, cur)
        if (index + 1 < queue.size) exo.addMediaItems(1, queue.subList(index + 1, queue.size).map(::item))
        if (index > 0) exo.addMediaItems(0, queue.subList(0, index).map(::item))
    }

    // ---- commands -------------------------------------------------------------------------------------------------
    fun play(tracks: List<Map<String, Any?>>, start: Int, ctx: Any?) {
        queue = tracks.toMutableList(); shuffle = false; unshuffled = null; context = ctx
        index = start.coerceIn(0, maxOf(0, tracks.size - 1))
        if (tracks.isEmpty()) { stop(); return }
        link?.let { l -> l.load(index, 0.0, true); keepTime(true); emit(); return }
        exo.setMediaItems(queue.map(::item), index, 0)
        exo.volume = if (muted) 0f else volume
        exo.repeatMode = exoRepeat()
        exo.prepare(); exo.play()
        emit()
    }

    private fun exoRepeat() = when (repeatMode) { "one" -> Player.REPEAT_MODE_ONE; "all" -> Player.REPEAT_MODE_ALL; else -> Player.REPEAT_MODE_OFF }

    private fun go(i: Int) {
        if (i < 0 || i >= queue.size) { stop(); return }
        index = i
        link?.let { l -> l.jump(i); keepTime(true); emit(); return }
        if (exo.playbackState == Player.STATE_IDLE) exo.prepare()
        exo.seekTo(i, 0); exo.play()
        emit()
    }

    fun command(cmd: String, arg: Any?): Map<String, Any?> {
        val l = link
        when (cmd) {
            "toggle" -> if (l != null) { if (l.paused) { l.play(); keepTime(true) } else { l.pause(); keepTime(false) } } else { if (exo.playWhenReady) exo.pause() else { if (exo.playbackState == Player.STATE_IDLE) exo.prepare(); exo.play() } }
            "pause" -> if (l != null) { l.pause(); keepTime(false) } else exo.pause()
            "play" -> if (l != null) { l.play(); keepTime(true) } else { if (exo.playbackState == Player.STATE_IDLE) exo.prepare(); exo.play() }
            "next" -> if (index + 1 < queue.size) go(index + 1) else if (repeatMode == "all" && queue.isNotEmpty()) go(0) else { seek(0.0); if (l != null) l.pause() else exo.pause() }
            "prev" -> { val pos = l?.now ?: (exo.currentPosition / 1000.0); if (pos > 3 || index <= 0) seek(0.0) else go(index - 1) }
            "seek" -> arg.asNum()?.let { seek(it) }
            "volume" -> arg.asNum()?.let { v -> if (l != null) l.setVolume(Math.round(v).toInt()) else { volume = (v / 100).toFloat().coerceIn(0f, 1f); exo.volume = if (muted) 0f else volume } }
            "volup" -> if (l != null) l.setVolume(l.volume + 5) else { volume = minOf(1f, volume + 0.05f); exo.volume = if (muted) 0f else volume }
            "voldown" -> if (l != null) l.setVolume(l.volume - 5) else { volume = maxOf(0f, volume - 0.05f); exo.volume = if (muted) 0f else volume }
            "mute" -> if (l != null) l.setMuted(!l.muted) else { muted = !muted; exo.volume = if (muted) 0f else volume }
            "jump" -> arg.asNum()?.toInt()?.let { go(it) }
            "stop" -> stop()
            "clear" -> current?.let { cur -> val was = index; queue = mutableListOf(cur); index = 0; unshuffled = null; l?.rebuild(was, 0); resync() }
            "shuffle" -> { val was = index; toggleShuffle(); if (was >= 0) { l?.rebuild(was, index); resync() } }
            "repeat" -> { repeatMode = mapOf("off" to "all", "all" to "one")[repeatMode] ?: "off"; exo.repeatMode = if (l != null) Player.REPEAT_MODE_ONE else exoRepeat(); l?.repeatOne(repeatMode == "one") }
            "enqueue" -> {
                val o = arg.asMap()
                @Suppress("UNCHECKED_CAST") val tracks = (o?.get("tracks") as? List<Map<String, Any?>>)?.map { it + ("queued" to true) } ?: emptyList()
                if (tracks.isNotEmpty()) {
                    if (o?.get("next") == true && index >= 0) {
                        queue.addAll(index + 1, tracks)
                        if (l != null) l.rebuild(index, index) else exo.addMediaItems(index + 1, tracks.map(::item))
                    } else {
                        queue.addAll(tracks)
                        if (l != null) { if (index >= 0) l.grew() } else exo.addMediaItems(tracks.map(::item))
                    }
                    if (index < 0) { if (l != null) l.forget() else { exo.prepare() }; go(0) }
                }
            }
        }
        emit()
        return snapshot()
    }

    private fun seek(s: Double) { link?.seek(s) ?: exo.seekTo((s * 1000).toLong()) }

    private fun toggleShuffle() {
        shuffle = !shuffle
        if (index < 0 || index >= queue.size) return
        val cur = queue[index]
        val id = { t: Map<String, Any?> -> t["id"] as? String ?: "" }
        if (shuffle) {
            unshuffled = queue.toList()
            val rest = queue.toMutableList().also { it.removeAt(index) }.shuffled()
            queue = (listOf(cur) + rest).toMutableList(); index = 0
        } else {
            val base = unshuffled ?: queue
            val known = base.map(id).toSet()
            queue = (base + queue.filter { id(it) !in known }).toMutableList()
            index = queue.indexOfFirst { id(it) == id(cur) }.coerceAtLeast(0)
            unshuffled = null
        }
    }

    fun stop() {
        link?.let { it.pause(); it.forget() }
        exo.stop(); exo.clearMediaItems()
        queue = mutableListOf(); index = -1; shuffle = false; unshuffled = null
        emit()
    }

    // ---- Sonos -------------------------------------------------------------------------------------------------------
    val sonosId: String? get() = link?.room?.id

    /** Play on a Sonos room (or back on the phone, with null): the song carries on there from where it was. */
    fun useSonos(room: SonosRoom?) {
        val l0 = link
        val wasPlaying = if (l0 != null) index >= 0 && !l0.paused else exo.isPlaying || exo.playWhenReady && exo.mediaItemCount > 0
        val pos = l0?.now ?: (exo.currentPosition / 1000.0)
        l0?.release(true)
        link = null
        if (room != null) {
            val l = SonosLink(room) { queue }
            l.onUpdate = { i, ended -> sonosMoved(i, ended) }
            l.onProblem = { m -> bridge?.emit("notice", m) }
            link = l
            l.start()
            if (repeatMode == "one") l.repeatOne(true)
            exo.stop(); exo.clearMediaItems()
            if (index >= 0) l.load(index, pos, wasPlaying)
            keepTime(wasPlaying)
            tick()
        } else {
            exo.stop(); exo.clearMediaItems()
            if (index >= 0) {
                exo.setMediaItems(queue.map(::item), index, (pos * 1000).toLong())
                exo.repeatMode = exoRepeat(); exo.volume = if (muted) 0f else volume
                exo.prepare()
                if (wasPlaying) exo.play()
            }
        }
        emit()
    }

    /**
     * While on a speaker, the phone plays silence with the song's details: that's what keeps Parlor running with
     * the screen off (it has to be, to hand the speaker its songs) and shows the song in the notification and on
     * the lock screen, whose buttons work the speaker.
     */
    private fun keepTime(playing: Boolean) {
        val t = current ?: return
        val meta = MediaMetadata.Builder().setTitle(t["title"] as? String).setArtist(listOfNotNull(t["artist"] as? String, link?.room?.name).joinToString(" — "))
            .setAlbumTitle(t["album"] as? String)
        (t["art"] as? String)?.let { if (File(it).exists()) meta.setArtworkUri(Uri.fromFile(File(it))) }
        val it = MediaItem.Builder().setUri(Uri.fromFile(silence)).setMediaId("sonos-" + (t["id"] as? String ?: "")).setMediaMetadata(meta.build()).build()
        if (exo.mediaItemCount == 0 || exo.currentMediaItem?.mediaId != it.mediaId) {
            exo.setMediaItem(it); exo.repeatMode = Player.REPEAT_MODE_ONE; exo.volume = 0f; exo.prepare()
        }
        exo.playWhenReady = playing
    }

    private fun sonosMoved(i: Int?, ended: Boolean) {
        val l = link ?: return
        if (ended) {
            if (repeatMode == "all" && queue.isNotEmpty()) { index = 0; l.load(0, 0.0, true) } else { stop(); return }
        } else if (i != null && i != index && i >= 0 && i < queue.size) {
            index = i
            emit()
        }
        keepTime(!l.paused)
        emit(throttled = true)
    }

    /** One second of silence, as a WAV file. */
    private fun silentWav(): ByteArray {
        val rate = 8000; val samples = rate
        val b = java.nio.ByteBuffer.allocate(44 + samples * 2).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        b.put("RIFF".toByteArray()); b.putInt(36 + samples * 2); b.put("WAVE".toByteArray())
        b.put("fmt ".toByteArray()); b.putInt(16); b.putShort(1); b.putShort(1); b.putInt(rate); b.putInt(rate * 2); b.putShort(2); b.putShort(16)
        b.put("data".toByteArray()); b.putInt(samples * 2)
        return b.array()
    }
}

/**
 * The player the notification and lock screen see: their buttons go through Parlor's own commands (so Previous
 * restarts a song first, and on a speaker they work the speaker), and on a speaker the time shown is the
 * speaker's.
 */
class SessionPlayer(p: Player) : ForwardingPlayer(p) {
    private val sonos get() = MusicPlayer.sonosId != null
    private fun snap() = MusicPlayer.snapshot()
    override fun play() { MusicPlayer.command("play", null) }
    override fun pause() { MusicPlayer.command("pause", null) }
    override fun setPlayWhenReady(playWhenReady: Boolean) { MusicPlayer.command(if (playWhenReady) "play" else "pause", null) }
    override fun seekToNext() { MusicPlayer.command("next", null) }
    override fun seekToNextMediaItem() { MusicPlayer.command("next", null) }
    override fun seekToPrevious() { MusicPlayer.command("prev", null) }
    override fun seekToPreviousMediaItem() { MusicPlayer.command("prev", null) }
    override fun seekTo(positionMs: Long) { MusicPlayer.command("seek", positionMs / 1000.0) }
    override fun hasNextMediaItem(): Boolean = if (sonos) true else super.hasNextMediaItem()
    override fun hasPreviousMediaItem(): Boolean = if (sonos) true else super.hasPreviousMediaItem()
    override fun getCurrentPosition(): Long = if (sonos) ((snap()["pos"].asNum() ?: 0.0) * 1000).toLong() else super.getCurrentPosition()
    override fun getContentPosition(): Long = currentPosition
    override fun getBufferedPosition(): Long = if (sonos) currentPosition else super.getBufferedPosition()
    override fun getDuration(): Long = if (sonos) ((snap()["dur"].asNum() ?: 0.0) * 1000).toLong() else super.getDuration()
    override fun getContentDuration(): Long = duration
    override fun isCommandAvailable(command: Int): Boolean =
        command == Player.COMMAND_SEEK_TO_NEXT || command == Player.COMMAND_SEEK_TO_PREVIOUS || command == Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM ||
            command == Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM || super.isCommandAvailable(command)
    override fun getAvailableCommands(): Player.Commands = super.getAvailableCommands().buildUpon()
        .addAll(Player.COMMAND_SEEK_TO_NEXT, Player.COMMAND_SEEK_TO_PREVIOUS, Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM, Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM).build()
}
