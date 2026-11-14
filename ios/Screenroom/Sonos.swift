import AVFoundation
import CryptoKit
import Foundation
import Network

// Parlor playing on Sonos speakers. The speaker is told where each song is on the Wi-Fi (a small web server in
// the app hands it the file exactly as it is on the phone: a Dolby Atmos song arrives as Dolby Atmos on a speaker
// that plays Dolby Atmos; one that only plays stereo, like a Five, gets the album's stereo version of the song, or a
// stereo copy the phone makes), and plays it itself; Parlor keeps the queue, and its screen and the lock screen follow the speaker.

// ---- the files, on the Wi-Fi ---------------------------------------------------------------------------------

/// A tiny web server for the speakers: only songs (and covers) Parlor has handed out are served, each under an
/// address nobody could guess, with byte ranges (speakers read a file in pieces).
final class FileServer {
    static let shared = FileServer()
    private var listener: NWListener?
    private(set) var port: UInt16 = 0
    private var files: [String: String] = [:]   // token → path
    private let lock = NSLock()
    private let q = DispatchQueue(label: "parlor.file-server", qos: .userInitiated)
    private let secret = randomHex(16)

    /// Started (again, if iOS stopped it while the app was away). The same port each time when it can be, so
    /// addresses a speaker already has keep working.
    func ensureRunning() throws {
        if listener != nil && port != 0 { return }
        listener?.cancel(); listener = nil; port = 0
        for want in [NWEndpoint.Port(rawValue: 51400)!, .any] {
            let params = NWParameters.tcp
            params.allowLocalEndpointReuse = true
            guard let l = try? NWListener(using: params, on: want) else { continue }
            let ready = DispatchSemaphore(value: 0)
            var ok = false
            l.stateUpdateHandler = { [weak self, weak l] st in
                switch st {
                case .ready: ok = true; self?.port = l?.port?.rawValue ?? 0; ready.signal()
                case .failed, .cancelled:
                    if self?.listener === l { self?.listener = nil; self?.port = 0 }
                    ready.signal()
                default: break
                }
            }
            l.newConnectionHandler = { [weak self] c in self?.serve(c) }
            listener = l
            l.start(queue: q)
            _ = ready.wait(timeout: .now() + 3)
            if ok && port != 0 { return }
            l.cancel(); listener = nil; port = 0
        }
        throw ScreenroomError("Parlor couldn't share songs on the Wi-Fi.")
    }

    /// The address a speaker uses for this file. `host` is the phone's own address on the speaker's network.
    func url(for path: String, host: String) -> String {
        let token = String(sha256Hex(secret + path).prefix(32))
        lock.lock(); files[token] = path; lock.unlock()
        let ext = (path as NSString).pathExtension.lowercased()
        return "http://\(host):\(port)/p/\(token).\(ext.isEmpty ? "bin" : ext)"
    }

    private func path(for token: String) -> String? { lock.lock(); defer { lock.unlock() }; return files[token] }

    private func serve(_ c: NWConnection) {
        c.start(queue: q)
        readHead(c, Data())
    }

    private func readHead(_ c: NWConnection, _ sofar: Data) {
        c.receive(minimumIncompleteLength: 1, maximumLength: 16384) { [weak self] data, _, done, err in
            guard let self else { c.cancel(); return }
            var b = sofar
            if let data { b.append(data) }
            if let r = b.range(of: Data("\r\n\r\n".utf8)) {
                self.answer(c, String(decoding: b[..<r.lowerBound], as: UTF8.self))
            } else if done || err != nil || b.count > 32768 {
                c.cancel()
            } else {
                self.readHead(c, b)
            }
        }
    }

    private func finish(_ c: NWConnection) {
        c.send(content: nil, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { _ in c.cancel() })
    }

    private func status(_ c: NWConnection, _ line: String, _ extra: String = "") {
        c.send(content: Data("HTTP/1.1 \(line)\r\nContent-Length: 0\r\nConnection: close\r\n\(extra)\r\n".utf8), completion: .contentProcessed { _ in self.finish(c) })
    }

