import Foundation
import CryptoKit

/// Where everything lives.
///  - Documents/Films and Documents/Music: your films and songs ("On My iPad › Screenroom" in the Files app).
///  - Application Support/Screenroom: Screenroom's own small JSON files, cover art, profile pictures, and a
///    copy of the screens (web pages) the app shows.
final class Storage {
    static let shared = Storage()
    let fm = FileManager.default

    let docs: URL
    let films: URL
    let music: URL
    let data: URL
    let art: URL
    let avatars: URL
    let web: URL

    private init() {
        docs = fm.urls(for: .documentDirectory, in: .userDomainMask)[0]
        films = docs.appendingPathComponent("Films", isDirectory: true)
        music = docs.appendingPathComponent("Music", isDirectory: true)
        let support = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        data = support.appendingPathComponent("Screenroom", isDirectory: true)
        art = data.appendingPathComponent("art", isDirectory: true)
        avatars = data.appendingPathComponent("avatars", isDirectory: true)
        web = data.appendingPathComponent("web", isDirectory: true)
    }

    func prepare() {
        // each app has its own folder in the Files app: Screenroom › Films, Parlor › Music
        for d in [isParlorApp ? music : films, data, art, avatars] {
            try? fm.createDirectory(at: d, withIntermediateDirectories: true)
        }
        // Profiles and progress are backed up; the cover-art cache (rebuilt by a scan) isn't.
        var cacheURL = art
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? cacheURL.setResourceValues(values)
        installWeb()
        if isParlorApp { loadLinked() }
    }

    // ---- music folders that stay where they are ------------------------------------------------------------
    // A folder picked in the Files app (On My iPad › Music, iCloud Drive …) that Parlor reads where it is rather
    // than copying in, so songs added to it or taken out of it show up in Parlor as they are. iOS lets the app
    // back into the folder after a restart through a saved "bookmark".
    private var linkedNow: [URL] = []
    private let linkLock = NSLock()
    var linked: [URL] { linkLock.lock(); defer { linkLock.unlock() }; return linkedNow }

