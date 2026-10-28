import UIKit
import WebKit

/// What the page's `window.api` (ios-api.js) asks the app to do. Each call gets an answer back as JSON;
/// events (progress, the music player, new files) are sent to the page as they happen.
final class Bridge: NSObject, WKScriptMessageHandler {
    weak var web: WKWebView?
    weak var host: UIViewController?
    private let st = Storage.shared
    private lazy var importer = Importer()

    func userContentController(_ uc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let id = body["id"] as? Int, let method = body["method"] as? String else { return }
        if method == "debugLog" {
            let line = ((try? JSONSerialization.jsonObject(with: Data((body["args"] as? String ?? "[]").utf8))) as? [Any])?.first as? String ?? ""
            let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            let url = caches.appendingPathComponent("page-errors.log")
            if (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int ?? 0) ?? 0 > 200_000 { try? FileManager.default.removeItem(at: url) }
            if let h = try? FileHandle(forWritingTo: url) { h.seekToEndOfFile(); h.write(Data((line + "\n").utf8)); try? h.close() }
            else { try? (line + "\n").write(to: url, atomically: true, encoding: .utf8) }
            NSLog("Screenroom page: %@", line)
            return
        }
        let argsJson = body["args"] as? String ?? "[]"
        let args = (try? JSONSerialization.jsonObject(with: Data(argsJson.utf8))) as? [Any] ?? []
        Task { @MainActor in
            var value: Any
            do {
                value = try await self.handle(method, args) ?? NSNull()
            } catch {
                value = ["__error": error.localizedDescription]
            }
            self.reply(id, value)
        }
    }

    private func reply(_ id: Int, _ value: Any) {
        send("window.__iosReply(\(id), \(jsString(json(value))))")
    }

    func emit(_ name: String, _ payload: Any) {
        DispatchQueue.main.async {
            self.send("window.__iosEvent(\(self.jsString(name)), \(self.jsString(self.json(payload))))")
        }
    }

    private func send(_ js: String) {
        DispatchQueue.main.async { self.web?.evaluateJavaScript(js, completionHandler: nil) }
    }

    private func json(_ v: Any) -> String {
        if v is NSNull { return "null" }
        guard let d = try? JSONSerialization.data(withJSONObject: v, options: [.fragmentsAllowed]) else { return "null" }
        return String(data: d, encoding: .utf8) ?? "null"
    }

    private func jsString(_ s: String) -> String {
        // a JSON string literal is a valid JavaScript string literal
        guard let d = try? JSONSerialization.data(withJSONObject: [s], options: []), let a = String(data: d, encoding: .utf8) else { return "\"\"" }
        return String(a.dropFirst().dropLast())
    }

    private func arg<T>(_ args: [Any], _ i: Int) -> T? { i < args.count ? args[i] as? T : nil }

    // ---- the calls ---------------------------------------------------------------------------------------------
    @MainActor
    private func handle(_ m: String, _ a: [Any]) async throws -> Any? {
        switch m {
        case "boot":
            return ["docs": st.docs.path, "films": st.films.path, "music": st.music.path, "data": st.data.path,
                    "art": st.art.path, "avatars": st.avatars.path, "device": UIDevice.current.model]
        case "readJson":
            guard let name: String = arg(a, 0) else { return nil }
            return st.readJson(name)
        case "writeJson":
            guard let name: String = arg(a, 0), a.count > 1 else { return false }
            try st.writeJson(name, a[1])
            return true
        case "scanVideos":
            let cacheOnly = ((arg(a, 0) as [String: Any]?)?["cacheOnly"] as? Bool) ?? false
            return await Scanner.shared.scanVideos(cacheOnly: cacheOnly) { done, total in
                self.emit("scan-progress", ["done": done, "total": total])
            }
        case "scanAudio":
            let cacheOnly = ((arg(a, 0) as [String: Any]?)?["cacheOnly"] as? Bool) ?? false
            return await Scanner.shared.scanAudio(cacheOnly: cacheOnly) { done, total in
                self.emit("scan-progress", ["done": done, "total": total, "music": true])
            }
        case "sha256":
            return sha256Hex(arg(a, 0) ?? "")
        case "random":
            return randomHex((arg(a, 0) as NSNumber?)?.intValue ?? 8)
        case "playVideo":
            guard let opts: [String: Any] = arg(a, 0), let host else { throw ScreenroomError("Nothing to play.") }
            try VideoPlayback.start(opts, from: host.presentedViewController ?? host, bridge: self)
            return ["ok": true]
        case "musicPlay":
            guard let o: [String: Any] = arg(a, 0), let tracks = o["tracks"] as? [[String: Any]] else { throw ScreenroomError("Nothing to play.") }
            MusicPlayer.shared.bridge = self
            MusicPlayer.shared.play(tracks: tracks, start: (o["start"] as? NSNumber)?.intValue ?? 0, context: o["context"])
            return ["ok": true]
        case "musicCmd":
            MusicPlayer.shared.bridge = self
            return MusicPlayer.shared.command(arg(a, 0) ?? "", a.count > 1 ? a[1] : nil)
        case "importFiles":
            guard let host else { return ["count": 0] }
            let n = await importer.pick(kind: arg(a, 0) ?? "any", from: host)
            return ["count": n]
        case "pickPhoto":
            guard let host else { return nil }
            let name: String? = arg(a, 0)
            let destBase: String? = arg(a, 1)
            guard let img = await importer.pickPhoto(from: host) else { return nil }
            if let base = destBase {
                // a cover for an album: cover.jpg in the album's folder
                guard st.isInside(base, st.docs) else { throw ScreenroomError("That folder isn't Screenroom's.") }
                let dest = URL(fileURLWithPath: base + ".jpg")
                guard let saved = saveJPEG(img, width: 1200, to: dest, quality: 0.9) else { throw ScreenroomError("Couldn't save the picture.") }
                return ["path": saved]
            }
            let file = "\((name ?? randomHex(4)).replacingOccurrences(of: "/", with: "-")).jpg"
            guard let saved = saveJPEG(img, width: 600, to: st.avatars.appendingPathComponent(file), quality: 0.85) else { throw ScreenroomError("Couldn't save the picture.") }
            return ["name": file, "path": saved]
        case "deleteFiles":
            let r = st.deleteFiles(arg(a, 0) ?? [])
            return ["removed": r.removed, "freed": r.freed]
        case "freeSpace":
            return st.freeSpace()
        case "listImages":
            return Scanner.shared.listImages(arg(a, 0) ?? "")
        case "httpGetJson":
            guard let s: String = arg(a, 0), let url = URL(string: s), url.scheme == "https" else { throw ScreenroomError("Bad address") }
            var req = URLRequest(url: url, timeoutInterval: 12)
            req.setValue("Screenroom/1.0 (iPad)", forHTTPHeaderField: "User-Agent")
            let (data, _) = try await URLSession.shared.data(for: req)
            return try JSONSerialization.jsonObject(with: data)
        case "download":
            guard let s: String = arg(a, 0), let url = URL(string: s), url.scheme == "https", url.host?.hasSuffix(".mzstatic.com") == true,
                  let dest: String = arg(a, 1), st.isInside(dest, st.docs) else { throw ScreenroomError("Bad address") }
            let (data, _) = try await URLSession.shared.data(from: url)
            guard UIImage(data: data) != nil else { throw ScreenroomError("That isn't a picture.") }
            try data.write(to: URL(fileURLWithPath: dest), options: .atomic)
            return dest
        default:
            throw ScreenroomError("Unknown call: \(m)")
        }
    }
}
