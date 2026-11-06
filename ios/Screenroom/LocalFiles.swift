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

    private struct Reply { let status: Int; let headers: [String: String]; let body: Data }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let key = ObjectIdentifier(task)
        lock.lock(); live.insert(key); lock.unlock()
        let url = task.request.url
        let range = task.request.value(forHTTPHeaderField: "Range")
        io.async { [weak self] in
            guard let self else { return }
            let reply = url.flatMap { self.read($0, range: range) }
            DispatchQueue.main.async {
                self.lock.lock(); let ok = self.live.remove(key) != nil; self.lock.unlock()
                guard ok, let url else { return }
                guard let reply else {
                    task.didFailWithError(NSError(domain: NSURLErrorDomain, code: NSURLErrorFileDoesNotExist))
                    return
                }
                task.didReceive(HTTPURLResponse(url: url, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: reply.headers)!)
                task.didReceive(reply.body)
                task.didFinish()
            }
        }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        lock.lock(); live.remove(ObjectIdentifier(task)); lock.unlock()
    }

    private func read(_ url: URL, range: String?) -> Reply? {
        let path = (url.path as NSString).standardizingPath
        // (the app's folder is also reachable as /private/var/…, a link to /var/…)
        let homes = [NSHomeDirectory(), "/private" + NSHomeDirectory()].map { ($0 as NSString).standardizingPath }
        guard homes.contains(where: { path.hasPrefix($0 + "/") }),
              let size = (try? FileManager.default.attributesOfItem(atPath: path)[.size] as? NSNumber)?.int64Value,
              let fh = FileHandle(forReadingAtPath: path) else { return nil }
        defer { try? fh.close() }
        let mime = UTType(filenameExtension: (path as NSString).pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        var headers = ["Content-Type": mime, "Accept-Ranges": "bytes", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-cache"]
        // "bytes=START-END" or "bytes=START-": send that piece (at most 4 MB at a time)
        if let range, range.hasPrefix("bytes="), size > 0 {
            let parts = range.dropFirst(6).split(separator: "-", omittingEmptySubsequences: false)
            if let first = parts.first, let start = Int64(first), start < size {
                var end = parts.count > 1 ? (Int64(parts[1]) ?? size - 1) : size - 1
                end = min(end, size - 1, start + 4 * 1024 * 1024 - 1)
                try? fh.seek(toOffset: UInt64(start))
                let body = (try? fh.read(upToCount: Int(end - start + 1))) ?? Data()
                headers["Content-Range"] = "bytes \(start)-\(start + Int64(body.count) - 1)/\(size)"
                headers["Content-Length"] = String(body.count)
                return Reply(status: 206, headers: headers, body: body)
            }
        }
        let body = (try? fh.readToEnd()) ?? Data()
        headers["Content-Length"] = String(body.count)
        return Reply(status: 200, headers: headers, body: body)
    }
}
