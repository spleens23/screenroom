package com.screenroom.phone

import android.content.Context
import android.os.Environment
import android.os.StatFs
import java.io.File

/**
 * Where everything lives (as on the iPhone):
 *  - docs: Parlor's own folder (songs imported with the Import button land in docs/Music);
 *  - linked: music folders on the phone read where they are (the phone's Music folder, and any folder picked);
 *  - data: Parlor's small JSON files, cover art and profile pictures.
 */
object Storage {
    /** Which app this is: "parlor" (music) or "screenroom" (films). The same code builds both. */
    var kind = "parlor"; private set
    val isParlor get() = kind == "parlor"
    lateinit var docs: File; private set
    lateinit var music: File; private set
    lateinit var films: File; private set
    lateinit var data: File; private set
    lateinit var art: File; private set
    lateinit var avatars: File; private set
    private val lock = Any()
    private var linkedNow: List<File> = emptyList()

    fun prepare(ctx: Context) {
        if (::docs.isInitialized) return
        kind = ctx.getString(R.string.app_kind)
        docs = ctx.getExternalFilesDir(null) ?: File(ctx.filesDir, "Documents")
        music = File(docs, "Music")
        films = File(docs, "Films")
        data = File(ctx.filesDir, if (isParlor) "Parlor" else "Screenroom")
        art = File(data, "art")
        avatars = File(data, "avatars")
        for (d in listOf(if (isParlor) music else films, data, art, avatars)) d.mkdirs()
        loadLinked()
    }

    // ---- music folders read where they are -------------------------------------------------------------------
    val linked: List<File> get() = synchronized(lock) { linkedNow }

    /** The phone's own Music folder (Parlor) or Movies folder (Screenroom), in its shared storage. */
    val phoneFolder: File get() = Environment.getExternalStoragePublicDirectory(if (isParlor) Environment.DIRECTORY_MUSIC else Environment.DIRECTORY_MOVIES)

    private fun loadLinked() {
        val saved = readJson("linked-folders").asList()?.mapNotNull { it as? String }
        val list = if (saved == null) {
            // the first time: the phone's Music folder is Parlor's, its Movies folder Screenroom's (what's put there
            // shows up by itself)
            listOf(phoneFolder.absolutePath).also { writeJson("linked-folders", it) }
        } else saved
        synchronized(lock) { linkedNow = list.map(::File) }
    }

    /** Keep a folder (picked in the system's folder picker). Returns its path. */
    fun link(dir: File): String {
        if (!dir.isDirectory) throw ParlorError("${if (isParlor) "Parlor" else "Screenroom"} can't open that folder. Is it allowed to use all files (Settings › Apps › Parlor › Permissions)?")
        if (isInside(dir.path + "/x", docs)) throw ParlorError("That's Parlor's own folder; it's read already.")
        synchronized(lock) {
            if (linkedNow.none { canonical(it) == canonical(dir) }) linkedNow = linkedNow + dir
            writeJson("linked-folders", linkedNow.map { it.path })
        }
        return dir.path
    }

    fun unlink(path: String) {
        synchronized(lock) {
            linkedNow = linkedNow.filter { canonical(it) != canonical(File(path)) }
            writeJson("linked-folders", linkedNow.map { it.path })
        }
    }

    /** Inside Parlor's own folder or one of the folders it reads where they are. */
    fun isMine(path: String): Boolean = isInside(path, docs) || linked.any { isInside(path, it) }

    /** Files the page may show: songs and covers in those folders, and Parlor's own cover art and pictures. */
    fun mayServe(path: String): Boolean = isMine(path) || isInside(path, data)

    // ---- small JSON files --------------------------------------------------------------------------------------
    private val nameOk = Regex("^[a-z0-9-]{1,48}$")
    private fun jsonFile(name: String): File? = if (nameOk.matches(name)) File(data, "$name.json") else null

    fun readJson(name: String): Any? {
        val f = jsonFile(name) ?: return null
        return try { if (f.exists()) parseJson(f.readText()) else null } catch (_: Exception) { null }
    }

    fun writeJson(name: String, value: Any?) {
        val f = jsonFile(name) ?: throw ParlorError("Bad name")
        synchronized(lock) {
            val tmp = File(f.parentFile, ".${f.name}.tmp")
            tmp.writeText(toJson(value))
            if (!tmp.renameTo(f)) { f.delete(); tmp.renameTo(f) }
        }
    }

    // ---- files ---------------------------------------------------------------------------------------------------
    fun freeSpace(): Long = try { StatFs(docs.path).availableBytes } catch (_: Exception) { 0 }

    /** A path inside Parlor's folder, for ids that stay the same if the folder moves. */
    fun relativeToDocs(f: File): String {
        val p = f.absolutePath; val d = docs.absolutePath
        return if (p.startsWith("$d/")) p.substring(d.length + 1) else p
    }

    fun canonical(f: File): String = try { f.canonicalPath } catch (_: Exception) { f.absolutePath }
    fun isInside(path: String, dir: File): Boolean = canonical(File(path)).startsWith(canonical(dir) + "/")

    /** Delete songs (and anything else of Parlor's the page asks for), then folders left with nothing but covers. */
    fun deleteFiles(paths: List<String>): Pair<Int, Long> {
        var removed = 0; var freed = 0L
        val dirs = mutableSetOf<File>()
        for (p in paths) {
            if (!(isMine(p) || isInside(p, avatars))) continue
            val f = File(p)
            val size = f.length()
            if (f.isFile && f.delete()) {
                removed++; freed += size; f.parentFile?.let { dirs.add(it) }
                // subtitles next to a film: Film.srt, Film.en.srt …
                val base = f.nameWithoutExtension
                f.parentFile?.listFiles()?.filter { it.name.startsWith("$base.") && it.extension.lowercase() in setOf("srt", "vtt", "ass", "ssa", "sub", "idx") }?.forEach { it.delete() }
            }
        }
        for (start in dirs) {
            var d: File? = start
            while (d != null && isMine(d.path + "/x") && linked.none { canonical(it) == canonical(d!!) } && canonical(d) != canonical(music) && canonical(d) != canonical(films) && canonical(d) != canonical(docs)) {
                val keep = d.list()?.filter { !it.startsWith(".") && it.substringAfterLast('.', "").lowercase() !in setOf("jpg", "jpeg", "png", "webp", "txt", "nfo") } ?: emptyList()
                if (keep.isNotEmpty()) break
                d.deleteRecursively()
                d = d.parentFile
            }
        }
        return removed to freed
    }

    /** A free name in a folder: "Song.m4a", then "Song 2.m4a" … */
    fun freeName(dir: File, name: String): File {
        var f = File(dir, name)
        val base = name.substringBeforeLast('.'); val ext = name.substringAfterLast('.', "")
        var n = 2
        while (f.exists()) { f = File(dir, if (ext.isEmpty()) "$base $n" else "$base $n.$ext"); n++ }
        return f
    }
}
