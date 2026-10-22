package com.screenroom.tv

import android.content.Context
import android.os.Build
import android.os.Environment
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.SecureRandom

/**
 * Everything Screenroom remembers, as small JSON files in the app's private folder:
 * config.json (settings), progress.json (where you stopped watching), library.json (scan cache).
 */
class Store(private val ctx: Context) {
    private val dir = ctx.filesDir
    private val cfgFile = File(dir, "config.json")
    private val libFile = File(dir, "library.json")
    val artDir = File(dir, "art").apply { mkdirs() }

    @Volatile var config: JSONObject = readObj(cfgFile).let { withDefaults(it) }
        private set
    // ---- profiles: progress belongs to whoever is watching -------------------------------------------
    val profiles = Profiles(dir)
    @Volatile var currentId: String = profiles.last().optString("id")
        private set
    /** Show "Who's watching?" (more than one profile, or a PIN). */
    @Volatile var needPick: Boolean = profiles.needsPicker()
    @Volatile var progress: JSONObject = readObj(profiles.progressFile(currentId))
        private set

    fun currentProfile(): JSONObject? = profiles.public(profiles.get(currentId))

    @Synchronized fun selectProfile(id: String) {
        currentId = id
        progress = readObj(profiles.progressFile(id))
        needPick = false
        profiles.setLast(id)
    }

    @Synchronized fun afterProfileDeleted(id: String) {
        forgetRatings(id)
        forgetRecs(id)
        if (id == currentId) {
            currentId = profiles.last().optString("id")
            progress = readObj(profiles.progressFile(currentId))
            needPick = profiles.needsPicker()
        }
    }
    /** path -> raw scan entry {id, path, mtime, size, probe, art, backdrop} */
    @Volatile var library: JSONObject = readObj(libFile)
        private set

    private fun withDefaults(c: JSONObject): JSONObject {
        if (!c.has("dirs")) c.put("dirs", JSONArray())
        if (!c.has("remote")) c.put("remote", true)
        if (!c.has("remotePort")) c.put("remotePort", 8686)
        if (!c.has("preferredLang")) c.put("preferredLang", "eng")
        if (!c.has("subLang")) c.put("subLang", "")
        if (!c.optString("remotePin").matches(Regex("\\d{4,8}"))) {
            c.put("remotePin", (1000 + SecureRandom().nextInt(9000)).toString())
            writeObj(cfgFile, c)
        }
        return c
    }

    @Synchronized fun saveConfig() = writeObj(cfgFile, config)

    @Synchronized fun patchConfig(patch: JSONObject) {
        val keys = patch.keys()
        while (keys.hasNext()) { val k = keys.next(); config.put(k, patch.get(k)) }
        saveConfig()
    }

    fun dirs(): List<String> {
        val a = config.optJSONArray("dirs") ?: JSONArray()
        return (0 until a.length()).map { a.getString(it) }
    }

    @Synchronized fun setDirs(list: List<String>) {
        config.put("dirs", JSONArray(list.distinct()))
        saveConfig()
    }

    // ---- where uploads and copies go ----------------------------------------------------------------------
    @Volatile var mediaDir: File = defaultMediaDir()
        private set

    fun canManageAllFiles(): Boolean =
        Build.VERSION.SDK_INT < 30 || Environment.isExternalStorageManager()

    private fun defaultMediaDir(): File {
        config.optString("mediaDir").takeIf { it.isNotBlank() }?.let { return File(it) }
        return if (canManageAllFiles()) File(Environment.getExternalStorageDirectory(), "Screenroom")
        else File(ctx.getExternalFilesDir(null) ?: ctx.filesDir, "Media")
    }

    fun ensureMediaDir() {
        mediaDir = defaultMediaDir()
        mediaDir.mkdirs()
        val path = mediaDir.absolutePath
        val dirs = dirs()
        if (dirs.none { path == it || path.startsWith("$it/") }) setDirs(dirs + path)
    }

    // ---- watch progress -------------------------------------------------------------------------------------
    @Synchronized fun setProgress(id: String, pos: Double, dur: Double, done: Boolean) {
        val o = JSONObject().put("pos", pos).put("dur", dur).put("updated", System.currentTimeMillis())
        if (done) o.put("done", true)
        progress.put(id, o)
        writeObj(profiles.progressFile(currentId), progress)
    }

    @Synchronized fun setWatched(ids: JSONArray, watched: Boolean) {
        for (i in 0 until ids.length()) {
            val id = ids.getString(i)
            if (watched) {
                val prev = progress.optJSONObject(id)
                val dur = prev?.optDouble("dur", 0.0) ?: 0.0
                progress.put(id, JSONObject().put("pos", 0).put("dur", dur).put("updated", System.currentTimeMillis()).put("done", true))
            } else progress.remove(id)
        }
        writeObj(profiles.progressFile(currentId), progress)
    }

    // ---- star ratings, shared by every profile (see lib/ratings.js on the desktop) --------------------------
    private val ratingsFile = File(dir, "ratings.json")
    @Volatile private var ratings: JSONObject = readObj(ratingsFile)

    @Synchronized fun rate(key: String, stars: Int) {
        val k = key.take(300)
        if (k.isEmpty() || stars !in 0..5) return
        val entry = ratings.optJSONObject(k) ?: JSONObject()
        if (stars > 0) entry.put(currentId, JSONObject().put("stars", stars).put("at", System.currentTimeMillis())) else entry.remove(currentId)
        if (entry.length() == 0) ratings.remove(k) else ratings.put(k, entry)
        writeObj(ratingsFile, ratings)
    }