    private func answer(_ c: NWConnection, _ head: String) {
        let lines = head.components(separatedBy: "\r\n")
        let first = lines.first?.split(separator: " ").map(String.init) ?? []
        guard first.count >= 2 else { return status(c, "400 Bad Request") }
        let method = first[0]
        guard method == "GET" || method == "HEAD" else { return status(c, "405 Method Not Allowed") }
        let target = first[1].split(separator: "?").first.map(String.init) ?? ""
        guard target.hasPrefix("/p/") else { return status(c, "404 Not Found") }
        let token = String(target.dropFirst(3).split(separator: ".").first ?? "")
        guard let path = self.path(for: token), let h = FileHandle(forReadingAtPath: path),
              let size = (try? FileManager.default.attributesOfItem(atPath: path)[.size] as? NSNumber)?.int64Value, size > 0
        else { return status(c, "404 Not Found") }

        var start: Int64 = 0, end = size - 1, partial = false
        for l in lines.dropFirst() where l.lowercased().hasPrefix("range:") {
            // bytes=a-b, bytes=a-, bytes=-n (the first range only)
            let v = l.split(separator: "=", maxSplits: 1).last.map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
            let ab = (v.split(separator: ",").first ?? "").split(separator: "-", omittingEmptySubsequences: false)
                .map { $0.trimmingCharacters(in: .whitespaces) }
            guard ab.count == 2 else { continue }
            if ab[0].isEmpty, let n = Int64(ab[1]) { start = max(0, size - n) }
            else if let a = Int64(ab[0]) { start = a; if let b = Int64(ab[1]) { end = min(b, size - 1) } }
            partial = true
        }
        guard start < size, start <= end else {
            try? h.close()
            return status(c, "416 Range Not Satisfiable", "Content-Range: bytes */\(size)\r\n")
        }
        let len = end - start + 1
        var hdr = partial ? "HTTP/1.1 206 Partial Content\r\n" : "HTTP/1.1 200 OK\r\n"
        hdr += "Content-Type: \(FileServer.mime(path))\r\nContent-Length: \(len)\r\nAccept-Ranges: bytes\r\nConnection: close\r\n"
        if partial { hdr += "Content-Range: bytes \(start)-\(end)/\(size)\r\n" }
        hdr += "\r\n"
        c.send(content: Data(hdr.utf8), completion: .contentProcessed { [weak self] e in
            guard let self, e == nil, method == "GET" else { try? h.close(); self?.finish(c); return }
            do { try h.seek(toOffset: UInt64(start)) } catch { try? h.close(); c.cancel(); return }
            self.pump(c, h, left: len)
        })
    }

    /// The file in pieces, each sent when the last one has gone (so a slow speaker never fills the memory).
    private func pump(_ c: NWConnection, _ h: FileHandle, left: Int64) {
        if left <= 0 { try? h.close(); finish(c); return }
        let d = (try? h.read(upToCount: Int(min(left, 256 * 1024)))) ?? Data()
        if d.isEmpty { try? h.close(); c.cancel(); return }
        c.send(content: d, completion: .contentProcessed { [weak self] e in
            if e != nil { try? h.close(); c.cancel(); return }
            self?.pump(c, h, left: left - Int64(d.count))
        })
    }

    static func mime(_ path: String) -> String {
        switch (path as NSString).pathExtension.lowercased() {
        case "m4a", "mp4", "m4b", "aac", "alac": return "audio/mp4"
        case "mp3": return "audio/mpeg"
        case "flac": return "audio/flac"
        case "wav": return "audio/wav"
        case "aif", "aiff": return "audio/aiff"
        case "ogg", "oga": return "audio/ogg"
        case "ec3", "eac3": return "audio/eac3"
        case "ac3": return "audio/ac3"
        case "jpg", "jpeg": return "image/jpeg"
        case "png": return "image/png"
        default: return "application/octet-stream"
        }
    }

    /// The phone's address on the same network as `ip` (the Wi-Fi the speaker is on).
    static func localAddress(toward ip: String) -> String? {
        if ip.hasPrefix("127.") { return "127.0.0.1" }
        var list: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&list) == 0, let first = list else { return nil }
        defer { freeifaddrs(list) }
        let target = inet_addr(ip), none = UInt32.max
        var wifi: String?, any: String?
        for p in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let a = p.pointee
            guard let sa = a.ifa_addr, sa.pointee.sa_family == UInt8(AF_INET),
                  (a.ifa_flags & UInt32(IFF_UP)) != 0, (a.ifa_flags & UInt32(IFF_LOOPBACK)) == 0 else { continue }
            let addr = sa.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { $0.pointee.sin_addr }
            let mask = a.ifa_netmask?.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { $0.pointee.sin_addr.s_addr } ?? 0
            var ia = addr
            var buf = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
            inet_ntop(AF_INET, &ia, &buf, socklen_t(INET_ADDRSTRLEN))
            let s = String(cString: buf)
            if target != none, mask != 0, (addr.s_addr & mask) == (target & mask) { return s }
            if wifi == nil, String(cString: a.ifa_name) == "en0" { wifi = s }
            if any == nil { any = s }
        }
        return wifi ?? any
    }
}

// ---- the speakers ----------------------------------------------------------------------------------------------

/// A room (or a group of rooms playing together) on the Sonos system: commands go to the group's coordinator.
struct SonosRoom {
    let id: String        // the coordinator's RINCON_… id
    let name: String      // "Living Room", or "Living Room + Kitchen"
    let host: String      // "192.168.1.20:1400"
    var model: String = ""
    var atmos = false     // a speaker that plays Dolby Atmos music (Arc, Arc Ultra, Beam (Gen 2), Era 300)

