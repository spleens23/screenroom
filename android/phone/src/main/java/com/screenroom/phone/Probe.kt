package com.screenroom.phone

import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.os.Build
import java.io.File
import java.io.RandomAccessFile

/**
 * What a song is: its tags (title, artist, album …), how long it is, its format (codec, channels, sample rate,
 * bit depth) and whether its Dolby sound is Atmos. The same description the iPhone's scanner gives, so the
 * shared screens build the same library.
 */
object Probe {
    private val codecs = mapOf(
        "audio/mp4a-latm" to "AAC", "audio/mpeg" to "MP3", "audio/flac" to "FLAC", "audio/alac" to "Apple Lossless",
        "audio/raw" to "WAV / AIFF", "audio/ac3" to "Dolby Digital", "audio/eac3" to "Dolby Digital Plus",
        "audio/eac3-joc" to "Dolby Digital Plus", "audio/ac4" to "Dolby AC-4", "audio/true-hd" to "Dolby TrueHD",
        "audio/opus" to "Opus", "audio/vorbis" to "Vorbis", "audio/vnd.dts" to "DTS", "audio/vnd.dts.hd" to "DTS-HD",
    )
    private val lossless = setOf("audio/flac", "audio/alac", "audio/raw", "audio/true-hd")

    fun audio(file: File, mtime: Double, size: Long): MutableMap<String, Any?> {
        val id = sha1Hex(Storage.relativeToDocs(file)).take(16)
        val entry = mutableMapOf<String, Any?>("id" to id, "path" to file.path, "mtime" to mtime, "size" to size, "channels" to 0)
        val ext = file.extension.lowercase()

        // the tracks: sound (which codec, how many channels) and pictures (a music video, or a cover stored as a track)
        var audioFmt: MediaFormat? = null
        var moving = false
        val ex = MediaExtractor()
        try {
            ex.setDataSource(file.path)
            for (i in 0 until ex.trackCount) {
                val f = ex.getTrackFormat(i)
                val mime = f.getString(MediaFormat.KEY_MIME) ?: continue
                if (mime.startsWith("audio/")) { if (audioFmt == null) audioFmt = f }
                else if (mime.startsWith("video/") && mime != "video/mjpeg") {
                    val fps = if (f.containsKey(MediaFormat.KEY_FRAME_RATE)) (try { f.getInteger(MediaFormat.KEY_FRAME_RATE).toDouble() } catch (_: Exception) { f.getFloat(MediaFormat.KEY_FRAME_RATE).toDouble() }) else -1.0
                    val dur = if (f.containsKey(MediaFormat.KEY_DURATION)) f.getLong(MediaFormat.KEY_DURATION) / 1e6 else -1.0
                    if (fps >= 2 || (fps < 0 && dur > 1.5)) moving = true
                }
            }
        } catch (e: Exception) {
            // (a format Android's own reader doesn't open: the tags may still be readable)
        } finally { ex.release() }

        val mime = audioFmt?.getString(MediaFormat.KEY_MIME) ?: ""
        if (ext in boxExtensions) {
            if (audioFmt == null) { entry["notSong"] = if (moving) "nosound" else "unreadable"; return entry }
            val ch = audioFmt.intOr(MediaFormat.KEY_CHANNEL_COUNT)
            // Dolby or surround sound means music made for listening (an Atmos song with a picture track), so it stays
            val dolby = mime in setOf("audio/ac3", "audio/eac3", "audio/eac3-joc", "audio/ac4", "audio/true-hd") || ch > 2
            if (moving && !dolby) { entry["notSong"] = "video"; return entry }
        }
        if (audioFmt != null) {
            entry["codec"] = codecs[mime] ?: mime.removePrefix("audio/").uppercase()
            entry["lossless"] = mime in lossless
            audioFmt.intOr(MediaFormat.KEY_CHANNEL_COUNT).takeIf { it > 0 }?.let { entry["channels"] = it }
            audioFmt.intOr(MediaFormat.KEY_SAMPLE_RATE).takeIf { it > 0 }?.let { entry["sampleRate"] = it }
            audioFmt.intOr(MediaFormat.KEY_BIT_RATE).takeIf { it > 0 }?.let { entry["bitrate"] = it / 1000 }
            if (mime == "audio/eac3-joc" || mime == "audio/ac4") entry["atmos"] = true
            // Dolby Digital Plus in an .m4a / .mp4: its description says whether there's Atmos in it
            if (mime == "audio/eac3" && ext in boxExtensions + setOf("m4a", "m4b") && Dec3.isAtmos(file)) entry["atmos"] = true
        }

        val tags = mutableMapOf<String, String>()
        val r = MediaMetadataRetriever()
        try {
            r.setDataSource(file.path)
            fun put(key: Int, name: String) { r.extractMetadata(key)?.trim()?.takeIf { it.isNotEmpty() }?.let { if (name !in tags) tags[name] = it } }
            put(MediaMetadataRetriever.METADATA_KEY_TITLE, "title")
            put(MediaMetadataRetriever.METADATA_KEY_ARTIST, "artist")
            put(MediaMetadataRetriever.METADATA_KEY_ALBUMARTIST, "album_artist")
            put(MediaMetadataRetriever.METADATA_KEY_ALBUM, "album")
            put(MediaMetadataRetriever.METADATA_KEY_CD_TRACK_NUMBER, "track")
            put(MediaMetadataRetriever.METADATA_KEY_DISC_NUMBER, "disc")
            put(MediaMetadataRetriever.METADATA_KEY_YEAR, "date")
            put(MediaMetadataRetriever.METADATA_KEY_DATE, "date")
            put(MediaMetadataRetriever.METADATA_KEY_GENRE, "genre")
            put(MediaMetadataRetriever.METADATA_KEY_COMPILATION, "compilation")
            tags["date"]?.let { if (it.startsWith("1904") || it.startsWith("0000")) tags.remove("date") } // (an empty MP4 date)
            r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()?.let { entry["duration"] = it / 1000.0 }
            if (entry["bitrate"] == null) r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_BITRATE)?.toLongOrNull()?.let { entry["bitrate"] = (it / 1000).toInt() }
            if (Build.VERSION.SDK_INT >= 31) {
                if (entry["sampleRate"] == null) r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_SAMPLERATE)?.toIntOrNull()?.let { entry["sampleRate"] = it }
                r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_BITS_PER_SAMPLE)?.toIntOrNull()?.takeIf { it > 0 && entry["lossless"] == true }?.let { entry["bitDepth"] = it }
            }
            r.embeddedPicture?.let { entry["_cover"] = it }
        } catch (e: Exception) {
            if (audioFmt == null) { entry["notSong"] = "unreadable"; return entry }
        } finally { try { r.release() } catch (_: Exception) {} }

        if (audioFmt == null && entry["duration"] == null) { entry["notSong"] = "unreadable"; return entry }
        if (entry["codec"] == null) entry["codec"] = ext.uppercase()
        // the player (with FFmpeg's decoders) plays everything that has sound in it
        entry["playable"] = true
        entry["tags"] = tags
        return entry
    }

    private fun MediaFormat.intOr(key: String): Int = try { if (containsKey(key)) getInteger(key) else 0 } catch (_: Exception) { 0 }
}

