import Foundation
import WebKit
import UniformTypeIdentifiers

/// Hands the page pictures from the app's own folder (cover art, profile photos, album covers) as
/// srfile://f/<path>. On a real iPad the page can't read files outside its own folder by file: address (the
/// simulator allows it), so pictures showed as a broken-image box.
final class LocalFiles: NSObject, WKURLSchemeHandler {
    static let scheme = "srfile"
    private let io = DispatchQueue(label: "screenroom.localfiles", qos: .userInitiated, attributes: .concurrent)
    private var live = Set<ObjectIdentifier>()
    private let lock = NSLock()

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let key = ObjectIdentifier(task)
        lock.lock(); live.insert(key); lock.unlock()
        let url = task.request.url
        io.async { [weak self] in
            guard let self else { return }
            let path = url.map { ($0.path as NSString).standardizingPath } ?? ""
            let home = (NSHomeDirectory() as NSString).standardizingPath
            var data: Data?
            if path.hasPrefix(home + "/") { data = try? Data(contentsOf: URL(fileURLWithPath: path), options: .mappedIfSafe) }
            DispatchQueue.main.async {
                self.lock.lock(); let ok = self.live.remove(key) != nil; self.lock.unlock()
                guard ok, let url else { return }
                guard let data else {
                    task.didFailWithError(NSError(domain: NSURLErrorDomain, code: NSURLErrorFileDoesNotExist))
                    return
                }
                let ext = (path as NSString).pathExtension
                let mime = UTType(filenameExtension: ext)?.preferredMIMEType ?? "application/octet-stream"
                let resp = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
                    "Content-Type": mime, "Content-Length": String(data.count),
                    "Access-Control-Allow-Origin": "*", "Cache-Control": "no-cache",
                ])!
                task.didReceive(resp)
                task.didReceive(data)
                task.didFinish()
            }
        }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        lock.lock(); live.remove(ObjectIdentifier(task)); lock.unlock()
    }
}
