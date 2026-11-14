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
    private var statusObserver: NSKeyValueObservation?
    private var failsInARow = 0
    private var lastEmit = Date.distantPast
    private var shuffle = false
    private var unshuffled: [[String: Any]]?   // the queue's own order while shuffled
    private var repeatMode = "off"             // off, all (the whole queue), one (this song)
    private var link: SonosLink?               // playing on a Sonos room instead of the phone

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
        // (the audio system is only ever asked on its own queue: its answers can take a moment, and the screen
        // mustn't wait for them)
        let nc = NotificationCenter.default
        nc.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: nil) { [weak self] _ in self?.refreshRoute() }
        nc.addObserver(forName: AVAudioSession.spatialPlaybackCapabilitiesChangedNotification, object: nil, queue: nil) { [weak self] _ in self?.refreshRoute() }
        refreshRoute()
    }

    private let audioQ = DispatchQueue(label: "parlor.audio-session", qos: .userInitiated)
    private var routeNow: [String: Any] = [:]   // read on the main thread only

    /// Where the sound is going: the headphones or speaker, and whether iOS is playing it as Spatial Audio there.
    private func refreshRoute() {
        audioQ.async { [weak self] in
            let s = AVAudioSession.sharedInstance()
            let outs = s.currentRoute.outputs
            let r: [String: Any] = ["spatial": outs.contains { $0.isSpatialAudioEnabled }, "name": outs.first?.portName ?? "",
                                    "kind": outs.first?.portType.rawValue ?? "", "channels": s.outputNumberOfChannels]
            DispatchQueue.main.async {
                guard let self else { return }
                let changed = !NSDictionary(dictionary: self.routeNow).isEqual(to: r)
                self.routeNow = r
                if changed { self.emit() }
            }
        }
    }

    /// Surround songs (5.1, 7.1): telling iOS Parlor plays multichannel sound is what lets AirPods (and Beats) play
    /// them as Spatial Audio, each channel placed around you with head tracking; the speaker and wired headphones
    /// get them mixed down to stereo.
    private func prepareSession() {
        audioQ.async { [weak self] in
            let session = AVAudioSession.sharedInstance()
            try? session.setCategory(.playback, mode: .default)
            try? session.setSupportsMultichannelContent(true)
            try? session.setActive(true)
            if session.maximumOutputNumberOfChannels > 2, session.preferredOutputNumberOfChannels != session.maximumOutputNumberOfChannels {
                try? session.setPreferredOutputNumberOfChannels(session.maximumOutputNumberOfChannels)
            }
            self?.refreshRoute()
        }
    }

    // ---- what the page sees ----------------------------------------------------------------------------------
    func snapshot() -> [String: Any] {
        var pos = player.currentTime().seconds
        var dur = player.currentItem?.duration.seconds ?? 0
        var playing = index >= 0 && player.currentItem != nil
        var paused = playing && player.timeControlStatus == .paused
        var vol = Int((volume * 100).rounded()), mute = muted
        var route = routeNow
        if let l = link {
            // on a Sonos room: where the speaker is, its volume
            playing = index >= 0; paused = playing && l.paused
            pos = l.now; dur = l.dur; vol = l.volume; mute = l.muted
            // (downmix: this song is Dolby Atmos or surround and the speaker only plays stereo, so it gets a stereo version;
            // twin: that's the album's own stereo version)
            let down = current.map { l.stereoFor($0) } ?? false
            route = ["kind": "sonos", "name": l.room.name, "spatial": false, "channels": 0, "sonos": true, "atmos": l.room.atmos, "model": l.room.model,
                     "downmix": down, "twin": down && (current?["stereoPath"] as? String).map { FileManager.default.fileExists(atPath: $0) } == true]
        }
        if !dur.isFinite || dur <= 0 { dur = (current?["duration"] as? NSNumber)?.doubleValue ?? 0 }
        var output: Any = NSNull()
        if let l = link { output = ["id": l.room.id, "name": l.room.name, "atmos": l.room.atmos] as [String: Any] }
        return [
            "playing": playing,
            "paused": paused,
            "index": index, "pos": pos.isFinite ? pos : 0, "dur": dur,
            "volume": vol, "muted": mute,
            "queue": queue.compactMap { $0["id"] as? String },
            "queued": queue.map { ($0["queued"] as? Bool) == true },
            "shuffle": shuffle, "repeat": repeatMode,
            "context": context ?? NSNull(),
            "route": route,
            "output": output,
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
        if let l = link {
            // a new queue on the speaker
            index = max(0, min(start, tracks.count - 1))
            l.load(from: index, at: 0, play: true)
            KeepAwake.shared.start()
            emit(); updateNowPlaying(newTrack: true)
            return
        }
        go(to: max(0, min(start, tracks.count - 1)))
    }

    private func go(to i: Int) {
        guard i >= 0, i < queue.count, let path = queue[i]["path"] as? String else { stop(); return }
        if let l = link {
            index = i
            l.jump(i)
            KeepAwake.shared.start()
            emit(); updateNowPlaying(newTrack: true)
            return
        }
        prepareSession()
        index = i
        let item = AVPlayerItem(url: URL(fileURLWithPath: path))
        // surround songs always spatialized; stereo ones too when "Spatialize Stereo" is on in Control Center
        item.allowedAudioSpatializationFormats = .monoStereoAndMultichannel
        if let o = endObserver { NotificationCenter.default.removeObserver(o) }
        endObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self] _ in
            self?.next(auto: true)
        }
        // a song the phone can't play (Dolby TrueHD, a damaged file) is skipped, with a word about it
        let title = queue[i]["title"] as? String ?? "That song"
        statusObserver = item.observe(\.status, options: [.new]) { [weak self] it, _ in
            DispatchQueue.main.async {
                guard let self, self.player.currentItem === it else { return }
                if it.status == .readyToPlay { self.failsInARow = 0; return }
                guard it.status == .failed else { return }
                NSLog("Parlor: can't play %@: %@", title, String(describing: it.error))
                self.bridge?.emit("notice", "\(title) can't be played on this phone")
                self.failsInARow += 1
                if self.failsInARow >= max(1, self.queue.count) { self.failsInARow = 0; self.stop(); return }
                if self.index + 1 < self.queue.count { self.go(to: self.index + 1) } else { self.stop() }
            }
        }
        player.replaceCurrentItem(with: item)
        player.volume = muted ? 0 : volume
        player.play()
        emit()
        updateNowPlaying(newTrack: true)
    }

    func command(_ cmd: String, _ arg: Any?) -> [String: Any]? {
        if let l = link { sonosCommand(l, cmd, arg); emit(); updateNowPlaying(); return snapshot() }
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
        if let l = link { if l.now > 3 || index == 0 { l.seek(0) } else { go(to: index - 1) }; return }
        if player.currentTime().seconds > 3 || index == 0 { player.seek(to: .zero) } else { go(to: index - 1) }
    }

    func stop() {
        if let l = link { l.pause(); l.forget(); KeepAwake.shared.stop() }
        player.pause()
        player.replaceCurrentItem(with: nil)
        queue = []
        index = -1
        shuffle = false; unshuffled = nil
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        emit()
    }

    func pauseForVideo() { if index >= 0 { link?.pause(); player.pause(); emit() } }

    // ---- Sonos -------------------------------------------------------------------------------------------------
    var sonosId: String? { link?.room.id }

    /// Play on a Sonos room (or back on the phone, with nil): the song carries on there from where it was.
    func use(sonos room: SonosRoom?) {
        let wasPlaying: Bool, pos: Double
        if let l = link { wasPlaying = index >= 0 && !l.paused; pos = l.now }
        else { wasPlaying = player.currentItem != nil && player.timeControlStatus != .paused; pos = player.currentTime().seconds }
        link?.release(pause: true)
        link = nil
        if let room {
            player.pause()
            player.replaceCurrentItem(with: nil)
            let l = SonosLink(room: room, tracks: { [weak self] in self?.queue ?? [] })
            l.onUpdate = { [weak self] i, ended in self?.sonosMoved(i, ended) }
            l.onProblem = { [weak self] m in self?.bridge?.emit("notice", m) }
            link = l
            l.start()
            if repeatMode == "one" { l.repeatOne(true) }
            if index >= 0 {
                l.load(from: index, at: pos.isFinite ? pos : 0, play: wasPlaying)
                if wasPlaying { KeepAwake.shared.start() }
            }
        } else {
            KeepAwake.shared.stop()
            if index >= 0 {
                go(to: index)
                if pos.isFinite, pos > 1 { player.seek(to: CMTime(seconds: pos, preferredTimescale: 600)) }
                if !wasPlaying { player.pause() }
            }
        }
        emit()
        updateNowPlaying(newTrack: true)
    }

    /// The speaker moved on (the next song), or ran out of songs.
    private func sonosMoved(_ i: Int?, _ ended: Bool) {
        guard let l = link else { return }
        if ended {
            if repeatMode == "all" && !queue.isEmpty { index = 0; l.load(from: 0, at: 0, play: true) } else { stop(); return }
        } else if let i, i != index, i >= 0, i < queue.count {
            index = i
            emit(); updateNowPlaying(newTrack: true)
        }
        if l.paused { KeepAwake.shared.stop(after: 600) } else { KeepAwake.shared.start() }
        emit(throttled: true)
        updateNowPlaying()
    }

    private func sonosCommand(_ l: SonosLink, _ cmd: String, _ arg: Any?) {
        switch cmd {
        case "toggle": if l.paused { l.play(); KeepAwake.shared.start() } else { l.pause() }
        case "pause": l.pause()
        case "play": l.play(); KeepAwake.shared.start()
        case "next":
            if index + 1 < queue.count { go(to: index + 1) }
            else if repeatMode == "all" && !queue.isEmpty { go(to: 0) }
            else { l.seek(0); l.pause() }
        case "prev": prev()
        case "seek": if let s = (arg as? NSNumber)?.doubleValue { l.seek(s) }
        case "volume": if let v = (arg as? NSNumber)?.doubleValue { l.setVolume(Int(v.rounded())) }
        case "volup": l.setVolume(l.volume + 5)
        case "voldown": l.setVolume(l.volume - 5)
        case "mute": l.setMuted(!l.muted)
        case "jump": if let i = (arg as? NSNumber)?.intValue { go(to: i) }
        case "stop": stop()
        case "clear":
            if let cur = current { let was = index; queue = [cur]; index = 0; unshuffled = nil; l.rebuild(was: was, now: 0) }
        case "shuffle":
            let was = index
            toggleShuffle()
            if was >= 0 { l.rebuild(was: was, now: index) }
        case "repeat":
            repeatMode = ["off": "all", "all": "one"][repeatMode] ?? "off"
            l.repeatOne(repeatMode == "one")
        case "enqueue":
            if let o = arg as? [String: Any], var tracks = o["tracks"] as? [[String: Any]] {
                for i in tracks.indices { tracks[i]["queued"] = true }
                if (o["next"] as? Bool) == true, index >= 0 {
                    queue.insert(contentsOf: tracks, at: index + 1)
                    l.rebuild(was: index, now: index)
                } else {
                    queue.append(contentsOf: tracks)
                    if index >= 0 { l.grew() }
                }
                if index < 0, !queue.isEmpty { l.forget(); go(to: 0) }
            }
        default: break
        }
    }

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
        let onSpeaker = link
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: t["title"] as? String ?? "",
            MPMediaItemPropertyArtist: onSpeaker.map { (t["artist"] as? String ?? "") + " — " + $0.room.name } ?? (t["artist"] as? String ?? ""),
            MPMediaItemPropertyAlbumTitle: t["album"] as? String ?? "",
            MPNowPlayingInfoPropertyElapsedPlaybackTime: onSpeaker?.now ?? player.currentTime().seconds,
            MPNowPlayingInfoPropertyPlaybackRate: (onSpeaker.map { $0.paused } ?? (player.timeControlStatus == .paused)) ? 0.0 : 1.0,
            MPNowPlayingInfoPropertyPlaybackQueueIndex: index,
            MPNowPlayingInfoPropertyPlaybackQueueCount: queue.count,
        ]
        let dur = onSpeaker?.dur ?? player.currentItem?.duration.seconds ?? 0
        info[MPMediaItemPropertyPlaybackDuration] = dur.isFinite && dur > 0 ? dur : ((t["duration"] as? NSNumber)?.doubleValue ?? 0)
        if let a = artwork { info[MPMediaItemPropertyArtwork] = a }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    private func setUpRemote() {
        let c = MPRemoteCommandCenter.shared()
        // (each goes to the speaker instead while Parlor is playing on one)
        c.playCommand.addTarget { [weak self] _ in _ = self?.command("play", nil); return .success }
        c.pauseCommand.addTarget { [weak self] _ in _ = self?.command("pause", nil); return .success }
        c.togglePlayPauseCommand.addTarget { [weak self] _ in _ = self?.command("toggle", nil); return .success }
        c.nextTrackCommand.addTarget { [weak self] _ in _ = self?.command("next", nil); return .success }
        c.previousTrackCommand.addTarget { [weak self] _ in _ = self?.command("prev", nil); return .success }
        c.changePlaybackPositionCommand.addTarget { [weak self] e in
            guard let e = e as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            _ = self?.command("seek", NSNumber(value: e.positionTime))
            return .success
        }
    }
}