    @Synchronized fun forgetRatings(pid: String) {
        val keys = ratings.keys().asSequence().toList()
        for (k in keys) { val e = ratings.optJSONObject(k) ?: continue; e.remove(pid); if (e.length() == 0) ratings.remove(k) }
        writeObj(ratingsFile, ratings)
    }

    // ---- the house: who's watched what, and recommendations (see lib/social.js on the desktop) --------------
    /** { itemId: [profile ids that finished it] } */
    fun watchedBy(): JSONObject {
        val out = JSONObject()
        val list = profiles.list()
        for (i in 0 until list.length()) {
            val pid = list.getJSONObject(i).optString("id")
            val prog = if (pid == currentId) progress else readObj(profiles.progressFile(pid))
            for (id in prog.keys()) {
                val v = prog.optJSONObject(id) ?: continue
                val dur = v.optDouble("dur", 0.0)
                if (v.optBoolean("done") || (dur > 0 && v.optDouble("pos", 0.0) / dur > 0.9)) {
                    (out.optJSONArray(id) ?: JSONArray().also { out.put(id, it) }).put(pid)
                }
            }
        }
        return out
    }

    private val recsFile = File(dir, "recommendations.json")
    @Volatile private var recs: JSONArray = try { JSONArray(recsFile.readText()) } catch (_: Throwable) { JSONArray() }
    private fun saveRecs() {
        val tmp = File(dir, "recommendations.json.tmp")
        tmp.writeText(recs.toString())
        if (!tmp.renameTo(recsFile)) { recsFile.delete(); tmp.renameTo(recsFile) }
    }
    private fun recList(): List<JSONObject> = (0 until recs.length()).mapNotNull { recs.optJSONObject(it) }

    @Synchronized fun recommend(to: JSONArray, item: JSONObject) {
        val key = item.optString("key").take(300)
        val kind = item.optString("kind")
        if (key.isEmpty() || kind !in setOf("movie", "series", "album")) return
        var list = recList()
        for (i in 0 until to.length()) {
            val pid = to.optString(i)
            if (pid.isEmpty() || pid == currentId || profiles.get(pid) == null) continue
            list = list.filter { !(it.optString("from") == currentId && it.optString("to") == pid && it.optString("key") == key) } +
                JSONObject().put("id", java.lang.Long.toHexString(SecureRandom().nextLong())).put("from", currentId).put("to", pid)
                    .put("key", key).put("kind", kind).put("name", item.optString("name").take(120)).put("at", System.currentTimeMillis())
        }
        recs = JSONArray(list.takeLast(600))
        saveRecs()
    }

    @Synchronized fun dismissRec(id: String) {
        recs = JSONArray(recList().filter { !(it.optString("id") == id && it.optString("to") == currentId) })
        saveRecs()
    }

    @Synchronized fun forgetRecs(pid: String) {
        recs = JSONArray(recList().filter { it.optString("from") != pid && it.optString("to") != pid })
        saveRecs()
    }

    /** Movie night: the vote runs in the web UI, which hands its state here for the phones. */
    @Volatile var voteBlob: JSONObject? = null

    // ---- playback problems (shown in Settings so they can be reported) ---------------------------------------
    private val problemsFile = File(dir, "playback-problems.json")

    @Synchronized fun addProblem(title: String, code: String, details: String) {
        val old = try { JSONArray(problemsFile.readText()) } catch (_: Throwable) { JSONArray() }
        val next = JSONArray().put(JSONObject().put("at", System.currentTimeMillis()).put("title", title).put("code", code).put("details", details))
        for (i in 0 until minOf(old.length(), 9)) next.put(old.get(i))
        problemsFile.writeText(next.toString())
    }

    fun problems(): JSONArray = try { JSONArray(problemsFile.readText()) } catch (_: Throwable) { JSONArray() }

    @Synchronized fun clearProblems() { problemsFile.delete() }

    @Synchronized fun saveLibrary(next: JSONObject) {
        library = next
        writeObj(libFile, next)
    }

    // ---- what the web UI asks for -------------------------------------------------------------------------
    fun snapshot(): JSONObject {
        val lib = JSONArray()
        val keys = library.keys()
        while (keys.hasNext()) lib.put(library.getJSONObject(keys.next()))
        val s = JSONObject()
            .put("library", lib)
            .put("progress", progress)
            .put("config", config)
            .put("tv", true)
            .put("platform", "android")
            .put("mpvFound", true)
            .put("ffprobeFound", true)
            .put("drives", Drives.toJson(Drives.current))
            .put("mediaDir", mediaDir.absolutePath)
            .put("profile", currentProfile())
            .put("profiles", profiles.list())
            .put("pickProfile", needPick)
            .put("playbackProblems", problems())
            .put("ratings", ratings)
            .put("recs", recs)
            .put("watchedBy", watchedBy())
        if (!canManageAllFiles()) {
            s.put("storageWarning", "Screenroom can only see video files on drives, not subtitles, and uploads are kept inside the app. " +
                "Run the setup script once (it grants full file access) to fix this.")
        }
        return s
    }

    companion object {
        fun readObj(f: File): JSONObject = try { JSONObject(f.readText()) } catch (_: Throwable) { JSONObject() }

        fun writeObj(f: File, o: JSONObject) {
            val tmp = File(f.parentFile, f.name + ".tmp")
            tmp.writeText(o.toString())
            if (!tmp.renameTo(f)) { f.delete(); tmp.renameTo(f) }
        }
    }
}
