package com.screenroom.phone

import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.webkit.JavascriptInterface
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * What the page's window.api (ios-api.js, shared with the iPhone) asks the app to do: the same calls the iPhone
 * app answers (Bridge.swift), each answered with JSON; events (scan progress, the player) go to the page as
 * they happen.
 */
class Bridge(private val act: MainActivity) {
    companion object { @Volatile var current: Bridge? = null }
    init { current = this }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val importer = Importer(act)

    /** The page's side: window.SRAndroid. */
    val js = JS()
    inner class JS {
        @JavascriptInterface fun kind(): String = Storage.kind
        @JavascriptInterface fun log(line: String) = pageLog(line)
        @JavascriptInterface fun post(message: String) {
            val m = (try { parseJson(message) } catch (_: Exception) { null }).asMap() ?: return
            val id = m["id"].asNum()?.toInt() ?: return
            val method = m["method"] as? String ?: return
            if (method == "debugLog") { pageLog(((m["args"] as? String)?.let { parseJson(it) }.asList()?.firstOrNull() as? String) ?: ""); return }
            val args = (m["args"] as? String)?.let { try { parseJson(it).asList() } catch (_: Exception) { null } } ?: emptyList()
            scope.launch {
                val value: Any? = try { handle(method, args) } catch (e: Throwable) {
                    android.util.Log.w("Parlor", "$method failed", e)
                    mapOf("__error" to (e.message ?: e.toString()))
                }
                reply(id, value)
            }
        }
    }

    private fun pageLog(line: String) {
        android.util.Log.i("Parlor", "page: $line")
        try {
            val f = File(act.cacheDir, "page-errors.log")
            if (f.length() > 200_000) f.delete()
            f.appendText(line + "\n")
        } catch (_: Exception) {}
    }

    private fun reply(id: Int, value: Any?) = run("window.__iosReply && window.__iosReply($id, ${toJson(toJson(value))})")

    // (an event before the page is ready, as the app opens, is dropped: the page asks for everything as it starts)
    fun emit(name: String, payload: Any?) = run("window.__iosEvent && window.__iosEvent(${toJson(name)}, ${toJson(toJson(payload))})")

    private fun run(js: String) { act.runOnUiThread { act.web.evaluateJavascript(js, null) } }

    @Suppress("UNCHECKED_CAST")
    private fun <T> arg(a: List<Any?>, i: Int): T? = a.getOrNull(i) as? T
    private suspend fun <T> io(block: () -> T): T = withContext(Dispatchers.IO) { block() }

