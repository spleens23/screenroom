package com.screenroom.tv

import android.app.admin.DeviceAdminReceiver
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest

/** Lets the setup script make Screenroom the box's "device owner" (adb shell dpm set-device-owner ...). */
class AdminReceiver : DeviceAdminReceiver()

/**
 * "Lock to Screenroom": Screenroom becomes the Home screen, every other app is paused (they stay installed,
 * they just can't open), and Android's Settings still work. A PIN undoes it.
 * Needs Screenroom to be the device owner, which the setup script arranges.
 */
object Kiosk {
    private const val HOME_ALIAS = "com.screenroom.tv.HomeAlias"

    // Never pause these: Screenroom itself, Android settings, and the pieces Settings relies on.
    private val KEEP = setOf(
        "com.android.tv.settings", "com.android.settings", "com.google.android.tv.settings",
        "com.android.systemui", "com.google.android.apps.tv.launcherx", "com.google.android.tvlauncher",
        "com.android.packageinstaller", "com.google.android.packageinstaller", "com.android.vending.setupwizard",
    )

    private fun admin(ctx: Context) = ComponentName(ctx, AdminReceiver::class.java)
    private fun dpm(ctx: Context) = ctx.getSystemService(DevicePolicyManager::class.java)

    fun isOwner(ctx: Context): Boolean = try { dpm(ctx)?.isDeviceOwnerApp(ctx.packageName) == true } catch (_: Throwable) { false }

    fun isLocked(): Boolean = App.store.config.optBoolean("kioskLocked", false)

    private fun hash(pin: String): String =
        MessageDigest.getInstance("SHA-256").digest(("screenroom:" + pin).toByteArray()).joinToString("") { "%02x".format(it) }

    private fun result(ok: Boolean, message: String) = JSONObject().put("ok", ok).put("message", message)

    fun status(ctx: Context): JSONObject {
        val owner = isOwner(ctx)
        val o = JSONObject().put("owner", owner).put("locked", isLocked())
        if (!owner) o.put("message", "To lock this box, run the setup script from your computer with the lock option " +
            "(it needs the box to be set up without a Google account). See the setup guide.")
        return o
    }

    /** Apps someone could open from the home screen (TV and phone-style launchers). */
    private fun launchable(ctx: Context): Set<String> {
        val pm = ctx.packageManager
        val out = HashSet<String>()
        for (cat in listOf(Intent.CATEGORY_LEANBACK_LAUNCHER, Intent.CATEGORY_LAUNCHER)) {
            val intent = Intent(Intent.ACTION_MAIN).addCategory(cat)
            @Suppress("DEPRECATION")
            for (ri in pm.queryIntentActivities(intent, 0)) out.add(ri.activityInfo.packageName)
        }
        out.remove(ctx.packageName)
        out.removeAll(KEEP)
        return out
    }

    fun lock(ctx: Context, pin: String): JSONObject {
        if (!isOwner(ctx)) return result(false, "Screenroom isn't allowed to lock this box yet. Run the setup script with the lock option first.")
        if (!pin.matches(Regex("\\d{4,8}"))) return result(false, "Choose a PIN of 4 to 8 digits.")
        val dpm = dpm(ctx) ?: return result(false, "Device policy service unavailable.")
        val admin = admin(ctx)
        val pm = ctx.packageManager
        val alias = ComponentName(ctx.packageName, HOME_ALIAS)
        pm.setComponentEnabledSetting(alias, PackageManager.COMPONENT_ENABLED_STATE_ENABLED, PackageManager.DONT_KILL_APP)
        val filter = IntentFilter(Intent.ACTION_MAIN).apply {
            addCategory(Intent.CATEGORY_HOME)
            addCategory(Intent.CATEGORY_DEFAULT)
        }
        dpm.addPersistentPreferredActivity(admin, filter, alias)

        val pkgs = launchable(ctx).toTypedArray()
        val failed = try { dpm.setPackagesSuspended(admin, pkgs, true).toSet() } catch (_: Throwable) { pkgs.toSet() }
        val paused = JSONArray()
        pkgs.filter { it !in failed }.forEach { paused.put(it) }

        App.store.patchConfig(JSONObject().put("kioskLocked", true).put("kioskPin", hash(pin)).put("kioskPaused", paused))
        return result(true, "Locked. Home now always opens Screenroom, and ${paused.length()} other apps are paused.")
    }

    fun unlock(ctx: Context, pin: String): JSONObject {
        val cfg = App.store.config
        if (!isLocked()) return result(true, "Not locked.")
        if (hash(pin) != cfg.optString("kioskPin")) {
            Thread.sleep(800)
            return result(false, "Wrong PIN.")
        }
        val dpm = dpm(ctx)
        val admin = admin(ctx)
        if (dpm != null && isOwner(ctx)) {
            try { dpm.clearPackagePersistentPreferredActivities(admin, ctx.packageName) } catch (_: Throwable) {}
            val paused = cfg.optJSONArray("kioskPaused") ?: JSONArray()
            val list = (0 until paused.length()).map { paused.getString(it) }.toTypedArray()
            try { if (list.isNotEmpty()) dpm.setPackagesSuspended(admin, list, false) } catch (_: Throwable) {}
        }
        ctx.packageManager.setComponentEnabledSetting(
            ComponentName(ctx.packageName, HOME_ALIAS), PackageManager.COMPONENT_ENABLED_STATE_DISABLED, PackageManager.DONT_KILL_APP
        )
        App.store.patchConfig(JSONObject().put("kioskLocked", false).put("kioskPaused", JSONArray()))
        return result(true, "Unlocked. Everything is back to normal.")
    }

    /** Hand the box back to Android completely (Screenroom can then be uninstalled). */
    fun release(ctx: Context): JSONObject {
        if (isLocked()) return result(false, "Unlock first.")
        if (!isOwner(ctx)) return result(true, "Screenroom doesn't control this box.")
        return try {
            @Suppress("DEPRECATION")
            dpm(ctx)?.clearDeviceOwnerApp(ctx.packageName)
            result(true, "Released. Screenroom is now an ordinary app.")
        } catch (e: Throwable) {
            result(false, "Couldn't release: ${e.message}")
        }
    }
}
