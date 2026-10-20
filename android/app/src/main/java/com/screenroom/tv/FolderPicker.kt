package com.screenroom.tv

import android.app.Activity
import android.app.AlertDialog
import android.os.Environment
import java.io.File
import java.util.concurrent.CompletableFuture

/** A simple folder chooser that works with a TV remote (the system file picker often isn't on TV boxes). */
object FolderPicker {
    fun pick(activity: Activity): CompletableFuture<String?> {
        val result = CompletableFuture<String?>()
        activity.runOnUiThread { show(activity, null, result) }
        return result
    }

    private fun roots(): List<Pair<String, File>> {
        val list = ArrayList<Pair<String, File>>()
        list.add("Internal storage" to Environment.getExternalStorageDirectory())
        for (d in Drives.current) list.add(d.label to File(d.path))
        list.add("Screenroom uploads" to App.store.mediaDir)
        return list.filter { it.second.exists() }
    }

    private fun show(a: Activity, dir: File?, result: CompletableFuture<String?>) {
        if (a.isFinishing || a.isDestroyed) { result.complete(null); return }
        val labels = ArrayList<String>()
        val actions = ArrayList<() -> Unit>()
        if (dir == null) {
            for ((label, file) in roots()) { labels.add(label); actions.add { show(a, file, result) } }
        } else {
            labels.add("✓  Use this folder"); actions.add { result.complete(dir.absolutePath) }
            labels.add("↑  Back"); actions.add {
                val atRoot = roots().any { it.second.absolutePath == dir.absolutePath }
                show(a, if (atRoot) null else dir.parentFile, result)
            }
            val subs = dir.listFiles()?.filter { it.isDirectory && !it.name.startsWith(".") }?.sortedBy { it.name.lowercase() } ?: emptyList()
            for (s in subs) { labels.add("📁  " + s.name); actions.add { show(a, s, result) } }
        }
        AlertDialog.Builder(a, android.R.style.Theme_DeviceDefault_Dialog_Alert)
            .setTitle(dir?.absolutePath ?: "Choose a folder")
            .setItems(labels.toTypedArray()) { _, which -> actions[which]() }
            .setNegativeButton("Cancel") { _, _ -> result.complete(null) }
            .setOnCancelListener { result.complete(null) }
            .show()
    }
}
