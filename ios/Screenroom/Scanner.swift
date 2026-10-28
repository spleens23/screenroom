import Foundation
import AVFoundation
import UIKit
import MobileVLCKit

/// Finds the films and songs in Documents and describes each one: films the way ffprobe does on the desktop
/// (so the shared JavaScript builds the same library items), songs by their tags. Results are cached by path +
/// modified time + size, so a rescan only reads new or changed files.
final class Scanner {
    static let shared = Scanner()
    private let st = Storage.shared
    private let videoCacheName = "scan-films-2"
    private let audioCacheName = "scan-music"
    private var videoBusy = false
    private var audioBusy = false

    // ---- walking Documents -------------------------------------------------------------------------------
    private func files(withExtensions exts: Set<String>) -> [URL] {
        var out: [URL] = []
        let keys: [URLResourceKey] = [.isDirectoryKey, .isHiddenKey]
        guard let e = st.fm.enumerator(at: st.docs, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles, .skipsPackageDescendants]) else { return [] }
        for case let url as URL in e {
            if url.lastPathComponent == ".Trash" { e.skipDescendants(); continue }
            if exts.contains(url.pathExtension.lowercased()) { out.append(url) }
        }
        return out.sorted { $0.path.localizedStandardCompare($1.path) == .orderedAscending }
    }

    private func stat(_ url: URL) -> (mtime: Double, size: Int64) {
        let v = try? url.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey])
        return ((v?.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000, Int64(v?.fileSize ?? 0))
    }

    // ---- films --------------------------------------------------------------------------------------------
    func scanVideos(cacheOnly: Bool, progress: @escaping (Int, Int) -> Void) async -> [[String: Any]] {
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
                    : await probeWithVLC(url, mtime: s.mtime, size: s.size)
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

    private func probeVideo(_ url: URL, mtime: Double, size: Int64) async -> [String: Any] {
        let id = String(sha1Hex(st.relativeToDocs(url)).prefix(16))
        let asset = AVURLAsset(url: url)
        var streams: [[String: Any]] = []
        var tags: [String: String] = [:]
        var duration = 0.0
        var cover: Data?
        var needsVLC = false
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
            // file groups its soundtracks: anything else plays with VLC's engine.
            let audioCodecs = streams.filter { ($0["codec_type"] as? String) == "audio" }.compactMap { $0["codec_name"] as? String }
            let avAudio: Set<String> = ["aac", "ac3", "eac3", "alac", "mp3", "pcm_s16le", "flac"]
            if audioCodecs.contains(where: { !avAudio.contains($0) }) { needsVLC = true }
            if audioCodecs.count > 1 {
                let options = (try? await asset.loadMediaSelectionGroup(for: .audible))?.options.count ?? 0
                if options < audioCodecs.count { needsVLC = true }
            }
            if !((try? await asset.load(.isPlayable)) ?? true) { needsVLC = true }
            // MP4 / iTunes tags, named as ffprobe names them.
            let items = (try? await asset.load(.metadata)) ?? []
            for item in items {
                let ident = item.identifier?.rawValue ?? ""
                let key = (item.key as? String) ?? ""
                if ident == AVMetadataIdentifier.iTunesMetadataCoverArt.rawValue || ident == AVMetadataIdentifier.commonIdentifierArtwork.rawValue {
                    if cover == nil { cover = try? await item.load(.dataValue) }
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
        // Apple's frameworks couldn't open it at all: let VLC read it
        if !readable || streams.isEmpty { return await probeWithVLC(url, mtime: mtime, size: size) }
        if !sidecarSubtitles(url).isEmpty { needsVLC = true }
        var entry: [String: Any] = [
            "id": id, "path": url.path, "mtime": mtime, "size": size,
            "probe": ["format": ["duration": String(duration), "tags": tags], "streams": streams],
        ]
        if let c = cover, let img = UIImage(data: c), let saved = saveJPEG(img, width: 600, to: st.art.appendingPathComponent("\(id)-cover.jpg"), quality: 0.85) {
            entry["art"] = saved
        }
        if entry["art"] == nil, let side = sidecarArt(url) { entry["art"] = side.path }
        if let back = await grabFrame(asset, duration: duration, to: st.art.appendingPathComponent("\(id)-back.jpg")) {
            entry["backdrop"] = back
        }
        if entry["art"] == nil, let back = entry["backdrop"] { entry["art"] = back } // like the desktop: a frame from the film
        if needsVLC { entry["engine"] = "vlc" }
        return entry
    }

    // ---- films Apple's frameworks can't read (MKV, AVI …): VLC reads them ----------------------------------
    private func probeWithVLC(_ url: URL, mtime: Double, size: Int64) async -> [String: Any] {
        let id = String(sha1Hex(st.relativeToDocs(url)).prefix(16))
        let media = VLCMedia(url: url)
        await VLCProbe.parse(media)
        var streams: [[String: Any]] = []
        var firstAudio = true
        for case let t as [String: Any] in (media.tracksInformation ?? []) {
            let type = t[VLCMediaTracksInformationType] as? String ?? ""
            let code = (t[VLCMediaTracksInformationCodec] as? NSNumber)?.uint32Value ?? 0
            let cc = vlcFourCC(code)
            let lang = (t[VLCMediaTracksInformationLanguage] as? String) ?? ""
            var st: [String: Any] = ["tags": ["language": lang]]
            if type == VLCMediaTracksInformationTypeVideo {
                st["codec_type"] = "video"
                st["codec_name"] = ["h264": "h264", "avc1": "h264", "hevc": "hevc", "h265": "hevc", "av01": "av1", "VP90": "vp9", "VP80": "vp8",
                                    "mpgv": "mpeg2video", "mp2v": "mpeg2video", "mp4v": "mpeg4", "WVC1": "vc1", "XVID": "mpeg4", "DIVX": "mpeg4"][cc] ?? cc.trimmingCharacters(in: .whitespaces).lowercased()
                st["width"] = (t[VLCMediaTracksInformationVideoWidth] as? NSNumber)?.intValue ?? 0
                st["height"] = (t[VLCMediaTracksInformationVideoHeight] as? NSNumber)?.intValue ?? 0
                st["disposition"] = ["default": 1, "attached_pic": 0]
            } else if type == VLCMediaTracksInformationTypeAudio {
                st["codec_type"] = "audio"
                st["codec_name"] = ["dts ": "dts", "a52 ": "ac3", "eac3": "eac3", "mp4a": "aac", "trhd": "truehd", "mlp ": "truehd", "mpga": "mp3",
                                    "mp3 ": "mp3", "flac": "flac", "opus": "opus", "vorb": "vorbis", "araw": "pcm_s16le", "s16l": "pcm_s16le", "lpcm": "pcm_s16le"][cc]
                    ?? cc.trimmingCharacters(in: .whitespaces).lowercased()
                st["channels"] = (t[VLCMediaTracksInformationAudioChannelsNumber] as? NSNumber)?.intValue ?? 2
                st["disposition"] = ["default": firstAudio ? 1 : 0]
                firstAudio = false
            } else if type == VLCMediaTracksInformationTypeText {
                st["codec_type"] = "subtitle"
                st["codec_name"] = ["subt": "subrip", "tx3g": "mov_text", "ssa ": "ass", "pgs ": "hdmv_pgs_subtitle", "spu ": "dvd_subtitle"][cc] ?? "subrip"
            } else { continue }
            streams.append(st)
        }
        var tags: [String: String] = [:]
        for (k, n) in [("title", "title"), ("description", "description"), ("genre", "genre"), ("date", "date"), ("showName", "show"),
                       ("season", "season_number"), ("episode", "episode_sort"), ("artist", "artist")] {
            if let v = media.metadata(forKey: k), !v.isEmpty { tags[n] = v }
        }
        // VLC calls an untitled file by its file name: that's not a real title
        if tags["title"] == url.lastPathComponent || tags["title"] == url.deletingPathExtension().lastPathComponent { tags["title"] = nil }
        let duration = Double(media.length.intValue) / 1000
        var entry: [String: Any] = [
            "id": id, "path": url.path, "mtime": mtime, "size": size, "engine": "vlc",
            "probe": ["format": ["duration": String(max(0, duration)), "tags": tags], "streams": streams],
        ]
        if let art = media.metadata(forKey: "artworkURL"), let au = URL(string: art), au.isFileURL, let img = UIImage(contentsOfFile: au.path),
           let saved = saveJPEG(img, width: 600, to: self.st.art.appendingPathComponent("\(id)-cover.jpg"), quality: 0.85) {
            entry["art"] = saved
        }
        if entry["art"] == nil, let side = sidecarArt(url) { entry["art"] = side.path }
        if let cg = await VLCProbe.thumbnail(url, at: duration > 10 ? 0.2 : 0.5),
           let back = saveJPEG(UIImage(cgImage: cg), width: 1280, to: self.st.art.appendingPathComponent("\(id)-back.jpg"), quality: 0.8) {
            entry["backdrop"] = back
        }
        if entry["art"] == nil, let back = entry["backdrop"] { entry["art"] = back }
        return entry
    }

    /// VLC packs a codec name in four characters, lowest byte first.
    private func vlcFourCC(_ code: UInt32) -> String {
        let bytes = [UInt8(code & 0xff), UInt8((code >> 8) & 0xff), UInt8((code >> 16) & 0xff), UInt8((code >> 24) & 0xff)]
        return String(bytes: bytes, encoding: .ascii) ?? ""
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
    func scanAudio(cacheOnly: Bool, progress: @escaping (Int, Int) -> Void) async -> [[String: Any]] {
        let cache = (st.readJson(audioCacheName) as? [String: [String: Any]]) ?? [:]
        let list = files(withExtensions: audioExtensions)
        if cacheOnly || audioBusy {
            return list.compactMap { cache[$0.path] }
        }
        audioBusy = true
        defer { audioBusy = false }
        var next: [String: [String: Any]] = [:]
        var dirArt: [String: String] = [:]     // a folder's embedded cover, saved once
        var dirCover: [String: String?] = [:]  // a folder's cover picture (cover.jpg …)
        var done = 0
        for url in list {
            let s = stat(url)
            var entry: [String: Any]
            if let hit = cache[url.path], (hit["mtime"] as? Double) == s.mtime, (hit["size"] as? NSNumber)?.int64Value == s.size {
                entry = hit
            } else {
                entry = await probeAudio(url, mtime: s.mtime, size: s.size)
            }
            let dir = url.deletingLastPathComponent().path
            if dirCover[dir] == nil { dirCover[dir] = folderCover(url.deletingLastPathComponent()) }
            entry["folderArt"] = dirCover[dir] ?? nil
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
        return list.compactMap { next[$0.path] }
    }

    private func probeAudio(_ url: URL, mtime: Double, size: Int64) async -> [String: Any] {
        let id = String(sha1Hex(st.relativeToDocs(url)).prefix(16))
        let asset = AVURLAsset(url: url)
        var tags: [String: String] = [:]
        var entry: [String: Any] = ["id": id, "path": url.path, "mtime": mtime, "size": size]
        do {
            let d = try await asset.load(.duration).seconds
            entry["duration"] = d.isFinite ? d : 0
            if let t = try await asset.loadTracks(withMediaType: .audio).first {
                let fds = (try? await t.load(.formatDescriptions)) ?? []
                let sub = fds.first.map { fourCC(CMFormatDescriptionGetMediaSubType($0)) } ?? ""
                let codec = ["aac ": "AAC", "mp4a": "AAC", ".mp3": "MP3", "alac": "Apple Lossless", "fLaC": "FLAC", "lpcm": "WAV / AIFF", "ac-3": "AC3", "ec-3": "E-AC3", "opus": "Opus"][sub] ?? sub.uppercased()
                entry["codec"] = codec
                entry["lossless"] = ["alac", "fLaC", "lpcm"].contains(sub)
                if let fd = fds.first, let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fd)?.pointee { entry["sampleRate"] = Int(asbd.mSampleRate) }
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
        } catch {
            NSLog("Screenroom: couldn't read \(url.lastPathComponent): \(error)")
        }
        entry["tags"] = tags
        return entry
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

/// Waits for VLC to read a file's tracks and tags, and grabs a picture from it (with time limits, so a damaged
/// file can't stall the scan).
final class VLCProbe: NSObject, VLCMediaDelegate, VLCMediaThumbnailerDelegate {
    private var cont: CheckedContinuation<Void, Never>?
    private var thumbCont: CheckedContinuation<CGImage?, Never>?
    private var thumbnailer: VLCMediaThumbnailer?
    private static var alive: [VLCProbe] = []

    static func parse(_ media: VLCMedia) async {
        let p = VLCProbe()
        await MainActor.run { alive.append(p) }
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            DispatchQueue.main.async {
                p.cont = c
                media.delegate = p
                let started = media.parse(options: [.fetchLocal], timeout: 15000)
                if started != 0 { p.finish() }
                DispatchQueue.main.asyncAfter(deadline: .now() + 16) { p.finish() }
            }
        }
        await MainActor.run { alive.removeAll { $0 === p } }
    }

    private func finish() {
        cont?.resume()
        cont = nil
    }

    func mediaDidFinishParsing(_ aMedia: VLCMedia) {
        DispatchQueue.main.async { self.finish() }
    }

    static func thumbnail(_ url: URL, at position: Float) async -> CGImage? {
        let p = VLCProbe()
        await MainActor.run { alive.append(p) }
        let img: CGImage? = await withCheckedContinuation { (c: CheckedContinuation<CGImage?, Never>) in
            DispatchQueue.main.async {
                p.thumbCont = c
                let t = VLCMediaThumbnailer(media: VLCMedia(url: url), andDelegate: p)
                t.snapshotPosition = position
                t.thumbnailWidth = 1280
                t.thumbnailHeight = 720
                p.thumbnailer = t
                t.fetchThumbnail()
                DispatchQueue.main.asyncAfter(deadline: .now() + 20) { p.thumbDone(nil) }
            }
        }
        await MainActor.run { alive.removeAll { $0 === p } }
        return img
    }

    private func thumbDone(_ img: CGImage?) {
        thumbCont?.resume(returning: img)
        thumbCont = nil
        thumbnailer = nil
    }

    func mediaThumbnailerDidTimeOut(_ mediaThumbnailer: VLCMediaThumbnailer) {
        DispatchQueue.main.async { self.thumbDone(nil) }
    }

    func mediaThumbnailer(_ mediaThumbnailer: VLCMediaThumbnailer, didFinishThumbnail thumbnail: CGImage) {
        DispatchQueue.main.async { self.thumbDone(thumbnail) }
    }
}
