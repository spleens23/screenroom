import UIKit
import AVFoundation
import MediaPlayer
import MobileVLCKit

/// Plays what Apple's player can't (DTS and TrueHD sound, MKV / AVI / WebM files, films with .srt subtitles beside
/// them) with VLC's engine, behind Screenroom's own controls: the title, a scrub bar, back / forward 10 s,
/// play / pause, an Audio & subtitles menu that switches tracks while the film plays, and Next episode.
/// Reports where you are every few seconds (Continue Watching) and goes on to the next episode by itself.
final class VLCPlayback: NSObject, VLCMediaPlayerDelegate {
    static var current: VLCPlayback?

    private let queue: [[String: Any]]
    private var index = 0
    private let audioLang: String
    private let subLang: String
    private let audioTrack: Int?
    private let bridge: Bridge
    private let player = VLCMediaPlayer()
    private var controller: VLCPlayerController!
    private var progressTimer: Timer?
    private var finished = false
    private var tracksChosen = false
    private var pendingStart: Double = 0

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
        let p = VLCPlayback(queue: q, audioLang: opts["audioLang"] as? String ?? "eng", subLang: opts["subLang"] as? String ?? "",
                            audioTrack: (opts["audioTrack"] as? NSNumber)?.intValue, bridge: bridge)
        current = p
        p.present(from: presenter)
    }

    private var item: [String: Any] { queue[index] }

    private func present(from presenter: UIViewController) {
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        try? AVAudioSession.sharedInstance().setActive(true)
        controller = VLCPlayerController()
        controller.modalPresentationStyle = .fullScreen
        controller.loadViewIfNeeded()
        controller.onClose = { [weak self] in self?.close() }
        controller.onToggle = { [weak self] in self?.togglePause() }
        controller.onSkip = { [weak self] s in self?.skip(s) }
        controller.onSeek = { [weak self] f in self?.seek(to: f) }
        controller.onNext = { [weak self] in self?.next() }
        controller.menuProvider = { [weak self] in self?.tracksMenu() }
        player.delegate = self
        player.drawable = controller.videoView
        presenter.present(controller, animated: true) { [weak self] in self?.load(0) }
        progressTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.reportProgress(done: false) }
        UIApplication.shared.isIdleTimerDisabled = true
    }

    private func load(_ i: Int) {
        index = i
        tracksChosen = false
        guard let path = item["path"] as? String else { return }
        let url = URL(fileURLWithPath: path)
        let media = VLCMedia(url: url)
        player.media = media
        // .srt / .vtt beside the film (Film.srt, Film.en.srt …)
        for sub in sidecarSubtitles(for: url) { player.addPlaybackSlave(sub, type: .subtitle, enforce: false) }
        pendingStart = (item["start"] as? NSNumber)?.doubleValue ?? 0
        let title = item["title"] as? String ?? ""
        let sub = [item["sub"] as? String, item["name"] as? String].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
        controller.setTitle(title, subtitle: sub)
        controller.setHasNext(index + 1 < queue.count)
        player.play()
        updateNowPlaying()
    }

    private func sidecarSubtitles(for url: URL) -> [URL] {
        let dir = url.deletingLastPathComponent()
        let base = url.deletingPathExtension().lastPathComponent.lowercased()
        let names = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
        return names.filter { n in
            let l = n.lowercased()
            return (l.hasSuffix(".srt") || l.hasSuffix(".vtt") || l.hasSuffix(".ass") || l.hasSuffix(".ssa")) && l.hasPrefix(base)
        }.sorted().map { dir.appendingPathComponent($0) }
    }

    // ---- controls ---------------------------------------------------------------------------------------
    private func togglePause() {
        if player.isPlaying { player.pause() } else { player.play() }
        controller.setPlaying(!player.isPlaying)
    }

    private func skip(_ seconds: Int) {
        if seconds >= 0 { player.jumpForward(Int32(seconds)) } else { player.jumpBackward(Int32(-seconds)) }
        controller.poke()
    }

    private func seek(to fraction: Float) {
        player.position = max(0, min(1, fraction))
    }

    private func next() {
        guard index + 1 < queue.count else { return }
        reportProgress(done: true)
        load(index + 1)
    }

    /// The Audio & subtitles menu: every soundtrack and subtitle in the file (and beside it), the playing ones ticked.
    private func tracksMenu() -> UIMenu {
        func names(_ a: [Any]?) -> [String] { (a ?? []).map { "\($0)" } }
        func ids(_ a: [Any]?) -> [Int32] { (a ?? []).compactMap { ($0 as? NSNumber)?.int32Value } }
        let aIds = ids(player.audioTrackIndexes), aNames = names(player.audioTrackNames)
        let sIds = ids(player.videoSubTitlesIndexes), sNames = names(player.videoSubTitlesNames)
        let curA = player.currentAudioTrackIndex, curS = player.currentVideoSubTitleIndex
        var audio: [UIAction] = []
        for (n, id) in aIds.enumerated() where id >= 0 {
            let label = n < aNames.count ? aNames[n] : "Track \(n)"
            audio.append(UIAction(title: label, state: id == curA ? .on : .off) { [weak self] _ in
                self?.player.currentAudioTrackIndex = id
                self?.controller.poke()
            })
        }
        var subs: [UIAction] = []
        for (n, id) in sIds.enumerated() {
            let label = id < 0 ? "Off" : (n < sNames.count ? sNames[n] : "Subtitle \(n)")
            subs.append(UIAction(title: label, state: id == curS ? .on : .off) { [weak self] _ in
                self?.player.currentVideoSubTitleIndex = id
                self?.controller.poke()
            })
        }
        if subs.isEmpty { subs = [UIAction(title: "None in this file", attributes: .disabled) { _ in }] }
        return UIMenu(title: "", children: [
            UIMenu(title: "Audio", options: .displayInline, children: audio.isEmpty ? [UIAction(title: "None", attributes: .disabled) { _ in }] : audio),
            UIMenu(title: "Subtitles", options: .displayInline, children: subs),
        ])
    }

    /// The soundtrack in your language (or the one picked on the film's page), subtitles if you want them.
    private func chooseTracks() {
        guard !tracksChosen else { return }
        let aIds = (player.audioTrackIndexes ?? []).compactMap { ($0 as? NSNumber)?.int32Value }.filter { $0 >= 0 }
        guard !aIds.isEmpty else { return }
        tracksChosen = true
        let aNames = (player.audioTrackNames ?? []).map { "\($0)".lowercased() }
        if let n = audioTrack, n >= 1, n <= aIds.count {
            player.currentAudioTrackIndex = aIds[n - 1]
        } else if let k = matchIndex(aNames.filter { $0 != "disable" }, lang: audioLang) {
            player.currentAudioTrackIndex = aIds[k]
        }
        let sIds = (player.videoSubTitlesIndexes ?? []).compactMap { ($0 as? NSNumber)?.int32Value }
        let sNames = (player.videoSubTitlesNames ?? []).map { "\($0)".lowercased() }
        if subLang.isEmpty {
            player.currentVideoSubTitleIndex = -1
        } else if let k = matchIndex(sNames, lang: subLang), k < sIds.count {
            player.currentVideoSubTitleIndex = sIds[k]
        }
    }

    /// VLC names tracks like "English - [English]" or "Track 2 - [Deutsch]": find the one in a language.
    private func matchIndex(_ names: [String], lang: String) -> Int? {
        guard !lang.isEmpty else { return nil }
        let code = Locale(identifier: lang).language.languageCode?.identifier ?? lang
        let english = Locale(identifier: "en").localizedString(forLanguageCode: code)?.lowercased() ?? lang
        let native = Locale(identifier: code).localizedString(forLanguageCode: code)?.lowercased() ?? lang
        return names.firstIndex { $0.contains(english) || $0.contains(native) || $0.contains("[\(lang)]") || $0.contains("[\(code)]") }
    }

    // ---- what VLC tells us --------------------------------------------------------------------------------
    func mediaPlayerStateChanged(_ aNotification: Notification) {
        DispatchQueue.main.async { [weak self] in
            guard let self, !self.finished else { return }
            switch self.player.state {
            case .playing, .esAdded:
                self.chooseTracks()
                if self.pendingStart > 0, let len = self.player.media?.length.intValue, len > 0 {
                    self.player.position = Float(self.pendingStart * 1000 / Double(len))
                    self.pendingStart = 0
                }
                self.controller.setPlaying(true)
            case .paused:
                self.controller.setPlaying(false)
            case .ended:
                self.ended()
            case .error:
                let title = self.item["title"] as? String ?? ""
                self.bridge.emit("playback-error", ["title": title, "code": "vlc", "details": "", "message": "\(title): this file couldn't be played."])
                self.close()
            default:
                break
            }
        }
    }

    func mediaPlayerTimeChanged(_ aNotification: Notification) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            let pos = Double(self.player.time.intValue) / 1000
            let len = Double(self.player.media?.length.intValue ?? 0) / 1000
            self.controller.setTime(pos, duration: len)
            if !self.tracksChosen { self.chooseTracks() }
        }
    }

    private func ended() {
        reportProgress(done: true)
        if index + 1 < queue.count { load(index + 1) } else { close() }
    }

    private func reportProgress(done: Bool) {
        guard let id = item["id"] as? String else { return }
        let pos = Double(player.time.intValue) / 1000
        var dur = Double(player.media?.length.intValue ?? 0) / 1000
        if dur <= 0 { dur = (item["duration"] as? NSNumber)?.doubleValue ?? 0 }
        guard pos > 0 || done else { return }
        bridge.emit("video-progress", ["id": id, "pos": pos, "dur": dur, "done": done || (dur > 0 && pos / dur > 0.95)])
        updateNowPlaying()
    }

    private func updateNowPlaying() {
        let len = Double(player.media?.length.intValue ?? 0) / 1000
        MPNowPlayingInfoCenter.default().nowPlayingInfo = [
            MPMediaItemPropertyTitle: item["title"] as? String ?? "",
            MPNowPlayingInfoPropertyElapsedPlaybackTime: Double(player.time.intValue) / 1000,
            MPMediaItemPropertyPlaybackDuration: len > 0 ? len : ((item["duration"] as? NSNumber)?.doubleValue ?? 0),
            MPNowPlayingInfoPropertyPlaybackRate: player.isPlaying ? 1.0 : 0.0,
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
        player.delegate = nil
        player.stop()
        UIApplication.shared.isIdleTimerDisabled = false
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        bridge.emit("video-ended", [:])
        if VLCPlayback.current === self { VLCPlayback.current = nil }
    }
}