/**
 * Whether Dolby Digital Plus in an MP4 / M4A carries Atmos: the 'dec3' box inside the song's description
 * (moov › trak › mdia › minf › stbl › stsd › ec-3) ends with a flag for it (ETSI TS 102 366, annex F).
 */
object Dec3 {
    private val containers = setOf("moov", "trak", "mdia", "minf", "stbl")

    fun isAtmos(file: File): Boolean = try {
        RandomAccessFile(file, "r").use { f -> find(f, 0, f.length(), 0) ?: false }
    } catch (_: Exception) { false }

    private fun find(f: RandomAccessFile, start: Long, end: Long, depth: Int): Boolean? {
        var pos = start
        while (pos + 8 <= end && depth < 8) {
            f.seek(pos)
            var size = f.readInt().toLong() and 0xffffffffL
            val type = ByteArray(4).also { f.readFully(it) }.toString(Charsets.ISO_8859_1)
            var header = 8L
            if (size == 1L) { size = f.readLong(); header = 16 } else if (size == 0L) size = end - pos
            if (size < header) return null
            when {
                type in containers -> find(f, pos + header, pos + size, depth + 1)?.let { return it }
                type == "stsd" -> find(f, pos + header + 8, pos + size, depth + 1)?.let { return it } // (version, flags, count)
                type == "ec-3" -> find(f, pos + header + 28, pos + size, depth + 1)?.let { return it } // (an audio sample entry's fields)
                type == "dec3" -> return parse(ByteArray((size - header).toInt().coerceAtMost(64)).also { f.seek(pos + header); f.readFully(it) })
            }
            pos += size
        }
        return null
    }

    private fun parse(b: ByteArray): Boolean {
        var bit = 0
        fun read(n: Int): Int {
            var v = 0
            repeat(n) {
                if (bit / 8 >= b.size) return -1
                v = (v shl 1) or ((b[bit / 8].toInt() shr (7 - bit % 8)) and 1); bit++
            }
            return v
        }
        read(13) // data rate
        val subs = read(3) + 1
        repeat(subs) {
            read(2); read(5); read(1); read(1); read(3); read(3); read(1); read(3) // fscod bsid … lfeon reserved
            val dep = read(4)
            if (dep > 0) read(9) else read(1)
        }
        if (bit + 8 > b.size * 8) return false
        read(7)
        return read(1) == 1 // flag_ec3_extension_type_a: Joint Object Coding (Atmos)
    }
}