    var ip: String { String(host.split(separator: ":").first ?? "") }
    var json: [String: Any] { ["id": id, "name": name, "model": model, "atmos": atmos] }

    func soap(_ path: String, _ service: String, _ action: String, _ args: [(String, String)] = []) async throws -> String {
        guard let url = URL(string: "http://\(host)\(path)") else { throw ScreenroomError("Bad speaker address") }
        var req = URLRequest(url: url, timeoutInterval: 8)
        req.httpMethod = "POST"
        req.setValue("text/xml; charset=\"utf-8\"", forHTTPHeaderField: "Content-Type")
        req.setValue("\"urn:schemas-upnp-org:service:\(service):1#\(action)\"", forHTTPHeaderField: "SOAPACTION")
        let inner = args.map { "<\($0.0)>\(Sonos.esc($0.1))</\($0.0)>" }.joined()
        req.httpBody = Data(("<?xml version=\"1.0\" encoding=\"utf-8\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" "
            + "s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body><u:\(action) xmlns:u=\"urn:schemas-upnp-org:service:\(service):1\">"
            + inner + "</u:\(action)></s:Body></s:Envelope>").utf8)
        let (d, r) = try await Sonos.session.data(for: req)
        let s = String(decoding: d, as: UTF8.self)
        if let code = (r as? HTTPURLResponse)?.statusCode, code >= 300 {
            throw ScreenroomError("\(name) said no to \(action) (\(Sonos.tag("errorCode", s) ?? String(code)))")
        }
        return s
    }

    @discardableResult
    func av(_ action: String, _ args: [(String, String)] = []) async throws -> String {
        try await soap("/MediaRenderer/AVTransport/Control", "AVTransport", action, [("InstanceID", "0")] + args)
    }

    @discardableResult
    func group(_ action: String, _ args: [(String, String)] = []) async throws -> String {
        try await soap("/MediaRenderer/GroupRenderingControl/Control", "GroupRenderingControl", action, [("InstanceID", "0")] + args)
    }
}

