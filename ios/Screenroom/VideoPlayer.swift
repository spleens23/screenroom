import AVKit
import UIKit

/// Plays the films Apple's engine handles (MP4 / MOV with AAC, AC-3 or E-AC-3 sound; keeps HDR and Dolby Vision),
/// behind the same Screenroom controls as the mpv films: title, scrub bar, back / forward 10 s, play / pause,
/// an Audio & subtitles menu and Next episode. Reports where you are every few seconds (Continue Watching) and
/// goes on to the next episode by itself.
final class VideoPlayback: NSObject {
    static var current: VideoPlayback?

    private let queue: [[String: Any]]
    private var index = 0
    private let audioLang: String
    private let subLang: String
    private let audioTrack: Int?
    private let bridge: Bridge
    private let player = AVPlayer()
    private var controller: PlayerScreen!
    private let layerView = PlayerLayerView()
    private var timeObserver: Any?
    private var tickObserver: Any?
    private var endObserver: NSObjectProtocol?
    private var statusObserver: NSKeyValueObservation?
    private var rateObserver: NSKeyValueObservation?
    private var audioGroup: AVMediaSelectionGroup?
    private var subGroup: AVMediaSelectionGroup?
    private var finished = false

    init(queue: [[String: Any]], audioLang: String, subLang: String, audioTrack: Int?, bridge: Bridge) {
        self.queue = queue
        self.audioLang = audioLang
        self.subLang = subLang
        self.audioTrack = audioTrack
        self.bridge = bridge
    }

    static func start(_ opts: [String: Any], from presenter: UIViewController, bridge: Bridge) throws {
        guard let q = opts["queue"] as? [[String: Any]], !q.isEmpty else { throw ScreenroomError("Nothing to play.") }
        current?.stop()
        MPVPlayback.current?.stop()
        MusicPlayer.shared.pauseForVideo()
        let p = VideoPlayback(queue: q, audioLang: opts["audioLang"] as? String ?? "eng", subLang: opts["subLang"] as? String ?? "",
                              audioTrack: (opts["audioTrack"] as? NSNumber)?.intValue, bridge: bridge)
        current = p
        p.present(from: presenter)
    }

