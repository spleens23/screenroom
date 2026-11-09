package com.screenroom.parlor

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Handler
import android.os.Looper
import fi.iki.elonen.NanoHTTPD
import java.io.File
import java.io.FileInputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.NetworkInterface
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

// Parlor playing on Sonos speakers (as on the iPhone, Sonos.swift). The speaker is told where each song is on the
// Wi-Fi (a small web server in the app hands it the file exactly as it is on the phone: a Dolby Atmos song arrives
// as Dolby Atmos), and plays it itself; Parlor keeps the queue, and its screen and the lock screen follow the speaker.

// ---- the files, on the Wi-Fi ---------------------------------------------------------------------------------
object FileServer {
    private var server: NanoHTTPD? = null
    var port = 0; private set
    private val files = ConcurrentHashMap<String, String>()   // token → path
    private val secret = randomHex(16)

    @Synchronized fun ensureRunning() {
        if (server?.isAlive == true) return
        server?.stop()
        for (want in listOf(51400, 0)) {
            val s = object : NanoHTTPD(want) { override fun serve(session: IHTTPSession): Response = answer(session) }
            try { s.start(NanoHTTPD.SOCKET_READ_TIMEOUT, true); server = s; port = s.listeningPort; return } catch (_: Exception) {}
        }
        throw ParlorError("Parlor couldn't share songs on the Wi-Fi.")
    }

    /** The address a speaker uses for this file. `host` is the phone's own address on the speaker's network. */
    fun url(path: String, host: String): String {
        val token = sha256Hex(secret + path).take(32)
        files[token] = path
        val ext = File(path).extension.lowercase().ifEmpty { "bin" }
        return "http://$host:$port/p/$token.$ext"
    }

    private fun answer(s: NanoHTTPD.IHTTPSession): NanoHTTPD.Response {
        val token = s.uri.removePrefix("/p/").substringBefore('.')
        val path = files[token]
        val f = path?.let(::File)
        if (!s.uri.startsWith("/p/") || f == null || !f.isFile) return NanoHTTPD.newFixedLengthResponse(NanoHTTPD.Response.Status.NOT_FOUND, "text/plain", "")
        val size = f.length()
        var start = 0L; var end = size - 1; var partial = false
        s.headers["range"]?.let { r ->
            Regex("bytes=(\\d*)-(\\d*)").find(r)?.let { m ->
                val a = m.groupValues[1].toLongOrNull(); val b = m.groupValues[2].toLongOrNull()
                if (a == null && b != null) { start = maxOf(0, size - b) } else if (a != null) { start = a; if (b != null) end = minOf(b, size - 1) }
                partial = true
            }
        }
        if (start >= size || start > end) {
            return NanoHTTPD.newFixedLengthResponse(NanoHTTPD.Response.Status.RANGE_NOT_SATISFIABLE, "text/plain", "").also { it.addHeader("Content-Range", "bytes */$size") }
        }
        val len = end - start + 1
        val input: InputStream = FileInputStream(f).also { var left = start; while (left > 0) { val k = it.skip(left); if (k <= 0) break; left -= k } }
        val status = if (partial) NanoHTTPD.Response.Status.PARTIAL_CONTENT else NanoHTTPD.Response.Status.OK
        val res = if (s.method == NanoHTTPD.Method.HEAD) NanoHTTPD.newFixedLengthResponse(status, mime(f.name), "")
            else NanoHTTPD.newFixedLengthResponse(status, mime(f.name), input, len)
        res.addHeader("Accept-Ranges", "bytes")
        if (s.method == NanoHTTPD.Method.HEAD) res.addHeader("Content-Length", len.toString())
        if (partial) res.addHeader("Content-Range", "bytes $start-$end/$size")
        return res
    }