    private func loadLinked() {
        var out: [URL] = []
        var marks: [String] = []
        for b64 in (readJson("linked-folders") as? [String]) ?? [] {
            guard let d = Data(base64Encoded: b64) else { continue }
            var stale = false
            guard let u = try? URL(resolvingBookmarkData: d, options: [], relativeTo: nil, bookmarkDataIsStale: &stale) else { continue }
            _ = u.startAccessingSecurityScopedResource() // (kept open while the app runs)
            if stale, let fresh = try? u.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) {
                marks.append(fresh.base64EncodedString())
            } else { marks.append(b64) }
            out.append(u)
        }
        try? writeJson("linked-folders", marks)
        linkLock.lock(); linkedNow = out; linkLock.unlock()
    }

    /// Keep a folder picked in the Files app. Returns its path.
    func link(_ url: URL) throws -> String {
        guard url.startAccessingSecurityScopedResource() || fm.isReadableFile(atPath: url.path) else { throw ScreenroomError("Parlor wasn't allowed into that folder.") }
        if isInside(url.path + "/x", docs) { throw ScreenroomError("That's Parlor's own folder; it's read already.") }
        let mark = try url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
        var marks = (readJson("linked-folders") as? [String]) ?? []
        linkLock.lock()
        let had = linkedNow.firstIndex { canonical($0) == canonical(url) }
        if let i = had { linkedNow[i] = url; if i < marks.count { marks[i] = mark.base64EncodedString() } }
        else { linkedNow.append(url); marks.append(mark.base64EncodedString()) }
        linkLock.unlock()
        try writeJson("linked-folders", marks)
        return url.path
    }

    func unlink(_ path: String) {
        var marks = (readJson("linked-folders") as? [String]) ?? []
        linkLock.lock()
        if let i = linkedNow.firstIndex(where: { canonical($0) == canonical(URL(fileURLWithPath: path)) }) {
            linkedNow[i].stopAccessingSecurityScopedResource()
            linkedNow.remove(at: i)
            if i < marks.count { marks.remove(at: i) }
        }
        linkLock.unlock()
        try? writeJson("linked-folders", marks)
    }

    /// Inside Parlor's own folder or one of the folders it reads where they are.
    func isMine(_ path: String) -> Bool {
        isInside(path, docs) || linked.contains { isInside(path, $0) }
    }

    /// The screens ship inside the app; they're copied next to the data so the web view may show both them and
    /// cover art from the same place (a web view reads files only under one folder).
    private func installWeb() {
        guard let bundled = Bundle.main.url(forResource: "Web", withExtension: nil) else { return }
        let stamp = web.appendingPathComponent(".version")
        let version = (Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "0") + "-" +
            (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0")
        #if DEBUG
        let fresh = false
        #else
        let fresh = (try? String(contentsOf: stamp, encoding: .utf8)) == version
        #endif
        if fresh && fm.fileExists(atPath: web.appendingPathComponent("renderer/index.html").path) { return }
        try? fm.removeItem(at: web)
        do {
            try fm.copyItem(at: bundled, to: web)
            try version.write(to: stamp, atomically: true, encoding: .utf8)
        } catch {
            NSLog("Screenroom: couldn't install the screens: \(error)")
        }
    }

    // ---- small JSON files ----------------------------------------------------------------------------
    private let lock = NSLock()

    private func jsonURL(_ name: String) -> URL? {
        guard name.range(of: "^[a-z0-9-]{1,48}$", options: .regularExpression) != nil else { return nil }
        return data.appendingPathComponent("\(name).json")
    }

    func readJson(_ name: String) -> Any? {
        guard let url = jsonURL(name), let d = try? Data(contentsOf: url) else { return nil }
        return try? JSONSerialization.jsonObject(with: d, options: [.fragmentsAllowed])
    }

    func writeJson(_ name: String, _ value: Any) throws {
        guard let url = jsonURL(name) else { throw ScreenroomError("Bad name") }
        let d = try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed])
        lock.lock(); defer { lock.unlock() }
        try d.write(to: url, options: .atomic)
    }

    // ---- files ------------------------------------------------------------------------------------------
    func freeSpace() -> Int64 {
        let v = try? docs.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        return v?.volumeAvailableCapacityForImportantUsage ?? 0
    }

    /// Path inside Documents, for ids that survive the app's folder moving (e.g. after a restore).
    func relativeToDocs(_ url: URL) -> String {
        let p = url.standardizedFileURL.path
        let d = docs.standardizedFileURL.path
        return p.hasPrefix(d + "/") ? String(p.dropFirst(d.count + 1)) : p
    }

    func isInside(_ path: String, _ dir: URL) -> Bool {
        let p = canonical(URL(fileURLWithPath: path))
        let d = canonical(dir)
        return p.hasPrefix(d + "/")
    }

    /// One spelling for a path: the app's folder shows up both as /var/… and /private/var/… (a link), and a
    /// file that doesn't exist yet (a new cover.jpg) can't have its links resolved, so its folder's are.
    func canonical(_ url: URL) -> String {
        var u = url.standardizedFileURL
        var tail: [String] = []
        while !fm.fileExists(atPath: u.path), u.path != "/" { tail.insert(u.lastPathComponent, at: 0); u = u.deletingLastPathComponent() }
        var p = u.resolvingSymlinksInPath().path
        if p.hasPrefix("/private/") { p.removeFirst("/private".count) }
        for t in tail { p = (p as NSString).appendingPathComponent(t) }
        return p
    }

    /// Delete films or songs (and their subtitles / covers beside them), then folders left empty.
    func deleteFiles(_ paths: [String]) -> (removed: Int, freed: Int64) {
        var removed = 0
        var freed: Int64 = 0
        var dirs = Set<URL>()
        for p in paths {
            guard isMine(p) || isInside(p, avatars) else { continue }
            let url = URL(fileURLWithPath: p)
            let size = Int64((try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0)
            if (try? fm.removeItem(at: url)) != nil {
                removed += 1
                freed += size
                dirs.insert(url.deletingLastPathComponent())
                // subtitles next to a film: Film.srt, Film.en.srt …
                let base = url.deletingPathExtension().lastPathComponent
                if let kids = try? fm.contentsOfDirectory(atPath: url.deletingLastPathComponent().path) {
                    for k in kids where k.hasPrefix(base + ".") && ["srt", "vtt", "ass", "ssa", "sub", "idx"].contains((k as NSString).pathExtension.lowercased()) {
                        try? fm.removeItem(at: url.deletingLastPathComponent().appendingPathComponent(k))
                    }
                }
            }
        }
        // folders left with nothing worth keeping (only covers or hidden files)
        for var d in dirs {
            while isMine(d.path), !linked.contains(where: { canonical($0) == canonical(d) }), d.standardizedFileURL != films.standardizedFileURL, d.standardizedFileURL != music.standardizedFileURL {
                let kids = (try? fm.contentsOfDirectory(atPath: d.path)) ?? []
                let keep = kids.filter { !$0.hasPrefix(".") && !["jpg", "jpeg", "png", "webp", "txt", "nfo"].contains(($0 as NSString).pathExtension.lowercased()) }
                guard keep.isEmpty else { break }
                try? fm.removeItem(at: d)
                d = d.deletingLastPathComponent()
            }
        }
        return (removed, freed)
    }

    /// A free name in a folder: "Film.mp4", then "Film 2.mp4" …
    func freeName(in dir: URL, for name: String) -> URL {
        var url = dir.appendingPathComponent(name)
        let base = (name as NSString).deletingPathExtension
        let ext = (name as NSString).pathExtension
        var n = 2
        while fm.fileExists(atPath: url.path) {
            url = dir.appendingPathComponent(ext.isEmpty ? "\(base) \(n)" : "\(base) \(n).\(ext)")
            n += 1
        }
        return url
    }
}