/// The player screen: the picture, and Screenroom's controls over it (they fade after a few seconds; a tap
/// brings them back).
final class VLCPlayerController: UIViewController {
    let videoView = UIView()
    var onClose: (() -> Void)?
    var onToggle: (() -> Void)?
    var onSkip: ((Int) -> Void)?
    var onSeek: ((Float) -> Void)?
    var onNext: (() -> Void)?
    var menuProvider: (() -> UIMenu?)?

    private let ink = UIColor(red: 0.086, green: 0.067, blue: 0.051, alpha: 1)
    private let cream = UIColor(red: 0.953, green: 0.914, blue: 0.863, alpha: 1)
    private let muted = UIColor(red: 0.804, green: 0.741, blue: 0.675, alpha: 1)
    private let amber = UIColor(red: 0.941, green: 0.655, blue: 0.227, alpha: 1)
    private let edge = UIColor(red: 0.353, green: 0.275, blue: 0.212, alpha: 1)

    private let overlay = UIView()
    private let panel = UIView()
    private let titleLabel = UILabel()
    private let subLabel = UILabel()
    private let elapsed = UILabel()
    private let remaining = UILabel()
    private let slider = UISlider()
    private let playButton = UIButton(type: .system)
    private let nextButton = UIButton(type: .system)
    private let tracksButton = UIButton(type: .system)
    private var hideTimer: Timer?
    private var scrubbing = false
    private var duration: Double = 0

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        videoView.backgroundColor = .black
        videoView.frame = view.bounds
        videoView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(videoView)