    fun mime(name: String): String = when (name.substringAfterLast('.').lowercase()) {
        "m4a", "mp4", "m4b", "aac", "alac" -> "audio/mp4"; "mp3" -> "audio/mpeg"; "flac" -> "audio/flac"; "wav" -> "audio/wav"
        "aif", "aiff" -> "audio/aiff"; "ogg", "oga" -> "audio/ogg"; "ec3", "eac3" -> "audio/eac3"; "ac3" -> "audio/ac3"
        "jpg", "jpeg" -> "image/jpeg"; "png" -> "image/png"; else -> "application/octet-stream"
    }

    /** The phone's address on the same network as `ip` (the Wi-Fi the speaker is on). */
    fun localAddress(ip: String): String? {
        val target = try { java.net.InetAddress.getByName(ip).address } catch (_: Exception) { null }
        var wifi: String? = null; var any: String? = null
        for (ni in NetworkInterface.getNetworkInterfaces()?.toList() ?: emptyList()) {
            if (!ni.isUp || ni.isLoopback) continue
            for (ia in ni.interfaceAddresses) {
                val a = ia.address as? Inet4Address ?: continue
                val bits = ia.networkPrefixLength.toInt()
                if (target != null && target.size == 4 && bits in 1..32) {
                    val mask = if (bits == 32) -1 else (-1 shl (32 - bits))
                    val x = java.nio.ByteBuffer.wrap(a.address).int; val y = java.nio.ByteBuffer.wrap(target).int
                    if ((x and mask) == (y and mask)) return a.hostAddress
                }
                if (wifi == null && ni.name.startsWith("wlan")) wifi = a.hostAddress
                if (any == null) any = a.hostAddress
            }
        }
        return wifi ?: any
    }
}

// ---- the speakers ----------------------------------------------------------------------------------------------
/** A room (or a group of rooms playing together) on the Sonos system: commands go to the group's coordinator. */
data class SonosRoom(val id: String, val name: String, val host: String, val model: String = "", val atmos: Boolean = false) {
    val ip: String get() = host.substringBefore(':')
    val json: Map<String, Any?> get() = mapOf("id" to id, "name" to name, "model" to model, "atmos" to atmos)

    fun soap(path: String, service: String, action: String, args: List<Pair<String, String>> = emptyList()): String {
        val c = URL("http://$host$path").openConnection() as HttpURLConnection
        c.connectTimeout = 6000; c.readTimeout = 8000
        c.requestMethod = "POST"; c.doOutput = true
        c.setRequestProperty("Content-Type", "text/xml; charset=\"utf-8\"")
        c.setRequestProperty("SOAPACTION", "\"urn:schemas-upnp-org:service:$service:1#$action\"")
        val inner = args.joinToString("") { "<${it.first}>${Sonos.esc(it.second)}</${it.first}>" }
        val body = "<?xml version=\"1.0\" encoding=\"utf-8\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" " +
            "s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body><u:$action xmlns:u=\"urn:schemas-upnp-org:service:$service:1\">" +
            inner + "</u:$action></s:Body></s:Envelope>"
        try {
            c.outputStream.use { it.write(body.toByteArray()) }
            val code = c.responseCode
            val text = (if (code >= 300) c.errorStream else c.inputStream)?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
            if (code >= 300) throw ParlorError("$name said no to $action (${Sonos.tag("errorCode", text) ?: code})")
            return text
        } finally { c.disconnect() }
    }

    fun av(action: String, vararg args: Pair<String, String>) = soap("/MediaRenderer/AVTransport/Control", "AVTransport", action, listOf("InstanceID" to "0") + args)
    fun group(action: String, vararg args: Pair<String, String>) = soap("/MediaRenderer/GroupRenderingControl/Control", "GroupRenderingControl", action, listOf("InstanceID" to "0") + args)
}

object Sonos {
    private val found = ConcurrentHashMap.newKeySet<String>()   // "ip:1400" of any speaker seen
    @Volatile var rooms: List<SonosRoom> = emptyList(); private set
    private var browsing = false

