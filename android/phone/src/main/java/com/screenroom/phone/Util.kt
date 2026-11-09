package com.screenroom.phone

import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.security.SecureRandom

/** A message for the page ("That folder isn't Parlor's."), shown as it is. */
class ParlorError(message: String) : Exception(message)

// ---- JSON: the page's values as plain Kotlin maps and lists, and back ----------------------------------------

/** org.json values as Map / List / String / Number / Boolean / null. */
fun plain(v: Any?): Any? = when (v) {
    null, JSONObject.NULL -> null
    is JSONObject -> { val m = LinkedHashMap<String, Any?>(); for (k in v.keys()) m[k] = plain(v.opt(k)); m }
    is JSONArray -> (0 until v.length()).map { plain(v.opt(it)) }
    else -> v
}

/** Kotlin values (maps, lists, numbers …) as JSON text. */
fun toJson(v: Any?): String = when (v) {
    null, Unit -> "null"
    is String -> JSONObject.quote(v)
    is Map<*, *>, is Collection<*>, is Array<*> -> wrap(v).toString()
    is Double -> if (v.isFinite()) v.toString() else "0"
    is Float -> if (v.isFinite()) v.toString() else "0"
    is Number, is Boolean -> v.toString()
    else -> JSONObject.quote(v.toString())
}

fun wrap(v: Any?): Any = when (v) {
    null, Unit -> JSONObject.NULL
    is Map<*, *> -> JSONObject().also { o -> for ((k, x) in v) o.put(k.toString(), wrap(x)) }
    is Collection<*> -> JSONArray().also { a -> for (x in v) a.put(wrap(x)) }
    is Array<*> -> JSONArray().also { a -> for (x in v) a.put(wrap(x)) }
    is Double -> if (v.isFinite()) v else 0.0
    is Float -> if (v.isFinite()) v.toDouble() else 0.0
    else -> v
}

fun parseJson(text: String): Any? = plain(org.json.JSONTokener(text).nextValue())

@Suppress("UNCHECKED_CAST")
fun Any?.asMap(): Map<String, Any?>? = this as? Map<String, Any?>
@Suppress("UNCHECKED_CAST")
fun Any?.asList(): List<Any?>? = this as? List<Any?>
fun Any?.asNum(): Double? = (this as? Number)?.toDouble()

// ---- small helpers ------------------------------------------------------------------------------------------

private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }
fun sha1Hex(s: String): String = hex(MessageDigest.getInstance("SHA-1").digest(s.toByteArray()))
fun sha256Hex(s: String): String = hex(MessageDigest.getInstance("SHA-256").digest(s.toByteArray()))
fun randomHex(bytes: Int): String = ByteArray(bytes.coerceIn(1, 64)).also { SecureRandom().nextBytes(it) }.let(::hex)

val audioExtensions = setOf("mp3", "m4a", "m4b", "aac", "flac", "alac", "wav", "aif", "aiff", "caf", "ac3", "ec3", "eac3", "ogg", "opus")
val boxExtensions = setOf("mp4", "m4v", "mov")
val imageExtensions = setOf("jpg", "jpeg", "png", "webp")

/** An album's moving cover: cover.mp4, folder.mov, motion.mp4 … (as on the iPhone). */
private val motionName = Regex("^(cover|folder|front|album|artwork|motion|animated|(animated|motion)[ _-]?cover|cover[ _-]?(animated|motion|loop))\\.(mp4|m4v|mov|webm)$", RegexOption.IGNORE_CASE)
fun isMotionCover(name: String): Boolean = motionName.matches(name)
