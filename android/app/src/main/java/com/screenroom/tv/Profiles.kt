package com.screenroom.tv

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * User profiles (same rules as the desktop app's lib/profiles.js): profiles.json holds the list, each
 * profile's watch progress is its own file, and the first profile ("main") keeps progress.json so the
 * history from before profiles existed carries over.
 */
class Profiles(private val dir: File) {
    private val file = File(dir, "profiles.json")
    private var data: JSONObject = Store.readObj(file)

    init {
        val list = data.optJSONArray("profiles")
        if (list == null || list.length() == 0) {
            data = JSONObject()
                .put("profiles", JSONArray().put(JSONObject().put("id", "main").put("name", "Main").put("color", COLORS[0]).put("kids", false)))
                .put("last", "main")
            save()
        }
    }

    companion object {
        const val MAX = 8
        val COLORS = listOf("#b5523a", "#2f80ed", "#27ae60", "#f2c94c", "#9b51e0", "#f2994a", "#56ccf2", "#eb5757")

        private fun hash(salt: String, pin: String): String =
            MessageDigest.getInstance("SHA-256").digest("$salt:$pin".toByteArray()).joinToString("") { "%02x".format(it) }

        private fun ok(): JSONObject = JSONObject().put("ok", true)
        private fun fail(msg: String): JSONObject = JSONObject().put("ok", false).put("error", msg)
    }

    @Synchronized private fun save() = Store.writeObj(file, data)

    private fun all(): List<JSONObject> {
        val a = data.getJSONArray("profiles")
        return (0 until a.length()).map { a.getJSONObject(it) }
    }

    fun get(id: String?): JSONObject? = all().firstOrNull { it.optString("id") == id }
    fun last(): JSONObject = get(data.optString("last")) ?: all().first()
    fun needsPicker(): Boolean = all().size > 1 || all().first().has("pinHash")

    @Synchronized fun setLast(id: String) { if (get(id) != null) { data.put("last", id); save() } }

    /** What the UI may see (never the PIN hash). */
    fun public(p: JSONObject?): JSONObject? {
        p ?: return null
        return JSONObject()
            .put("id", p.optString("id")).put("name", p.optString("name")).put("color", p.optString("color"))
            .put("kids", p.optBoolean("kids")).put("maxLevel", p.optInt("maxLevel", 1))
            .put("allowUnrated", p.optBoolean("allowUnrated")).put("hasPin", p.has("pinHash"))
            .put("preferredLang", p.optString("preferredLang")).put("subLang", p.optString("subLang"))
            .also { o ->
                val photo = photoFile(p)
                val av = p.optString("avatar")
                o.put("avatar", if (av == "photo" && photo == null) "" else av)
                if (photo != null) o.put("photo", photo.absolutePath)
            }
    }

    // ---- profile pictures: "" (initial), "char:<id>" (a character), or "photo" ----------------------------
    private val avatarDir = File(dir, "avatars")
    private fun photoFile(p: JSONObject): File? = p.optString("photo").takeIf { it.isNotEmpty() }?.let { File(avatarDir, it) }?.takeIf { it.isFile }
    fun photoPath(id: String): String? = get(id)?.let { photoFile(it) }?.absolutePath

    @Synchronized fun setPhoto(id: String, bytes: ByteArray, ext: String): JSONObject {
        val p = get(id) ?: return fail("Profile not found")
        if (bytes.isEmpty() || bytes.size > 12 * 1024 * 1024) return fail("That picture is too big.")
        val e = ext.lowercase().let { if (it == "jpeg") "jpg" else it }
        if (!e.matches(Regex("^(jpg|png|webp|gif)$"))) return fail("Use a JPEG, PNG or WebP picture.")
        avatarDir.mkdirs()
        photoFile(p)?.delete()
        val name = "${p.optString("id")}-${System.currentTimeMillis()}.$e"
        File(avatarDir, name).writeBytes(bytes)
        p.put("photo", name).put("avatar", "photo")
        save()
        return ok().put("profile", public(p))
    }

    fun list(): JSONArray = JSONArray().also { a -> all().forEach { a.put(public(it)) } }

    fun progressFile(id: String): File = File(dir, if (id == "main") "progress.json" else "progress-$id.json")

    fun checkPin(id: String, pin: String): Boolean {
        val p = get(id) ?: return false
        if (!p.has("pinHash")) return true
        return MessageDigest.isEqual(p.getString("pinHash").toByteArray(), hash(p.optString("pinSalt"), pin).toByteArray())
    }

    @Synchronized fun upsert(input: JSONObject): JSONObject {
        val name = input.optString("name").replace(Regex("[\\u0000-\\u001f]"), "").trim().take(24)
        if (name.isEmpty()) return fail("Give the profile a name.")
        val id = input.optString("id").takeIf { it.isNotEmpty() }
        val existing: JSONObject? = if (id != null) (get(id) ?: return fail("Profile not found")) else null
        val existingId = existing?.optString("id")
        if (all().any { it.optString("name").equals(name, ignoreCase = true) && it.optString("id") != existingId }) {
            return fail("There is already a profile with that name.")
        }
        val p: JSONObject = existing ?: run {
            if (all().size >= MAX) return fail("Up to $MAX profiles.")
            val used = all().map { it.optString("color") }.toSet()
            val newId = ByteArray(4).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
            val created = JSONObject().put("id", newId).put("color", COLORS.firstOrNull { it !in used } ?: COLORS[0])
            data.getJSONArray("profiles").put(created)
            created
        }
        p.put("name", name)
        input.optString("color").takeIf { it.matches(Regex("^#[0-9a-fA-F]{6}$")) }?.let { p.put("color", it) }
        if (input.has("kids")) p.put("kids", input.optBoolean("kids"))
        if (input.has("maxLevel")) p.put("maxLevel", input.optInt("maxLevel", 1).coerceIn(1, 3))
        if (input.has("allowUnrated")) p.put("allowUnrated", input.optBoolean("allowUnrated"))
        if (input.has("preferredLang")) p.put("preferredLang", input.optString("preferredLang").take(8))
        if (input.has("subLang")) p.put("subLang", input.optString("subLang").take(8))
        if (input.has("avatar")) {
            val av = input.optString("avatar")
            when {
                av.isEmpty() || av.matches(Regex("^char:[a-z]{2,20}$")) -> p.put("avatar", av)
                av == "photo" && photoFile(p) != null -> p.put("avatar", av)
            }
        }
        save()
        return ok().put("profile", public(p))
    }

    @Synchronized fun setPin(id: String, pin: String?): JSONObject {
        val p = get(id) ?: return fail("Profile not found")
        if (pin.isNullOrEmpty()) { p.remove("pinHash"); p.remove("pinSalt"); save(); return ok() }
        if (!pin.matches(Regex("^\\d{4}$"))) return fail("A PIN is 4 digits.")
        val salt = ByteArray(8).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
        p.put("pinSalt", salt).put("pinHash", hash(salt, pin))
        save()
        return ok()
    }

    @Synchronized fun remove(id: String): JSONObject {
        val list = all()
        if (list.size <= 1) return fail("You can't delete the only profile.")
        if (list.none { it.optString("id") == id }) return fail("Profile not found")
        get(id)?.let { photoFile(it)?.delete() }
        val keep = JSONArray()
        list.filter { it.optString("id") != id }.forEach { keep.put(it) }
        data.put("profiles", keep)
        if (data.optString("last") == id) data.put("last", keep.getJSONObject(0).optString("id"))
        save()
        if (id != "main") progressFile(id).delete()
        return ok()
    }
}