    /** Speakers announce themselves on the Wi-Fi (Bonjour, `_sonos._tcp`); their own web address is on port 1400. */
    @Synchronized private fun browse(ctx: Context) {
        if (browsing) return
        val nsd = ctx.getSystemService(NsdManager::class.java) ?: return
        val wifi = ctx.applicationContext.getSystemService(WifiManager::class.java)
        val lock = wifi?.createMulticastLock("parlor-sonos")?.apply { setReferenceCounted(false); acquire() }
        val resolving = Executors.newSingleThreadExecutor()
        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(t: String) {}
            override fun onDiscoveryStopped(t: String) { browsing = false; lock?.release() }
            override fun onStartDiscoveryFailed(t: String, e: Int) { browsing = false; lock?.release() }
            override fun onStopDiscoveryFailed(t: String, e: Int) {}
            override fun onServiceLost(s: NsdServiceInfo) {}
            override fun onServiceFound(s: NsdServiceInfo) {
                // (one at a time: older Androids resolve only one service at once)
                resolving.execute {
                    val done = java.util.concurrent.CountDownLatch(1)
                    @Suppress("DEPRECATION")
                    nsd.resolveService(s, object : NsdManager.ResolveListener {
                        override fun onResolveFailed(i: NsdServiceInfo, e: Int) { done.countDown() }
                        override fun onServiceResolved(i: NsdServiceInfo) {
                            val loc = i.attributes["location"]?.toString(Charsets.UTF_8)
                            val u = loc?.let { try { URL(it) } catch (_: Exception) { null } }
                            @Suppress("DEPRECATION") val ip = i.host?.hostAddress
                            if (u != null) found.add("${u.host}:${if (u.port > 0) u.port else 1400}") else if (ip != null && i.host is Inet4Address) found.add("$ip:1400")
                            done.countDown()
                        }
                    })
                    done.await(4, java.util.concurrent.TimeUnit.SECONDS)
                }
            }
        }
        try { nsd.discoverServices("_sonos._tcp", NsdManager.PROTOCOL_DNS_SD, listener); browsing = true } catch (_: Exception) { lock?.release() }
    }

    /** The rooms on the Wi-Fi, found afresh (a few seconds at most). Not on the main thread. */
    fun findRooms(ctx: Context): List<SonosRoom> {
        browse(ctx)
        Storage.readJson("sonos-hosts").asList()?.forEach { (it as? String)?.let(found::add) }
        val tried = HashSet<String>()
        val deadline = System.currentTimeMillis() + 5000
        while (System.currentTimeMillis() < deadline) {
            for (h in found.toList()) {
                if (!tried.add(h)) continue
                val list = topology(h)
                if (!list.isNullOrEmpty()) {
                    rooms = list
                    try { Storage.writeJson("sonos-hosts", list.map { it.host }.distinct()) } catch (_: Exception) {}
                    return list
                }
            }
            Thread.sleep(250)
        }
        return rooms
    }

    fun room(id: String): SonosRoom? = rooms.firstOrNull { it.id == id }

    /** The groups, from one speaker: each group's coordinator, its name, and what kind of speaker it is. */
    private fun topology(host: String): List<SonosRoom>? {
        val r = try { SonosRoom("", "The speaker", host).soap("/ZoneGroupTopology/Control", "ZoneGroupTopology", "GetZoneGroupState") } catch (_: Exception) { return null }
        val state = unesc(tag("ZoneGroupState", r) ?: return null)
        val out = ArrayList<SonosRoom>()
        for (g in Regex("<ZoneGroup\\s([^>]*)>(.*?)</ZoneGroup>", RegexOption.DOT_MATCHES_ALL).findAll(state)) {
            val coord = attrs(g.groupValues[1])["Coordinator"] ?: continue
            var lead: Map<String, String>? = null
            val others = ArrayList<String>()
            for (m in Regex("<ZoneGroupMember\\s([^>]*?)/?>", RegexOption.DOT_MATCHES_ALL).findAll(g.groupValues[2])) {
                val a = attrs(m.groupValues[1])
                if (a["UUID"] == coord) lead = a else if (a["Invisible"] != "1") a["ZoneName"]?.let(others::add)
            }
            val name = lead?.get("ZoneName") ?: continue
            val u = try { URL(lead["Location"] ?: continue) } catch (_: Exception) { continue }
            var room = SonosRoom(coord, (listOf(name) + others.sorted()).joinToString(" + "), "${u.host}:${if (u.port > 0) u.port else 1400}")
            try {
                val x = (u.openConnection() as HttpURLConnection).run { connectTimeout = 4000; readTimeout = 4000; inputStream.use { it.readBytes().toString(Charsets.UTF_8) } }
                val model = (tag("displayName", x) ?: tag("modelName", x) ?: "").removePrefix("Sonos ")
                val number = tag("modelNumber", x) ?: ""
                val m = model.lowercase()
                room = room.copy(model = model, atmos = m.startsWith("arc") || "era 300" in m || (m.startsWith("beam") && number != "S14"))
            } catch (_: Exception) {}
            out.add(room)
        }
        return out.sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.name })
    }

    // ---- bits of XML ----
    fun esc(s: String) = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;")
    fun unesc(s: String) = s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
    fun tag(name: String, s: String): String? {
        val a = s.indexOf("<$name>"); if (a < 0) return null
        val b = s.indexOf("</$name>", a); if (b < 0) return null
        return s.substring(a + name.length + 2, b)
    }
    private fun attrs(s: String) = Regex("([A-Za-z_:]+)=\"([^\"]*)\"").findAll(s).associate { it.groupValues[1] to unesc(it.groupValues[2]) }
    fun hms(t: Double): String { val s = maxOf(0, t.toInt()); return "%d:%02d:%02d".format(s / 3600, (s / 60) % 60, s % 60) }
    fun secs(s: String?): Double = if (s.isNullOrEmpty() || s == "NOT_IMPLEMENTED") 0.0 else s.split(":").fold(0.0) { acc, p -> acc * 60 + (p.toDoubleOrNull() ?: 0.0) }
}

