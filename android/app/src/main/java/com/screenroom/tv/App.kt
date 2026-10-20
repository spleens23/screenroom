package com.screenroom.tv

import android.content.Context
import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import java.lang.ref.WeakReference
import java.util.concurrent.Executors

/** Process-wide pieces: the store, the background workers, and a line back to the web UI. */
object App {
    lateinit var context: Context
        private set
    lateinit var store: Store
        private set
    val main = Handler(Looper.getMainLooper())
    val io = Executors.newCachedThreadPool()
    private var bridgeRef: WeakReference<Bridge>? = null
    private var started = false
    var remote: RemoteServer? = null

    fun init(ctx: Context) {
        if (started) return
        started = true
        context = ctx.applicationContext
        store = Store(context)
        store.ensureMediaDir()
        restartRemote()
        Drives.startWatching()
    }

    fun attach(bridge: Bridge) { bridgeRef = WeakReference(bridge) }

    /** Send an event to the web UI (if it's open). */
    fun emit(name: String, payload: Any? = null) {
        bridgeRef?.get()?.emit(name, payload)
    }

    fun restartRemote() {
        try { remote?.stop() } catch (_: Throwable) {}
        remote = null
        if (!store.config.optBoolean("remote", true)) return
        val port = store.config.optInt("remotePort", 8686)
        try {
            remote = RemoteServer(port).also { it.begin() }
        } catch (e: Throwable) {
            android.util.Log.w("Screenroom", "phone remote could not start on $port: $e")
        }
    }

    // A rescan a little later, collapsing bursts (several uploads in a row, a drive appearing).
    private val rescanRunnable = Runnable {
        if (PlayerActivity.current != null) return@Runnable
        io.execute {
            Library.scan(context) { done, total -> emit("scan-progress", JSONObject().put("done", done).put("total", total)) }
            emit("library-updated")
        }
    }

    fun rescanSoon(delayMs: Long) {
        main.removeCallbacks(rescanRunnable)
        main.postDelayed(rescanRunnable, delayMs)
    }
}
