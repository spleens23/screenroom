package com.screenroom.parlor

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Finds the songs in Parlor's folders and describes each one (Probe). Results are cached by path + modified
 * time + size, so opening Parlor reads only new or changed files, and only when something changed at all.
 * (The same as the iPhone's Scanner.swift.)
 */
object Scanner {
    private const val CACHE = "scan-music-4"
    @Volatile private var busy = false
    @Volatile private var started = 0L
    private val prober = Executors.newCachedThreadPool()

    // ---- walking the folders ------------------------------------------------------------------------------------
    private fun walk(each: (File) -> Unit) {
        val seen = HashSet<String>()
        for (root in listOf(Storage.docs) + Storage.linked) {
            val stack = ArrayDeque<File>().apply { add(root) }
            while (stack.isNotEmpty()) {
                val dir = stack.removeLast()
                val kids = dir.listFiles() ?: continue
                for (f in kids) {
                    val name = f.name
                    if (name.startsWith(".") || name == ".Trash") continue
                    if (f.isDirectory) {
                        // (Android's own folders inside the phone's storage aren't music)
                        if (name == "Android" && dir.path == "/storage/emulated/0") continue
                        stack.add(f)
                    } else if (seen.add(Storage.canonical(f))) each(f)
                }
            }
        }
    }

    private fun files(exts: Set<String>): List<File> {
        val out = ArrayList<File>()
        walk { f -> if (f.extension.lowercase() in exts) out.add(f) }
        return out.sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.path })
    }

    /** A quick fingerprint of everything (names, sizes and dates; nothing is opened). */
    fun musicSignature(): String {
        val parts = ArrayList<String>()
        walk { f ->
            val ext = f.extension.lowercase()
            if (ext in audioExtensions || ext in boxExtensions || ext in imageExtensions) parts.add("${Storage.relativeToDocs(f)}|${f.length()}|${f.lastModified() / 1000}")
        }
        parts.sort()
        return sha1Hex(parts.joinToString("\n"))
    }

    fun musicChanged(): Boolean = Storage.readJson("scan-music-sig").asMap()?.get("sig") != musicSignature()

    @Suppress("UNCHECKED_CAST")
    private fun readCache(): Map<String, Map<String, Any?>> =
        (Storage.readJson(CACHE).asMap() ?: emptyMap()).mapNotNull { (k, v) -> (v as? Map<String, Any?>)?.let { k to it } }.toMap()

    private fun unchanged(hit: Map<String, Any?>, f: File): Boolean =
        Math.abs((hit["mtime"].asNum() ?: -1.0) - f.lastModified().toDouble()) < 1500 && (hit["size"].asNum()?.toLong() == f.length())

    // ---- songs ------------------------------------------------------------------------------------------------------
    fun scanAudio(cacheOnly: Boolean, deep: Boolean, progress: (Int, Int) -> Unit): List<Map<String, Any?>> {
        val list = (files(audioExtensions) + files(boxExtensions).filter { !isMotionCover(it.name) })
            .sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.path })
        val stillBusy = busy && System.currentTimeMillis() - started < 240_000
        if (cacheOnly || stillBusy) {
            val old = readCache()
            return list.mapNotNull { old[it.path] }.filter { it["notSong"] == null }
        }
        busy = true; started = System.currentTimeMillis()
        try {
            val began = System.currentTimeMillis()
            val cache = if (deep) emptyMap() else readCache()
            val saved = readCache()
            val next = LinkedHashMap<String, Map<String, Any?>>()
            val skipped = ArrayList<Map<String, Any?>>()
            val dirArt = HashMap<String, String>()
            val dirCover = HashMap<String, String?>()
            val dirMotion = HashMap<String, String?>()
            val motionNotes = ArrayList<Map<String, Any?>>()
            var probed = 0; var savedAt = 0; var done = 0
            val fresh = { f: File ->
                cache[f.path]?.takeIf { unchanged(it, f) }?.let { hit ->
                    val why = hit["notSong"] as? String
                    if (why != null) (if (why == "timeout") null else hit) else if (hit["channels"] != null) hit else null
                }
            }
            val hits = list.mapNotNull { f -> fresh(f)?.let { f.path to it } }.toMap()
            val toRead = list.size - hits.size
            for (f in list) {
                if (probed - savedAt >= 15) {
                    savedAt = probed
                    Storage.writeJson(CACHE, saved + next)
                }
                var entry: MutableMap<String, Any?>
                val hit = hits[f.path]
                if (hit != null) entry = hit.toMutableMap()
                else {
                    probed++
                    // (one odd file can't hold the whole scan up: after 25 seconds it's left out and noted)
                    val mtime = f.lastModified().toDouble(); val size = f.length()
                    val job = prober.submit<MutableMap<String, Any?>> { Probe.audio(f, mtime, size) }
                    entry = try { job.get(25, TimeUnit.SECONDS) } catch (e: Exception) {
                        job.cancel(true)
                        mutableMapOf("id" to "", "path" to f.path, "mtime" to mtime, "size" to size, "channels" to 0, "notSong" to "timeout")
                    }
                }
                val why = entry["notSong"] as? String
                if (why != null) {
                    if (why != "timeout") next[f.path] = entry
                    skipped.add(mapOf("file" to f.name, "folder" to (f.parentFile?.name ?: ""), "why" to why))
                    if (hit == null) done++
                    continue
                }
                val dir = f.parentFile ?: continue
                val dk = dir.path
                if (dk !in dirCover) dirCover[dk] = folderCover(dir)
                entry["folderArt"] = dirCover[dk]
                if (dk !in dirMotion) {
                    // in the album's folder, or the one above it (an album with Disc 1 / Disc 2 folders)
                    var m = folderMotion(dir)
                    val up = dir.parentFile
                    val roots = listOf(Storage.music) + Storage.linked
                    if (m == null && up != null && roots.none { Storage.canonical(it) == Storage.canonical(up) } && roots.any { Storage.isInside(up.path, it) }) m = folderMotion(up)
                    if (m != null) motionNotes.add(mapOf("album" to dir.name, "file" to File(m).name, "path" to m, "status" to "plays", "detail" to ""))
                    dirMotion[dk] = m
                }
                entry["folderMotion"] = dirMotion[dk]
                val cover = entry.remove("_cover") as? ByteArray
                if (cover != null && dk !in dirArt) {
                    val dest = File(Storage.art, "${sha1Hex(Storage.relativeToDocs(dir)).take(16)}-album.jpg")
                    saveJpeg(cover, 600, dest)?.let { dirArt[dk] = it }
                }
                if (entry["art"] == null) dirArt[dk]?.let { entry["art"] = it }
                next[f.path] = entry
                if (hit == null) { done++; if (done % 5 == 0 || done == toRead) progress(done, toRead) }
            }
            // songs read before their folder's cover was found
            for ((p, e) in next.entries.toList()) if (e["art"] == null) dirArt[File(p).parent ?: ""]?.let { next[p] = e + ("art" to it) }
            Storage.writeJson(CACHE, next)
            Storage.writeJson("motion-report", motionNotes)
            Storage.writeJson("scan-music-sig", mapOf("sig" to musicSignature()))
            val songs = list.mapNotNull { next[it.path] }.filter { it["notSong"] == null }
            val perFolder = list.groupingBy { Storage.relativeToDocs(it.parentFile ?: it) }.eachCount()
            val folders = perFolder.entries.sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.key }).take(400).map { mapOf("dir" to it.key, "n" to it.value) }
            var everything = 0
            Storage.docs.walkTopDown().forEach { if (it.isFile) everything++ }
            Storage.writeJson("scan-report", mapOf("at" to System.currentTimeMillis().toDouble(), "seconds" to (System.currentTimeMillis() - began) / 1000.0,
                "deep" to deep, "files" to list.size, "songs" to songs.size, "read" to probed, "skipped" to skipped, "folders" to folders,
                "everything" to everything, "where" to Storage.docs.path))
            return songs
        } finally { busy = false }
    }

    /** An album's moving cover in its folder (cover.mp4 …). */
    fun folderMotion(dir: File): String? = dir.list()?.sorted()?.firstOrNull { !it.startsWith(".") && isMotionCover(it) }?.let { File(dir, it).path }

    /** The album's cover picture in its folder: cover.jpg, folder.jpg, front.jpg … */
    fun folderCover(dir: File): String? {
        val imgs = dir.list()?.filter { !it.startsWith(".") && it.substringAfterLast('.', "").lowercase() in setOf("jpg", "jpeg", "png", "webp", "gif", "bmp") } ?: return null
        val base = { n: String -> n.substringBeforeLast('.').lowercase() }
        for (want in listOf("cover", "folder", "front", "album", "albumart", "albumartsmall")) imgs.firstOrNull { base(it) == want }?.let { return File(dir, it).path }
        fun score(n: String): Int {
            val b = base(n); var s = 0
            if ("front" in b || "cover" in b || "folder" in b) s += 4
            if ("albumart" in b) s += 1
            if (listOf("back", "cd", "disc", "inlay", "inside", "booklet", "tray", "label", "spine", "small").any { it in b }) s -= 3
            return s
        }
        val ranked = imgs.map { it to score(it) }.sortedByDescending { it.second }
        val top = ranked.firstOrNull() ?: return null
        return if (top.second > 0 || ranked.size == 1) File(dir, top.first).path else null
    }

    fun listImages(dir: String): List<String> {
        if (!Storage.isMine("$dir/x")) return emptyList()
        return File(dir).list()?.filter { it.substringAfterLast('.', "").lowercase() in imageExtensions }?.map { File(dir, it).path } ?: emptyList()
    }
}

/** A picture saved as a JPEG no wider than `width`. Returns its path. */
fun saveJpeg(bytes: ByteArray, width: Int, dest: File, quality: Int = 85): String? = try {
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.let { saveBitmap(it, width, dest, quality) }
} catch (_: Throwable) { null }

fun saveBitmap(bmp: Bitmap, width: Int, dest: File, quality: Int = 85): String? = try {
    val out = if (bmp.width > width) Bitmap.createScaledBitmap(bmp, width, maxOf(1, bmp.height * width / bmp.width), true) else bmp
    dest.parentFile?.mkdirs()
    FileOutputStream(dest).use { out.compress(Bitmap.CompressFormat.JPEG, quality, it) }
    dest.path
} catch (_: Throwable) { null }