    private suspend fun handle(m: String, a: List<Any?>): Any? {
        val st = Storage
        return when (m) {
            "boot" -> mapOf("docs" to st.docs.path, "films" to st.films.path, "music" to st.music.path, "data" to st.data.path,
                "art" to st.art.path, "avatars" to st.avatars.path, "device" to "Android")
            "exists" -> arg<String>(a, 0)?.let { File(it).exists() } ?: false
            "readJson" -> arg<String>(a, 0)?.let { io { st.readJson(it) } }
            "writeJson" -> { val n = arg<String>(a, 0) ?: return false; io { st.writeJson(n, a.getOrNull(1)) }; true }
            "scanVideos" -> {
                if (st.isParlor) return emptyList<Any>() // (Parlor is music only)
                val o = arg<Map<String, Any?>>(a, 0)
                if (!act.hasFiles() && o?.get("cacheOnly") != true) emit("notice", "Screenroom can't see your films yet: allow it to manage all files (Settings › Apps › Screenroom)")
                io { VideoScanner.scan(o?.get("cacheOnly") == true, o?.get("deep") == true) { done, total -> emit("scan-progress", mapOf("done" to done, "total" to total)) } }
            }
            "videosChanged" -> if (st.isParlor) false else io { VideoScanner.changed() }
            "scanAudio" -> {
                if (!st.isParlor) return emptyList<Any>() // (Screenroom is films only: music is Parlor's)
                val o = arg<Map<String, Any?>>(a, 0)
                if (!act.hasFiles() && o?.get("cacheOnly") != true) emit("notice", "Parlor can't see your music yet: allow it to manage all files (Settings › Apps › Parlor)")
                io { Scanner.scanAudio(o?.get("cacheOnly") == true, o?.get("deep") == true) { done, total -> emit("scan-progress", mapOf("done" to done, "total" to total, "music" to true)) } }
            }
            "musicChanged" -> if (st.isParlor) io { Scanner.musicChanged() } else false
            "sha256" -> sha256Hex(arg<String>(a, 0) ?: "")
            "random" -> randomHex(arg<Number>(a, 0)?.toInt() ?: 8)
            "statusBar" -> { act.setStatusBar(arg<String>(a, 0) == "dark"); null }
            "linkMusicFolder" -> {
                // a folder picked in Android's folder picker, read where it is
                val r = act.pick(Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)) ?: return null
                val dir = treePath(r.data ?: return null) ?: throw ParlorError("Parlor can only read folders on this phone or its memory card.")
                st.link(dir)
            }
            "linkPathForTest" -> if (act.isDebuggable) st.link(File(arg<String>(a, 0) ?: "")) else throw ParlorError("Not in this build.")
            "linkedFolders" -> st.linked.map { it.path }
            "unlinkFolder" -> { st.unlink(arg<String>(a, 0) ?: ""); true }
            "showInFiles" -> { openFiles(); true }
            "playVideo" -> {
                if (st.isParlor) throw ParlorError("Parlor plays music only.")
                MusicPlayer.stop()
                PlayerActivity.pending = arg<Map<String, Any?>>(a, 0) ?: throw ParlorError("Nothing to play.")
                act.startActivity(Intent(act, PlayerActivity::class.java))
                mapOf("ok" to true)
            }
            "musicPlay" -> {
                val o = arg<Map<String, Any?>>(a, 0) ?: throw ParlorError("Nothing to play.")
                @Suppress("UNCHECKED_CAST") val tracks = (o["tracks"] as? List<Map<String, Any?>>) ?: throw ParlorError("Nothing to play.")
                MusicPlayer.bridge = this
                MusicPlayer.play(tracks, o["start"].asNum()?.toInt() ?: 0, o["context"])
                mapOf("ok" to true)
            }
            "musicCmd" -> { MusicPlayer.bridge = this; MusicPlayer.command(arg<String>(a, 0) ?: "", a.getOrNull(1)) }
            "importFiles" -> mapOf("count" to importer.importFiles())
            "pickPhoto" -> importer.pickPhoto(arg(a, 0), arg(a, 1))
            "pickMotion" -> importer.pickMotion(arg(a, 0) ?: "", arg(a, 1) ?: "photos")
            "deleteFiles" -> {
                @Suppress("UNCHECKED_CAST") val paths = (a.getOrNull(0) as? List<String>) ?: emptyList()
                val (removed, freed) = io { st.deleteFiles(paths) }
                mapOf("removed" to removed, "freed" to freed)
            }
            "freeSpace" -> st.freeSpace()
            "listImages" -> Scanner.listImages(arg(a, 0) ?: "")
            "httpGetJson" -> {
                val s = arg<String>(a, 0) ?: throw ParlorError("Bad address")
                if (!s.startsWith("https://")) throw ParlorError("Bad address")
                io { parseJson(get(s).toString(Charsets.UTF_8)) }
            }
            "download" -> {
                val s = arg<String>(a, 0) ?: ""; val dest = arg<String>(a, 1) ?: ""
                val host = try { Uri.parse(s).host ?: "" } catch (_: Exception) { "" }
                if (!s.startsWith("https://") || !host.endsWith(".mzstatic.com") || !st.isMine(dest)) throw ParlorError("Bad address")
                io {
                    val bytes = get(s)
                    if (android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size) == null) throw ParlorError("That isn't a picture.")
                    File(dest).writeBytes(bytes)
                }
                dest
            }
            "sonosRooms" -> {
                val rooms = io { Sonos.findRooms(act) }
                mapOf("rooms" to rooms.map { it.json }, "using" to (MusicPlayer.sonosId ?: ""))
            }
            "sonosUse" -> {
                MusicPlayer.bridge = this
                val id = arg<String>(a, 0) ?: ""
                if (id.isEmpty()) { MusicPlayer.useSonos(null); return MusicPlayer.snapshot() }
                val room = Sonos.room(id) ?: io { Sonos.findRooms(act) }.firstOrNull { it.id == id } ?: throw ParlorError("That speaker isn't on the Wi-Fi now.")
                MusicPlayer.useSonos(room)
                MusicPlayer.snapshot()
            }
            else -> throw ParlorError("Unknown call: $m")
        }
    }

    private fun get(url: String): ByteArray {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = 12000; c.readTimeout = 12000
        c.setRequestProperty("User-Agent", "Parlor/1.0 (Android)")
        try { return c.inputStream.use { it.readBytes() } } finally { c.disconnect() }
    }

    /** A folder from the folder picker as a path: "primary:Music/Jazz" → /storage/emulated/0/Music/Jazz. */
    private fun treePath(uri: Uri): File? {
        if (uri.authority != "com.android.externalstorage.documents") return null
        val id = DocumentsContract.getTreeDocumentId(uri)
        val vol = id.substringBefore(':'); val rel = id.substringAfter(':', "")
        val base = if (vol == "primary") "/storage/emulated/0" else "/storage/$vol"
        return File(if (rel.isEmpty()) base else "$base/$rel")
    }

    /** The phone's Files app, at the Music folder. */
    private fun openFiles() {
        val doc = DocumentsContract.buildDocumentUri("com.android.externalstorage.documents", "primary:Music")
        val i = Intent(Intent.ACTION_VIEW).setDataAndType(doc, DocumentsContract.Document.MIME_TYPE_DIR).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        try { act.startActivity(i) } catch (_: Exception) {
            try { act.startActivity(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_APP_FILES)) } catch (_: Exception) {}
        }
    }
}