struct ScreenroomError: LocalizedError {
    let message: String
    init(_ m: String) { message = m }
    var errorDescription: String? { message }
}

func sha1Hex(_ s: String) -> String {
    Insecure.SHA1.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined()
}

func sha256Hex(_ s: String) -> String {
    SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined()
}

func randomHex(_ bytes: Int) -> String {
    var b = [UInt8](repeating: 0, count: max(1, min(64, bytes)))
    _ = SecRandomCopyBytes(kSecRandomDefault, b.count, &b)
    return b.map { String(format: "%02x", $0) }.joined()
}

let videoExtensions: Set<String> = ["mp4", "m4v", "mov", "mkv", "avi", "webm", "ts", "m2ts", "mts", "wmv", "flv", "mpg", "mpeg", "vob", "ogv", "3gp"]
/// Films Apple's own player (AVFoundation) opens; everything else plays with mpv's engine.
let avVideoExtensions: Set<String> = ["mp4", "m4v", "mov"]
/// Pictures and subtitles that travel with films and songs when a folder is imported.
let sidecarExtensions: Set<String> = ["jpg", "jpeg", "png", "webp", "srt", "vtt", "ass", "ssa"]
let audioExtensions: Set<String> = ["mp3", "m4a", "m4b", "aac", "flac", "alac", "wav", "aif", "aiff", "caf", "ac3", "ec3", "eac3"] // (Dolby Digital surround too)

/// Which app this is: "screenroom" (films) or "parlor" (music), from the app's Info.plist. The same code builds both.
let appKind: String = (Bundle.main.object(forInfoDictionaryKey: "SRApp") as? String) ?? "screenroom"
let isParlorApp = appKind == "parlor"
