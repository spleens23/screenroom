import UIKit
import PhotosUI
import UniformTypeIdentifiers

/// Bringing films, songs and pictures in: the Files picker (iCloud Drive, a USB-C drive, other apps: single files
/// or whole folders), dropping files and folders onto Screenroom, AirDrop, and the photo picker. Films are copied
/// into Documents/Films and songs into Documents/Music; a folder keeps its structure (Series / Season 1 / …,
/// Artist / Album / …), with the cover pictures and subtitles beside the files.
final class Importer: NSObject, UIDocumentPickerDelegate, PHPickerViewControllerDelegate {
    private let st = Storage.shared
    private var filesDone: ((Int) -> Void)?
    private var photoDone: ((UIImage?) -> Void)?
    private var motionDone: ((URL?) -> Void)?   // picking an album's moving cover (a video), from Photos or Files
    private var folderDone: ((URL?) -> Void)?   // picking a music folder Parlor reads where it is

    @MainActor
    func pickFolder(from host: UIViewController) async -> URL? {
        await withCheckedContinuation { cont in
            folderDone = { u in cont.resume(returning: u) }
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder], asCopy: false)
            picker.allowsMultipleSelection = false
            picker.delegate = self
            host.present(picker, animated: true)
        }
    }
    private var kind = "any"

    @MainActor
    func pick(kind: String, from host: UIViewController) async -> Int {
        self.kind = kind
        // Screenroom takes films, Parlor takes music
        var types: [UTType] = isParlorApp ? [.audio, .mpeg4Movie, .quickTimeMovie] : [.movie, .audiovisualContent] // (Dolby Atmos songs are often .mp4)
        types.append(.folder)
        // MKV, AVI and other films the system doesn't know as movies; FLAC for Parlor
        for ext in isParlorApp ? ["flac", "alac", "ac3", "ec3", "eac3", "wav"] : ["mkv", "avi", "webm", "ts", "m2ts", "wmv", "flv"] { if let t = UTType(filenameExtension: ext) { types.append(t) } }
        return await withCheckedContinuation { cont in
            filesDone = { n in cont.resume(returning: n) }
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: types, asCopy: false)
            picker.allowsMultipleSelection = true
            picker.delegate = self
            host.present(picker, animated: true)
        }
    }

    func documentPicker(_ c: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        if let done = folderDone { folderDone = nil; done(urls.first); return }
        if let done = motionDone {
            motionDone = nil
            DispatchQueue.global(qos: .userInitiated).async {
                let out = urls.first.flatMap { self.keepPicked($0) }
                DispatchQueue.main.async { done(out) }
            }
            return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            let n = urls.reduce(0) { $0 + self.bringIn($1, copy: true) }
            DispatchQueue.main.async { self.filesDone?(n); self.filesDone = nil }
        }
    }

    func documentPickerWasCancelled(_ c: UIDocumentPickerViewController) {
        if let done = folderDone { folderDone = nil; done(nil); return }
        if let done = motionDone { motionDone = nil; done(nil); return }
        filesDone?(0)
        filesDone = nil
    }

    private func isMedia(_ url: URL) -> Bool {
        let e = url.pathExtension.lowercased()
        return videoExtensions.contains(e) || audioExtensions.contains(e)
    }

    /// Copy (or move) a file or a whole folder into Films / Music. Returns how many films and songs came in.
    @discardableResult
    func bringIn(_ url: URL, copy: Bool = false) -> Int {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        // Reading through a file coordinator downloads a file that's only in iCloud Drive (or another cloud
        // provider) first; without it those songs and films were silently skipped.
        var n = 0
        var err: NSError?
        NSFileCoordinator().coordinate(readingItemAt: url, options: [.withoutChanges], error: &err) { u in n = self.bringInNow(u, copy: copy) }
        if let err { NSLog("Screenroom: couldn't read \(url.lastPathComponent): \(err)"); n = bringInNow(url, copy: copy) }
        return n
    }

    private func bringInNow(_ url: URL, copy: Bool) -> Int {
        var isDir: ObjCBool = false
        guard st.fm.fileExists(atPath: url.path, isDirectory: &isDir) else { return 0 }
        if isDir.boolValue { return bringInFolder(url) }
        let ext = url.pathExtension.lowercased()
        let dir: URL
        if videoExtensions.contains(ext), !isParlorApp { dir = st.films }
        else if audioExtensions.contains(ext), isParlorApp { dir = st.music }
        else if isParlorApp, ["mp4", "m4v", "mov"].contains(ext) { dir = st.music } // a Dolby Atmos song (.mp4); Parlor's scan tells songs from videos
        else { return 0 } // (a song brought to Screenroom, or a film to Parlor, isn't kept)
        return place(url, in: dir, name: url.lastPathComponent, copy: copy) ? 1 : 0
    }

    /// A folder keeps its own layout inside Films (if it has films) and Music (if it has songs).
    private func bringInFolder(_ folder: URL) -> Int {
        guard let e = st.fm.enumerator(at: folder, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles, .skipsPackageDescendants]) else { return 0 }
        var files: [URL] = []
        for case let f as URL in e where (try? f.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) != true { files.append(f) }
        let hasVideo = !isParlorApp && files.contains { videoExtensions.contains($0.pathExtension.lowercased()) }
        let hasAudio = isParlorApp && files.contains { audioExtensions.contains($0.pathExtension.lowercased()) || ["mp4", "m4v", "mov"].contains($0.pathExtension.lowercased()) }
        guard hasVideo || hasAudio else { return 0 }
        let top = folder.lastPathComponent
        let rootPath = folder.standardizedFileURL.path
        // Songs already in Music, by file name: an album folder brought in again (now with its cover.mp4) may have
        // been imported before under another name or layout, and its cover belongs beside those songs.
        var known: [String: URL] = [:]
        if isParlorApp, files.contains(where: { isMotionCover($0.lastPathComponent) }),
           let walk = st.fm.enumerator(at: st.music, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles]) {
            for case let k as URL in walk where audioExtensions.contains(k.pathExtension.lowercased()) {
                known["\(k.lastPathComponent)|\(fileSize(k))"] = k.deletingLastPathComponent()
            }
        }
        var n = 0
        for f in files {
            let ext = f.pathExtension.lowercased()
            var rel = String(f.standardizedFileURL.path.dropFirst(rootPath.count))
            if rel.hasPrefix("/") { rel.removeFirst() }
            let dest: URL
            if videoExtensions.contains(ext) && !isParlorApp && !isMotionCover(f.lastPathComponent) { dest = st.films }
            else if audioExtensions.contains(ext) && isParlorApp { dest = st.music }
            else if isParlorApp && isMotionCover(f.lastPathComponent) { dest = st.music } // an album's moving cover
            else if isParlorApp && ["mp4", "m4v", "mov"].contains(ext) { dest = st.music } // a Dolby Atmos song (.mp4) beside the others
            else if sidecarExtensions.contains(ext) { dest = hasVideo ? st.films : st.music }
            else { continue }
            var target = dest.appendingPathComponent(top).appendingPathComponent(rel)
            let isCover = isParlorApp && (isMotionCover(f.lastPathComponent) || sidecarExtensions.contains(ext))
            if isParlorApp && isMotionCover(f.lastPathComponent) {
                // beside the songs it came with, wherever they are now
                let sibs = (try? st.fm.contentsOfDirectory(at: f.deletingLastPathComponent(), includingPropertiesForKeys: nil)) ?? []
                if let home = sibs.lazy.filter({ audioExtensions.contains($0.pathExtension.lowercased()) })
                    .compactMap({ known["\($0.lastPathComponent)|\(fileSize($0))"] }).first {
                    target = home.appendingPathComponent(f.lastPathComponent)
                }
            }
            try? st.fm.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            if st.fm.fileExists(atPath: target.path) {
                // a file that's already here as it is is skipped; one that changed (a song retagged or swapped for an
                // upmixed version, a new moving cover) replaces the old one, so bringing a folder in again updates it
                guard !sameFile(target, f) else { continue }
                if isMotionCover(f.lastPathComponent) { removeMotionCovers(in: target.deletingLastPathComponent()) }
                else { try? st.fm.removeItem(at: target) }
            } else if isParlorApp && isMotionCover(f.lastPathComponent) {
                removeMotionCovers(in: target.deletingLastPathComponent()) // one moving cover per album
            }
            if (try? st.fm.copyItem(at: f, to: target)) != nil, isMedia(f) || isCover { n += 1 }
        }
        return n
    }

    private func place(_ url: URL, in dir: URL, name: String, copy: Bool) -> Bool {
        // in Parlor, a song brought in again under the same name replaces the one there (if it changed) rather than
        // sitting beside it as "Song 2"
        let same = dir.appendingPathComponent(name)
        if isParlorApp, st.fm.fileExists(atPath: same.path) {
            if sameFile(same, url) { return true }
            try? st.fm.removeItem(at: same)
        }
        let dest = st.freeName(in: dir, for: name)
        do {
            if copy { try st.fm.copyItem(at: url, to: dest) } else { try st.fm.moveItem(at: url, to: dest) }
            // subtitles beside the film (Film.srt, Film.en.srt) come along
            if videoExtensions.contains(url.pathExtension.lowercased()) {
                let base = url.deletingPathExtension().lastPathComponent
                let destBase = dest.deletingPathExtension().lastPathComponent
                for side in (try? st.fm.contentsOfDirectory(atPath: url.deletingLastPathComponent().path)) ?? [] {
                    let l = side.lowercased()
                    guard side.hasPrefix(base), side != url.lastPathComponent,
                          ["srt", "vtt", "ass", "ssa", "jpg", "jpeg", "png"].contains((l as NSString).pathExtension) else { continue }
                    let target = dir.appendingPathComponent(destBase + side.dropFirst(base.count))
                    if !st.fm.fileExists(atPath: target.path) { try? st.fm.copyItem(at: url.deletingLastPathComponent().appendingPathComponent(side), to: target) }
                }
            }
            return true
        } catch {
            do { try st.fm.copyItem(at: url, to: dest); return true } catch {
                NSLog("Screenroom: couldn't bring in \(url.lastPathComponent): \(error)")
                return false
            }
        }
    }

    /// Files AirDropped or shared to Screenroom land in Documents/Inbox: put them where they belong.
    func tidyInbox() -> Int {
        let inbox = st.docs.appendingPathComponent("Inbox")
        guard let kids = try? st.fm.contentsOfDirectory(at: inbox, includingPropertiesForKeys: nil) else { return 0 }
        var n = 0
        for k in kids { n += bringIn(k) }
        if ((try? st.fm.contentsOfDirectory(atPath: inbox.path)) ?? []).isEmpty { try? st.fm.removeItem(at: inbox) }
        return n
    }

    // ---- dropping films, songs and folders onto the app ---------------------------------------------------
    static let dropTypes: [String] = [UTType.movie.identifier, UTType.audiovisualContent.identifier, UTType.audio.identifier,
                                     UTType.folder.identifier, UTType.directory.identifier, UTType.data.identifier]

    /// Copies what was dropped; calls done(count) on the main thread when everything is in.
    func takeDrop(_ providers: [NSItemProvider], done: @escaping (Int) -> Void) {
        let group = DispatchGroup()
        var total = 0
        let lock = NSLock()
        for p in providers {
            guard let type = Importer.dropTypes.first(where: { p.hasItemConformingToTypeIdentifier($0) }) else { continue }
            group.enter()
            let finish: (URL?) -> Void = { url in
                if let url { let n = self.bringIn(url, copy: true); lock.lock(); total += n; lock.unlock() }
                group.leave()
            }
            p.loadInPlaceFileRepresentation(forTypeIdentifier: type) { url, _, err in
                if let url { finish(url); return }
                p.loadFileRepresentation(forTypeIdentifier: type) { url, _ in finish(url) }
            }
        }
        group.notify(queue: .main) { done(total) }
    }

    // ---- an album's moving cover ------------------------------------------------------------------------------
    /// Pick a short video (from Photos or Files) and make it the album's moving cover: it's copied into the album's
    /// folder as cover.mp4 / cover.mov, in place of any moving cover that was there. Returns the new file.
    @MainActor
    func pickMotion(from host: UIViewController, source: String, into dir: URL) async -> URL? {
        let picked: URL? = await withCheckedContinuation { cont in
            motionDone = { u in cont.resume(returning: u) }
            if source == "files" {
                let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.movie, .mpeg4Movie, .quickTimeMovie], asCopy: true)
                picker.allowsMultipleSelection = false
                picker.delegate = self
                host.present(picker, animated: true)
            } else {
                var cfg = PHPickerConfiguration()
                cfg.filter = .videos
                cfg.selectionLimit = 1
                cfg.preferredAssetRepresentationMode = .current
                let picker = PHPickerViewController(configuration: cfg)
                picker.delegate = self
                host.present(picker, animated: true)
            }
        }
        guard let tmp = picked else { return nil }
        defer { try? st.fm.removeItem(at: tmp) }
        var ext = tmp.pathExtension.lowercased()
        if !["mp4", "m4v", "mov"].contains(ext) { ext = "mov" }
        let dest = dir.appendingPathComponent("cover.\(ext)")
        removeMotionCovers(in: dir)
        do { try st.fm.copyItem(at: tmp, to: dest) } catch { NSLog("Parlor: couldn't keep the moving cover: \(error)"); return nil }
        return dest
    }

    /// Takes away an album's moving cover(s) in a folder.
    func removeMotionCovers(in dir: URL) {
        for name in (try? st.fm.contentsOfDirectory(atPath: dir.path)) ?? [] where isMotionCover(name) {
            try? st.fm.removeItem(at: dir.appendingPathComponent(name))
        }
    }

    /// A picked file copied somewhere of our own, before the picker throws its copy away.
    private func keepPicked(_ url: URL) -> URL? {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("motion-\(randomHex(4)).\(url.pathExtension.isEmpty ? "mov" : url.pathExtension)")
        do { try st.fm.copyItem(at: url, to: tmp); return tmp } catch { NSLog("Parlor: couldn't read the picked video: \(error)"); return nil }
    }

    // ---- pictures (profile photos, album covers) -----------------------------------------------------------------
    @MainActor
    func pickPhoto(from host: UIViewController) async -> UIImage? {
        await withCheckedContinuation { cont in
            photoDone = { img in cont.resume(returning: img) }
            var cfg = PHPickerConfiguration()
            cfg.filter = .images
            cfg.selectionLimit = 1
            let picker = PHPickerViewController(configuration: cfg)
            picker.delegate = self
            host.present(picker, animated: true)
        }
    }

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        if let done = motionDone {
            motionDone = nil
            guard let p = results.first?.itemProvider,
                  let type = p.registeredTypeIdentifiers.first(where: { UTType($0)?.conforms(to: .movie) == true }) ?? (p.hasItemConformingToTypeIdentifier(UTType.movie.identifier) ? UTType.movie.identifier : nil)
            else { done(nil); return }
            p.loadFileRepresentation(forTypeIdentifier: type) { url, err in
                // the file only lasts until this returns, so it's copied here
                let out = url.flatMap { self.keepPicked($0) }
                if out == nil { NSLog("Parlor: couldn't load the video from Photos: \(String(describing: err))") }
                DispatchQueue.main.async { done(out) }
            }
            return
        }
        guard let p = results.first?.itemProvider, p.canLoadObject(ofClass: UIImage.self) else {
            photoDone?(nil); photoDone = nil
            return
        }
        p.loadObject(ofClass: UIImage.self) { obj, _ in
            DispatchQueue.main.async {
                self.photoDone?(obj as? UIImage)
                self.photoDone = nil
            }
        }
    }
}

/// Same size and (to the second) the same date: the same file brought in again.
private func sameFile(_ a: URL, _ b: URL) -> Bool {
    guard fileSize(a) == fileSize(b) else { return false }
    let d = { (u: URL) in (try? u.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate?.timeIntervalSince1970) ?? 0 }
    return abs(d(a) - d(b)) < 2
}

private func fileSize(_ u: URL) -> Int64 {
    ((try? FileManager.default.attributesOfItem(atPath: u.path))?[.size] as? NSNumber)?.int64Value ?? -1
}
