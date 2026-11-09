package com.screenroom.phone

import android.content.ClipData
import android.content.Intent
import android.graphics.ImageDecoder
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.provider.OpenableColumns
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/** Bringing songs in (copied into Parlor's own folder), covers and profile pictures, and moving covers. */
class Importer(private val act: MainActivity) {
    private val cr get() = act.contentResolver

    /** Songs picked in Android's file picker, copied into Parlor's Music folder. Returns how many came in. */
    suspend fun importFiles(): Int {
        val films = !Storage.isParlor
        val i = Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
            .putExtra(Intent.EXTRA_MIME_TYPES, if (films) arrayOf("video/*") else arrayOf("audio/*", "video/mp4", "video/quicktime"))
            .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        val r = act.pick(i) ?: return 0
        val uris = uris(r)
        return withContext(Dispatchers.IO) {
            var n = 0
            for (u in uris) {
                val name = nameOf(u) ?: continue
                val ext = name.substringAfterLast('.', "").lowercase()
                if (films && ext !in VideoScanner.videoExtensions) continue
                if (!films && ext !in audioExtensions && ext !in boxExtensions) continue
                // a song brought in again under the same name replaces the one there rather than sitting beside it
                val same = File(if (films) Storage.films else Storage.music, name)
                if (same.exists()) same.delete()
                try { cr.openInputStream(u)?.use { inp -> same.outputStream().use { inp.copyTo(it) } }; n++ } catch (_: Exception) { same.delete() }
            }
            n
        }
    }

    /** A picture from the phone: an album's cover (saved beside its songs as `destBase`.jpg) or a profile picture. */
    suspend fun pickPhoto(name: String?, destBase: String?): Map<String, Any?>? {
        val i = if (Build.VERSION.SDK_INT >= 33) Intent(MediaStore.ACTION_PICK_IMAGES) else Intent(Intent.ACTION_GET_CONTENT).setType("image/*")
        val r = act.pick(i) ?: return null
        val u = uris(r).firstOrNull() ?: return null
        return withContext(Dispatchers.IO) {
            val bmp = try { ImageDecoder.decodeBitmap(ImageDecoder.createSource(cr, u)) { d, _, _ -> d.allocator = ImageDecoder.ALLOCATOR_SOFTWARE } }
                catch (e: Exception) { throw ParlorError("Couldn't read that picture.") }
            if (destBase != null) {
                if (!Storage.isMine(destBase)) throw ParlorError("That folder isn't Parlor's.")
                val saved = saveBitmap(bmp, 1200, File("$destBase.jpg"), 90) ?: throw ParlorError("Couldn't save the picture.")
                mapOf("path" to saved)
            } else {
                val file = "${(name ?: randomHex(4)).replace("/", "-")}.jpg"
                val saved = saveBitmap(bmp, 600, File(Storage.avatars, file), 85) ?: throw ParlorError("Couldn't save the picture.")
                mapOf("name" to file, "path" to saved)
            }
        }
    }

    /** An album's moving cover: a short video copied into the album's folder as cover.mp4 (or taken away). */
    suspend fun pickMotion(dir: String, how: String): Map<String, Any?>? {
        if (!Storage.isMine("$dir/x")) throw ParlorError("That album isn't in Parlor's music folders.")
        val folder = File(dir)
        if (how == "remove") {
            removeMotion(folder)
            val up = folder.parentFile
            if (up != null && Storage.isInside(up.path + "/x", Storage.music) && Storage.canonical(up) != Storage.canonical(Storage.music)) removeMotion(up)
            return mapOf("removed" to true)
        }
        val i = if (how == "photos" && Build.VERSION.SDK_INT >= 33) Intent(MediaStore.ACTION_PICK_IMAGES).setType("video/*")
            else Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("video/*")
        val r = act.pick(i) ?: return null
        val u = uris(r).firstOrNull() ?: return null
        return withContext(Dispatchers.IO) {
            var ext = (nameOf(u) ?: "").substringAfterLast('.', "").lowercase()
            if (ext !in boxExtensions) ext = "mp4"
            removeMotion(folder)
            val dest = File(folder, "cover.$ext")
            try { cr.openInputStream(u)?.use { inp -> dest.outputStream().use { inp.copyTo(it) } } } catch (e: Exception) { dest.delete(); throw ParlorError("Couldn't keep that video.") }
            mapOf("path" to dest.path, "plays" to true, "status" to "plays", "detail" to "")
        }
    }

    private fun removeMotion(dir: File) { dir.listFiles()?.filter { isMotionCover(it.name) }?.forEach { it.delete() } }

    private fun uris(r: Intent): List<Uri> {
        val clip: ClipData? = r.clipData
        return if (clip != null) (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri } else listOfNotNull(r.data)
    }

    private fun nameOf(u: Uri): String? = try {
        cr.query(u, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c -> if (c.moveToFirst()) c.getString(0) else null }
    } catch (_: Exception) { null } ?: u.lastPathSegment?.substringAfterLast('/')
}
