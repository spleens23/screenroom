import Foundation
import AVFoundation
import UIKit

/// Finds the films and songs in Documents and describes each one: films the way ffprobe does on the desktop
/// (so the shared JavaScript builds the same library items), songs by their tags. Results are cached by path +
/// modified time + size, so a rescan only reads new or changed files.
final class Scanner {
    static let shared = Scanner()
    private let st = Storage.shared
    private let videoCacheName = "scan-films-5"
    private let audioCacheName = "scan-music-4" // (4: .mp4 songs anywhere, still-picture tracks aren't "video")
    private var videoBusy = false
    private var audioBusy = false
    private var audioStarted = Date.distantPast // a scan that's been going far too long is taken as stuck

    // ---- walking Documents -------------------------------------------------------------------------------
    private func files(withExtensions exts: Set<String>) -> [URL] {
        var out: [URL] = []
        let keys: [URLResourceKey] = [.isDirectoryKey, .isHiddenKey]
        guard let e = st.fm.enumerator(at: st.docs, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles, .skipsPackageDescendants]) else { return [] }
        for case let url as URL in e {
            if url.lastPathComponent == ".Trash" { e.skipDescendants(); continue }
            if exts.contains(url.pathExtension.lowercased()), !(exts == videoExtensions && isMotionCover(url.lastPathComponent)) { out.append(url) }
        }
        return out.sorted { $0.path.localizedStandardCompare($1.path) == .orderedAscending }
    }

    /// A quick fingerprint of everything in the music folder (names, sizes and dates; nothing is opened), so
    /// Parlor can tell whether anything was added, removed or changed since its last scan without rescanning.
    func musicSignature() -> String {
        var parts: [String] = []
        let keys: [URLResourceKey] = [.contentModificationDateKey, .fileSizeKey, .isDirectoryKey]
        if let e = st.fm.enumerator(at: st.music, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles, .skipsPackageDescendants]) {
            for case let u as URL in e {
                let v = try? u.resourceValues(forKeys: Set(keys))
                if v?.isDirectory == true { continue }
                parts.append("\(u.path)|\(v?.fileSize ?? 0)|\(Int(v?.contentModificationDate?.timeIntervalSince1970 ?? 0))")
            }
        }
        parts.sort()
        return sha1Hex(parts.joined(separator: "\n"))
    }

    /// True when the music folder isn't how the last scan left it.
    func musicChanged() -> Bool {
        (st.readJson("scan-music-sig") as? [String: String])?["sig"] != musicSignature()
    }

    private func stat(_ url: URL) -> (mtime: Double, size: Int64) {
        let v = try? url.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey])
        return ((v?.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000, Int64(v?.fileSize ?? 0))
    }

    // ---- films --------------------------------------------------------------------------------------------
    func scanVideos(cacheOnly: Bool, progress: @escaping (Int, Int) -> Void) async -> [[String: Any]] {
        if isParlorApp { return [] } // Parlor is music only
        let cache = (st.readJson(videoCacheName) as? [String: [String: Any]]) ?? [:]
        let list = files(withExtensions: videoExtensions)
        if cacheOnly || videoBusy {
            return list.compactMap { cache[$0.path] }
        }
        videoBusy = true
        defer { videoBusy = false }
        var next: [String: [String: Any]] = [:]
        var done = 0
        for url in list {
            let s = stat(url)
            if let hit = cache[url.path], (hit["mtime"] as? Double) == s.mtime, (hit["size"] as? NSNumber)?.int64Value == s.size, artOK(hit) {
                next[url.path] = hit
            } else {
                next[url.path] = avVideoExtensions.contains(url.pathExtension.lowercased())
                    ? await probeVideo(url, mtime: s.mtime, size: s.size)
                    : await probeWithFF(url, mtime: s.mtime, size: s.size)
            }
            done += 1
            if done % 3 == 0 || done == list.count { progress(done, list.count) }
        }
        try? st.writeJson(videoCacheName, next)
        return list.compactMap { next[$0.path] }
    }

    private func artOK(_ e: [String: Any]) -> Bool {
        for k in ["art", "backdrop"] {
            if let p = e[k] as? String, !p.isEmpty, !st.fm.fileExists(atPath: p) { return false }
        }
        return true
    }

    private func fourCC(_ code: FourCharCode) -> String {
        let bytes = [UInt8((code >> 24) & 0xff), UInt8((code >> 16) & 0xff), UInt8((code >> 8) & 0xff), UInt8(code & 0xff)]
        return String(bytes: bytes, encoding: .ascii) ?? ""
    }

    /// Sound Apple's player plays.
    private let avAudio: Set<String> = ["aac", "ac3", "eac3", "alac", "mp3", "pcm_s16le", "flac"]

    private func probeVideo(_ url: URL, mtime: Double, size: Int64) async -> [String: Any] {
        let id = String(sha1Hex(st.relativeToDocs(url)).prefix(16))
        let asset = AVURLAsset(url: url)
        var streams: [[String: Any]] = []
        var tags: [String: String] = [:]
        var duration = 0.0
        var cover: Data?
        var needsMPV = false
        var readable = true
        do {
            duration = try await asset.load(.duration).seconds
            if !duration.isFinite { duration = 0 }
            let tracks = try await asset.load(.tracks)
            var firstAudio = true
            for t in tracks {
                let lang = (try? await t.load(.languageCode)) ?? nil
                let fds = (try? await t.load(.formatDescriptions)) ?? []
                let sub = fds.first.map { fourCC(CMFormatDescriptionGetMediaSubType($0)) } ?? ""
                var s: [String: Any] = ["tags": ["language": (lang == nil || lang == "und") ? "" : lang!]]
                switch t.mediaType {
                case .video:
                    s["codec_type"] = "video"
                    s["codec_name"] = ["avc1": "h264", "avc3": "h264", "hvc1": "hevc", "hev1": "hevc", "dvh1": "hevc", "dvhe": "hevc", "av01": "av1", "mp4v": "mpeg4"][sub] ?? sub
                    let size = (try? await t.load(.naturalSize)) ?? .zero
                    let tf = (try? await t.load(.preferredTransform)) ?? .identity
                    let r = CGRect(origin: .zero, size: size).applying(tf)
                    s["width"] = Int(abs(r.width)); s["height"] = Int(abs(r.height))
                    let fps = (try? await t.load(.nominalFrameRate)) ?? 0
                    if fps > 0 { s["avg_frame_rate"] = "\(Int((fps * 1000).rounded()))/1000" }
                    if let fd = fds.first, let transfer = CMFormatDescriptionGetExtension(fd, extensionKey: kCMFormatDescriptionExtension_TransferFunction) as? String {
                        if transfer == (kCMFormatDescriptionTransferFunction_SMPTE_ST_2084_PQ as String) { s["color_transfer"] = "smpte2084" }
                        if transfer == (kCMFormatDescriptionTransferFunction_ITU_R_2100_HLG as String) { s["color_transfer"] = "arib-std-b67" }
                    }
                    if sub == "dvh1" || sub == "dvhe" { s["side_data_list"] = [["side_data_type": "DOVI configuration record"]] }
                    s["disposition"] = ["default": 1, "attached_pic": 0]
                case .audio:
                    s["codec_type"] = "audio"
                    s["codec_name"] = ["aac ": "aac", "mp4a": "aac", "ac-3": "ac3", "ec-3": "eac3", "dtsc": "dts", "dtsh": "dts", "dtsl": "dts", "dtse": "dts",
                                       "alac": "alac", "fLaC": "flac", ".mp3": "mp3", "opus": "opus", "lpcm": "pcm_s16le"][sub] ?? sub.trimmingCharacters(in: .whitespaces)
                    if let fd = fds.first, let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fd)?.pointee {
                        s["channels"] = Int(asbd.mChannelsPerFrame)
                    }
                    let rate = (try? await t.load(.estimatedDataRate)) ?? 0
                    if rate > 0 { s["bit_rate"] = Int(rate) }
                    s["disposition"] = ["default": firstAudio ? 1 : 0]
                    firstAudio = false
                case .subtitle, .closedCaption, .text:
                    s["codec_type"] = "subtitle"
                    s["codec_name"] = ["tx3g": "mov_text", "wvtt": "webvtt", "c608": "eia_608"][sub] ?? "mov_text"
                default:
                    continue
                }
                streams.append(s)
            }
            // Apple's player can't play DTS / TrueHD / Opus … sound, and only offers a soundtrack menu when the
            // file groups its soundtracks: anything else plays with mpv's engine.
            let audioCodecs = streams.filter { ($0["codec_type"] as? String) == "audio" }.compactMap { $0["codec_name"] as? String }
            if audioCodecs.contains(where: { !avAudio.contains($0) }) { needsMPV = true }
            if audioCodecs.count > 1 {
                let options = (try? await asset.loadMediaSelectionGroup(for: .audible))?.options.count ?? 0
                if options < audioCodecs.count { needsMPV = true }
            }
            if !((try? await asset.load(.isPlayable)) ?? true) { needsMPV = true }
            // MP4 / iTunes tags, named as ffprobe names them.
            var items = (try? await asset.load(.metadata)) ?? []
            items += (try? await asset.loadMetadata(for: .iTunesMetadata)) ?? []
            items += (try? await asset.load(.commonMetadata)) ?? []
            for item in items {
                let ident = item.identifier?.rawValue ?? ""
                let key = (item.key as? String) ?? ""
                if ident == AVMetadataIdentifier.iTunesMetadataCoverArt.rawValue || ident == AVMetadataIdentifier.commonIdentifierArtwork.rawValue
                    || item.commonKey == .commonKeyArtwork || ident.hasSuffix("/covr") {
                    if cover == nil { cover = try? await item.load(.dataValue) }
                    if cover == nil { cover = (try? await item.load(.value)) as? Data }
                    continue
                }
                let name: String? = [
                    "itsk/%A9nam": "title", "itsk/desc": "description", "itsk/ldes": "synopsis", "itsk/%A9gen": "genre", "itsk/gnre": "genre",
                    "itsk/%A9day": "date", "itsk/tvsh": "show", "itsk/tvsn": "season_number", "itsk/tves": "episode_sort", "itsk/tven": "episode_id",
                    "itsk/%A9ART": "artist", "itsk/aART": "album_artist", "itsk/%A9cmt": "comment",
                    AVMetadataIdentifier.commonIdentifierTitle.rawValue: "title",
                    AVMetadataIdentifier.commonIdentifierDescription.rawValue: "description",
                    AVMetadataIdentifier.quickTimeMetadataYear.rawValue: "date",
                    AVMetadataIdentifier.quickTimeMetadataGenre.rawValue: "genre",
                ][ident] ?? (key.contains("iTunEXTC") || ident.contains("iTunEXTC") ? "iTunEXTC" : nil)
                guard let n = name, tags[n] == nil else { continue }
                if let str = try? await item.load(.stringValue), !str.isEmpty { tags[n] = str }
                else if let num = try? await item.load(.numberValue) { tags[n] = num.stringValue }
            }
        } catch {
            NSLog("Screenroom: couldn't read \(url.lastPathComponent): \(error)")
            readable = false
        }
        // Apple's frameworks couldn't open it at all: let FFmpeg read it
        if !readable || streams.isEmpty { return await probeWithFF(url, mtime: mtime, size: size) }
        if !sidecarSubtitles(url).isEmpty { needsMPV = true }
        // Apple's reader leaves out soundtracks it can't play (DTS or TrueHD in an MP4): FFmpeg sees every stream,
        // named exactly as ffprobe names them on the desktop. A film with sound Apple can't play goes to mpv's engine.
        if let ff = FFProbe.read(url), !ff.streams.isEmpty {
            let isAudio: ([String: Any]) -> Bool = { ($0["codec_type"] as? String) == "audio" }
            let ffAudio = ff.streams.filter(isAudio)
            if ffAudio.count > streams.filter(isAudio).count || ffAudio.contains(where: { !avAudio.contains($0["codec_name"] as? String ?? "") }) {
                needsMPV = true
            }
            // keep Apple's HDR / Dolby Vision reading for the video, FFmpeg's for everything else
            let avVideo = streams.filter { ($0["codec_type"] as? String) == "video" }
            streams = ff.streams.filter { ($0["codec_type"] as? String) != "video" || ($0["disposition"] as? [String: Int])?["attached_pic"] == 1 }
            streams = (avVideo.isEmpty ? ff.streams.filter { ($0["codec_type"] as? String) == "video" } : avVideo) + streams
            for (k, v) in ff.tags where tags[k] == nil { tags[k] = v }
            if cover == nil { cover = ff.cover }
            if duration <= 0 { duration = ff.duration }
        }
        var entry: [String: Any] = [
            "id": id, "path": url.path, "mtime": mtime, "size": size,
            "probe": ["format": ["duration": String(duration), "tags": tags], "streams": streams],
        ]
        if let img = cover.flatMap({ UIImage(data: $0) }),
           let saved = saveJPEG(img, width: 600, to: st.art.appendingPathComponent("\(id)-cover.jpg"), quality: 0.85) {
            entry["art"] = saved
        }
        if entry["art"] == nil, let side = sidecarArt(url) { entry["art"] = side.path }
        if let back = await grabFrame(asset, duration: duration, to: st.art.appendingPathComponent("\(id)-back.jpg")) {
            entry["backdrop"] = back
        }
        if entry["art"] == nil, let back = entry["backdrop"] { entry["art"] = back } // like the desktop: a frame from the film
        if needsMPV { entry["engine"] = "mpv" }
        return entry
    }

    // ---- films Apple's frameworks can't read (MKV, AVI …): FFmpeg reads them, mpv plays them ---------------
    private func probeWithFF(_ url: URL, mtime: Double, size: Int64) async -> [String: Any] {
        let id = String(sha1Hex(st.relativeToDocs(url)).prefix(16))
        let ff = FFProbe.read(url) ?? FFProbe.Result()
        var tags = ff.tags
        // a title that's just the file name isn't a real title
        if tags["title"] == url.lastPathComponent || tags["title"] == url.deletingPathExtension().lastPathComponent { tags["title"] = nil }
        var entry: [String: Any] = [
            "id": id, "path": url.path, "mtime": mtime, "size": size, "engine": "mpv",
            "probe": ["format": ["duration": String(max(0, ff.duration)), "tags": tags], "streams": ff.streams],
        ]
        if let img = ff.cover.flatMap({ UIImage(data: $0) }),
           let saved = saveJPEG(img, width: 600, to: self.st.art.appendingPathComponent("\(id)-cover.jpg"), quality: 0.85) {
            entry["art"] = saved
        }
        if entry["art"] == nil, let side = sidecarArt(url) { entry["art"] = side.path }
        if let cg = FFProbe.frame(url, at: ff.duration > 10 ? 0.2 : 0.5),
           let back = saveJPEG(UIImage(cgImage: cg), width: 1280, to: self.st.art.appendingPathComponent("\(id)-back.jpg"), quality: 0.8) {
            entry["backdrop"] = back
        }
        if entry["art"] == nil, let back = entry["backdrop"] { entry["art"] = back }
        return entry
    }

    /// Subtitles beside a film: Film.srt, Film.en.srt …
    private func sidecarSubtitles(_ url: URL) -> [String] {
        let base = url.deletingPathExtension().lastPathComponent.lowercased()
        let names = (try? st.fm.contentsOfDirectory(atPath: url.deletingLastPathComponent().path)) ?? []
        return names.filter { let l = $0.lowercased(); return l.hasPrefix(base) && ["srt", "vtt", "ass", "ssa"].contains((l as NSString).pathExtension) }
    }

    /// A poster beside a film: Film.jpg, or poster / cover / folder.jpg in its folder (and the show's folder above a
    /// Season folder). Not in Films itself, where one picture would land on every film.
    private func sidecarArt(_ url: URL) -> URL? {
        let dir = url.deletingLastPathComponent()
        let base = url.deletingPathExtension().lastPathComponent
        let exts = ["jpg", "jpeg", "png", "webp"]
        for e in exts {
            let u = dir.appendingPathComponent("\(base).\(e)")
            if st.fm.fileExists(atPath: u.path) { return u }
            let p = dir.appendingPathComponent("\(base)-poster.\(e)")
            if st.fm.fileExists(atPath: p.path) { return p }
        }
        var dirs: [URL] = []
        if dir.standardizedFileURL.path != st.films.standardizedFileURL.path { dirs.append(dir) }
        let parent = dir.deletingLastPathComponent()
        if dir.lastPathComponent.range(of: "^(season|series|staffel|saison|temporada|specials?)\\b", options: [.regularExpression, .caseInsensitive]) != nil,
           parent.standardizedFileURL.path != st.films.standardizedFileURL.path { dirs.append(parent) }
        for d in dirs {
            for name in ["poster", "cover", "folder", "show", "season"] {
                for e in exts {
                    let u = d.appendingPathComponent("\(name).\(e)")
                    if st.fm.fileExists(atPath: u.path) { return u }
                }
            }
        }
        return nil
    }

    private func grabFrame(_ asset: AVAsset, duration: Double, to dest: URL) async -> String? {
        let gen = AVAssetImageGenerator(asset: asset)
        gen.appliesPreferredTrackTransform = true
        gen.maximumSize = CGSize(width: 1280, height: 720)
        let at = duration > 10 ? max(5, duration * 0.2) : duration / 2
        do {
            let (cg, _) = try await gen.image(at: CMTime(seconds: at, preferredTimescale: 600))
            return saveJPEG(UIImage(cgImage: cg), width: 1280, to: dest, quality: 0.8)
        } catch {
            return nil
        }
    }

    // ---- songs --------------------------------------------------------------------------------------------
    func scanAudio(cacheOnly: Bool, deep: Bool = false, progress: @escaping (Int, Int) -> Void) async -> [[String: Any]] {
        if !isParlorApp { return [] } // Screenroom is films only (music is Parlor's)
        let cache = deep ? [:] : ((st.readJson(audioCacheName) as? [String: [String: Any]]) ?? [:])
        // songs, plus MP4 / MOV files in the music folder with no picture in them (Dolby Atmos music often comes as .mp4)
        let list = (files(withExtensions: audioExtensions) + musicFolderVideos()).sorted { $0.path.localizedStandardCompare($1.path) == .orderedAscending }
        let busy = audioBusy && Date().timeIntervalSince(audioStarted) < 240
        if cacheOnly || busy {
            let old = (st.readJson(audioCacheName) as? [String: [String: Any]]) ?? [:]
            return list.compactMap { old[$0.path] }.filter { $0["notSong"] == nil }
        }
        audioBusy = true
        audioStarted = Date()
        let began = Date()
        var skipped: [[String: Any]] = [] // files that aren't songs, or couldn't be read, for Settings
        var probed = 0
        defer { audioBusy = false }
        var next: [String: [String: Any]] = [:]
        var dirArt: [String: String] = [:]     // a folder's embedded cover, saved once
        var dirCover: [String: String?] = [:]  // a folder's cover picture (cover.jpg …)
        var dirMotion: [String: String?] = [:] // a folder's moving cover (cover.mp4 …)
        var motionNotes: [[String: Any]] = []  // what happened to each one, for Settings
        var done = 0
        for url in list {
            let s = stat(url)
            var entry: [String: Any]
            // (songs read before Parlor noted channels are read once more, so surround ones are known)
            if let hit = cache[url.path], abs(((hit["mtime"] as? NSNumber)?.doubleValue ?? -1) - s.mtime) < 1.5, (hit["size"] as? NSNumber)?.int64Value == s.size, hit["channels"] != nil {
                entry = hit
            } else {
                probed += 1
                // (one odd file can't hold the whole scan up: after 25 seconds it's left out and noted)
                let u = url, m = s.mtime, z = s.size
                entry = await withTimeout(25, fallback: ["id": "", "path": u.path, "mtime": m, "size": z, "channels": 0, "notSong": "timeout"] as [String: Any]) {
                    await self.probeAudio(u, mtime: m, size: z)
                }
            }
            if let why = entry["notSong"] as? String {
                // (remembered, so it isn't opened again until it changes; a file that timed out is tried again next time)
                if why != "timeout" { next[url.path] = entry }
                skipped.append(["file": url.lastPathComponent, "folder": url.deletingLastPathComponent().lastPathComponent, "why": why])
                done += 1
                continue
            }
            if (entry["playable"] as? Bool) == false {
                skipped.append(["file": url.lastPathComponent, "folder": url.deletingLastPathComponent().lastPathComponent,
                                "why": "unplayable", "codec": entry["codec"] as? String ?? ""])
            }
            let dir = url.deletingLastPathComponent().path
            if dirCover[dir] == nil { dirCover[dir] = folderCover(url.deletingLastPathComponent()) }
            entry["folderArt"] = dirCover[dir] ?? nil
            if dirMotion[dir] == nil {
                // in the album's folder, or the one above it (an album with Disc 1 / Disc 2 folders)
                let here = url.deletingLastPathComponent(), up = here.deletingLastPathComponent()
                var m = folderMotion(here)
                if m == nil, up.standardizedFileURL.path != st.music.standardizedFileURL.path, st.isInside(up.path, st.music) { m = folderMotion(up) }
                if let p = m {
                    let (use, how) = await withTimeout(40, fallback: (String?.none, "timeout")) { await self.playableMotion(p) }
                    motionNotes.append(["album": here.lastPathComponent, "file": (p as NSString).lastPathComponent, "path": p, "status": how,
                                        "detail": FFProbe.describeVideo(URL(fileURLWithPath: p))])
                    m = use
                }
                dirMotion[dir] = m
            }
            entry["folderMotion"] = dirMotion[dir] ?? nil
            if let cover = entry.removeValue(forKey: "_cover") as? Data, dirArt[dir] == nil, let img = UIImage(data: cover) {
                let dest = st.art.appendingPathComponent("\(sha1Hex(st.relativeToDocs(url.deletingLastPathComponent())).prefix(16))-album.jpg")
                if let saved = saveJPEG(img, width: 600, to: dest, quality: 0.85) { dirArt[dir] = saved }
            }
            if entry["art"] == nil, let a = dirArt[dir] { entry["art"] = a }
            next[url.path] = entry
            done += 1
            if done % 5 == 0 || done == list.count { progress(done, list.count) }
        }
        // songs read before their folder's cover was found
        for (p, var e) in next where e["art"] == nil {
            if let a = dirArt[(p as NSString).deletingLastPathComponent] { e["art"] = a; next[p] = e }
        }
        try? st.writeJson(audioCacheName, next)
        // videos in the music folder that aren't anyone's moving cover (misnamed, or not beside any songs)
        let used = Set(motionNotes.compactMap { n in (n["path"] as? String).map { URL(fileURLWithPath: $0).resolvingSymlinksInPath().path } })
        if let walk = st.fm.enumerator(at: st.music, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles]) {
            for case let f as URL in walk where videoExtensions.contains(f.pathExtension.lowercased()) && !used.contains(f.resolvingSymlinksInPath().path)
                && !(next[f.path] != nil && next[f.path]?["notSong"] == nil) { // (an .mp4 that's a song isn't a cover)
                motionNotes.append(["album": f.deletingLastPathComponent().lastPathComponent, "file": f.lastPathComponent,
                                    "status": isMotionCover(f.lastPathComponent) ? "nosongs" : "name", "detail": FFProbe.describeVideo(f)])
            }
        }
        try? st.writeJson("motion-report", motionNotes)
        try? st.writeJson("scan-music-sig", ["sig": musicSignature()])
        let songs = list.compactMap { next[$0.path] }.filter { $0["notSong"] == nil }
        try? st.writeJson("scan-report", ["at": Date().timeIntervalSince1970 * 1000, "seconds": Date().timeIntervalSince(began), "deep": deep,
                                          "files": list.count, "songs": songs.count, "read": probed, "skipped": skipped])
        return songs
    }

    /// MP4 / M4V / MOV files anywhere in Parlor's folder (not just Music: songs dropped in from the Files app can
    /// land beside it) that aren't moving covers: maybe songs (Dolby Atmos music is usually an .mp4 with only sound
    /// in it). Each is opened once to tell.
    private func musicFolderVideos() -> [URL] {
        files(withExtensions: ["mp4", "m4v", "mov"]).filter { !isMotionCover($0.lastPathComponent) }
    }

    private func probeAudio(_ url: URL, mtime: Double, size: Int64) async -> [String: Any] {
        let id = String(sha1Hex(st.relativeToDocs(url)).prefix(16))
        let asset = AVURLAsset(url: url)
        var tags: [String: String] = [:]
        var entry: [String: Any] = ["id": id, "path": url.path, "mtime": mtime, "size": size, "channels": 0]
        // what FFmpeg makes of it: whether an .mp4 is a song or a video, and whether its Dolby sound is Atmos
        let ext = url.pathExtension.lowercased()
        let dolbyOrBox = ["mp4", "m4v", "mov", "ec3", "eac3", "ac3"].contains(ext)
        var ff = dolbyOrBox ? FFProbe.read(url) : nil
        if ["mp4", "m4v", "mov"].contains(ext) {
            let streams = ff?.streams ?? []
            let audio = streams.filter { ($0["codec_type"] as? String) == "audio" }
            if ff == nil {
                // FFmpeg couldn't open it: Apple's reader decides (sound and no pictures = a song)
                let a = (try? await asset.loadTracks(withMediaType: .audio)) ?? []
                let v = (try? await asset.loadTracks(withMediaType: .video)) ?? []
                if a.isEmpty { entry["notSong"] = v.isEmpty ? "unreadable" : "nosound"; return entry }
                if !v.isEmpty { entry["notSong"] = "video"; return entry }
            } else {
                if audio.isEmpty { entry["notSong"] = "nosound"; return entry }
                // a real moving picture makes it a music video or a film; a cover stored as a one-picture track doesn't
                let moving = streams.contains { st in
                    guard (st["codec_type"] as? String) == "video", ((st["disposition"] as? [String: Int])?["attached_pic"] ?? 0) == 0 else { return false }
                    if ["mjpeg", "png", "bmp", "gif", "webp", "tiff"].contains(st["codec_name"] as? String ?? "") { return false }
                    if let fr = st["avg_frame_rate"] as? String, let n = Double(fr.split(separator: "/").first ?? ""), let d = Double(fr.split(separator: "/").last ?? ""), d > 0, n / d < 2 { return false }
                    if let nf = st["nb_frames"] as? Int, nf > 0, nf <= 2 { return false }
                    return true
                }
                // Dolby or surround sound means it's music made for listening (an Atmos song with a picture track), so it stays
                let dolby = audio.contains { ["eac3", "ac3", "ac4", "truehd", "mlp"].contains($0["codec_name"] as? String ?? "") || ($0["channels"] as? Int ?? 0) > 2 }
                if moving && !dolby { entry["notSong"] = "video"; return entry } // a music video or a film: not for Parlor
            }
        }
        if let a = ff?.streams.first(where: { ($0["codec_type"] as? String) == "audio" }) {
            let prof = (a["profile"] as? String ?? "").lowercased()
            let name = a["codec_name"] as? String ?? ""
            if prof.contains("atmos") { entry["atmos"] = true }
            if name == "truehd" { entry["codec"] = "Dolby TrueHD" }
            if name == "ac4" { entry["codec"] = "Dolby AC-4"; entry["atmos"] = true } // (AC-4 music is Atmos)
            if let ch = a["channels"] as? Int, ch > 0 { entry["channels"] = ch }
        }
        do {
            let d = try await asset.load(.duration).seconds
            entry["duration"] = d.isFinite ? d : 0
            if let t = try await asset.loadTracks(withMediaType: .audio).first {
                let fds = (try? await t.load(.formatDescriptions)) ?? []
                let sub = fds.first.map { fourCC(CMFormatDescriptionGetMediaSubType($0)) } ?? ""
                let codec = ["aac ": "AAC", "mp4a": "AAC", ".mp3": "MP3", "alac": "Apple Lossless", "fLaC": "FLAC", "lpcm": "WAV / AIFF", "ac-3": "Dolby Digital", "ec-3": "Dolby Digital Plus", "ec+3": "Dolby Digital Plus", "mlpa": "Dolby TrueHD", "ac-4": "Dolby AC-4", "opus": "Opus"][sub] ?? sub.uppercased()
                if sub == "ec+3" { entry["atmos"] = true } // (Apple's name for Dolby Digital Plus with Atmos)
                // Dolby sound in an .m4a: FFmpeg tells whether it's Atmos
                if ff == nil, sub == "ec-3" || sub == "ec+3", let f = FFProbe.read(url) {
                    ff = f
                    if let a = f.streams.first(where: { ($0["codec_type"] as? String) == "audio" }), (a["profile"] as? String ?? "").lowercased().contains("atmos") { entry["atmos"] = true }
                }
                entry["codec"] = codec
                entry["lossless"] = ["alac", "fLaC", "lpcm"].contains(sub)
                if let fd = fds.first, let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fd)?.pointee {
                    entry["sampleRate"] = Int(asbd.mSampleRate)
                    if Int(asbd.mChannelsPerFrame) > 0 { entry["channels"] = Int(asbd.mChannelsPerFrame) } // 6 = 5.1, 8 = 7.1
                    // PCM says its bit depth outright; Apple Lossless and FLAC keep it in the format flags (1 = 16-bit … 4 = 32-bit)
                    if asbd.mBitsPerChannel > 0 { entry["bitDepth"] = Int(asbd.mBitsPerChannel) }
                    else if sub == "alac" || sub == "fLaC", let d = [1: 16, 2: 20, 3: 24, 4: 32][Int(asbd.mFormatFlags)] { entry["bitDepth"] = d }
                }
                let rate = (try? await t.load(.estimatedDataRate)) ?? 0
                entry["bitrate"] = Int(rate / 1000)
            }
            let items = (try? await asset.load(.metadata)) ?? []
            for item in items {
                let ident = item.identifier?.rawValue ?? ""
                if ident == AVMetadataIdentifier.iTunesMetadataCoverArt.rawValue || ident == AVMetadataIdentifier.commonIdentifierArtwork.rawValue
                    || ident == AVMetadataIdentifier.id3MetadataAttachedPicture.rawValue {
                    if entry["_cover"] == nil, let data = try? await item.load(.dataValue) { entry["_cover"] = data }
                    continue
                }
                // track / disc numbers in MP4 are binary: [0, 0, n, n, total, total, …]
                if ident == "itsk/trkn" || ident == "itsk/disk" {
                    if let data = try? await item.load(.dataValue), data.count >= 6 {
                        let b = [UInt8](data)
                        let n = Int(b[2]) << 8 | Int(b[3]), total = Int(b[4]) << 8 | Int(b[5])
                        tags[ident == "itsk/trkn" ? "track" : "disc"] = total > 0 ? "\(n)/\(total)" : "\(n)"
                    }
                    continue
                }
                let name: String? = [
                    "itsk/%A9nam": "title", "itsk/%A9ART": "artist", "itsk/aART": "album_artist", "itsk/%A9alb": "album",
                    "itsk/%A9day": "date", "itsk/%A9gen": "genre", "itsk/gnre": "genre", "itsk/cpil": "compilation", "itsk/rtng": "rtng",
                    "id3/TIT2": "title", "id3/TPE1": "artist", "id3/TPE2": "album_artist", "id3/TALB": "album", "id3/TRCK": "track",
                    "id3/TPOS": "disc", "id3/TYER": "date", "id3/TDRC": "date", "id3/TCON": "genre", "id3/TCMP": "compilation",
                    AVMetadataIdentifier.commonIdentifierTitle.rawValue: "title",
                    AVMetadataIdentifier.commonIdentifierArtist.rawValue: "artist",
                    AVMetadataIdentifier.commonIdentifierAlbumName.rawValue: "album",
                    AVMetadataIdentifier.commonIdentifierCreationDate.rawValue: "date",
                ][ident]
                guard let n = name, tags[n] == nil else { continue }
                if let str = try? await item.load(.stringValue), !str.isEmpty { tags[n] = str }
                else if let num = try? await item.load(.numberValue) { tags[n] = num.stringValue }
            }
            // common keys from any format (FLAC's comments come through here too)
            let common = (try? await asset.load(.commonMetadata)) ?? []
            for item in common {
                guard let k = item.commonKey else { continue }
                let names: [AVMetadataKey: String] = [.commonKeyTitle: "title", .commonKeyArtist: "artist", .commonKeyAlbumName: "album", .commonKeyCreationDate: "date", .commonKeyType: "genre"]
                let n = names[k]
                if k == .commonKeyArtwork, entry["_cover"] == nil, let data = try? await item.load(.dataValue) { entry["_cover"] = data; continue }
                guard let name = n, tags[name] == nil, let str = try? await item.load(.stringValue), !str.isEmpty else { continue }
                tags[name] = str
            }
            // can Apple's player play it here? (Dolby TrueHD, for one, it can't)
            entry["playable"] = (try? await asset.load(.isPlayable)) ?? false
        } catch {
            NSLog("Screenroom: couldn't read \(url.lastPathComponent): \(error)")
            entry["playable"] = false
        }
        if entry["codec"] == nil, let a = ff?.streams.first(where: { ($0["codec_type"] as? String) == "audio" }) { entry["codec"] = (a["codec_name"] as? String ?? "").uppercased() }
        // tags FFmpeg found that Apple's reader didn't (Atmos .mp4 files tagged by other apps)
        for (k, v) in ff?.tags ?? [:] where !v.isEmpty {
            let key = ["album_artist": "album_artist", "albumartist": "album_artist", "title": "title", "artist": "artist", "album": "album",
                       "date": "date", "genre": "genre", "track": "track", "disc": "disc"][k]
            if let key, tags[key] == nil { tags[key] = v }
        }
        if entry["_cover"] == nil, let c = ff?.cover { entry["_cover"] = c }
        entry["tags"] = tags
        return entry
    }

    /// The album's moving cover in its folder: a short looping video (cover.mp4 …), like Apple Music's animated
    /// covers. Parlor plays it silently in place of the still cover; the film library skips these files.
    func folderMotion(_ dir: URL) -> String? {
        guard let names = try? st.fm.contentsOfDirectory(atPath: dir.path) else { return nil }
        return names.first { !$0.hasPrefix(".") && isMotionCover($0) }.map { dir.appendingPathComponent($0).path }
    }

    /// A moving cover the phone can actually play. If Apple's player refuses the file as it is (most often HEVC
    /// labelled "hev1"), a rewrapped copy is made once in the art folder and used instead; the original is left
    /// alone. If even that can't be played, the album just shows its still cover.
    func playableMotion(_ path: String) async -> (String?, String) {
        let src = URL(fileURLWithPath: path)
        let s = stat(src)
        let fixed = st.art.appendingPathComponent("\(sha1Hex(st.relativeToDocs(src)).prefix(16))-\(Int(s.mtime))-motion.mp4")
        if st.fm.fileExists(atPath: fixed.path) { return (fixed.path, "fixed") }
        if await canPlay(src) { return (path, "plays") }
        let made = await Task.detached(priority: .utility) { FFProbe.rewrapForApple(src, to: fixed) }.value
        if made, await canPlay(fixed) { return (fixed.path, "fixed") }
        try? st.fm.removeItem(at: fixed)
        NSLog("Parlor: the moving cover %@ can't be played on this device", src.lastPathComponent)
        return (nil, made ? "unplayable" : "unreadable")
    }

    private func canPlay(_ url: URL) async -> Bool {
        let asset = AVURLAsset(url: url)
        guard (try? await asset.load(.isPlayable)) == true,
              let track = try? await asset.loadTracks(withMediaType: .video).first else { return false }
        return (try? await track.load(.isPlayable)) == true
    }

    /// The album's cover picture in its folder: cover.jpg, folder.jpg, front.jpg … (like lib/music.js).
    func folderCover(_ dir: URL) -> String? {
        guard let names = try? st.fm.contentsOfDirectory(atPath: dir.path) else { return nil }
        let imgs = names.filter { !$0.hasPrefix(".") && ["jpg", "jpeg", "png", "webp", "gif", "bmp"].contains(($0 as NSString).pathExtension.lowercased()) }
        let base = { (n: String) in (n as NSString).deletingPathExtension.lowercased() }
        for want in ["cover", "folder", "front", "album", "albumart", "albumartsmall"] {
            if let hit = imgs.first(where: { base($0) == want }) { return dir.appendingPathComponent(hit).path }
        }
        func score(_ n: String) -> Int {
            let b = base(n)
            var s = 0
            if b.contains("front") || b.contains("cover") || b.contains("folder") { s += 4 }
            if b.contains("albumart") { s += 1 }
            for bad in ["back", "cd", "disc", "inlay", "inside", "booklet", "tray", "label", "spine", "small"] where b.contains(bad) { s -= 3; break }
            return s
        }
        let ranked = imgs.map { ($0, score($0)) }.sorted { $0.1 > $1.1 }
        if let top = ranked.first, top.1 > 0 || ranked.count == 1 { return dir.appendingPathComponent(top.0).path }
        return nil
    }

    func listImages(_ dir: String) -> [String] {
        guard st.isInside(dir + "/x", st.docs), let names = try? st.fm.contentsOfDirectory(atPath: dir) else { return [] }
        return names.filter { ["jpg", "jpeg", "png", "webp"].contains(($0 as NSString).pathExtension.lowercased()) }.map { (dir as NSString).appendingPathComponent($0) }
    }
}

