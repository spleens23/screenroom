import AVFoundation
import MediaPlayer
import UIKit

/// Parlor's player: a queue of songs that keeps playing with the screen off, with the lock screen and Control
/// Center controls (play / pause / skip / scrub). The page sees a snapshot of it (`music-state`).
final class MusicPlayer {
    static let shared = MusicPlayer()
    weak var bridge: Bridge?

    private let player = AVPlayer()
    private var queue: [[String: Any]] = []
    private var index = -1
    private var context: Any?
    private var volume: Float = 1
    private var muted = false
    private var endObserver: NSObjectProtocol?
    private var timeObserver: Any?
    private var rateObserver: NSKeyValueObservation?
    private var lastEmit = Date.distantPast
    private var shuffle = false
    private var unshuffled: [[String: Any]]?   // the queue's own order while shuffled
    private var repeatMode = "off"             // off, all (the whole queue), one (this song)

    private init() {
        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 1, preferredTimescale: 2), queue: .main) { [weak self] _ in
            self?.emit(throttled: true)
            self?.updateNowPlaying()
        }
        rateObserver = player.observe(\.timeControlStatus, options: [.new]) { [weak self] _, _ in
            DispatchQueue.main.async { self?.emit(); self?.updateNowPlaying() }
        }
        setUpRemote()
        // AirPods put in or taken out, Spatial Audio switched on or off in Control Center: the page shows it
        let nc = NotificationCenter.default
        nc.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] _ in self?.emit() }
        nc.addObserver(forName: AVAudioSession.spatialPlaybackCapabilitiesChangedNotification, object: nil, queue: .main) { [weak self] _ in self?.emit() }
    }

    /// Where the sound is going: the headphones or speaker, and whether iOS is playing it as Spatial Audio there.
    private func route() -> [String: Any] {
        let s = AVAudioSession.sharedInstance()
        let outs = s.currentRoute.outputs
        return ["spatial": outs.contains { $0.isSpatialAudioEnabled }, "name": outs.first?.portName ?? "",
                "kind": outs.first?.portType.rawValue ?? "", "channels": s.outputNumberOfChannels]
    }

    // ---- what the page sees ----------------------------------------------------------------------------------
    func snapshot() -> [String: Any] {
        let pos = player.currentTime().seconds
        var dur = player.currentItem?.duration.seconds ?? 0
        if !dur.isFinite || dur <= 0 { dur = (current?["duration"] as? NSNumber)?.doubleValue ?? 0 }
        let playing = index >= 0 && player.currentItem != nil
        return [
            "playing": playing,
            "paused": playing && player.timeControlStatus == .paused,
            "index": index, "pos": pos.isFinite ? pos : 0, "dur": dur,
            "volume": Int((volume * 100).rounded()), "muted": muted,
            "queue": queue.compactMap { $0["id"] as? String },
            "queued": queue.map { ($0["queued"] as? Bool) == true },
            "shuffle": shuffle, "repeat": repeatMode,
            "context": context ?? NSNull(),
            "route": route(),
        ]
    }

    private func emit(throttled: Bool = false) {
        if throttled && Date().timeIntervalSince(lastEmit) < 0.9 { return }
        lastEmit = Date()
        bridge?.emit("music-state", snapshot())
    }

    private var current: [String: Any]? { index >= 0 && index < queue.count ? queue[index] : nil }

    // ---- commands -------------------------------------------------------------------------------------------
    func play(tracks: [[String: Any]], start: Int, context: Any?) {
        VideoPlayback.current?.stop()
        MPVPlayback.current?.stop()
        queue = tracks
        shuffle = false; unshuffled = nil
        self.context = context
        go(to: max(0, min(start, tracks.count - 1)))
    }

    private func go(to i: Int) {
        guard i >= 0, i < queue.count, let path = queue[i]["path"] as? String else { stop(); return }
        // Surround songs (5.1, 7.1): telling iOS Parlor plays multichannel sound is what lets AirPods (and Beats) play
        // them as Spatial Audio, each channel placed around you with head tracking; the speaker and wired
        // headphones get them mixed down to stereo.
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .default)
        try? session.setSupportsMultichannelContent(true)
        try? session.setActive(true)
        try? session.setPreferredOutputNumberOfChannels(session.maximumOutputNumberOfChannels)
        index = i
        let item = AVPlayerItem(url: URL(fileURLWithPath: path))
        // surround songs always spatialized; stereo ones too when "Spatialize Stereo" is on in Control Center
        item.allowedAudioSpatializationFormats = .monoStereoAndMultichannel
        if let o = endObserver { NotificationCenter.default.removeObserver(o) }
        endObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self] _ in
            self?.next(auto: true)
        }
        player.replaceCurrentItem(with: item)
        player.volume = muted ? 0 : volume
        player.play()
        emit()
        updateNowPlaying(newTrack: true)
    }

    func command(_ cmd: String, _ arg: Any?) -> [String: Any]? {
        switch cmd {
        case "toggle": if player.timeControlStatus == .paused { player.play() } else { player.pause() }
        case "pause": player.pause()
        case "play": player.play()
        case "next": next(auto: false)
        case "prev": prev()
        case "seek":
            if let s = (arg as? NSNumber)?.doubleValue { player.seek(to: CMTime(seconds: s, preferredTimescale: 600)) }
        case "volume":
            if let v = (arg as? NSNumber)?.floatValue { volume = max(0, min(100, v)) / 100; player.volume = muted ? 0 : volume }
        case "volup": volume = min(1, volume + 0.05); player.volume = muted ? 0 : volume
        case "voldown": volume = max(0, volume - 0.05); player.volume = muted ? 0 : volume
        case "mute": muted.toggle(); player.volume = muted ? 0 : volume
        case "jump": if let i = (arg as? NSNumber)?.intValue { go(to: i) }
        case "stop": stop()
        case "clear":
            // Clear Queue: only the song that's playing is left (it carries on)
            if let cur = current { queue = [cur]; index = 0; unshuffled = nil }
        case "shuffle": toggleShuffle()
        case "repeat": repeatMode = ["off": "all", "all": "one"][repeatMode] ?? "off"
        case "enqueue":
            if let o = arg as? [String: Any], var tracks = o["tracks"] as? [[String: Any]] {
                for i in tracks.indices { tracks[i]["queued"] = true } // shown under "Playing Next"
                if (o["next"] as? Bool) == true, index >= 0 { queue.insert(contentsOf: tracks, at: index + 1) } else { queue.append(contentsOf: tracks) }
                if index < 0, !queue.isEmpty { go(to: 0) }
            }
        default: break
        }
        emit()
        return snapshot()
    }

    private func next(auto: Bool) {
        if auto && repeatMode == "one" { player.seek(to: .zero); player.play(); return }
        if index + 1 < queue.count { go(to: index + 1) }
        else if repeatMode == "all" && !queue.isEmpty { go(to: 0) }
        else if auto { stop() } else { player.seek(to: .zero); player.pause(); emit() }
    }

    /// Shuffle on: this song first, then everything else in a random order. Off: back to the queue's own order
    /// (songs added while shuffled stay, at the end). The song that's playing carries on either way.
    private func toggleShuffle() {
        shuffle.toggle()
        guard index >= 0, index < queue.count else { return }
        let cur = queue[index]
        let id = { (t: [String: Any]) in (t["id"] as? String) ?? "" }
        if shuffle {
            unshuffled = queue
            var rest = queue; rest.remove(at: index)
            queue = [cur] + rest.shuffled(); index = 0
        } else {
            let base = unshuffled ?? queue
            let known = Set(base.map(id))
            queue = base + queue.filter { !known.contains(id($0)) }
            index = queue.firstIndex { id($0) == id(cur) } ?? 0
            unshuffled = nil
        }
    }

    private func prev() {
        if player.currentTime().seconds > 3 || index == 0 { player.seek(to: .zero) } else { go(to: index - 1) }
    }

    func stop() {
        player.pause()
        player.replaceCurrentItem(with: nil)
        queue = []
        index = -1
        shuffle = false; unshuffled = nil
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        emit()
    }

    func pauseForVideo() { if index >= 0 { player.pause(); emit() } }

    // ---- lock screen and Control Center ------------------------------------------------------------------------
    private var artwork: MPMediaItemArtwork?
    private var artworkPath: String?

    private func updateNowPlaying(newTrack: Bool = false) {
        guard let t = current else { return }
        if newTrack || artworkPath != (t["art"] as? String) {
            artworkPath = t["art"] as? String
            if let p = artworkPath, let img = UIImage(contentsOfFile: p) {
                artwork = MPMediaItemArtwork(boundsSize: img.size) { _ in img }
            } else {
                artwork = nil
            }
        }
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: t["title"] as? String ?? "",
            MPMediaItemPropertyArtist: t["artist"] as? String ?? "",
            MPMediaItemPropertyAlbumTitle: t["album"] as? String ?? "",
            MPNowPlayingInfoPropertyElapsedPlaybackTime: player.currentTime().seconds,
            MPNowPlayingInfoPropertyPlaybackRate: player.timeControlStatus == .paused ? 0.0 : 1.0,
            MPNowPlayingInfoPropertyPlaybackQueueIndex: index,
            MPNowPlayingInfoPropertyPlaybackQueueCount: queue.count,
        ]
        let dur = player.currentItem?.duration.seconds ?? 0
        info[MPMediaItemPropertyPlaybackDuration] = dur.isFinite && dur > 0 ? dur : ((t["duration"] as? NSNumber)?.doubleValue ?? 0)
        if let a = artwork { info[MPMediaItemPropertyArtwork] = a }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    private func setUpRemote() {
        let c = MPRemoteCommandCenter.shared()
        c.playCommand.addTarget { [weak self] _ in self?.player.play(); return .success }
        c.pauseCommand.addTarget { [weak self] _ in self?.player.pause(); return .success }
        c.togglePlayPauseCommand.addTarget { [weak self] _ in _ = self?.command("toggle", nil); return .success }
        c.nextTrackCommand.addTarget { [weak self] _ in self?.next(auto: false); return .success }
        c.previousTrackCommand.addTarget { [weak self] _ in self?.prev(); return .success }
        c.changePlaybackPositionCommand.addTarget { [weak self] e in
            guard let e = e as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            self?.player.seek(to: CMTime(seconds: e.positionTime, preferredTimescale: 600))
            return .success
        }
    }
}
