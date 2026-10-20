package com.screenroom.tv

import android.content.ActivityNotFoundException
import android.content.Intent
import android.provider.Settings
import android.webkit.JavascriptInterface
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * What the web UI's `window.api` calls (through android-api.js). Each call runs on a background thread
 * and its answer is posted back to the page as JSON.
 */
class Bridge(private val activity: MainActivity) {

    @JavascriptInterface
    fun call(id: Int, method: String, argsJson: String) {
        App.io.execute {
            val value: Any? = try {
                handle(method, JSONArray(argsJson))
            } catch (e: Throwable) {
                JSONObject().put("__error", e.message ?: e.toString())
            }
            send("window.__androidReply($id, ${JSONObject.quote(toJson(value))})")
        }
    }

    fun emit(name: String, payload: Any?) {
        send("window.__androidEvent(${JSONObject.quote(name)}, ${JSONObject.quote(toJson(payload))})")
    }

    private fun send(js: String) {
        activity.runOnUiThread {
            if (!activity.isFinishing && !activity.isDestroyed) activity.web.evaluateJavascript(js, null)
        }
    }

    private fun toJson(v: Any?): String = when (v) {
        null -> "null"
        is JSONObject, is JSONArray -> v.toString()
        is String -> JSONObject.quote(v)
        is Boolean, is Number -> v.toString()
        else -> JSONObject.quote(v.toString())
    }

    private fun progress(done: Int, total: Int) {
        App.emit("scan-progress", JSONObject().put("done", done).put("total", total))
    }

    private fun rescan(): JSONObject {
        Library.scan(activity, this::progress)
        return App.store.snapshot()
    }

    private fun handle(m: String, a: JSONArray): Any? {
        val st = App.store
        return when (m) {
            "state" -> st.snapshot()
            "scan" -> rescan()
            "addDir" -> {
                val path = FolderPicker.pick(activity).get()
                if (path != null) { st.setDirs(st.dirs() + path); rescan() } else st.snapshot()
            }
            "removeDir" -> { val d = a.getString(0); st.setDirs(st.dirs().filter { it != d }); rescan() }
            "setConfig" -> {
                val patch = a.getJSONObject(0)
                val before = st.config.optBoolean("remote", true) to st.config.optInt("remotePort", 8686)
                st.patchConfig(patch)
                val after = st.config.optBoolean("remote", true) to st.config.optInt("remotePort", 8686)
                if (before != after) App.restartRemote()
                st.snapshot()
            }
            "setWatched" -> {
                val o = a.getJSONObject(0)
                st.setWatched(o.getJSONArray("ids"), o.optBoolean("watched", true))
                st.snapshot()
            }
            "play" -> {
                PlayerActivity.launch(activity, a.getJSONObject(0))
                JSONObject().put("ok", true)
            }
            "remoteInfo" -> RemoteServer.info()
            "setCatalog" -> { RemoteServer.catalog = a.getJSONArray(0); true }
            "quit" -> {
                if (!Kiosk.isLocked()) activity.runOnUiThread { activity.finish() }
                true
            }
            "drives" -> { Drives.current = Drives.list(); Drives.toJson(Drives.current) }
            "copyDrive" -> copyDrive(a.getString(0))
            "cancelCopy" -> { Transfer.cancel = true; true }
            "ejectDrive" -> {
                openSettings("storage")
                JSONObject().put("ok", false).put("msg", "Pick the drive in Storage settings, then choose Eject.")
            }
            "openSettings" -> { openSettings(a.optString(0, "main")); true }
            "kioskStatus" -> Kiosk.status(activity)
            "kioskLock" -> Kiosk.lock(activity, a.optString(0, ""))
            "kioskUnlock" -> Kiosk.unlock(activity, a.optString(0, ""))
            "kioskRelease" -> Kiosk.release(activity)
            else -> throw IllegalArgumentException("Unknown call: $m")
        }
    }

    private fun copyDrive(mount: String): JSONObject {
        val d = Drives.current.firstOrNull { it.path == mount } ?: return JSONObject().put("error", "Drive not found")
        return try {
            val r = Transfer.copyTree(File(d.path), App.store.mediaDir) { file, index, total, bytesDone, bytesTotal ->
                App.emit("copy-progress", JSONObject().put("label", d.label).put("file", file).put("index", index)
                    .put("total", total).put("bytesDone", bytesDone).put("bytesTotal", bytesTotal))
            }
            App.rescanSoon(500)
            JSONObject().put("copied", r.copied).put("skipped", r.skipped).put("total", r.total).put("cancelled", r.cancelled)
        } catch (e: Throwable) {
            JSONObject().put("error", e.message ?: e.toString())
        }
    }

    private fun openSettings(which: String) {
        val actions = when (which) {
            "storage" -> listOf(Settings.ACTION_INTERNAL_STORAGE_SETTINGS, Settings.ACTION_SETTINGS)
            "network" -> listOf(Settings.ACTION_WIFI_SETTINGS, Settings.ACTION_WIRELESS_SETTINGS, Settings.ACTION_SETTINGS)
            else -> listOf(Settings.ACTION_SETTINGS)
        }
        activity.runOnUiThread {
            for (action in actions) {
                try {
                    activity.startActivity(Intent(action).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    return@runOnUiThread
                } catch (_: ActivityNotFoundException) {
                } catch (_: SecurityException) {
                }
            }
        }
    }
}