@discardableResult
func saveJPEG(_ img: UIImage, width: CGFloat, to dest: URL, quality: CGFloat) -> String? {
    var out = img
    if img.size.width > width {
        let h = max(1, img.size.height * width / img.size.width)
        let fmt = UIGraphicsImageRendererFormat.default()
        fmt.scale = 1
        out = UIGraphicsImageRenderer(size: CGSize(width: width, height: h), format: fmt).image { _ in
            img.draw(in: CGRect(x: 0, y: 0, width: width, height: h))
        }
    }
    guard let data = out.jpegData(compressionQuality: quality), (try? data.write(to: dest, options: .atomic)) != nil else { return nil }
    return dest.path
}


/// cover.mp4, motion.mov, animated-cover.mp4 … beside an album's songs (same names as lib/music.js).
func isMotionCover(_ name: String) -> Bool {
    name.range(of: #"^(cover|folder|front|album|artwork|motion|animated|(animated|motion)[ _-]?cover|cover[ _-]?(animated|motion|loop))\.(mp4|m4v|mov|webm)$"#,
               options: [.regularExpression, .caseInsensitive]) != nil
}

/// Runs `op`, but gives up after `seconds` and returns `fallback` (Apple's file readers can, rarely, never answer
/// about an odd file; a scan mustn't wait for them forever).
func withTimeout<T>(_ seconds: Double, fallback: T, _ op: @escaping () async -> T) async -> T {
    await withCheckedContinuation { (cont: CheckedContinuation<T, Never>) in
        let lock = NSLock()
        var finished = false
        let finish: (T) -> Void = { v in
            lock.lock(); defer { lock.unlock() }
            if !finished { finished = true; cont.resume(returning: v) }
        }
        Task.detached(priority: .utility) { finish(await op()) }
        DispatchQueue.global().asyncAfter(deadline: .now() + seconds) { finish(fallback) }
    }
}
