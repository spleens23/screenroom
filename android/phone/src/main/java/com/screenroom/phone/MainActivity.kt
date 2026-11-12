package com.screenroom.phone

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.ComponentName
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.Settings
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.core.view.WindowInsetsControllerCompat
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import java.io.File
import java.io.FileInputStream
import java.io.InputStream

/**
 * Parlor and Screenroom for Android phones: one full-screen page, the same screens as on the iPhone. The page's
 * files (its screens from the app, songs and covers from the phone) come from one made-up address
 * (https://appassets.androidplatform.net), answered here.
 */
class MainActivity : Activity() {
    lateinit var web: WebView
    lateinit var bridge: Bridge
    private var controller: com.google.common.util.concurrent.ListenableFuture<MediaController>? = null
    private var asked = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Storage.prepare(this)
        MusicPlayer.init(applicationContext)
        web = WebView(this)
        web.setBackgroundColor(0xff1c1a18.toInt())
        web.overScrollMode = View.OVER_SCROLL_NEVER
        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
        }
        if (isDebuggable) WebView.setWebContentsDebuggingEnabled(true)
        bridge = Bridge(this)
        MusicPlayer.bridge = bridge
        web.addJavascriptInterface(bridge.js, "SRAndroid")
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? = serve(request)
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val u = request.url
                if (u.host == HOST) return false
                // links (a review, a website) open in the browser
                try { startActivity(Intent(Intent.ACTION_VIEW, u)) } catch (_: Exception) {}
                return true
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(m: ConsoleMessage): Boolean { android.util.Log.i("Parlor", "page: ${m.message()}"); return true }
            // a picture chosen on the page (a profile photo): the phone's own photo picker
            override fun onShowFileChooser(view: WebView, cb: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                val i = Intent(Intent.ACTION_GET_CONTENT).apply { addCategory(Intent.CATEGORY_OPENABLE); type = "image/*" }
                kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Main).launch {
                    val r = pick(i)
                    cb.onReceiveValue(r?.data?.let { arrayOf(it) })
                }
                return true
            }
        }
        setContentView(web)
        web.loadUrl("https://$HOST/web/renderer/index.html")
        // test builds can be driven from the command line: --es script64 "<JavaScript, in base64>" runs once the page is up
        intent?.let(::scriptFrom)?.let { runLater(it) }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        scriptFrom(intent)?.let { runLater(it) }
    }

    private fun scriptFrom(i: Intent): String? = i.getStringExtra("script64")?.let { try { String(android.util.Base64.decode(it, 0)) } catch (_: Exception) { null } }

    private fun runLater(js: String) {
        if (!isDebuggable) return
        web.postDelayed({ web.evaluateJavascript(js, null) }, 6000)
    }

    val isDebuggable get() = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0

    override fun onStart() {
        super.onStart()
        // the music service (playing with the screen off, the notification and lock screen controls)
        if (controller == null && Storage.isParlor) controller = MediaController.Builder(this, SessionToken(this, ComponentName(this, MusicService::class.java))).buildAsync()
        askForFiles()
    }

    override fun onResume() {
        super.onResume()
        // something may have been added to the music folders while Parlor was away
        Thread { if (hasFiles() && (if (Storage.isParlor) Scanner.musicChanged() else VideoScanner.changed())) bridge.emit("files-changed", null) }.start()
    }

    override fun onDestroy() {
        controller?.let { MediaController.releaseFuture(it) }
        controller = null
        super.onDestroy()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        web.evaluateJavascript("(window.__srBack ? window.__srBack() : false)") { r -> if (r != "true") moveTaskToBack(true) }
    }

    fun setStatusBar(dark: Boolean) {
        runOnUiThread { WindowInsetsControllerCompat(window, window.decorView).isAppearanceLightStatusBars = dark }
    }

    // ---- reading the music folders --------------------------------------------------------------------------
    fun hasFiles(): Boolean = if (Build.VERSION.SDK_INT >= 30) Environment.isExternalStorageManager()
        else checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED

    /** Parlor reads the music where it is on the phone: that takes Android's "All files" access, asked for once. */
    private fun askForFiles() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED && !asked) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 7)
        }
        if (hasFiles() || asked) return
        asked = true
        if (Build.VERSION.SDK_INT < 30) { requestPermissions(arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE), 8); return }
        val (t, m) = if (Storage.isParlor) "Let Parlor see your music" to "Parlor plays the music in your phone's Music folder (and any other folder you choose) right where it is. Android asks you to allow that once: turn on \"Allow access to manage all files\" for Parlor on the next screen, then come back."
            else "Let Screenroom see your films" to "Screenroom plays the films and shows in your phone's Movies folder right where they are. Android asks you to allow that once: turn on \"Allow access to manage all files\" for Screenroom on the next screen, then come back."
        AlertDialog.Builder(this)
            .setTitle(t)
            .setMessage(m)
            .setPositiveButton("Continue") { _, _ ->
                try { startActivity(Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:$packageName"))) }
                catch (_: Exception) { startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)) }
            }
            .setNegativeButton("Not now", null)
            .show()
    }

    // ---- pickers (files, folders, pictures, videos) -------------------------------------------------------------
    private val waiting = HashMap<Int, CompletableDeferred<Intent?>>()
    private var nextCode = 100

    suspend fun pick(intent: Intent): Intent? {
        val d = CompletableDeferred<Intent?>()
        val code = nextCode++
        runOnUiThread {
            waiting[code] = d
            try { startActivityForResult(intent, code) } catch (e: Exception) { waiting.remove(code); d.complete(null) }
        }
        return d.await()
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        waiting.remove(requestCode)?.complete(if (resultCode == RESULT_OK) data else null)
    }

    // ---- the page's files ------------------------------------------------------------------------------------------
    private fun serve(req: WebResourceRequest): WebResourceResponse? {
        val u = req.url
        if (u.host != HOST) return null
        val path = u.path ?: return notFound()
        return when {
            path.startsWith("/web/") -> try {
                WebResourceResponse(mime(path), if (isText(path)) "utf-8" else null, assets.open(path.removePrefix("/")))
            } catch (_: Exception) { notFound() }
            path.startsWith("/f/") -> {
                val file = File(path.removePrefix("/f"))
                if (!Storage.mayServe(file.path) || !file.isFile) notFound() else fileResponse(file, req.requestHeaders["Range"] ?: req.requestHeaders["range"])
            }
            else -> notFound()
        }
    }

    private fun fileResponse(f: File, range: String?): WebResourceResponse {
        val size = f.length()
        val headers = mutableMapOf("Accept-Ranges" to "bytes", "Cache-Control" to "no-cache", "Access-Control-Allow-Origin" to "*")
        val m = range?.let { Regex("bytes=(\\d*)-(\\d*)").find(it) }
        if (m != null && size > 0) {
            var start = m.groupValues[1].toLongOrNull()
            var end = m.groupValues[2].toLongOrNull() ?: (size - 1)
            if (start == null) { start = maxOf(0, size - end); end = size - 1 }
            end = minOf(end, size - 1)
            if (start >= size || start > end) return WebResourceResponse(mime(f.name), null, 416, "Range Not Satisfiable", headers + ("Content-Range" to "bytes */$size"), null)
            val len = end - start + 1
            val input = FileInputStream(f).also { it.skipFully(start) }
            headers["Content-Range"] = "bytes $start-$end/$size"
            headers["Content-Length"] = len.toString()
            return WebResourceResponse(mime(f.name), null, 206, "Partial Content", headers, Limited(input, len))
        }
        headers["Content-Length"] = size.toString()
        return WebResourceResponse(mime(f.name), null, 200, "OK", headers, FileInputStream(f))
    }

    private fun notFound() = WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), null)
    private fun isText(p: String) = p.substringAfterLast('.').lowercase() in setOf("html", "js", "css", "json", "svg", "txt")

    companion object {
        const val HOST = "appassets.androidplatform.net"
        fun mime(name: String): String = when (name.substringAfterLast('.').lowercase()) {
            "html" -> "text/html"; "js" -> "text/javascript"; "css" -> "text/css"; "json" -> "application/json"; "svg" -> "image/svg+xml"
            "png" -> "image/png"; "jpg", "jpeg" -> "image/jpeg"; "webp" -> "image/webp"; "gif" -> "image/gif"
            "woff2" -> "font/woff2"; "woff" -> "font/woff"; "ttf" -> "font/ttf"; "otf" -> "font/otf"
            "mp4", "m4v" -> "video/mp4"; "mov" -> "video/quicktime"; "webm" -> "video/webm"
            "m4a", "m4b" -> "audio/mp4"; "mp3" -> "audio/mpeg"; "flac" -> "audio/flac"; "wav" -> "audio/wav"
            else -> "application/octet-stream"
        }
    }
}

private fun InputStream.skipFully(n: Long) { var left = n; while (left > 0) { val s = skip(left); if (s <= 0) { if (read() < 0) return; left-- } else left -= s } }

/** At most `left` bytes of a stream (a byte range of a file). */
private class Limited(private val inner: InputStream, private var left: Long) : InputStream() {
    override fun read(): Int = if (left <= 0) -1 else inner.read().also { if (it >= 0) left-- }
    override fun read(b: ByteArray, off: Int, len: Int): Int {
        if (left <= 0) return -1
        val n = inner.read(b, off, minOf(len.toLong(), left).toInt())
        if (n > 0) left -= n
        return n
    }
    override fun close() = inner.close()
}