final class Sonos {
    static let shared = Sonos()
    static let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 8
        c.httpMaximumConnectionsPerHost = 4
        return URLSession(configuration: c)
    }()

    private var browser: NWBrowser?
    private var found: Set<String> = []        // "ip:1400" of any speaker seen
    private let lock = NSLock()
    private let q = DispatchQueue(label: "parlor.sonos")
    private(set) var rooms: [SonosRoom] = []

    private func seen(_ host: String) { lock.lock(); found.insert(host); lock.unlock() }
    private var hosts: [String] { lock.lock(); defer { lock.unlock() }; return Array(found) }

    /// Speakers announce themselves on the Wi-Fi (Bonjour, `_sonos._tcp`); their own web address is on port 1400.
    private func browse() {
        if browser != nil { return }
        let b = NWBrowser(for: .bonjourWithTXTRecord(type: "_sonos._tcp", domain: nil), using: .tcp)
        b.browseResultsChangedHandler = { [weak self] results, _ in
            for r in results { self?.locate(r) }
        }
        b.stateUpdateHandler = { [weak self] st in
            if case .failed = st { self?.browser = nil }
        }
        browser = b
        b.start(queue: q)
    }

    private func locate(_ r: NWBrowser.Result) {
        // the announcement usually carries the speaker's address ("location"); if not, it's looked up
        if case let .bonjour(txt) = r.metadata, let loc = txt["location"] ?? txt["Location"],
           let u = URL(string: loc), let h = u.host {
            seen("\(h):\(u.port ?? 1400)")
            return
        }
        let p = NWParameters.tcp
        if let ip = p.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options { ip.version = .v4 }
        let c = NWConnection(to: r.endpoint, using: p)
        c.stateUpdateHandler = { [weak self] st in
            switch st {
            case .ready:
                if case let .hostPort(host, _) = c.currentPath?.remoteEndpoint {
                    var h = "\(host)"
                    if let pct = h.firstIndex(of: "%") { h = String(h[..<pct]) }
                    self?.seen("\(h):1400")
                }
                c.cancel()
            case .failed, .waiting: c.cancel()
            default: break
            }
        }
        c.start(queue: q)
        q.asyncAfter(deadline: .now() + 4) { c.cancel() }
    }

    /// The rooms on the Wi-Fi, found afresh (a few seconds at most).
    func findRooms() async -> [SonosRoom] {
        browse()
        let known = (Storage.shared.readJson("sonos-hosts") as? [String]) ?? []
        for h in known { seen(h) }
        // asked of the speakers seen so far: any one of them knows the whole system
        var tried = Set<String>()
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline {
            for h in hosts where !tried.contains(h) {
                tried.insert(h)
                if let list = await topology(from: h), !list.isEmpty {
                    rooms = list
                    try? Storage.shared.writeJson("sonos-hosts", Array(Set(list.map(\.host))))
                    return list
                }
            }
            try? await Task.sleep(nanoseconds: 250_000_000)
        }
        return rooms
    }

    func room(_ id: String) -> SonosRoom? { rooms.first { $0.id == id } }

    /// The groups, from one speaker: each group's coordinator, its name, and what kind of speaker it is.
    private func topology(from host: String) async -> [SonosRoom]? {
        let probe = SonosRoom(id: "", name: "The speaker", host: host)
        guard let r = try? await probe.soap("/ZoneGroupTopology/Control", "ZoneGroupTopology", "GetZoneGroupState") else { return nil }
        guard var state = Sonos.tag("ZoneGroupState", r) else { return nil }
        state = Sonos.unesc(state)
        var out: [SonosRoom] = []
        for g in Sonos.matches("<ZoneGroup\\s([^>]*)>(.*?)</ZoneGroup>", state) {
            let ga = Sonos.attrs(g[0])
            guard let coord = ga["Coordinator"] else { continue }
            var lead: [String: String]?
            var others: [String] = []
            for m in Sonos.matches("<ZoneGroupMember\\s([^>]*?)/?>", g[1]) {
                let a = Sonos.attrs(m[0])
                if a["UUID"] == coord { lead = a }
                else if a["Invisible"] != "1", let n = a["ZoneName"] { others.append(n) }
            }
            guard let lead, let name = lead["ZoneName"], let loc = lead["Location"], let u = URL(string: loc), let h = u.host else { continue }
            var room = SonosRoom(id: coord, name: ([name] + others.sorted()).joined(separator: " + "), host: "\(h):\(u.port ?? 1400)")
            if let d = try? await Sonos.session.data(from: u).0 {
                let x = String(decoding: d, as: UTF8.self)
                let display = Sonos.tag("displayName", x) ?? Sonos.tag("modelName", x) ?? ""
                let number = Sonos.tag("modelNumber", x) ?? ""
                room.model = display.replacingOccurrences(of: "Sonos ", with: "")
                let m = room.model.lowercased()
                room.atmos = m.hasPrefix("arc") || m.contains("era 300") || (m.hasPrefix("beam") && number != "S14")
            }
            out.append(room)
        }
        return out.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    // ---- bits of XML ----
    static func esc(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
    }
    static func unesc(_ s: String) -> String {
        s.replacingOccurrences(of: "&lt;", with: "<").replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&quot;", with: "\"").replacingOccurrences(of: "&apos;", with: "'")
            .replacingOccurrences(of: "&amp;", with: "&")
    }
    static func tag(_ name: String, _ s: String) -> String? {
        guard let a = s.range(of: "<\(name)>"), let b = s.range(of: "</\(name)>", range: a.upperBound..<s.endIndex) else { return nil }
        return String(s[a.upperBound..<b.lowerBound])
    }
    static func matches(_ pattern: String, _ s: String) -> [[String]] {
        guard let re = try? NSRegularExpression(pattern: pattern, options: [.dotMatchesLineSeparators]) else { return [] }
        let ns = s as NSString
        return re.matches(in: s, range: NSRange(location: 0, length: ns.length)).map { m in
            (1..<m.numberOfRanges).map { m.range(at: $0).location == NSNotFound ? "" : ns.substring(with: m.range(at: $0)) }
        }
    }
    static func attrs(_ s: String) -> [String: String] {
        var d: [String: String] = [:]
        for m in matches("([A-Za-z_:]+)=\"([^\"]*)\"", s) { d[m[0]] = unesc(m[1]) }
        return d
    }
    static func hms(_ t: Double) -> String {
        let s = max(0, Int(t))
        return String(format: "%d:%02d:%02d", s / 3600, (s / 60) % 60, s % 60)
    }
    static func secs(_ s: String?) -> Double {
        guard let s, !s.isEmpty, s != "NOT_IMPLEMENTED" else { return 0 }
        return s.split(separator: ":").reduce(0.0) { $0 * 60 + (Double($1) ?? 0) }
    }
}

// ---- playing on a room ---------------------------------------------------------------------------------------

/// Parlor's queue on a Sonos room. The speaker gets the songs from the one playing onwards (its own queue,
/// so one song follows the next with no gap even while the phone is asleep), added a few at a time; Parlor
/// asks it every second where it's got to.
final class SonosLink {
    let room: SonosRoom
    private let tracks: () -> [[String: Any]]
    /// (on the main thread) where the speaker is: the queue index it's playing, or nil if it's stopped at the end
    var onUpdate: ((_ index: Int?, _ ended: Bool) -> Void)?
    var onProblem: ((String) -> Void)?

    // what the speaker said last (main thread)
    private(set) var pos: Double = 0
    private(set) var dur: Double = 0
    private(set) var at = Date()
    private(set) var paused = true
    private(set) var volume = 30
    private(set) var muted = false

