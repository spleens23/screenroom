package com.screenroom.phone

import android.graphics.Bitmap
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import java.io.File
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Screenroom's films: every video in its folders, described the way ffprobe does on the desktop (so the shared
 * screens build the same library items), with a cover and a frame from the film. Cached by path + modified time +
 * size, so opening Screenroom reads only new or changed films, and only when something changed at all.
 */
object VideoScanner {
    private const val CACHE = "scan-films-5"
    val videoExtensions = setOf("mp4", "m4v", "mov", "mkv", "webm", "ts", "m2ts", "mts", "3gp")
    @Volatile private var busy = false

    private fun list(): List<File> {
        val out = ArrayList<File>()
        val seen = HashSet<String>()
        for (root in listOf(Storage.docs) + Storage.linked) {
            root.walkTopDown().onEnter { !it.name.startsWith(".") && !(it.name == "Android" && it.parent == "/storage/emulated/0") }.forEach { f ->
                if (f.isFile && f.extension.lowercase() in videoExtensions && !f.name.startsWith(".") && !isMotionCover(f.name) && seen.add(Storage.canonical(f))) out.add(f)
            }
        }
        return out.sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.path })
    }

    fun signature(): String = sha1Hex(list().map { "${Storage.relativeToDocs(it)}|${it.length()}|${it.lastModified() / 1000}" }.sorted().joinToString("\n"))
    fun changed(): Boolean = Storage.readJson("scan-video-sig").asMap()?.get("sig") != signature()

    @Suppress("UNCHECKED_CAST")
    private fun readCache(): Map<String, Map<String, Any?>> =
        (Storage.readJson(CACHE).asMap() ?: emptyMap()).mapNotNull { (k, v) -> (v as? Map<String, Any?>)?.let { k to it } }.toMap()

    private fun artOk(e: Map<String, Any?>) = listOf("art", "backdrop").all { k -> (e[k] as? String).let { it.isNullOrEmpty() || File(it).exists() } }

    fun scan(cacheOnly: Boolean, deep: Boolean, progress: (Int, Int) -> Unit): List<Map<String, Any?>> {
        val files = list()
        val cache = readCache()
        if (cacheOnly || busy) return files.mapNotNull { cache[it.path] }
        busy = true
        try {
            val fresh = { f: File -> !deep && cache[f.path]?.let { h -> Math.abs((h["mtime"].asNum() ?: -1.0) - f.lastModified()) < 1500 && h["size"].asNum()?.toLong() == f.length() && artOk(h) } == true }
            val toRead = files.count { !fresh(it) }
            val next = LinkedHashMap<String, Map<String, Any?>>()
            var done = 0
            for (f in files) {
                if (fresh(f)) { next[f.path] = cache[f.path]!!; continue }
                next[f.path] = try { probe(f) } catch (e: Throwable) {
                    mapOf("id" to sha1Hex(Storage.relativeToDocs(f)).take(16), "path" to f.path, "mtime" to f.lastModified().toDouble(), "size" to f.length(),
                        "probe" to mapOf("format" to mapOf("duration" to "0", "tags" to emptyMap<String, String>()), "streams" to emptyList<Any>()))
                }
                done++
                if (done % 3 == 0 || done == toRead) progress(done, toRead)
                if (done % 10 == 0) Storage.writeJson(CACHE, cache + next)
            }
            Storage.writeJson(CACHE, next)
            Storage.writeJson("scan-video-sig", mapOf("sig" to signature()))
            return files.mapNotNull { next[it.path] }
        } finally { busy = false }
    }

    // ---- one film ---------------------------------------------------------------------------------------------------
    private fun probe(f: File): Map<String, Any?> {
        val id = sha1Hex(Storage.relativeToDocs(f)).take(16)
        val ext = f.extension.lowercase()
        val meta = if (ext in setOf("mp4", "m4v", "mov")) try { Mp4Tags.read(f) } catch (_: Throwable) { Mp4Tags.Result() } else Mp4Tags.Result()
        val streams = ArrayList<Map<String, Any?>>()
        var durUs = 0L
        val ex = MediaExtractor()
        try {
            ex.setDataSource(f.path)
            var firstAudio = true
            for (i in 0 until ex.trackCount) {
                val fmt = ex.getTrackFormat(i)
                val mime = fmt.getString(MediaFormat.KEY_MIME) ?: continue
                if (fmt.containsKey(MediaFormat.KEY_DURATION)) durUs = max(durUs, fmt.getLong(MediaFormat.KEY_DURATION))
                val lang = if (fmt.containsKey(MediaFormat.KEY_LANGUAGE)) (fmt.getString(MediaFormat.KEY_LANGUAGE) ?: "") else ""
                val tags = mapOf("language" to if (lang == "und") "" else lang)
                when {
                    mime.startsWith("video/") -> streams.add(videoStream(fmt, mime, tags))
                    mime.startsWith("audio/") -> { streams.add(audioStream(fmt, mime, tags, firstAudio)); firstAudio = false }
                    mime.startsWith("text/") || mime.startsWith("application/") ->
                        streams.add(mapOf("codec_type" to "subtitle", "codec_name" to subtitleCodec(mime), "tags" to tags))
                }
            }
        } catch (_: Throwable) {
        } finally { try { ex.release() } catch (_: Throwable) {} }

        val tags = LinkedHashMap<String, String>(meta.tags)
        var duration = if (durUs > 0) durUs / 1e6 else meta.durationSec
        // tags in other files (MKV …): the title, from Android's own reader
        val r = MediaMetadataRetriever()
        try {
            r.setDataSource(f.path)
            if (tags["title"] == null) r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_TITLE)?.trim()?.takeIf { it.isNotEmpty() && it != f.name && it != f.nameWithoutExtension }?.let { tags["title"] = it }
            if (duration <= 0) r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()?.let { duration = it / 1000.0 }
        } catch (_: Throwable) {} finally { try { r.release() } catch (_: Throwable) {} }

        val entry = mutableMapOf<String, Any?>("id" to id, "path" to f.path, "mtime" to f.lastModified().toDouble(), "size" to f.length(),
            "probe" to mapOf("format" to mapOf("duration" to duration.toString(), "tags" to tags), "streams" to streams))
        meta.cover?.let { saveJpeg(it, 600, File(Storage.art, "$id-cover.jpg"))?.let { p -> entry["art"] = p } }
        if (entry["art"] == null) sidecarArt(f)?.let { entry["art"] = it.path }
        grabFrame(f.path, (duration * 1e6).toLong(), File(Storage.art, "$id-back.jpg"))?.let { entry["backdrop"] = it }
        if (entry["art"] == null) entry["backdrop"]?.let { entry["art"] = it } // like the desktop: a frame from the film
        return entry
    }

    private fun videoStream(fmt: MediaFormat, mime: String, tags: Map<String, String>): Map<String, Any?> {
        val s = mutableMapOf<String, Any?>("codec_type" to "video", "codec_name" to videoCodec(mime), "tags" to tags)
        intKey(fmt, MediaFormat.KEY_WIDTH)?.let { s["width"] = it }
        intKey(fmt, MediaFormat.KEY_HEIGHT)?.let { s["height"] = it }
        val fps = numKey(fmt, MediaFormat.KEY_FRAME_RATE) ?: 0.0
        if (fps > 0) s["avg_frame_rate"] = "${(fps * 1000).roundToInt()}/1000"
        when (intKey(fmt, MediaFormat.KEY_COLOR_TRANSFER)) {
            MediaFormat.COLOR_TRANSFER_ST2084 -> s["color_transfer"] = "smpte2084"
            MediaFormat.COLOR_TRANSFER_HLG -> s["color_transfer"] = "arib-std-b67"
        }
        if (mime == "video/dolby-vision") s["side_data_list"] = listOf(mapOf("side_data_type" to "DOVI configuration record"))
        s["disposition"] = mapOf("default" to 1, "attached_pic" to 0)
        return s
    }

    private fun audioStream(fmt: MediaFormat, mime: String, tags: Map<String, String>, first: Boolean): Map<String, Any?> {
        val (codec, profile) = when (mime) {
            "audio/ac3" -> "ac3" to ""; "audio/eac3" -> "eac3" to ""; "audio/eac3-joc" -> "eac3" to "Dolby Atmos"
            "audio/true-hd" -> "truehd" to ""; "audio/vnd.dts" -> "dts" to ""; "audio/vnd.dts.hd" -> "dts" to "DTS-HD MA"
            "audio/vnd.dts.uhd" -> "dts" to "DTS:X"; "audio/mp4a-latm" -> "aac" to ""; "audio/opus" -> "opus" to ""
            "audio/flac" -> "flac" to ""; "audio/mpeg" -> "mp3" to ""; "audio/ac4" -> "ac4" to ""
            else -> mime.removePrefix("audio/") to ""
        }
        val s = mutableMapOf<String, Any?>("codec_type" to "audio", "codec_name" to codec, "tags" to tags)
        if (profile.isNotEmpty()) s["profile"] = profile
        intKey(fmt, MediaFormat.KEY_CHANNEL_COUNT)?.let { s["channels"] = it }
        intKey(fmt, MediaFormat.KEY_BIT_RATE)?.let { s["bit_rate"] = it }
        s["disposition"] = mapOf("default" to if (first) 1 else 0)
        return s
    }

    private fun videoCodec(mime: String) = when (mime) {
        "video/avc" -> "h264"; "video/hevc", "video/dolby-vision" -> "hevc"; "video/av01" -> "av1"
        "video/x-vnd.on2.vp9" -> "vp9"; "video/mp4v-es" -> "mpeg4"; else -> mime.removePrefix("video/")
    }
    private fun subtitleCodec(mime: String) = when (mime) { "text/vtt" -> "webvtt"; "application/x-subrip" -> "subrip"; "text/x-ssa" -> "ass"; else -> "mov_text" }
    private fun intKey(f: MediaFormat, key: String): Int? = if (!f.containsKey(key)) null else try { f.getInteger(key) } catch (_: Throwable) { try { f.getFloat(key).roundToInt() } catch (_: Throwable) { null } }
    private fun numKey(f: MediaFormat, key: String): Double? = if (!f.containsKey(key)) null else try { f.getInteger(key).toDouble() } catch (_: Throwable) { try { f.getFloat(key).toDouble() } catch (_: Throwable) { null } }

    /** A poster beside a film: Film.jpg, or poster / cover / folder.jpg in its folder (and the show's above a Season folder). */
    private fun sidecarArt(f: File): File? {
        val dir = f.parentFile ?: return null
        val exts = listOf("jpg", "jpeg", "png", "webp")
        for (e in exts) {
            File(dir, "${f.nameWithoutExtension}.$e").takeIf { it.exists() }?.let { return it }
            File(dir, "${f.nameWithoutExtension}-poster.$e").takeIf { it.exists() }?.let { return it }
        }
        val dirs = ArrayList<File>()
        val roots = (listOf(Storage.films, Storage.docs) + Storage.linked).map { Storage.canonical(it) }
        if (Storage.canonical(dir) !in roots) dirs.add(dir)
        val parent = dir.parentFile
        if (parent != null && Regex("^(season|series|staffel|saison|temporada|specials?)\\b", RegexOption.IGNORE_CASE).containsMatchIn(dir.name) && Storage.canonical(parent) !in roots) dirs.add(parent)
        for (d in dirs) for (name in listOf("poster", "cover", "folder", "show", "season")) for (e in exts) File(d, "$name.$e").takeIf { it.exists() }?.let { return it }
        return null
    }

    /** Subtitles beside a film: Film.srt, Film.en.srt … */
    fun sidecarSubtitles(f: File): List<File> {
        val base = f.nameWithoutExtension.lowercase()
        return f.parentFile?.listFiles()?.filter { val l = it.name.lowercase(); l.startsWith(base) && it.extension.lowercase() in setOf("srt", "vtt", "ass", "ssa") } ?: emptyList()
    }

    // (Android's emulator stops dead while it takes frames out of films; a real phone doesn't, so only the emulator,
    // which the automated check runs in, goes without them: its films show their own covers)
    private val emulator = android.os.Build.HARDWARE in setOf("ranchu", "goldfish") || android.os.Build.FINGERPRINT.contains("generic")

    private fun grabFrame(path: String, durUs: Long, out: File): String? {
        if (emulator) return null
        val r = MediaMetadataRetriever()
        return try {
            r.setDataSource(path)
            val at = if (durUs > 10_000_000) max(5_000_000L, (durUs * 0.2).toLong()) else durUs / 2
            val bmp: Bitmap = r.getScaledFrameAtTime(at, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, 1280, 720) ?: return null
            saveBitmap(bmp, 1280, out, 80)
        } catch (_: Throwable) { null } finally { try { r.release() } catch (_: Throwable) {} }
    }
}
