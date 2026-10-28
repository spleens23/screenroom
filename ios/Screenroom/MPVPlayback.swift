import UIKit
import AVFoundation
import MediaPlayer
import Libmpv

/// Plays what Apple's player can't (DTS and TrueHD sound, including TrueHD inside an MP4, MKV / AVI / WebM files,
/// films with .srt subtitles beside them) with mpv's engine, behind Screenroom's own controls: the title, a scrub
/// bar, back / forward 10 s, play / pause, an Audio & subtitles menu that switches tracks while the film plays,
/// and Next episode. Reports where you are every few seconds (Continue Watching) and goes on to the next
/// episode by itself.
final class MPVPlayback: NSObject {
    static var current: MPVPlayback?
    /// Players whose engine is still shutting down (kept alive until it has).
    private static var closing: [MPVPlayback] = []

    private let queue: [[String: Any]]
    private var index = 0
    private let audioLang: String
    private let subLang: String
    private let audioTrack: Int?
    private let bridge: Bridge
    private var mpv: OpaquePointer?
    /// mpv's events are read here; anything for the screen goes back to the main thread.
    private let events = DispatchQueue(label: "screenroom.mpv.events", qos: .userInitiated)
    private let metalLayer = MPVMetalLayer()
    private var controller: PlayerScreen!
    private var progressTimer: Timer?
    private var finished = false
    private var pos = 0.0
    private var dur = 0.0
    private var paused = false

    init(queue: [[String: Any]], audioLang: String, subLang: String, audioTrack: Int?, bridge: Bridge) {
        self.queue = queue
        self.audioLang = audioLang
        self.subLang = subLang
        self.audioTrack = audioTrack
        self.bridge = bridge
        super.init()
    }

    static func start(_ opts: [String: Any], queue q: [[String: Any]], from presenter: UIViewController, bridge: Bridge) {
        current?.stop()
        VideoPlayback.current?.stop()
        MusicPlayer.shared.pauseForVideo()
        let p = MPVPlayback(queue: q, audioLang: opts["audioLang"] as? String ?? "eng", subLang: opts["subLang"] as? String ?? "",
                            audioTrack: (opts["audioTrack"] as? NSNumber)?.intValue, bridge: bridge)
        current = p
        p.present(from: presenter)
    }

    private var item: [String: Any] { queue[index] }