        overlay.frame = view.bounds
        overlay.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(overlay)
        view.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped)))

        let close = roundButton(symbol: "xmark", size: 52, filled: false)
        close.addAction(UIAction { [weak self] _ in self?.onClose?() }, for: .touchUpInside)
        close.accessibilityLabel = "Close"

        panel.backgroundColor = ink.withAlphaComponent(0.9)
        titleLabel.font = UIFont(descriptor: UIFont.systemFont(ofSize: 30, weight: .semibold).fontDescriptor.withDesign(.serif)!, size: 30)
        titleLabel.textColor = cream
        subLabel.font = .systemFont(ofSize: 18)
        subLabel.textColor = muted
        for l in [elapsed, remaining] { l.font = .monospacedDigitSystemFont(ofSize: 16, weight: .regular); l.textColor = muted }
        slider.minimumTrackTintColor = amber
        slider.maximumTrackTintColor = edge
        slider.thumbTintColor = cream
        slider.addTarget(self, action: #selector(scrubStart), for: .touchDown)
        slider.addTarget(self, action: #selector(scrubMove), for: .valueChanged)
        slider.addTarget(self, action: #selector(scrubEnd), for: [.touchUpInside, .touchUpOutside, .touchCancel])

        let back = roundButton(symbol: "gobackward.10", size: 56, filled: false)
        back.addAction(UIAction { [weak self] _ in self?.onSkip?(-10) }, for: .touchUpInside)
        back.accessibilityLabel = "Back 10 seconds"
        let fwd = roundButton(symbol: "goforward.10", size: 56, filled: false)
        fwd.addAction(UIAction { [weak self] _ in self?.onSkip?(10) }, for: .touchUpInside)
        fwd.accessibilityLabel = "Forward 10 seconds"
        styleRound(playButton, symbol: "pause.fill", size: 72, filled: true)
        playButton.addAction(UIAction { [weak self] _ in self?.onToggle?() }, for: .touchUpInside)

        stylePill(tracksButton, title: "Audio & subtitles")
        tracksButton.showsMenuAsPrimaryAction = true
        tracksButton.menu = UIMenu(children: [UIDeferredMenuElement.uncached { [weak self] done in
            done(self?.menuProvider?()?.children ?? [])
        }])
        stylePill(nextButton, title: "Next episode")
        nextButton.addAction(UIAction { [weak self] _ in self?.onNext?() }, for: .touchUpInside)

        let titles = UIStackView(arrangedSubviews: [titleLabel, subLabel])
        titles.axis = .vertical; titles.spacing = 2
        let bar = UIStackView(arrangedSubviews: [elapsed, slider, remaining])
        bar.spacing = 14; bar.alignment = .center
        let transport = UIStackView(arrangedSubviews: [back, playButton, fwd])
        transport.spacing = 28; transport.alignment = .center
        let right = UIStackView(arrangedSubviews: [nextButton, tracksButton])
        right.spacing = 12; right.alignment = .center

        for v in [close, panel] as [UIView] { v.translatesAutoresizingMaskIntoConstraints = false; overlay.addSubview(v) }
        for v in [titles, bar, transport, right] as [UIView] { v.translatesAutoresizingMaskIntoConstraints = false; panel.addSubview(v) }
        let g = overlay.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            close.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 28),
            close.topAnchor.constraint(equalTo: g.topAnchor, constant: 20),
            panel.leadingAnchor.constraint(equalTo: overlay.leadingAnchor),
            panel.trailingAnchor.constraint(equalTo: overlay.trailingAnchor),
            panel.bottomAnchor.constraint(equalTo: overlay.bottomAnchor),
            titles.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 36),
            titles.trailingAnchor.constraint(lessThanOrEqualTo: g.trailingAnchor, constant: -36),
            titles.topAnchor.constraint(equalTo: panel.topAnchor, constant: 22),
            bar.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 36),
            bar.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -36),
            bar.topAnchor.constraint(equalTo: titles.bottomAnchor, constant: 14),
            transport.centerXAnchor.constraint(equalTo: panel.centerXAnchor),
            transport.topAnchor.constraint(equalTo: bar.bottomAnchor, constant: 12),
            transport.bottomAnchor.constraint(equalTo: g.bottomAnchor, constant: -18),
            right.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -36),
            right.centerYAnchor.constraint(equalTo: transport.centerYAnchor),
            right.leadingAnchor.constraint(greaterThanOrEqualTo: transport.trailingAnchor, constant: 20),
        ])
        setTime(0, duration: 0)
        poke()
    }

    private func roundButton(symbol: String, size: CGFloat, filled: Bool) -> UIButton {
        let b = UIButton(type: .system)
        styleRound(b, symbol: symbol, size: size, filled: filled)
        return b
    }

    private func styleRound(_ b: UIButton, symbol: String, size: CGFloat, filled: Bool) {
        var c = UIButton.Configuration.plain()
        c.image = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: size * 0.36, weight: .semibold))
        c.baseForegroundColor = filled ? ink : cream
        c.background.backgroundColor = filled ? amber : ink.withAlphaComponent(0.6)
        c.background.strokeColor = filled ? .clear : edge
        c.background.strokeWidth = filled ? 0 : 1.5
        c.background.cornerRadius = size / 2
        b.configuration = c
        b.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([b.widthAnchor.constraint(equalToConstant: size), b.heightAnchor.constraint(equalToConstant: size)])
    }

    private func stylePill(_ b: UIButton, title: String) {
        var c = UIButton.Configuration.plain()
        var t = AttributedString(title); t.font = .systemFont(ofSize: 17, weight: .medium)
        c.attributedTitle = t
        c.baseForegroundColor = cream
        c.background.backgroundColor = .clear
        c.background.strokeColor = edge
        c.background.strokeWidth = 1.5
        c.background.cornerRadius = 24
        c.contentInsets = NSDirectionalEdgeInsets(top: 12, leading: 22, bottom: 12, trailing: 22)
        b.configuration = c
    }

    func setTitle(_ title: String, subtitle: String) {
        titleLabel.text = title
        subLabel.text = subtitle
        subLabel.isHidden = subtitle.isEmpty
    }

    func setHasNext(_ has: Bool) { nextButton.isHidden = !has }

    func setPlaying(_ playing: Bool) {
        styleRound(playButton, symbol: playing ? "pause.fill" : "play.fill", size: 72, filled: true)
        playButton.accessibilityLabel = playing ? "Pause" : "Play"
        if !playing { show(true) } else { poke() }
    }

    func setTime(_ pos: Double, duration d: Double) {
        duration = d
        elapsed.text = fmt(pos)
        remaining.text = "−" + fmt(max(0, d - pos))
        if !scrubbing && d > 0 { slider.value = Float(pos / d) }
    }

    private func fmt(_ t: Double) -> String {
        let s = Int(max(0, t)), h = s / 3600, m = s % 3600 / 60, sec = s % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, sec) : String(format: "%d:%02d", m, sec)
    }

    @objc private func scrubStart() { scrubbing = true; hideTimer?.invalidate() }
    @objc private func scrubMove() { if duration > 0 { elapsed.text = fmt(Double(slider.value) * duration) } }
    @objc private func scrubEnd() { scrubbing = false; onSeek?(slider.value); poke() }

    @objc private func tapped() {
        if overlay.alpha > 0.5 { show(false) } else { poke() }
    }

    /// Show the controls for a few seconds.
    func poke() {
        show(true)
        hideTimer?.invalidate()
        hideTimer = Timer.scheduledTimer(withTimeInterval: 4, repeats: false) { [weak self] _ in
            guard let self, !self.scrubbing, !self.tracksButton.isHighlighted else { return }
            self.show(false)
        }
    }

    private func show(_ on: Bool) {
        UIView.animate(withDuration: 0.25) { self.overlay.alpha = on ? 1 : 0 }
    }
}