// ---- playing on a room ---------------------------------------------------------------------------------------
/**
 * Parlor's queue on a Sonos room. The speaker gets the songs from the one playing onwards (its own queue, so one
 * song follows the next with no gap), added a few at a time; Parlor asks it every second where it's got to.
 * State is read and changed on the main thread; the speaker is called one thing at a time on a thread of its own.
 */
class SonosLink(val room: SonosRoom, private val tracks: () -> List<Map<String, Any?>>) {
    var onUpdate: ((Int?, Boolean) -> Unit)? = null
    var onProblem: ((String) -> Unit)? = null

    var pos = 0.0; private set
    var dur = 0.0; private set
    private var at = System.currentTimeMillis()
    var paused = true; private set
    var volume = 30; private set
    var muted = false; private set

    private var base = 0
    private var filled = 0
    private var gen = 0
    private var filling = false
    private var wasPlaying = false
    private var holdUntil = 0L
    private val calls = Executors.newSingleThreadExecutor()
    private val polls = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    @Volatile private var polling = false
    private var alive = true

    val now: Double get() = if (paused) pos else minOf(if (dur > 0) dur else Double.MAX_VALUE, pos + (System.currentTimeMillis() - at) / 1000.0)

    private fun ui(block: () -> Unit) { main.post { block() } }
    private fun <T> onMain(block: () -> T): T {
        if (Looper.myLooper() == Looper.getMainLooper()) return block()
        val q = java.util.concurrent.FutureTask<T> { block() }; main.post(q); return q.get()
    }

    private fun run(what: String, op: () -> Unit) = calls.execute {
        try { op() } catch (e: Exception) {
            android.util.Log.w("Parlor", "Sonos: $what failed", e)
            ui { onProblem?.invoke(e.message ?: "$what failed") }
        }
    }

