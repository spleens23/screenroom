package com.screenroom.tv

import android.os.Build
import android.os.StatFs
import fi.iki.elonen.NanoHTTPD
import fi.iki.elonen.NanoHTTPD.IHTTPSession
import fi.iki.elonen.NanoHTTPD.Method
import fi.iki.elonen.NanoHTTPD.Response
import org.json.JSONArray
import org.json.JSONObject
import java.net.Inet4Address
import java.net.NetworkInterface
import java.net.URLDecoder
import java.security.MessageDigest

/**
 * The phone remote + upload page (remote/index.html, shared with the desktop app), served on the box.
 * Everything under /api needs the PIN shown in Settings, sent as an "x-pin" header.
 */
class RemoteServer(port: Int) : NanoHTTPD(port) {

    private class Code(private val code: Int, private val text: String) : Response.IStatus {
        override fun getDescription(): String = "$code $text"
        override fun getRequestStatus(): Int = code
    }

    fun begin() = start(60_000, true)

    private fun json(code: Int, body: Any): Response {
        val r = NanoHTTPD.newFixedLengthResponse(Code(code, if (code == 200) "OK" else "Error"), "application/json", body.toString())
        r.addHeader("Cache-Control", "no-store")
        return r
    }

    private fun error(code: Int, msg: String) = json(code, JSONObject().put("error", msg))

    override fun serve(session: IHTTPSession): Response {
        val uri = session.uri ?: "/"
        try {
            if (session.method == Method.GET && (uri == "/" || uri == "/index.html")) {
                val page = App.context.assets.open("web/remote/index.html").bufferedReader().use { it.readText() }
                val r = NanoHTTPD.newFixedLengthResponse(Code(200, "OK"), "text/html; charset=utf-8", page)
                r.addHeader("Cache-Control", "no-store")
                return r
            }
            // the profile characters, so the phone draws the same pictures as the TV
            if (session.method == Method.GET && uri == "/avatars.js") {
                val js = App.context.assets.open("web/renderer/avatars.js").bufferedReader().use { it.readText() }
                return NanoHTTPD.newFixedLengthResponse(Code(200, "OK"), "text/javascript; charset=utf-8", js)
            }
            if (!uri.startsWith("/api/")) return error(404, "not found")

            val pin = App.store.config.optString("remotePin")
            val given = session.headers["x-pin"] ?: ""
            if (pin.isEmpty() || !MessageDigest.isEqual(given.toByteArray(), pin.toByteArray())) {
                Thread.sleep(600) // slow down guessing
                return error(401, "wrong pin")
            }

            when {
                session.method == Method.GET && uri == "/api/library" -> return json(200, catalog)
                session.method == Method.GET && uri == "/api/ping" -> return json(200, JSONObject().put("ok", true))
                session.method == Method.GET && uri == "/api/info" -> return json(200, info())
                session.method == Method.POST && uri == "/api/rescan" -> { App.rescanSoon(500); return json(200, JSONObject().put("ok", true)) }
                session.method == Method.PUT && uri == "/api/upload" -> return upload(session)
                // ---- profile pictures and movie night ----
                session.method == Method.GET && uri == "/api/profiles" -> return json(200, profilesForPhone())
                session.method == Method.GET && uri == "/api/photo" -> return sendFile(App.store.profiles.photoPath(param(session, "profile")))
                session.method == Method.GET && uri == "/api/art" -> return sendFile(artFor(param(session, "id")))
                session.method == Method.GET && uri == "/api/vote" -> return json(200, App.store.voteBlob ?: JSONObject().put("open", false))
                session.method == Method.PUT && uri == "/api/avatar" -> return avatar(session)
            }
            if (session.method != Method.POST) return error(405, "method not allowed")

            val body = JSONObject(readBody(session).ifBlank { "{}" })
            when (uri) {
                "/api/key" -> key(body.optString("key"))
                "/api/player" -> onMain { PlayerActivity.current?.remote(body.optString("cmd")) }
                "/api/open" -> if (PlayerActivity.current == null) App.emit("remote", JSONObject().put("type", "open").put("key", body.optString("key")))
                "/api/search" -> if (PlayerActivity.current == null) App.emit("remote", JSONObject().put("type", "search").put("q", body.optString("q")))
                "/api/vote" -> if (App.store.voteBlob?.optBoolean("open") == true) App.emit("remote", JSONObject().put("type", "vote")
                    .put("profile", body.optString("profile").take(40)).put("choice", body.optString("choice").take(200)))
                "/api/text" -> if (PlayerActivity.current == null) App.emit("remote", JSONObject().put("type", "text").put("text", body.optString("text").take(200)))
                else -> return error(404, "not found")
            }
            return json(200, JSONObject().put("ok", true))
        } catch (e: Transfer.HttpError) {
            return error(e.status, e.message ?: "error")
        } catch (e: Throwable) {
            return error(400, e.message ?: e.toString())
        }
    }

    private fun onMain(fn: () -> Unit) { App.main.post { fn() } }

    private fun param(s: IHTTPSession, name: String): String =
        (s.queryParameterString ?: "").split('&').firstOrNull { it.startsWith("$name=") }?.let { URLDecoder.decode(it.substring(name.length + 1), "UTF-8") } ?: ""

