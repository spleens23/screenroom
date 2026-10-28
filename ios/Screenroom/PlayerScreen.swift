import UIKit

/// The player screen: the picture, and Screenroom's controls over it (they fade after a few seconds; a tap
/// brings them back).
final class PlayerScreen: UIViewController {
    let videoView = UIView()
    var onClose: (() -> Void)?
    var onToggle: (() -> Void)?
    var onSkip: ((Int) -> Void)?
    var onSeek: ((Float) -> Void)?
    var onNext: (() -> Void)?
    var menuProvider: (() -> UIMenu?)?
    /// Called when the screen changes size (the mpv picture layer follows it).
    var onLayout: (() -> Void)?

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        onLayout?()
    }

    private let ink = UIColor(red: 0.086, green: 0.067, blue: 0.051, alpha: 1)
    private let cream = UIColor(red: 0.953, green: 0.914, blue: 0.863, alpha: 1)
    private let muted = UIColor(red: 0.804, green: 0.741, blue: 0.675, alpha: 1)
    private let amber = UIColor(red: 0.941, green: 0.655, blue: 0.227, alpha: 1)
    private let edge = UIColor(red: 0.353, green: 0.275, blue: 0.212, alpha: 1)

    /// Lets taps through where there's no control, so they reach the catcher underneath.
    private let overlay = PassthroughView()
    /// Fills the screen under the controls: a tap on the picture shows or hides them. (A plain control rather than
    /// a gesture recogniser, so nothing else on the screen can swallow the tap.)
    private let catcher = UIControl()
    private let panel = UIView()
    private let titleLabel = UILabel()
    private let subLabel = UILabel()
    private let elapsed = UILabel()
    private let remaining = UILabel()
    private let slider = UISlider()
    private let playButton = UIButton(type: .system)
    private let nextButton = UIButton(type: .system)
    private let tracksButton = MenuButton(type: .system)
    private var menuOpen = false
    private var playing = true
    private var hideTimer: Timer?
    private var scrubbing = false
    private var duration: Double = 0

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        videoView.backgroundColor = .black
        videoView.isUserInteractionEnabled = false
        videoView.frame = view.bounds
        videoView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(videoView)

        catcher.frame = view.bounds
        catcher.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        catcher.backgroundColor = .clear
        catcher.isAccessibilityElement = true
        catcher.accessibilityLabel = "Show or hide the controls"
        catcher.addTarget(self, action: #selector(tapped), for: .touchUpInside)
        view.addSubview(catcher)
        overlay.frame = view.bounds
        overlay.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(overlay)

        let close = roundButton(symbol: "xmark", size: 40, filled: false)
        close.addAction(UIAction { [weak self] _ in self?.onClose?() }, for: .touchUpInside)
        close.accessibilityLabel = "Close"

        panel.backgroundColor = ink.withAlphaComponent(0.82)
        titleLabel.font = UIFont(descriptor: UIFont.systemFont(ofSize: 21, weight: .semibold).fontDescriptor.withDesign(.serif)!, size: 21)
        titleLabel.textColor = cream
        subLabel.font = .systemFont(ofSize: 14)
        subLabel.textColor = muted
        for l in [elapsed, remaining] { l.font = .monospacedDigitSystemFont(ofSize: 13, weight: .regular); l.textColor = muted }
        slider.minimumTrackTintColor = amber
        slider.maximumTrackTintColor = edge
        slider.thumbTintColor = cream
        slider.addTarget(self, action: #selector(scrubStart), for: .touchDown)
        slider.addTarget(self, action: #selector(scrubMove), for: .valueChanged)
        slider.addTarget(self, action: #selector(scrubEnd), for: [.touchUpInside, .touchUpOutside, .touchCancel])

        let back = roundButton(symbol: "gobackward.10", size: 42, filled: false)
        back.addAction(UIAction { [weak self] _ in self?.onSkip?(-10) }, for: .touchUpInside)
        back.accessibilityLabel = "Back 10 seconds"
        let fwd = roundButton(symbol: "goforward.10", size: 42, filled: false)
        fwd.addAction(UIAction { [weak self] _ in self?.onSkip?(10) }, for: .touchUpInside)
        fwd.accessibilityLabel = "Forward 10 seconds"
        styleRound(playButton, symbol: "pause.fill", size: 54, filled: true)
        sizeRound(playButton, 54)
        playButton.addAction(UIAction { [weak self] _ in self?.onToggle?() }, for: .touchUpInside)

        stylePill(tracksButton, title: "Audio & subtitles")
        tracksButton.showsMenuAsPrimaryAction = true
        // the controls stay while the menu is open, and fade again a few seconds after it closes
        tracksButton.onOpen = { [weak self] in self?.menuOpen = true; self?.hideTimer?.invalidate() }
        tracksButton.onClose = { [weak self] in self?.menuOpen = false; self?.poke() }
        tracksButton.menu = UIMenu(children: [UIDeferredMenuElement.uncached { [weak self] done in
            done(self?.menuProvider?()?.children ?? [])
        }])
        stylePill(nextButton, title: "Next episode")
        nextButton.addAction(UIAction { [weak self] _ in self?.onNext?() }, for: .touchUpInside)

        let titles = UIStackView(arrangedSubviews: [titleLabel, subLabel])
        titles.axis = .vertical; titles.spacing = 2
        let bar = UIStackView(arrangedSubviews: [elapsed, slider, remaining])
        bar.spacing = 12; bar.alignment = .center
        let transport = UIStackView(arrangedSubviews: [back, playButton, fwd])
        transport.spacing = 22; transport.alignment = .center
        let right = UIStackView(arrangedSubviews: [nextButton, tracksButton])
        right.spacing = 10; right.alignment = .center

        for v in [close, panel] as [UIView] { v.translatesAutoresizingMaskIntoConstraints = false; overlay.addSubview(v) }
        for v in [titles, bar, transport, right] as [UIView] { v.translatesAutoresizingMaskIntoConstraints = false; panel.addSubview(v) }
        let g = overlay.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            close.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 22),
            close.topAnchor.constraint(equalTo: g.topAnchor, constant: 16),
            panel.leadingAnchor.constraint(equalTo: overlay.leadingAnchor),
            panel.trailingAnchor.constraint(equalTo: overlay.trailingAnchor),
            panel.bottomAnchor.constraint(equalTo: overlay.bottomAnchor),
            titles.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 28),
            titles.trailingAnchor.constraint(lessThanOrEqualTo: g.trailingAnchor, constant: -28),
            titles.topAnchor.constraint(equalTo: panel.topAnchor, constant: 14),
            bar.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 28),
            bar.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -28),
            bar.topAnchor.constraint(equalTo: titles.bottomAnchor, constant: 8),
            transport.centerXAnchor.constraint(equalTo: panel.centerXAnchor),
            transport.topAnchor.constraint(equalTo: bar.bottomAnchor, constant: 6),
            transport.bottomAnchor.constraint(equalTo: g.bottomAnchor, constant: -10),
            right.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -28),
            right.centerYAnchor.constraint(equalTo: transport.centerYAnchor),
            right.leadingAnchor.constraint(greaterThanOrEqualTo: transport.trailingAnchor, constant: 20),
        ])
        setTime(0, duration: 0)
        poke()
    }

    private func roundButton(symbol: String, size: CGFloat, filled: Bool) -> UIButton {
        let b = UIButton(type: .system)
        styleRound(b, symbol: symbol, size: size, filled: filled)
        sizeRound(b, size)
        return b
    }

    private func styleRound(_ b: UIButton, symbol: String, size: CGFloat, filled: Bool) {
        var c = UIButton.Configuration.plain()
        c.image = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: size * 0.36, weight: .semibold))
        c.baseForegroundColor = filled ? ink : cream
        c.background.backgroundColor = filled ? amber : ink.withAlphaComponent(0.6)
        c.background.strokeColor = filled ? .clear : edge
        c.background.strokeWidth = filled ? 0 : 1.2
        c.background.cornerRadius = size / 2
        b.configuration = c
    }

    private func sizeRound(_ b: UIButton, _ size: CGFloat) {
        b.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([b.widthAnchor.constraint(equalToConstant: size), b.heightAnchor.constraint(equalToConstant: size)])
    }

    private func stylePill(_ b: UIButton, title: String) {
        var c = UIButton.Configuration.plain()
        var t = AttributedString(title); t.font = .systemFont(ofSize: 14, weight: .medium)
        c.attributedTitle = t
        c.baseForegroundColor = cream
        c.background.backgroundColor = .clear
        c.background.strokeColor = edge
        c.background.strokeWidth = 1.2
        c.background.cornerRadius = 18
        c.contentInsets = NSDirectionalEdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16)
        b.configuration = c
    }

    func setTitle(_ title: String, subtitle: String) {
        titleLabel.text = title
        subLabel.text = subtitle
        subLabel.isHidden = subtitle.isEmpty
    }

    func setHasNext(_ has: Bool) { nextButton.isHidden = !has }

    func setPlaying(_ playing: Bool) {
        trace("setPlaying(\(playing))")
        self.playing = playing
        styleRound(playButton, symbol: playing ? "pause.fill" : "play.fill", size: 54, filled: true)
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
        trace("tap (shown=\(shown), alpha=\(overlay.alpha), hidden=\(overlay.isHidden))")
        if shown { show(false) } else { poke() }
    }

    /// Show the controls for a few seconds.
    func poke() {
        show(true)
        hideTimer?.invalidate()
        hideTimer = Timer.scheduledTimer(withTimeInterval: 4, repeats: false) { [weak self] _ in
            guard let self else { return }
            if self.scrubbing || self.menuOpen { self.poke(); return } // still in use: look again later
            if !self.playing { return } // paused: the controls stay up
            self.show(false)
        }
    }

    private var shown = true

    /// Hidden controls are taken out of the way entirely (not just faded), so the next tap always lands on the
    /// catcher and brings them back.
    private func show(_ on: Bool) {
        if on != shown { trace(on ? "show" : "hide") }
        shown = on
        if !on { hideTimer?.invalidate() }
        if on { overlay.isHidden = false }
        UIView.animate(withDuration: 0.25, delay: 0, options: [.allowUserInteraction, .beginFromCurrentState]) {
            self.overlay.alpha = on ? 1 : 0
        } completion: { _ in
            if !self.shown { self.overlay.isHidden = true }
        }
    }
}

