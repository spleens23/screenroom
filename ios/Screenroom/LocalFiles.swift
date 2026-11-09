import Foundation
import WebKit
import UniformTypeIdentifiers

/// Hands the page files from the app's own folder (cover art, profile photos, album covers, moving covers) as
/// srfile://f/<path>. On a real iPhone or iPad the page can't read files outside its own folder by file: address
/// (the simulator allows it), so pictures showed as a broken-image box. Videos are asked for in pieces ("Range"
/// requests), which are answered piece by piece so a moving cover never has to be read into memory whole.
final class LocalFiles: NSObject, WKURLSchemeHandler {
    static let scheme = "srfile"
    private let io = DispatchQueue(label: "screenroom.localfiles", qos: .userInitiated, attributes: .concurrent)
    private var live = Set<ObjectIdentifier>()
    private let lock = NSLock()

    private struct Reply { let status: Int; let headers: [String: String]; let path: String; let start: Int64; let length: Int64 }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let key = ObjectIdentifier(task)
        lock.lock(); live.insert(key); lock.unlock()
        let url = task.request.url
        let range = task.request.value(forHTTPHeaderField: "Range")
        io.async { [weak self] in
            guard let self else { return }
            guard let url, let reply = self.plan(url, range: range), let fh = FileHandle(forReadingAtPath: reply.path) else {
                DispatchQueue.main.async {
                    guard self.finish(key) else { return }
                    task.didFailWithError(NSError(domain: NSURLErrorDomain, code: NSURLErrorFileDoesNotExist))
                }
                return
            }
            defer { try? fh.close() }
            let response = HTTPURLResponse(url: url, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: reply.headers)!
            guard self.onMain(key, { task.didReceive(response) }) else { return }
            // The whole piece that was asked for, sent 1 MB at a time. (Sending less than the page asked for
            // stalled a moving cover bigger than a few MB on a real phone: the player waited for bytes that
            // never came.)
            try? fh.seek(toOffset: UInt64(reply.start))
            var left = reply.length
            while left > 0 {
                let chunk = (try? fh.read(upToCount: Int(min(left, 1 << 20)))) ?? Data()
                if chunk.isEmpty { break }
                left -= Int64(chunk.count)
                guard self.onMain(key, { task.didReceive(chunk) }) else { return }
            }
            DispatchQueue.main.async { if self.finish(key) { task.didFinish() } }
        }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        lock.lock(); live.remove(ObjectIdentifier(task)); lock.unlock()
    }

    private func isLive(_ key: ObjectIdentifier) -> Bool { lock.lock(); defer { lock.unlock() }; return live.contains(key) }
    private func finish(_ key: ObjectIdentifier) -> Bool { lock.lock(); defer { lock.unlock() }; return live.remove(key) != nil }

    /// Runs `body` on the main thread while the task is still wanted; false once the page has cancelled it.
    private func onMain(_ key: ObjectIdentifier, _ body: @escaping () -> Void) -> Bool {
        var ok = false
        DispatchQueue.main.sync { if self.isLive(key) { body(); ok = true } }
        return ok
    }

    private func plan(_ url: URL, range: String?) -> Reply? {
        let path = (url.path as NSString).standardizingPath
        // (the app's folder is also reachable as /private/var/…, a link to /var/…)
        // (and music folders Parlor reads where they are: their covers and moving covers)
        let roots = [NSHomeDirectory()] + Storage.shared.linked.map(\.path)
        let homes = roots.flatMap { [$0, "/private" + $0, $0.hasPrefix("/private/") ? String($0.dropFirst(8)) : $0] }.map { ($0 as NSString).standardizingPath }
        guard homes.contains(where: { path.hasPrefix($0 + "/") }),
              let size = (try? FileManager.default.attributesOfItem(atPath: path)[.size] as? NSNumber)?.int64Value else { return nil }
        let mime = UTType(filenameExtension: (path as NSString).pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        var headers = ["Content-Type": mime, "Accept-Ranges": "bytes", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-cache"]
        // "bytes=START-END", "bytes=START-" or "bytes=-SUFFIX"
        if let range, range.hasPrefix("bytes="), size > 0 {
            let parts = range.dropFirst(6).split(separator: ",").first?.split(separator: "-", omittingEmptySubsequences: false) ?? []
            if parts.count == 2 {
                var start: Int64, end: Int64
                if parts[0].isEmpty, let suffix = Int64(parts[1].trimmingCharacters(in: .whitespaces)) {
                    start = max(0, size - suffix); end = size - 1
                } else if let s0 = Int64(parts[0].trimmingCharacters(in: .whitespaces)) {
                    start = s0; end = Int64(parts[1].trimmingCharacters(in: .whitespaces)) ?? size - 1
                } else { start = 0; end = size - 1 }
                end = min(end, size - 1)
                if start <= end {
                    headers["Content-Range"] = "bytes \(start)-\(end)/\(size)"
                    headers["Content-Length"] = String(end - start + 1)
                    return Reply(status: 206, headers: headers, path: path, start: start, length: end - start + 1)
                }
                headers["Content-Range"] = "bytes */\(size)"
                return Reply(status: 416, headers: headers, path: path, start: 0, length: 0)
            }
        }
        headers["Content-Length"] = String(size)
        return Reply(status: 200, headers: headers, path: path, start: 0, length: size)
    }
}
