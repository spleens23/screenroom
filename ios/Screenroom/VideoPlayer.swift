import AVKit
import UIKit

/// Plays a film (or a run of episodes) with Apple's player: full screen, scrubbing, AirPlay, picture-in-picture,
/// audio and subtitle choices. Reports where you are every few seconds, so Continue Watching works, and goes
/// on to the next episode by itself.
final class VideoPlayback: NSObject, AVPlayerViewControllerDelegate {
    static var current: VideoPlayback?

    private let queue: [[String: Any]]
    private var index = 0
    private let audioLang: String
    private let subLang: String
    private let audioTrack: Int?
    private let bridge: Bridge
    private let player = AVPlayer()
    private var controller: PlayerController!
    private var timeObserver: Any?
    private var endObserver: NSObjectProtocol?
    private var statusObserver: NSKeyValueObservation?
    private var inPiP = false
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
        VLCPlayback.current?.stop()
        MusicPlayer.shared.pauseForVideo()
        let p = VideoPlayback(queue: q, audioLang: opts["audioLang"] as? String ?? "eng", subLang: opts["subLang"] as? String ?? "",
                              audioTrack: (opts["audioTrack"] as? NSNumber)?.intValue, bridge: bridge)
        current = p
        p.present(from: presenter)
    }

    private func present(from presenter: UIViewController) {
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        try? AVAudioSession.sharedInstance().setActive(true)
        controller = PlayerController()
        controller.player = player
        controller.delegate = self
        controller.allowsPictureInPicturePlayback = true
        controller.canStartPictureInPictureAutomaticallyFromInline = true
        controller.modalPresentationStyle = .fullScreen
        controller.onDismiss = { [weak self] in self?.dismissed() }
        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 5, preferredTimescale: 1), queue: .main) { [weak self] _ in
            self?.reportProgress(done: false)
        }
        load(0)
        presenter.present(controller, animated: true) { [weak self] in self?.player.play() }
    }

    private var item: [String: Any] { queue[index] }

    private func load(_ i: Int) {
        index = i
        let entry = queue[i]
        guard let path = entry["path"] as? String else { return }
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
                var pick: AVMediaSelectionOption?
                if let n = audioTrack, n >= 1, n <= group.options.count { pick = group.options[n - 1] }
                if pick == nil { pick = group.options.first { matches($0, audioLang) } }
                if let p = pick { pi.select(p, in: group) }
            }
            if let group = try? await asset.loadMediaSelectionGroup(for: .legible) {
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
            controller.dismiss(animated: true)
        }
    }

    private func failed(_ error: Error?) {
        let title = item["title"] as? String ?? ""
        let msg = (error as NSError?)?.localizedDescription ?? "That file could not be played."
        bridge.emit("playback-error", ["title": title, "code": String((error as NSError?)?.code ?? 0),
                                       "details": String(describing: error), "message": "\(title): \(msg)"])
        controller.dismiss(animated: true)
    }

    private func dismissed() {
        if inPiP { return }
        stop()
    }

    func stop() {
        guard !finished else { return }
        finished = true
        reportProgress(done: false)
        player.pause()
        if let t = timeObserver { player.removeTimeObserver(t); timeObserver = nil }
        if let o = endObserver { NotificationCenter.default.removeObserver(o); endObserver = nil }
        statusObserver = nil
        player.replaceCurrentItem(with: nil)
        bridge.emit("video-ended", [:])
        if VideoPlayback.current === self { VideoPlayback.current = nil }
    }

    // ---- picture-in-picture ---------------------------------------------------------------------------------
    func playerViewControllerWillStartPictureInPicture(_ c: AVPlayerViewController) { inPiP = true }
    func playerViewControllerDidStopPictureInPicture(_ c: AVPlayerViewController) {
        inPiP = false
        if c.presentingViewController == nil { stop() }
    }
    func playerViewController(_ c: AVPlayerViewController, restoreUserInterfaceForPictureInPictureStopWithCompletionHandler done: @escaping (Bool) -> Void) {
        guard let root = UIApplication.shared.connectedScenes.compactMap({ ($0 as? UIWindowScene)?.keyWindow?.rootViewController }).first else { done(false); return }
        if c.presentingViewController == nil { root.present(c, animated: true) { done(true) } } else { done(true) }
    }
}

/// Apple's player screen, telling us when it's closed.
final class PlayerController: AVPlayerViewController {
    var onDismiss: (() -> Void)?
    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if isBeingDismissed || presentingViewController == nil { onDismiss?() }
    }
}