    private var base = 0       // the queue index of the speaker's first song
    private var filled = 0     // how many songs the speaker has
    private var gen = 0        // bumped whenever the speaker's queue is redone (a fill under way then stops)
    private var filling = false
    private var chain: Task<Void, Never>?
    private var timer: Timer?
    private var wasPlaying = false
    private var holdUntil = Date.distantPast   // just told to play / pause / seek: the next poll may not show it yet

    init(room: SonosRoom, tracks: @escaping () -> [[String: Any]]) {
        self.room = room
        self.tracks = tracks
    }

    /// The position now (the clock runs on between the speaker's answers).
    var now: Double { paused ? pos : min(dur > 0 ? dur : .infinity, pos + Date().timeIntervalSince(at)) }

    // one thing at a time, in order
    private func run(_ what: String, _ op: @escaping () async throws -> Void) {
        let prev = chain
        chain = Task { [weak self] in
            await prev?.value
            do { try await op() } catch {
                NSLog("Parlor on Sonos: %@ failed: %@", what, error.localizedDescription)
                await MainActor.run { self?.onProblem?(error.localizedDescription) }
            }
        }
    }

    private func didl(_ t: [String: Any], _ path: String, _ host: String) -> (String, String)? {
        let uri = FileServer.shared.url(for: path, host: host)
        var art = ""
        if let a = t["art"] as? String, FileManager.default.fileExists(atPath: a) {
            art = "<upnp:albumArtURI>\(Sonos.esc(FileServer.shared.url(for: a, host: host)))</upnp:albumArtURI>"
        }
        let d = (t["duration"] as? NSNumber)?.doubleValue ?? 0
        let e = { (k: String) in Sonos.esc(t[k] as? String ?? "") }
        let meta = "<DIDL-Lite xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\" "
            + "xmlns:r=\"urn:schemas-rinconnetworks-com:metadata-1-0/\" xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\">"
            + "<item id=\"-1\" parentID=\"-1\" restricted=\"true\"><dc:title>\(e("title"))</dc:title><upnp:class>object.item.audioItem.musicTrack</upnp:class>"
            + "<dc:creator>\(e("artist"))</dc:creator><upnp:album>\(e("album"))</upnp:album>\(art)"
            + "<res protocolInfo=\"http-get:*:\(FileServer.mime(path)):*\"\(d > 0 ? " duration=\"\(Sonos.hms(d))\"" : "")>\(Sonos.esc(uri))</res></item></DIDL-Lite>"
        return (uri, meta)
    }

    /// Whether a song goes to this speaker in stereo when it's Dolby Atmos or surround (a speaker that doesn't play
    /// Dolby Atmos music plays nothing at all if sent it).
    func stereoFor(_ t: [String: Any]) -> Bool { !room.atmos && (t["spatial"] as? Bool ?? false) }

    /// The file the speaker gets for a song: the song itself, or for a stereo-only speaker the album's stereo
    /// version of a Dolby Atmos / surround song, or a stereo copy made on the phone (kept for next time).
    func source(_ t: [String: Any]) async -> String? {
        guard let path = t["path"] as? String else { return nil }
        guard stereoFor(t) else { return path }
        if let twin = t["stereoPath"] as? String, FileManager.default.fileExists(atPath: twin) { return twin }
        do { return try await Downmix.shared.stereo(of: path) } catch {
            NSLog("Parlor on Sonos: no stereo copy of %@: %@", path, error.localizedDescription)
            let name = t["title"] as? String ?? "A song"
            await MainActor.run { self.onProblem?("\(name) couldn't be made into stereo for \(self.room.name), so it may not play there.") }
            return path
        }
    }

    private func add(_ t: [String: Any], path: String, at position: Int = 0) async throws {
        guard let host = FileServer.localAddress(toward: room.ip) else { throw ScreenroomError("This phone isn't on the speaker's Wi-Fi.") }
        guard let d = didl(t, path, host) else { return }
        try await room.av("AddURIToQueue", [("EnqueuedURI", d.0), ("EnqueuedURIMetaData", d.1),
                                           ("DesiredFirstTrackNumberEnqueued", String(position)), ("EnqueueAsNext", "0")])
    }

    /// The speaker starts again from queue index `i` (at `start` seconds into it).
    func load(from i: Int, at start: Double, play: Bool) {
        let list = tracks()
        guard i >= 0, i < list.count else { return }
        do { try FileServer.shared.ensureRunning() } catch { onProblem?(error.localizedDescription); return }
        gen += 1
        let g = gen
        base = i; filled = 0; filling = false
        pos = start; at = Date(); dur = (list[i]["duration"] as? NSNumber)?.doubleValue ?? 0
        paused = !play; holdUntil = Date().addingTimeInterval(3)
        let first = list[i], id = room.id
        run("start") { [weak self] in
            guard let self else { return }
            // (a stereo copy, if the speaker needs one, is made first: the speaker's told about the song once it's ready)
            guard let path = await self.source(first) else { return }
            guard await MainActor.run(body: { g == self.gen }) else { return }
            try await self.room.av("RemoveAllTracksFromQueue")
            try await self.add(first, path: path)
            await MainActor.run { if g == self.gen { self.filled = 1 } }
            try await self.room.av("SetAVTransportURI", [("CurrentURI", "x-rincon-queue:\(id)#0"), ("CurrentURIMetaData", "")])
            try await self.room.av("Seek", [("Unit", "TRACK_NR"), ("Target", "1")])
            if start > 1 { try? await self.room.av("Seek", [("Unit", "REL_TIME"), ("Target", Sonos.hms(start))]) }
            if play { try await self.room.av("Play", [("Speed", "1")]) }
            await MainActor.run { self.fill(g) }
        }
    }

    /// The rest of the queue onto the speaker, a few songs at a time (play / pause in between go straight through).
    private func fill(_ g: Int) {
        guard g == gen, !filling else { return }
        let list = tracks(), from = max(0, base + filled)
        guard from < list.count else { return }
        let batch = Array(list[from..<min(list.count, from + 4)])
        filling = true
        Task { [weak self] in
            guard let self else { return }
            // the files first (stereo copies take a few seconds each), outside the line of speaker commands so
            // Play / Pause don't wait for them; then onto the speaker
            var ready: [([String: Any], String)] = []
            for t in batch {
                guard await MainActor.run(body: { g == self.gen }) else { break }
                guard let p = await self.source(t) else { break }
                ready.append((t, p))
            }
            await MainActor.run {
                guard g == self.gen else { return }
                guard !ready.isEmpty else { self.filling = false; return }
                self.run("add songs") { [weak self] in
                    guard let self else { return }
                    for (t, p) in ready {
                        guard await MainActor.run(body: { g == self.gen }) else { break }
                        try await self.add(t, path: p)
                        await MainActor.run { if g == self.gen { self.filled += 1 } }
                    }
                    await MainActor.run {
                        // (a fill from before the queue was redone just stops: the new one has its own)
                        if g == self.gen { self.filling = false; self.fill(g) }
                    }
                }
            }
        }
    }

    /// The queue's gone (Parlor stopped): what the speaker has no longer matches it.
    func forget() { gen += 1; filled = 0; filling = false; wasPlaying = false }

    /// Songs were added to the end of the queue.
    func grew() { if !filling { fill(gen) } }

    /// The queue changed after the song that's playing (Play Next, shuffle, Clear Queue): that song carries on,
    /// and what follows it on the speaker is put back in the new order. `was` and `now` are the playing song's
    /// index before and after.
    func rebuild(was: Int, now: Int) {
        let k = was - base   // its place in the speaker's queue (0-based)
        guard k >= 0, k < filled else { load(from: now, at: self.now, play: !paused); return }
        gen += 1
        let g = gen
        filling = false
        base = now - k
        let drop = filled - (k + 1)
        filled = k + 1
        run("redo the queue") { [weak self] in
            guard let self else { return }
            if drop > 0 {
                try await self.room.av("RemoveTrackRangeFromQueue", [("UpdateID", "0"), ("StartingIndex", String(k + 2)), ("NumberOfTracks", String(drop))])
            }
            await MainActor.run { self.fill(g) }
        }
    }

    /// Play queue index `i` from its start.
    func jump(_ i: Int) {
        let k = i - base
        guard k >= 0, k < filled else { load(from: i, at: 0, play: true); return }
        pos = 0; at = Date(); paused = false; holdUntil = Date().addingTimeInterval(3)
        dur = ((tracks().indices.contains(i) ? tracks()[i]["duration"] : nil) as? NSNumber)?.doubleValue ?? 0
        run("skip") { [weak self] in
            try await self?.room.av("Seek", [("Unit", "TRACK_NR"), ("Target", String(k + 1))])
            try await self?.room.av("Play", [("Speed", "1")])
        }
    }

    func play() {
        pos = now; at = Date(); paused = false; holdUntil = Date().addingTimeInterval(3)
        run("play") { [weak self] in try await self?.room.av("Play", [("Speed", "1")]) }
    }
    func pause() {
        pos = now; at = Date(); paused = true; holdUntil = Date().addingTimeInterval(3)
        run("pause") { [weak self] in try await self?.room.av("Pause") }
    }
    func seek(_ s: Double) {
        pos = s; at = Date(); holdUntil = Date().addingTimeInterval(3)
        run("seek") { [weak self] in try await self?.room.av("Seek", [("Unit", "REL_TIME"), ("Target", Sonos.hms(s))]) }
    }
    func setVolume(_ v: Int) {
        volume = max(0, min(100, v))
        volumeSetAt = Date()
        let v = volume
        run("volume") { [weak self] in try await self?.room.group("SetGroupVolume", [("DesiredVolume", String(v))]) }
    }
    func setMuted(_ m: Bool) {
        muted = m
        run("mute") { [weak self] in try await self?.room.group("SetGroupMute", [("DesiredMute", m ? "1" : "0")]) }
    }
    func repeatOne(_ on: Bool) {
        run("repeat") { [weak self] in try await self?.room.av("SetPlayMode", [("NewPlayMode", on ? "REPEAT_ONE" : "NORMAL")]) }
    }

    func start() {
        Task { [weak self] in
            guard let self else { return }
            if let r = try? await self.room.group("GetGroupVolume"), let v = Int(Sonos.tag("CurrentVolume", r) ?? "") {
                await MainActor.run { self.volume = v }
            }
        }
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.poll() }
    }

    /// Parlor lets go of the speaker (the music stops there, if asked).
    func release(pause: Bool) {
        timer?.invalidate(); timer = nil
        gen += 1
        if pause { run("pause") { [weak self] in try await self?.room.av("Pause") } }
    }

    private var polling = false
    private var polls = 0
    private var volumeSetAt = Date.distantPast
    private func poll() {
        if polling { return }
        polling = true
        polls += 1
        let askVolume = polls % 3 == 0
        Task { [weak self] in
            guard let self else { return }
            let p = try? await self.room.av("GetPositionInfo")
            let t = try? await self.room.av("GetTransportInfo")
            // (the volume too, every few seconds: it may have been changed in the Sonos app or on the speaker)
            let vr = askVolume ? try? await self.room.group("GetGroupVolume") : nil
            await MainActor.run {
                self.polling = false
                if let vr, let v = Int(Sonos.tag("CurrentVolume", vr) ?? ""), Date().timeIntervalSince(self.volumeSetAt) > 3 { self.volume = v }
                guard let p, let t else { return }
                let state = Sonos.tag("CurrentTransportState", t) ?? ""
                let track = Int(Sonos.tag("Track", p) ?? "") ?? 0
                let playing = state == "PLAYING" || state == "TRANSITIONING"
                // (just told to play, pause or seek: the speaker may not have got there yet, so its time waits)
                if Date() >= self.holdUntil {
                    self.pos = Sonos.secs(Sonos.tag("RelTime", p))
                    let d = Sonos.secs(Sonos.tag("TrackDuration", p))
                    if d > 0 { self.dur = d }
                    self.at = Date()
                    self.paused = !playing
                }
                // the speaker ran out of songs (the end of the queue): stopped, not paused
                let lastFilled = self.base + self.filled >= self.tracks().count
                if state == "STOPPED" && self.wasPlaying && lastFilled && !self.filling {
                    self.wasPlaying = false
                    self.onUpdate?(nil, true)
                    return
                }
                self.wasPlaying = playing
                if state != "STOPPED", track > 0, track <= self.filled {
                    self.onUpdate?(self.base + track - 1, false)
                } else {
                    self.onUpdate?(nil, false)
                }
            }
        }
    }
}