    private func present(from presenter: UIViewController) {
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        try? AVAudioSession.sharedInstance().setActive(true)
        controller = PlayerScreen()
        controller.modalPresentationStyle = .fullScreen
        controller.loadViewIfNeeded()
        metalLayer.frame = controller.videoView.bounds
        metalLayer.contentsScale = UIScreen.main.nativeScale
        metalLayer.framebufferOnly = true
        metalLayer.backgroundColor = UIColor.black.cgColor
        controller.videoView.layer.addSublayer(metalLayer)
        controller.onLayout = { [weak self] in
            guard let self else { return }
            CATransaction.begin(); CATransaction.setDisableActions(true)
            self.metalLayer.frame = self.controller.videoView.bounds
            CATransaction.commit()
        }
        controller.onClose = { [weak self] in self?.close() }
        controller.onToggle = { [weak self] in self?.togglePause() }
        controller.onSkip = { [weak self] s in self?.skip(s) }
        controller.onSeek = { [weak self] f in self?.seek(to: f) }
        controller.onNext = { [weak self] in self?.next() }
        controller.menuProvider = { [weak self] in self?.tracksMenu() }
        guard startEngine() else {
            bridge.emit("playback-error", ["title": item["title"] as? String ?? "", "code": "mpv", "details": "", "message": "The player couldn't start."])
            finished = true
            if MPVPlayback.current === self { MPVPlayback.current = nil }
            return
        }
        presenter.present(controller, animated: true) { [weak self] in self?.load(0) }
        progressTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.reportProgress(done: false) }
        UIApplication.shared.isIdleTimerDisabled = true
    }

    // ---- the engine ----------------------------------------------------------------------------------------
    private func startEngine() -> Bool {
        guard let h = mpv_create() else { return false }
        mpv = h
        var layer = metalLayer
        mpv_set_option(h, "wid", MPV_FORMAT_INT64, &layer)
        let opts: [(String, String)] = [
            ("vo", "gpu-next"), ("gpu-api", "vulkan"), ("gpu-context", "moltenvk"), ("hwdec", "videotoolbox"),
            ("video-rotate", "no"), ("idle", "yes"), ("keep-open", "no"), ("input-default-bindings", "no"),
            ("sub-auto", "fuzzy"), ("audio-file-auto", "no"), ("alang", langList(audioLang)),
            ("slang", subLang.isEmpty ? "" : langList(subLang)), ("subs-fallback", "yes"),
            ("audio-channels", "auto-safe"), ("demuxer-max-bytes", "150MiB"),
        ]
        for (k, v) in opts { mpv_set_option_string(h, k, v) }
        #if DEBUG
        mpv_request_log_messages(h, "warn")
        #endif
        guard mpv_initialize(h) >= 0 else { mpv_terminate_destroy(h); mpv = nil; return false }
        mpv_observe_property(h, 1, "time-pos", MPV_FORMAT_DOUBLE)
        mpv_observe_property(h, 2, "duration", MPV_FORMAT_DOUBLE)
        mpv_observe_property(h, 3, "pause", MPV_FORMAT_FLAG)
        mpv_observe_property(h, 4, "paused-for-cache", MPV_FORMAT_FLAG)
        mpv_set_wakeup_callback(h, { ctx in
            guard let ctx else { return }
            Unmanaged<MPVPlayback>.fromOpaque(ctx).takeUnretainedValue().drain()
        }, Unmanaged.passUnretained(self).toOpaque())
        return true
    }

    /// "eng" → "eng,en" (mpv matches a track's language by either form).
    private func langList(_ lang: String) -> String {
        guard !lang.isEmpty else { return "" }
        let two = Locale(identifier: lang).language.languageCode?.identifier(.alpha2) ?? ""
        return two.isEmpty || two == lang ? lang : "\(lang),\(two)"
    }

    private func command(_ args: [String]) {
        guard let h = mpv else { return }
        var cargs: [UnsafePointer<CChar>?] = args.map { UnsafePointer(strdup($0)) }
        cargs.append(nil)
        defer { for p in cargs { free(UnsafeMutablePointer(mutating: p)) } }
        mpv_command(h, &cargs)
    }

    private func setString(_ name: String, _ value: String) {
        guard let h = mpv else { return }
        mpv_set_property_string(h, name, value)
    }

    private func getString(_ name: String) -> String? {
        guard let h = mpv, let c = mpv_get_property_string(h, name) else { return nil }
        defer { mpv_free(c) }
        return String(cString: c)
    }

    private func setFlag(_ name: String, _ on: Bool) {
        guard let h = mpv else { return }
        var v: Int32 = on ? 1 : 0
        mpv_set_property(h, name, MPV_FORMAT_FLAG, &v)
    }

    private func drain() {
        events.async { [weak self] in
            while let self, let h = self.mpv {
                guard let ev = mpv_wait_event(h, 0) else { break }
                let e = ev.pointee
                if e.event_id == MPV_EVENT_NONE { break }
                self.handle(e)
            }
        }
    }

    private func handle(_ e: mpv_event) {
        switch e.event_id {
        case MPV_EVENT_PROPERTY_CHANGE:
            guard let p = UnsafeMutablePointer<mpv_event_property>(OpaquePointer(e.data))?.pointee else { return }
            let name = String(cString: p.name)
            if p.format == MPV_FORMAT_DOUBLE, let d = UnsafePointer<Double>(OpaquePointer(p.data))?.pointee {
                DispatchQueue.main.async { [weak self] in
                    guard let self, !self.finished else { return }
                    if name == "time-pos" { self.pos = d } else if name == "duration" { self.dur = d }
                    self.controller.setTime(self.pos, duration: self.dur > 0 ? self.dur : self.listedDuration)
                }
            } else if p.format == MPV_FORMAT_FLAG, let f = UnsafePointer<Int32>(OpaquePointer(p.data))?.pointee {
                DispatchQueue.main.async { [weak self] in
                    guard let self, !self.finished else { return }
                    if name == "pause" {
                        self.paused = f != 0
                        self.controller.setPlaying(!self.paused)
                        self.updateNowPlaying()
                    }
                }
            }
        case MPV_EVENT_FILE_LOADED:
            DispatchQueue.main.async { [weak self] in
                guard let self, !self.finished else { return }
                self.controller.setPlaying(!self.paused)
                self.updateNowPlaying()
            }
        case MPV_EVENT_END_FILE:
            guard let end = UnsafeMutablePointer<mpv_event_end_file>(OpaquePointer(e.data))?.pointee else { return }
            if end.reason == MPV_END_FILE_REASON_EOF {
                DispatchQueue.main.async { [weak self] in
                    guard let self, !self.finished else { return }
                    self.ended()
                }
            } else if end.reason == MPV_END_FILE_REASON_ERROR {
                let why = String(cString: mpv_error_string(end.error))
                DispatchQueue.main.async { [weak self] in
                    guard let self, !self.finished else { return }
                    let title = self.item["title"] as? String ?? ""
                    self.bridge.emit("playback-error", ["title": title, "code": "mpv", "details": why, "message": "\(title): this file couldn't be played (\(why))."])
                    self.close()
                }
            }
        case MPV_EVENT_LOG_MESSAGE:
            #if DEBUG
            if let m = UnsafeMutablePointer<mpv_event_log_message>(OpaquePointer(e.data))?.pointee {
                let line = "[\(String(cString: m.prefix))] \(String(cString: m.level)): \(String(cString: m.text))"
                MPVPlayback.log(line)
            }
            #endif
        default:
            break
        }
    }

    #if DEBUG
    /// Test builds keep mpv's warnings in Library/Caches/mpv.log (the automated check reads it).
    static func log(_ line: String) {
        let url = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("mpv.log")
        let data = Data((line.hasSuffix("\n") ? line : line + "\n").utf8)
        if let h = try? FileHandle(forWritingTo: url) { h.seekToEndOfFile(); h.write(data); try? h.close() } else { try? data.write(to: url) }
    }
    #endif

    private var listedDuration: Double { (item["duration"] as? NSNumber)?.doubleValue ?? 0 }

    // ---- films ---------------------------------------------------------------------------------------------
    private func load(_ i: Int) {
        index = i
        guard let path = item["path"] as? String else { return }
        pos = 0; dur = 0
        var fileOpts: [String] = []
        let start = (item["start"] as? NSNumber)?.doubleValue ?? 0
        if start > 0 { fileOpts.append("start=\(String(format: "%.2f", start))") }
        if let n = audioTrack, n >= 1, i == 0 { fileOpts.append("aid=\(n)") }
        fileOpts.append(subLang.isEmpty ? "sid=no" : "sid=auto")
        command(["loadfile", path, "replace", "-1", fileOpts.joined(separator: ",")])
        setFlag("pause", false)
        let title = item["title"] as? String ?? ""
        let sub = [item["sub"] as? String, item["name"] as? String].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
        controller.setTitle(title, subtitle: sub)
        controller.setHasNext(index + 1 < queue.count)
        controller.setTime(start, duration: listedDuration)
        updateNowPlaying()
        #if DEBUG
        MPVPlayback.log("== playing \(URL(fileURLWithPath: path).lastPathComponent)")
        #endif
    }

    // ---- controls --------------------------------------------------------------------------------------------
    private func togglePause() {
        setFlag("pause", !paused)
    }

    private func skip(_ seconds: Int) {
        command(["seek", String(seconds), "relative"])
        controller.poke()
    }

    private func seek(to fraction: Float) {
        let d = dur > 0 ? dur : listedDuration
        guard d > 0 else { return }
        command(["seek", String(format: "%.2f", d * Double(max(0, min(1, fraction)))), "absolute"])
    }

    private func next() {
        guard index + 1 < queue.count else { return }
        reportProgress(done: true)
        load(index + 1)
    }

    private struct Track { let id: Int; let type: String; let label: String; let selected: Bool }

    private func tracks() -> [Track] {
        let n = Int(getString("track-list/count") ?? "0") ?? 0
        var out: [Track] = []
        for i in 0..<n {
            let p = "track-list/\(i)/"
            guard let type = getString(p + "type"), let id = Int(getString(p + "id") ?? "") else { continue }
            let title = getString(p + "title") ?? ""
            let lang = getString(p + "lang") ?? ""
            let codec = (getString(p + "codec") ?? "").uppercased()
            let langName = lang.isEmpty ? "" : (Locale.current.localizedString(forLanguageCode: lang) ?? lang)
            var parts: [String] = []
            if !title.isEmpty { parts.append(title) }
            if !langName.isEmpty && !title.localizedCaseInsensitiveContains(langName) { parts.append(langName) }
            var detail = codec == "DCA" ? "DTS" : codec
            if type == "audio", let ch = Int(getString(p + "demux-channel-count") ?? "") {
                detail += ch == 8 ? " 7.1" : ch == 6 ? " 5.1" : ch == 2 ? " stereo" : ch == 1 ? " mono" : " \(ch)ch"
            }
            if getString(p + "external") == "yes" { detail += " (beside the film)" }
            if !detail.isEmpty { parts.append(detail) }
            let label = parts.isEmpty ? "Track \(id)" : parts.joined(separator: " · ")
            out.append(Track(id: id, type: type, label: label, selected: getString(p + "selected") == "yes"))
        }
        return out
    }

    /// The Audio & subtitles menu: every soundtrack and subtitle in the file (and beside it), the playing ones ticked.
    private func tracksMenu() -> UIMenu {
        let all = tracks()
        let audio: [UIAction] = all.filter { $0.type == "audio" }.map { t in
            UIAction(title: t.label, state: t.selected ? .on : .off) { [weak self] _ in
                self?.setString("aid", String(t.id)); self?.controller.poke()
            }
        }
        let texts = all.filter { $0.type == "sub" }
        var subs: [UIAction] = []
        if !texts.isEmpty {
            subs.append(UIAction(title: "Off", state: texts.contains { $0.selected } ? .off : .on) { [weak self] _ in
                self?.setString("sid", "no"); self?.controller.poke()
            })
        }
        subs += texts.map { t in
            UIAction(title: t.label, state: t.selected ? .on : .off) { [weak self] _ in
                self?.setString("sid", String(t.id)); self?.controller.poke()
            }
        }
        if subs.isEmpty { subs = [UIAction(title: "None in this file", attributes: .disabled) { _ in }] }
        return UIMenu(title: "", children: [
            UIMenu(title: "Audio", options: .displayInline, children: audio.isEmpty ? [UIAction(title: "None", attributes: .disabled) { _ in }] : audio),
            UIMenu(title: "Subtitles", options: .displayInline, children: subs),
        ])
    }

    // ---- progress --------------------------------------------------------------------------------------------
    private func ended() {
        reportProgress(done: true)
        if index + 1 < queue.count { load(index + 1) } else { close() }
    }

    private func reportProgress(done: Bool) {
        guard let id = item["id"] as? String else { return }
        let d = dur > 0 ? dur : listedDuration
        guard pos > 0 || done else { return }
        bridge.emit("video-progress", ["id": id, "pos": pos, "dur": d, "done": done || (d > 0 && pos / d > 0.95)])
        updateNowPlaying()
    }

    private func updateNowPlaying() {
        MPNowPlayingInfoCenter.default().nowPlayingInfo = [
            MPMediaItemPropertyTitle: item["title"] as? String ?? "",
            MPNowPlayingInfoPropertyElapsedPlaybackTime: pos,
            MPMediaItemPropertyPlaybackDuration: dur > 0 ? dur : listedDuration,
            MPNowPlayingInfoPropertyPlaybackRate: paused ? 0.0 : 1.0,
        ]
    }

    private func close() {
        stop()
        controller?.dismiss(animated: true)
    }

    func stop() {
        guard !finished else { return }
        finished = true
        reportProgress(done: false)
        progressTimer?.invalidate(); progressTimer = nil
        UIApplication.shared.isIdleTimerDisabled = false
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        bridge.emit("video-ended", [:])
        if MPVPlayback.current === self { MPVPlayback.current = nil }
        #if DEBUG
        // test builds note whether sound was decoded and played (the automated check reads it)
        MPVPlayback.log("== stats \(item["title"] as? String ?? "?"): audio=\(getString("audio-codec-name") ?? "-") audio-pts=\(getString("audio-pts") ?? "-") time=\(getString("time-pos") ?? "-") ao=\(getString("current-ao") ?? "-") vo=\(getString("current-vo") ?? "-") hwdec=\(getString("hwdec-current") ?? "-")")
        #endif
        // shut the engine down off the main thread; this player stays alive until it has
        if let h = mpv {
            mpv_set_wakeup_callback(h, nil, nil)
            MPVPlayback.closing.append(self)
            events.async { [weak self] in
                self?.mpv = nil
                mpv_terminate_destroy(h)
                DispatchQueue.main.async { MPVPlayback.closing.removeAll { $0 === self } }
            }
        }
    }
}

/// The layer mpv draws the picture into (through MoltenVK).
final class MPVMetalLayer: CAMetalLayer {
    // MoltenVK sometimes sets the drawable to 1×1 to finish presenting; that would leave a tiny or flickering
    // picture (https://github.com/mpv-player/mpv/pull/13651).
    override var drawableSize: CGSize {
        get { super.drawableSize }
        set { if Int(newValue.width) > 1 && Int(newValue.height) > 1 { super.drawableSize = newValue } }
    }

    // turning on the screen's HDR mode only works from the main thread
    override var wantsExtendedDynamicRangeContent: Bool {
        get { super.wantsExtendedDynamicRangeContent }
        set {
            if Thread.isMainThread { super.wantsExtendedDynamicRangeContent = newValue }
            else { DispatchQueue.main.sync { super.wantsExtendedDynamicRangeContent = newValue } }
        }
    }
}
