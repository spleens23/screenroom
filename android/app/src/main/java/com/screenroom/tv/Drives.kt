package com.screenroom.tv

import android.os.Build
import android.os.Environment
import android.os.StatFs
import android.os.storage.StorageManager
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** USB drives / SD cards that are plugged in right now. Their videos join the library while they're there. */
object Drives {
    data class Drive(val path: String, val label: String, val total: Long, val free: Long)

    @Volatile var current: List<Drive> = emptyList()

    fun list(): List<Drive> {
        val ctx = App.context
        val sm = ctx.getSystemService(StorageManager::class.java) ?: return emptyList()
        val out = ArrayList<Drive>()
        for (v in sm.storageVolumes) {
            if (!v.isRemovable) continue
            val state = v.state
            if (state != Environment.MEDIA_MOUNTED && state != Environment.MEDIA_MOUNTED_READ_ONLY) continue
            val dir: File = (if (Build.VERSION.SDK_INT >= 30) v.directory else null)
                ?: v.uuid?.let { File("/storage/$it") }
                ?: continue
            if (!dir.exists()) continue
            val stat = try { StatFs(dir.path) } catch (_: Throwable) { null }
            out.add(Drive(dir.absolutePath, v.getDescription(ctx) ?: dir.name, stat?.totalBytes ?: 0L, stat?.availableBytes ?: 0L))
        }
        return out
    }

    fun toJson(list: List<Drive>): JSONArray {
        val a = JSONArray()
        for (d in list) {
            a.put(JSONObject().put("mount", d.path).put("device", "").put("fs", "").put("label", d.label)
                .put("total", d.total).put("free", d.free))
        }
        return a
    }

    private fun sig(list: List<Drive>) = list.map { it.path }.sorted().joinToString("|")

    private val poll = object : Runnable {
        override fun run() {
            App.io.execute {
                val next = try { list() } catch (_: Throwable) { current }
                val prev = current
                current = next
                if (sig(next) != sig(prev)) {
                    val added = JSONArray(); next.filter { n -> prev.none { it.path == n.path } }.forEach { added.put(it.label) }
                    val removed = JSONArray(); prev.filter { p -> next.none { it.path == p.path } }.forEach { removed.put(it.label) }
                    App.emit("drives-changed", JSONObject().put("drives", toJson(next)).put("added", added).put("removed", removed))
                    App.rescanSoon(1500)
                }
            }
            App.main.postDelayed(this, 5000)
        }
    }

    fun startWatching() {
        current = try { list() } catch (_: Throwable) { emptyList() }
        App.main.postDelayed(poll, 5000)
    }
}