// ---- stereo copies --------------------------------------------------------------------------------------------

/// Stereo copies of Dolby Atmos and surround songs, for Sonos speakers that only play stereo (a Five, a One, a
/// Move…): iOS decodes the song and mixes it down to two channels, saved as 256 kbps AAC in the app's caches
/// (iOS may clear them when space is short; they're made again when needed). About 1.5 GB is kept at most.
actor Downmix {
    static let shared = Downmix()
    private var jobs: [String: Task<String, Error>] = [:]
    private let dir: URL = {
        let d = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("stereo", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }()

    func stereo(of path: String) async throws -> String {
        let a = try FileManager.default.attributesOfItem(atPath: path)
        let size = (a[.size] as? NSNumber)?.int64Value ?? 0
        let mtime = Int((a[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0)
        let key = SHA256.hash(data: Data("\(path)|\(size)|\(mtime)".utf8)).prefix(12).map { String(format: "%02x", $0) }.joined()
        let out = dir.appendingPathComponent(key + ".m4a")
        if FileManager.default.fileExists(atPath: out.path) {
            try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: out.path)
            return out.path
        }
        if let j = jobs[key] { return try await j.value }
        let src = URL(fileURLWithPath: path)
        let j = Task.detached(priority: .userInitiated) { () throws -> String in
            try await Downmix.convert(src, to: out)
            return out.path
        }
        jobs[key] = j
        defer { jobs[key] = nil }
        let made = try await j.value
        prune()
        return made
    }

    /// The oldest copies go once there's more than about 1.5 GB of them.
    private func prune() {
        let keys: [URLResourceKey] = [.contentModificationDateKey, .fileSizeKey]
        guard let files = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: keys) else { return }
        var list = files.compactMap { u -> (URL, Date, Int)? in
            guard let v = try? u.resourceValues(forKeys: Set(keys)) else { return nil }
            return (u, v.contentModificationDate ?? .distantPast, v.fileSize ?? 0)
        }.sorted { $0.1 > $1.1 }
        var total = 0
        list = list.filter { total += $0.2; return total > 1_500_000_000 }
        for f in list { try? FileManager.default.removeItem(at: f.0) }
    }

    static func convert(_ src: URL, to out: URL) async throws {
        let asset = AVURLAsset(url: src)
        guard let track = try await asset.loadTracks(withMediaType: .audio).first else { throw ScreenroomError("There's no sound in that file.") }
        var layout = AudioChannelLayout()
        layout.mChannelLayoutTag = kAudioChannelLayoutTag_Stereo
        let layoutData = Data(bytes: &layout, count: MemoryLayout<AudioChannelLayout>.size)
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderAudioMixOutput(audioTracks: [track], audioSettings: [
            AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 48000, AVNumberOfChannelsKey: 2, AVChannelLayoutKey: layoutData,
            AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false])
        guard reader.canAdd(output) else { throw ScreenroomError("This phone can't read that song.") }
        reader.add(output)
        let tmp = out.deletingLastPathComponent().appendingPathComponent("making-" + UUID().uuidString + ".m4a")
        let writer = try AVAssetWriter(outputURL: tmp, fileType: .m4a)
        let input = AVAssetWriterInput(mediaType: .audio, outputSettings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48000, AVNumberOfChannelsKey: 2, AVChannelLayoutKey: layoutData, AVEncoderBitRateKey: 256_000])
        input.expectsMediaDataInRealTime = false
        guard writer.canAdd(input) else { throw ScreenroomError("This phone can't make a stereo copy.") }
        writer.add(input)
        guard reader.startReading() else { throw reader.error ?? ScreenroomError("This phone can't read that song.") }
        guard writer.startWriting() else { throw writer.error ?? ScreenroomError("This phone can't make a stereo copy.") }
        writer.startSession(atSourceTime: .zero)
        let q = DispatchQueue(label: "parlor.downmix")
        do {
            try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
                var done = false
                input.requestMediaDataWhenReady(on: q) {
                    while !done && input.isReadyForMoreMediaData {
                        if let b = output.copyNextSampleBuffer() {
                            if !input.append(b) {
                                done = true; reader.cancelReading(); writer.cancelWriting()
                                c.resume(throwing: writer.error ?? ScreenroomError("The stereo copy couldn't be saved.")); return
                            }
                        } else {
                            done = true
                            if reader.status == .failed {
                                writer.cancelWriting()
                                c.resume(throwing: reader.error ?? ScreenroomError("This phone can't read that song.")); return
                            }
                            input.markAsFinished()
                            writer.finishWriting {
                                if writer.status == .completed { c.resume() } else { c.resume(throwing: writer.error ?? ScreenroomError("The stereo copy couldn't be saved.")) }
                            }
                            return
                        }
                    }
                }
            }
        } catch {
            try? FileManager.default.removeItem(at: tmp)
            throw error
        }
        try? FileManager.default.removeItem(at: out)
        try FileManager.default.moveItem(at: tmp, to: out)
    }
}