    private func present(from presenter: UIViewController) {
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        try? AVAudioSession.sharedInstance().setActive(true)
        controller = PlayerScreen()
        controller.modalPresentationStyle = .fullScreen
        controller.loadViewIfNeeded()
        layerView.frame = controller.videoView.bounds
        layerView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        layerView.isUserInteractionEnabled = false
        layerView.playerLayer.player = player
        layerView.playerLayer.videoGravity = .resizeAspect
        controller.videoView.addSubview(layerView)
        controller.onClose = { [weak self] in self?.close() }
        controller.onToggle = { [weak self] in self?.togglePause() }
        controller.onSkip = { [weak self] s in self?.skip(s) }
        controller.onSeek = { [weak self] f in self?.seek(to: f) }
        controller.onNext = { [weak self] in self?.next() }
        controller.menuProvider = { [weak self] in self?.tracksMenu() }
        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 5, preferredTimescale: 1), queue: .main) { [weak self] _ in
            self?.reportProgress(done: false)
        }
        tickObserver = player.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 2), queue: .main) { [weak self] t in
            guard let self, let cur = self.player.currentItem else { return }
            var d = cur.duration.seconds
            if !d.isFinite || d <= 0 { d = (self.item["duration"] as? NSNumber)?.doubleValue ?? 0 }
            self.controller.setTime(t.seconds.isFinite ? t.seconds : 0, duration: d)
        }
        rateObserver = player.observe(\.timeControlStatus, options: [.new]) { [weak self] p, _ in
            DispatchQueue.main.async {
                guard let self, !self.finished, p.timeControlStatus != .waitingToPlayAtSpecifiedRate else { return }
                self.controller.setPlaying(p.timeControlStatus == .playing)
            }
        }
        UIApplication.shared.isIdleTimerDisabled = true
        load(0)
        presenter.present(controller, animated: true) { [weak self] in self?.player.play() }
    }

    private var item: [String: Any] { queue[index] }

    private func load(_ i: Int) {
        index = i
        let entry = queue[i]
        guard let path = entry["path"] as? String else { return }
        audioGroup = nil; subGroup = nil
        let asset = AVURLAsset(url: URL(fileURLWithPath: path))
        let pi = AVPlayerItem(asset: asset)
        pi.externalMetadata = metadata(entry)
        statusObserver = pi.observe(\.status, options: [.new]) { [weak self] it, _ in
            guard let self else { return }
            if it.status == .failed { DispatchQueue.main.async { self.failed(it.error) } }
            if it.status == .readyToPlay { DispatchQueue.main.async { self.chooseTracks(it) } }
        }
        if let o = endObserver { NotificationCenter.default.removeObserver(o) }
        endObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: pi, queue: .main) { [weak self] _ in
            self?.ended()
        }
        player.replaceCurrentItem(with: pi)
        let start = (entry["start"] as? NSNumber)?.doubleValue ?? 0
        if start > 0 { player.seek(to: CMTime(seconds: start, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero) }
        let title = entry["title"] as? String ?? ""
        let sub = [entry["sub"] as? String, entry["name"] as? String].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
        controller.setTitle(title, subtitle: sub)
        controller.setHasNext(i + 1 < queue.count)
        controller.setTime(start, duration: (entry["duration"] as? NSNumber)?.doubleValue ?? 0)
    }

    // ---- controls ---------------------------------------------------------------------------------------
    private func togglePause() {
        if player.timeControlStatus == .paused { player.play() } else { player.pause() }
    }

    private func skip(_ seconds: Int) {
        let t = player.currentTime().seconds
        guard t.isFinite else { return }
        player.seek(to: CMTime(seconds: max(0, t + Double(seconds)), preferredTimescale: 600))
        controller.poke()
    }

    private func seek(to fraction: Float) {
        guard let d = player.currentItem?.duration.seconds, d.isFinite, d > 0 else { return }
        player.seek(to: CMTime(seconds: d * Double(max(0, min(1, fraction))), preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
    }

    private func next() {
        guard index + 1 < queue.count else { return }
        reportProgress(done: true)
        load(index + 1)
        player.play()
    }

    private func close() {
        stop()
        controller?.dismiss(animated: true)
    }

    /// The Audio & subtitles menu: every soundtrack and subtitle Apple's engine sees in the file, the playing ones ticked.
    private func tracksMenu() -> UIMenu {
        guard let pi = player.currentItem else { return UIMenu(children: []) }
        var audio: [UIAction] = []
        if let g = audioGroup {
            let cur = pi.currentMediaSelection.selectedMediaOption(in: g)
            for o in g.options {
                audio.append(UIAction(title: o.displayName, state: o == cur ? .on : .off) { [weak self] _ in
                    pi.select(o, in: g); self?.controller.poke()
                })
            }
        }
        var subs: [UIAction] = []
        if let g = subGroup {
            let cur = pi.currentMediaSelection.selectedMediaOption(in: g)
            if g.allowsEmptySelection {
                subs.append(UIAction(title: "Off", state: cur == nil ? .on : .off) { [weak self] _ in
                    pi.select(nil, in: g); self?.controller.poke()
                })
            }
            for o in g.options {
                subs.append(UIAction(title: o.displayName, state: o == cur ? .on : .off) { [weak self] _ in
                    pi.select(o, in: g); self?.controller.poke()
                })
            }
        }
        if subs.isEmpty { subs = [UIAction(title: "None in this file", attributes: .disabled) { _ in }] }
        return UIMenu(title: "", children: [
            UIMenu(title: "Audio", options: .displayInline, children: audio.isEmpty ? [UIAction(title: "None", attributes: .disabled) { _ in }] : audio),
            UIMenu(title: "Subtitles", options: .displayInline, children: subs),
        ])
    }

    private func metadata(_ e: [String: Any]) -> [AVMetadataItem] {
        func item(_ id: AVMetadataIdentifier, _ value: Any?) -> AVMetadataItem? {
            let m = AVMutableMetadataItem()
            m.identifier = id
            if let s = value as? String {
                guard !s.isEmpty else { return nil }
                m.value = s as NSString
            } else if let d = value as? NSData {
                m.value = d
            } else {
                return nil
            }
            m.extendedLanguageTag = "und"
            return m
        }
        let title = e["title"] as? String ?? ""
        let sub = [e["sub"] as? String, e["name"] as? String].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
        var art: Data?
        if let p = e["art"] as? String, !p.isEmpty, let img = UIImage(contentsOfFile: p) { art = img.jpegData(compressionQuality: 0.8) }
        return [
            item(.commonIdentifierTitle, title),
            item(.iTunesMetadataTrackSubTitle, sub),
            item(.commonIdentifierDescription, e["desc"] as? String),
            item(.commonIdentifierArtwork, art.map { $0 as NSData }),
        ].compactMap { $0 }
    }

    /// The soundtrack in your language (or the one picked on the film's page), subtitles if you want them.
    private func chooseTracks(_ pi: AVPlayerItem) {
        Task { @MainActor in
            let asset = pi.asset
            if let group = try? await asset.loadMediaSelectionGroup(for: .audible) {
                audioGroup = group
                var pick: AVMediaSelectionOption?
                if let n = audioTrack, n >= 1, n <= group.options.count { pick = group.options[n - 1] }
                if pick == nil { pick = group.options.first { matches($0, audioLang) } }
                if let p = pick { pi.select(p, in: group) }
            }
            if let group = try? await asset.loadMediaSelectionGroup(for: .legible) {
                subGroup = group
                if subLang.isEmpty {
                    if group.allowsEmptySelection { pi.select(nil, in: group) }
                } else if let p = group.options.first(where: { matches($0, subLang) }) {
                    pi.select(p, in: group)
                }
            }
        }
    }

    private func matches(_ o: AVMediaSelectionOption, _ lang: String) -> Bool {
        guard !lang.isEmpty, let tag = o.extendedLanguageTag ?? o.locale?.identifier else { return false }
        let want = Locale(identifier: lang).language.languageCode?.identifier(.alpha2) ?? lang
        let have = Locale(identifier: tag).language.languageCode?.identifier(.alpha2) ?? tag
        return want.lowercased() == have.lowercased()
    }

    // ---- progress -----------------------------------------------------------------------------------------
    private func reportProgress(done: Bool) {
        guard let id = item["id"] as? String, let cur = player.currentItem else { return }
        let pos = player.currentTime().seconds
        var dur = cur.duration.seconds
        if !dur.isFinite || dur <= 0 { dur = (item["duration"] as? NSNumber)?.doubleValue ?? 0 }
        guard pos.isFinite, pos > 0 || done else { return }
        let finishedIt = done || (dur > 0 && pos / dur > 0.95)
        bridge.emit("video-progress", ["id": id, "pos": pos, "dur": dur, "done": finishedIt])
    }

    private func ended() {
        reportProgress(done: true)
        if index + 1 < queue.count {
            load(index + 1)
            player.play()
        } else {
            close()
        }
    }

    private func failed(_ error: Error?) {
        let title = item["title"] as? String ?? ""
        let msg = (error as NSError?)?.localizedDescription ?? "That file could not be played."
        bridge.emit("playback-error", ["title": title, "code": String((error as NSError?)?.code ?? 0),
                                       "details": String(describing: error), "message": "\(title): \(msg)"])
        close()
    }

    func stop() {
        guard !finished else { return }
        finished = true
        reportProgress(done: false)
        player.pause()
        if let t = timeObserver { player.removeTimeObserver(t); timeObserver = nil }
        if let t = tickObserver { player.removeTimeObserver(t); tickObserver = nil }
        rateObserver = nil
        UIApplication.shared.isIdleTimerDisabled = false
        if let o = endObserver { NotificationCenter.default.removeObserver(o); endObserver = nil }
        statusObserver = nil
        player.replaceCurrentItem(with: nil)
        bridge.emit("video-ended", [:])
        if VideoPlayback.current === self { VideoPlayback.current = nil }
    }

}

/// A view whose layer shows an AVPlayer's picture.
final class PlayerLayerView: UIView {
    override class var layerClass: AnyClass { AVPlayerLayer.self }
    var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
}