    private fun sendFile(path: String?): Response {
        val f = path?.let { java.io.File(it) }?.takeIf { it.isFile } ?: return error(404, "not found")
        val type = when (f.extension.lowercase()) { "png" -> "image/png"; "webp" -> "image/webp"; "gif" -> "image/gif"; else -> "image/jpeg" }
        val r = NanoHTTPD.newFixedLengthResponse(Code(200, "OK"), type, java.io.FileInputStream(f), f.length())
        r.addHeader("Cache-Control", "max-age=300")
        return r
    }

    private fun profilesForPhone(): JSONArray {
        val list = App.store.profiles.list()
        val out = JSONArray()
        for (i in 0 until list.length()) {
            val p = list.getJSONObject(i)
            out.put(JSONObject().put("id", p.optString("id")).put("name", p.optString("name")).put("color", p.optString("color"))
                .put("kids", p.optBoolean("kids")).put("avatar", p.optString("avatar")).put("hasPhoto", p.has("photo")).put("hasPin", p.optBoolean("hasPin")))
        }
        return out
    }

    /** Only the posters of the films being voted on can be fetched. */
    private fun artFor(id: String): String? {
        val blob = App.store.voteBlob ?: return null
        val cands = blob.optJSONArray("candidates") ?: return null
        if ((0 until cands.length()).none { cands.optJSONObject(it)?.optString("art") == id }) return null
        val lib = App.store.library
        for (k in lib.keys()) {
            val e = lib.optJSONObject(k) ?: continue
            if (e.optString("id") == id) return e.optString("art").ifEmpty { e.optString("backdrop") }.ifEmpty { null }
        }
        return null
    }

    private fun avatar(s: IHTTPSession): Response {
        val len = s.headers["content-length"]?.toIntOrNull() ?: return error(411, "length required")
        if (len > 12 * 1024 * 1024) return error(413, "That picture is too big.")
        val id = param(s, "profile")
        val st = App.store
        val target = st.profiles.get(id) ?: return error(400, "Profile not found")
        if (target.has("pinHash") && !st.profiles.checkPin(id, s.headers["x-profile-pin"] ?: "")) {
            Thread.sleep(600)
            return error(400, "That profile has a PIN — type it above the buttons.")
        }
        val buf = ByteArray(len)
        var off = 0
        while (off < len) { val n = s.inputStream.read(buf, off, len - off); if (n < 0) break; off += n }
        val type = s.headers["content-type"] ?: ""
        val ext = when { "png" in type -> "png"; "webp" in type -> "webp"; "gif" in type -> "gif"; else -> "jpg" }
        val r = st.profiles.setPhoto(id, buf.copyOf(off), ext)
        if (r.optBoolean("ok")) App.emit("config-changed", null)
        return json(if (r.optBoolean("ok")) 200 else 400, r)
    }

    private fun key(k: String) {
        val p = PlayerActivity.current
        if (p != null) onMain { p.remote(k) }
        else App.emit("remote", JSONObject().put("type", "key").put("key", k))
    }

    private fun readBody(s: IHTTPSession): String {
        val len = s.headers["content-length"]?.toIntOrNull() ?: 0
        if (len > 10_000) throw Transfer.HttpError(413, "too large")
        val buf = ByteArray(len)
        var off = 0
        while (off < len) {
            val n = s.inputStream.read(buf, off, len - off)
            if (n < 0) break
            off += n
        }
        return String(buf, 0, off, Charsets.UTF_8)
    }

    private fun upload(s: IHTTPSession): Response {
        val len = s.headers["content-length"]?.toLongOrNull() ?: return error(411, "length required")
        val query = s.queryParameterString ?: ""
        val rel = query.split('&').firstOrNull { it.startsWith("path=") }?.let { URLDecoder.decode(it.substring(5), "UTF-8") } ?: ""
        val skipped = Transfer.saveUpload(App.store.mediaDir, rel, s.inputStream, len)
        App.rescanSoon(10_000) // after the last file of a batch
        return json(200, JSONObject().put("ok", true).put("skipped", skipped))
    }

    companion object {
        /** The movie / show list for the phone's Library tab (built by the web UI). */
        @Volatile var catalog: JSONArray = JSONArray()

        fun lanAddresses(): List<String> {
            val out = ArrayList<String>()
            try {
                for (nif in NetworkInterface.getNetworkInterfaces()) {
                    if (!nif.isUp || nif.isLoopback) continue
                    for (a in nif.inetAddresses) if (a is Inet4Address && !a.isLoopbackAddress) a.hostAddress?.let { out.add(it) }
                }
            } catch (_: Throwable) {}
            return out
        }

        fun info(): JSONObject {
            val st = App.store
            val port = st.config.optInt("remotePort", 8686)
            val urls = JSONArray()
            for (a in lanAddresses()) urls.put("http://$a:$port")
            val free = try { StatFs(st.mediaDir.path).availableBytes } catch (_: Throwable) { -1L }
            val drives = JSONArray()
            Drives.current.forEach { drives.put(it.label) }
            return JSONObject()
                .put("enabled", st.config.optBoolean("remote", true) && App.remote != null)
                .put("pin", st.config.optString("remotePin"))
                .put("urls", urls)
                .put("smb", JSONArray())
                .put("mediaDir", st.mediaDir.absolutePath)
                .put("free", if (free >= 0) free else JSONObject.NULL)
                .put("hostname", Build.MODEL)
                .put("drives", drives)
        }
    }
}