/// While Parlor is playing on a speaker, it keeps a silent sound going on the phone: iOS lets an app that's
/// playing sound keep running with the screen off, and Parlor has to be running to hand the speaker its songs
/// (and it's what puts the speaker's song on the lock screen, with its controls).
final class KeepAwake {
    static let shared = KeepAwake()
    private var player: AVAudioPlayer?
    private var stopper: DispatchWorkItem?

    func start() {
        stopper?.cancel(); stopper = nil
        if player?.isPlaying == true { return }
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .default)
        try? session.setActive(true)
        if player == nil { player = try? AVAudioPlayer(data: KeepAwake.silence()) }
        player?.numberOfLoops = -1
        player?.volume = 0
        player?.play()
    }

    /// After a while paused there's no need to stay up (the lock screen controls go after that).
    func stop(after seconds: Double = 0) {
        stopper?.cancel()
        let w = DispatchWorkItem { [weak self] in self?.player?.stop() }
        stopper = w
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: w)
    }

    /// One second of silence, as a WAV file.
    private static func silence() -> Data {
        let rate: UInt32 = 8000, samples = Int(rate)
        var d = Data()
        func u32(_ v: UInt32) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 4)) }
        func u16(_ v: UInt16) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 2)) }
        d.append(Data("RIFF".utf8)); u32(UInt32(36 + samples * 2)); d.append(Data("WAVE".utf8))
        d.append(Data("fmt ".utf8)); u32(16); u16(1); u16(1); u32(rate); u32(rate * 2); u16(2); u16(16)
        d.append(Data("data".utf8)); u32(UInt32(samples * 2)); d.append(Data(count: samples * 2))
        return d
    }
}
