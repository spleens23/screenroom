package com.screenroom.tv

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.os.Build
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Walks the library folders (and any plugged-in drives) and describes each MP4 the way ffprobe does on
 * the desktop, so the shared JavaScript can build identical library items. Results are cached by
 * path + modified time + size, so a rescan only looks at new or changed files.
 */
object Library {
    private const val TAG = "Screenroom"
    private val VIDEO_EXT = setOf("mp4", "m4v")
    private val scanLock = Any()

    fun scanDirs(): List<String> {
        val dirs = App.store.dirs()
        val extra = Drives.current.map { it.path }.filter { m -> dirs.none { d -> m == d || m.startsWith("$d/") } }
        return dirs + extra
    }

    fun scan(ctx: Context, onProgress: (Int, Int) -> Unit) {
        synchronized(scanLock) {
            val files = LinkedHashMap<String, File>()
            for (d in scanDirs()) walk(File(d), files, 0)
            val cache = App.store.library
            val total = files.size
            val done = AtomicInteger(0)
            val results = ConcurrentHashMap<String, JSONObject>()
            val pool = Executors.newFixedThreadPool(2)
            for ((path, f) in files) {
                pool.execute {
                    try {
                        val mtime = f.lastModified()
                        val size = f.length()
                        val hit = cache.optJSONObject(path)
                        val entry = if (hit != null && hit.optLong("mtime") == mtime && hit.optLong("size") == size && artOk(hit)) hit
                        else probe(f, mtime, size)
                        results[path] = entry
                    } catch (e: Throwable) {
                        Log.w(TAG, "could not read $path: $e")
                    }
                    val n = done.incrementAndGet()
                    if (n % 5 == 0 || n == total) onProgress(n, total)
                }
            }
            pool.shutdown()
            pool.awaitTermination(12, TimeUnit.HOURS)
            val next = JSONObject()
            for (path in files.keys) results[path]?.let { next.put(path, it) }
            App.store.saveLibrary(next)
        }
    }

    private fun walk(dir: File, out: MutableMap<String, File>, depth: Int) {
        if (depth > 12) return
        val kids = dir.listFiles() ?: return
        kids.sortBy { it.name.lowercase() }
        for (f in kids) {
            val n = f.name
            if (n.startsWith(".") || n == "Android" || n == "LOST.DIR" || n == "System Volume Information") continue
            if (f.isDirectory) walk(f, out, depth + 1)
            else if (f.extension.lowercase() in VIDEO_EXT) out.putIfAbsent(f.absolutePath, f)
        }
    }

    private fun artOk(e: JSONObject): Boolean {
        val art = e.optString("art")
        val back = e.optString("backdrop")
        return (art.isEmpty() || File(art).exists()) && (back.isEmpty() || File(back).exists())
    }

    private fun sha1(s: String): String {
        val d = MessageDigest.getInstance("SHA-1").digest(s.toByteArray(Charsets.UTF_8))
        return d.joinToString("") { "%02x".format(it) }
    }

    // ---- describing one file -------------------------------------------------------------------------

    private fun probe(f: File, mtime: Long, size: Long): JSONObject {
        val path = f.absolutePath
        val id = sha1(path).substring(0, 16)
        val meta = try { Mp4Tags.read(f) } catch (e: Throwable) { Mp4Tags.Result() }
        val streams = JSONArray()
        var durUs = 0L
        val ex = MediaExtractor()
        try {
            ex.setDataSource(path)
            var firstAudio = true
            for (i in 0 until ex.trackCount) {
                val fmt = ex.getTrackFormat(i)
                val mime = fmt.getString(MediaFormat.KEY_MIME) ?: continue
                if (fmt.containsKey(MediaFormat.KEY_DURATION)) durUs = max(durUs, fmt.getLong(MediaFormat.KEY_DURATION))
                val lang = if (fmt.containsKey(MediaFormat.KEY_LANGUAGE)) (fmt.getString(MediaFormat.KEY_LANGUAGE) ?: "") else ""
                val tags = JSONObject().put("language", if (lang == "und") "" else lang)
                when {
                    mime.startsWith("video/") -> streams.put(videoStream(fmt, mime, tags))
                    mime.startsWith("audio/") -> {
                        streams.put(audioStream(fmt, mime, tags, firstAudio))
                        firstAudio = false
                    }
                    mime.startsWith("text/") || mime.startsWith("application/") -> streams.put(
                        JSONObject().put("codec_type", "subtitle").put("codec_name", subtitleCodec(mime)).put("tags", tags)
                    )
                }
            }
        } catch (e: Throwable) {
            Log.w(TAG, "could not read tracks of $path: $e")
        } finally {
            try { ex.release() } catch (_: Throwable) {}
        }

        val duration = if (durUs > 0) durUs / 1_000_000.0 else meta.durationSec
        val fmtTags = JSONObject()
        for ((k, v) in meta.tags) fmtTags.put(k, v)
        val probe = JSONObject()
            .put("format", JSONObject().put("duration", duration.toString()).put("tags", fmtTags))
            .put("streams", streams)

        val entry = JSONObject().put("id", id).put("path", path).put("mtime", mtime).put("size", size).put("probe", probe)
        meta.cover?.let { bytes ->
            val out = File(App.store.artDir, "$id-cover.jpg")
            if (saveScaled(bytes, out, 600)) entry.put("art", out.absolutePath)
        }
        grabFrame(path, (duration * 1_000_000).toLong(), File(App.store.artDir, "$id-back.jpg"))?.let { entry.put("backdrop", it) }
        return entry
    }

