package com.screenroom.tv

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONObject

/** Hosts the browse screens (the same web UI as the desktop app) in a full-screen WebView. */
class MainActivity : Activity() {
    lateinit var web: WebView
        private set
    private lateinit var bridge: Bridge

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        App.init(this)

        if ((applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0) WebView.setWebContentsDebuggingEnabled(true)
        web = WebView(this)
        web.setBackgroundColor(Color.parseColor("#141414"))
        web.isFocusable = true
        web.isFocusableInTouchMode = true
        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = true          // cover art lives in the app's own folder
            useWideViewPort = true          // the page is laid out 1600 px wide and scaled to the TV
            loadWithOverviewMode = true
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            textZoom = 100
            mediaPlaybackRequiresUserGesture = true
        }
        web.webChromeClient = WebChromeClient()
        web.webViewClient = object : WebViewClient() {
            // Never navigate away from the app's own page.
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = true
        }
        bridge = Bridge(this)
        App.attach(bridge)
        web.addJavascriptInterface(bridge, "Android")
        setContentView(web)
        hideSystemBars()
        web.loadUrl("file:///android_asset/web/renderer/index.html")
        web.requestFocus(View.FOCUS_DOWN)

        askForStorage()
        App.rescanSoon(2500)
        scheduleBackgroundScans()
    }

    private fun scheduleBackgroundScans() {
        App.main.postDelayed(object : Runnable {
            override fun run() {
                App.rescanSoon(0)
                App.main.postDelayed(this, 30L * 60 * 1000)
            }
        }, 30L * 60 * 1000)
    }

    @Suppress("DEPRECATION")
    private fun hideSystemBars() {
        window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_LAYOUT_STABLE)
    }

    private fun askForStorage() {
        val perm = if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_VIDEO else Manifest.permission.READ_EXTERNAL_STORAGE
        if (checkSelfPermission(perm) != PackageManager.PERMISSION_GRANTED) requestPermissions(arrayOf(perm), 1)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        App.store.ensureMediaDir()
        App.rescanSoon(500)
    }

    override fun onResume() {
        super.onResume()
        hideSystemBars()
        if (PlayerActivity.closedSinceResume) {
            PlayerActivity.closedSinceResume = false
            App.emit("playback-ended")
        }
    }

    private fun remoteKey(key: String, exitIfRoot: Boolean = false) {
        App.emit("remote", JSONObject().put("type", "key").put("key", key).put("exitIfRoot", exitIfRoot))
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val code = event.keyCode
        val handled = when (code) {
            KeyEvent.KEYCODE_BACK, KeyEvent.KEYCODE_BUTTON_B -> "back"
            KeyEvent.KEYCODE_MENU, KeyEvent.KEYCODE_SETTINGS, KeyEvent.KEYCODE_BUTTON_START -> "settings"
            KeyEvent.KEYCODE_BUTTON_A -> "ok"
            else -> null
        } ?: return super.dispatchKeyEvent(event)
        if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
            // Back on the home screen leaves the app, unless the box is locked to Screenroom.
            remoteKey(handled, exitIfRoot = handled == "back" && !Kiosk.isLocked())
        }
        return true
    }

    override fun onDestroy() {
        try { web.destroy() } catch (_: Throwable) {}
        super.onDestroy()
    }
}