    private fun didl(t: Map<String, Any?>, host: String): Pair<String, String>? {
        val path = t["path"] as? String ?: return null
        val uri = FileServer.url(path, host)
        val art = (t["art"] as? String)?.takeIf { File(it).exists() }?.let { "<upnp:albumArtURI>${Sonos.esc(FileServer.url(it, host))}</upnp:albumArtURI>" } ?: ""
        val d = t["duration"].asNum() ?: 0.0
        val e = { k: String -> Sonos.esc(t[k] as? String ?: "") }
        val meta = "<DIDL-Lite xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\" " +
            "xmlns:r=\"urn:schemas-rinconnetworks-com:metadata-1-0/\" xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\">" +
            "<item id=\"-1\" parentID=\"-1\" restricted=\"true\"><dc:title>${e("title")}</dc:title><upnp:class>object.item.audioItem.musicTrack</upnp:class>" +
            "<dc:creator>${e("artist")}</dc:creator><upnp:album>${e("album")}</upnp:album>$art" +
            "<res protocolInfo=\"http-get:*:${FileServer.mime(path)}:*\"${if (d > 0) " duration=\"${Sonos.hms(d)}\"" else ""}>${Sonos.esc(uri)}</res></item></DIDL-Lite>"
        return uri to meta
    }

    private fun add(t: Map<String, Any?>) {
        val host = FileServer.localAddress(room.ip) ?: throw ParlorError("This phone isn't on the speaker's Wi-Fi.")
        val (uri, meta) = didl(t, host) ?: return
        room.av("AddURIToQueue", "EnqueuedURI" to uri, "EnqueuedURIMetaData" to meta, "DesiredFirstTrackNumberEnqueued" to "0", "EnqueueAsNext" to "0")
    }

    /** The speaker starts again from queue index `i` (at `start` seconds into it). */
    fun load(i: Int, start: Double, play: Boolean) {
        val list = tracks()
        if (i < 0 || i >= list.size) return
        gen++; val g = gen
        base = i; filled = 0; filling = false
        pos = start; at = System.currentTimeMillis(); dur = list[i]["duration"].asNum() ?: 0.0
        paused = !play; holdUntil = System.currentTimeMillis() + 3000
        val first = list[i]
        run("start") {
            FileServer.ensureRunning()
            room.av("RemoveAllTracksFromQueue")
            add(first)
            onMain { if (g == gen) filled = 1 }
            room.av("SetAVTransportURI", "CurrentURI" to "x-rincon-queue:${room.id}#0", "CurrentURIMetaData" to "")
            room.av("Seek", "Unit" to "TRACK_NR", "Target" to "1")
            if (start > 1) try { room.av("Seek", "Unit" to "REL_TIME", "Target" to Sonos.hms(start)) } catch (_: Exception) {}
            if (play) room.av("Play", "Speed" to "1")
            ui { fill(g) }
        }
    }

    /** The rest of the queue onto the speaker, a few songs at a time (play / pause in between go straight through). */
    private fun fill(g: Int) {
        if (g != gen || filling) return
        val list = tracks(); val from = maxOf(0, base + filled)
        if (from >= list.size) return
        val batch = list.subList(from, minOf(list.size, from + 4)).toList()
        filling = true
        run("add songs") {
            try {
                for (t in batch) {
                    if (!onMain { g == gen }) break
                    add(t)
                    onMain { if (g == gen) filled++ }
                }
            } finally {
                ui { if (g == gen) { filling = false; fill(g) } }
            }
        }
    }

    /** The queue's gone (Parlor stopped): what the speaker has no longer matches it. */
    fun forget() { gen++; filled = 0; filling = false; wasPlaying = false }

    /** Songs were added to the end of the queue. */
    fun grew() { if (!filling) fill(gen) }

    /** The queue changed after the song that's playing: it carries on, and what follows is put back in the new order. */
    fun rebuild(was: Int, now: Int) {
        val k = was - base
        if (k < 0 || k >= filled) { load(now, this.now, !paused); return }
        gen++; val g = gen
        filling = false
        base = now - k
        val drop = filled - (k + 1)
        filled = k + 1
        run("redo the queue") {
            if (drop > 0) room.av("RemoveTrackRangeFromQueue", "UpdateID" to "0", "StartingIndex" to (k + 2).toString(), "NumberOfTracks" to drop.toString())
            ui { fill(g) }
        }
    }

    fun jump(i: Int) {
        val k = i - base
        if (k < 0 || k >= filled) { load(i, 0.0, true); return }
        pos = 0.0; at = System.currentTimeMillis(); paused = false; holdUntil = System.currentTimeMillis() + 3000
        dur = tracks().getOrNull(i)?.get("duration").asNum() ?: 0.0
        run("skip") { room.av("Seek", "Unit" to "TRACK_NR", "Target" to (k + 1).toString()); room.av("Play", "Speed" to "1") }
    }

    fun play() { pos = now; at = System.currentTimeMillis(); paused = false; holdUntil = at + 3000; run("play") { room.av("Play", "Speed" to "1") } }
    fun pause() { pos = now; at = System.currentTimeMillis(); paused = true; holdUntil = at + 3000; run("pause") { room.av("Pause") } }
    fun seek(s: Double) { pos = s; at = System.currentTimeMillis(); holdUntil = at + 3000; run("seek") { room.av("Seek", "Unit" to "REL_TIME", "Target" to Sonos.hms(s)) } }
    fun setVolume(v: Int) { volume = v.coerceIn(0, 100); val x = volume; run("volume") { room.group("SetGroupVolume", "DesiredVolume" to x.toString()) } }
    fun setMuted(m: Boolean) { muted = m; run("mute") { room.group("SetGroupMute", "DesiredMute" to if (m) "1" else "0") } }
    fun repeatOne(on: Boolean) { run("repeat") { room.av("SetPlayMode", "NewPlayMode" to if (on) "REPEAT_ONE" else "NORMAL") } }

    fun start() {
        polls.execute { try { Sonos.tag("CurrentVolume", room.group("GetGroupVolume"))?.toIntOrNull()?.let { v -> ui { volume = v } } } catch (_: Exception) {} }
        schedule()
    }

    private fun schedule() { main.postDelayed({ if (alive) { poll(); schedule() } }, 1000) }

    /** Parlor lets go of the speaker (the music stops there, if asked). */
    fun release(pause: Boolean) {
        alive = false
        gen++
        if (pause) run("pause") { room.av("Pause") }
    }

    private fun poll() {
        if (polling) return
        polling = true
        polls.execute {
            val p = try { room.av("GetPositionInfo") } catch (_: Exception) { null }
            val t = try { room.av("GetTransportInfo") } catch (_: Exception) { null }
            ui {
                polling = false
                if (p == null || t == null || !alive) return@ui
                val state = Sonos.tag("CurrentTransportState", t) ?: ""
                val track = Sonos.tag("Track", p)?.toIntOrNull() ?: 0
                val playing = state == "PLAYING" || state == "TRANSITIONING"
                // (just told to play, pause or seek: the speaker may not have got there yet, so its time waits)
                if (System.currentTimeMillis() >= holdUntil) {
                    pos = Sonos.secs(Sonos.tag("RelTime", p))
                    Sonos.secs(Sonos.tag("TrackDuration", p)).takeIf { it > 0 }?.let { dur = it }
                    at = System.currentTimeMillis()
                    paused = !playing
                }
                // the speaker ran out of songs (the end of the queue): stopped, not paused
                val lastFilled = base + filled >= tracks().size
                if (state == "STOPPED" && wasPlaying && lastFilled && !filling) { wasPlaying = false; onUpdate?.invoke(null, true); return@ui }
                wasPlaying = playing
                if (state != "STOPPED" && track in 1..filled) onUpdate?.invoke(base + track - 1, false) else onUpdate?.invoke(null, false)
            }
        }
    }
}
