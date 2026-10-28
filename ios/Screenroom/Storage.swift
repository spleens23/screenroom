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
        for d in [films, music, data, art, avatars] {
            try? fm.createDirectory(at: d, withIntermediateDirectories: true)
        }
        // Profiles and progress are backed up; the cover-art cache (rebuilt by a scan) isn't.
        var cacheURL = art
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? cacheURL.setResourceValues(values)
        installWeb()
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
        let p = URL(fileURLWithPath: path).standardizedFileURL.path
        let d = dir.standardizedFileURL.path
        return p.hasPrefix(d + "/")
    }

    /// Delete films or songs (and their subtitles / covers beside them), then folders left empty.
    func deleteFiles(_ paths: [String]) -> (removed: Int, freed: Int64) {
        var removed = 0
        var freed: Int64 = 0
        var dirs = Set<URL>()
        for p in paths {
            guard isInside(p, docs) || isInside(p, avatars) else { continue }
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
            while isInside(d.path, docs), d.standardizedFileURL != films.standardizedFileURL, d.standardizedFileURL != music.standardizedFileURL {
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

let videoExtensions: Set<String> = ["mp4", "m4v", "mov"]
let audioExtensions: Set<String> = ["mp3", "m4a", "m4b", "aac", "flac", "alac", "wav", "aif", "aiff", "caf"]