    private fun videoStream(fmt: MediaFormat, mime: String, tags: JSONObject): JSONObject {
        val s = JSONObject().put("codec_type", "video").put("codec_name", videoCodec(mime)).put("tags", tags)
        intKey(fmt, MediaFormat.KEY_WIDTH)?.let { s.put("width", it) }
        intKey(fmt, MediaFormat.KEY_HEIGHT)?.let { s.put("height", it) }
        val fps = numKey(fmt, MediaFormat.KEY_FRAME_RATE) ?: 0.0
        if (fps > 0) s.put("avg_frame_rate", "${(fps * 1000).roundToInt()}/1000")
        intKey(fmt, MediaFormat.KEY_COLOR_TRANSFER)?.let {
            when (it) {
                MediaFormat.COLOR_TRANSFER_ST2084 -> s.put("color_transfer", "smpte2084")
                MediaFormat.COLOR_TRANSFER_HLG -> s.put("color_transfer", "arib-std-b67")
                else -> {}
            }
        }
        if (mime == "video/dolby-vision") {
            s.put("side_data_list", JSONArray().put(JSONObject().put("side_data_type", "DOVI configuration record")))
        }
        s.put("disposition", JSONObject().put("default", 1).put("attached_pic", 0))
        return s
    }

    private fun audioStream(fmt: MediaFormat, mime: String, tags: JSONObject, first: Boolean): JSONObject {
        val (codec, profile) = when (mime) {
            "audio/ac3" -> "ac3" to ""
            "audio/eac3" -> "eac3" to ""
            "audio/eac3-joc" -> "eac3" to "Dolby Atmos"
            "audio/true-hd" -> "truehd" to ""
            "audio/vnd.dts" -> "dts" to ""
            "audio/vnd.dts.hd" -> "dts" to "DTS-HD MA"
            "audio/vnd.dts.uhd" -> "dts" to "DTS:X"
            "audio/mp4a-latm" -> "aac" to ""
            "audio/opus" -> "opus" to ""
            "audio/flac" -> "flac" to ""
            "audio/mpeg" -> "mp3" to ""
            "audio/ac4" -> "ac4" to ""
            else -> mime.removePrefix("audio/") to ""
        }
        val s = JSONObject().put("codec_type", "audio").put("codec_name", codec).put("tags", tags)
        if (profile.isNotEmpty()) s.put("profile", profile)
        intKey(fmt, MediaFormat.KEY_CHANNEL_COUNT)?.let { s.put("channels", it) }
        intKey(fmt, MediaFormat.KEY_BIT_RATE)?.let { s.put("bit_rate", it) }
        s.put("disposition", JSONObject().put("default", if (first) 1 else 0))
        return s
    }

    private fun videoCodec(mime: String) = when (mime) {
        "video/avc" -> "h264"
        "video/hevc", "video/dolby-vision" -> "hevc"
        "video/av01" -> "av1"
        "video/x-vnd.on2.vp9" -> "vp9"
        "video/mp4v-es" -> "mpeg4"
        else -> mime.removePrefix("video/")
    }

    private fun subtitleCodec(mime: String) = when (mime) {
        "text/vtt" -> "webvtt"
        "application/x-subrip" -> "subrip"
        "text/x-ssa" -> "ass"
        else -> "mov_text"
    }

    private fun intKey(f: MediaFormat, key: String): Int? {
        if (!f.containsKey(key)) return null
        return try { f.getInteger(key) } catch (_: Throwable) { try { f.getFloat(key).roundToInt() } catch (_: Throwable) { null } }
    }

    private fun numKey(f: MediaFormat, key: String): Double? {
        if (!f.containsKey(key)) return null
        return try { f.getInteger(key).toDouble() } catch (_: Throwable) { try { f.getFloat(key).toDouble() } catch (_: Throwable) { null } }
    }

    // ---- artwork ---------------------------------------------------------------------------------------

    private fun saveScaled(bytes: ByteArray, out: File, width: Int): Boolean {
        return try {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            if (bounds.outWidth <= 0) return false
            var sample = 1
            while (bounds.outWidth / (sample * 2) >= width) sample *= 2
            val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
                ?: return false
            val scaled = if (bmp.width > width) Bitmap.createScaledBitmap(bmp, width, max(1, bmp.height * width / bmp.width), true) else bmp
            FileOutputStream(out).use { scaled.compress(Bitmap.CompressFormat.JPEG, 85, it) }
            true
        } catch (e: Throwable) {
            Log.w(TAG, "cover art failed: $e")
            false
        }
    }

    private fun grabFrame(path: String, durUs: Long, out: File): String? {
        val r = MediaMetadataRetriever()
        return try {
            r.setDataSource(path)
            val at = if (durUs > 10_000_000) max(5_000_000L, (durUs * 0.2).toLong()) else durUs / 2
            val bmp: Bitmap = (if (Build.VERSION.SDK_INT >= 27)
                r.getScaledFrameAtTime(at, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, 1280, 720)
            else r.getFrameAtTime(at, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)) ?: return null
            val scaled = if (bmp.width > 1280) Bitmap.createScaledBitmap(bmp, 1280, max(1, bmp.height * 1280 / bmp.width), true) else bmp
            FileOutputStream(out).use { scaled.compress(Bitmap.CompressFormat.JPEG, 80, it) }
            out.absolutePath
        } catch (e: Throwable) {
            Log.w(TAG, "frame grab failed for $path: $e")
            null
        } finally {
            try { r.release() } catch (_: Throwable) {}
        }
    }
}