/// Test builds note what the controls did (Library/Caches/ui.log, read by the automated check).
func trace(_ line: String) {
    #if DEBUG
    let url = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("ui.log")
    let data = Data("\(String(format: "%.2f", CACurrentMediaTime())) \(line)\n".utf8)
    if let h = try? FileHandle(forWritingTo: url) { h.seekToEndOfFile(); h.write(data); try? h.close() } else { try? data.write(to: url) }
    #endif
}

/// A view that only takes touches meant for what's on it.
final class PassthroughView: UIView {
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let v = super.hitTest(point, with: event)
        return v === self ? nil : v
    }
}

/// A button whose menu tells us when it opens and closes.
final class MenuButton: UIButton {
    var onOpen: (() -> Void)?
    var onClose: (() -> Void)?

    override func contextMenuInteraction(_ interaction: UIContextMenuInteraction, willDisplayMenuFor configuration: UIContextMenuConfiguration,
                                         animator: UIContextMenuInteractionAnimating?) {
        super.contextMenuInteraction(interaction, willDisplayMenuFor: configuration, animator: animator)
        onOpen?()
    }

    override func contextMenuInteraction(_ interaction: UIContextMenuInteraction, willEndFor configuration: UIContextMenuConfiguration,
                                         animator: UIContextMenuInteractionAnimating?) {
        super.contextMenuInteraction(interaction, willEndFor: configuration, animator: animator)
        onClose?()
    }
}
