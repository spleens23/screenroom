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
    private var kind = "any"

    @MainActor
    func pick(kind: String, from host: UIViewController) async -> Int {
        self.kind = kind
        var types: [UTType] = kind == "films" ? [.movie, .audiovisualContent] : kind == "music" ? [.audio] : [.movie, .audiovisualContent, .audio]
        types.append(.folder)
        // MKV, AVI and other films the system doesn't know as movies
        for ext in ["mkv", "avi", "webm", "ts", "m2ts", "wmv", "flv", "flac"] { if let t = UTType(filenameExtension: ext) { types.append(t) } }
        return await withCheckedContinuation { cont in
            filesDone = { n in cont.resume(returning: n) }
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: types, asCopy: false)
            picker.allowsMultipleSelection = true
            picker.delegate = self
            host.present(picker, animated: true)
        }
    }

    func documentPicker(_ c: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        DispatchQueue.global(qos: .userInitiated).async {
            let n = urls.reduce(0) { $0 + self.bringIn($1, copy: true) }
            DispatchQueue.main.async { self.filesDone?(n); self.filesDone = nil }
        }
    }

    func documentPickerWasCancelled(_ c: UIDocumentPickerViewController) {
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
        var isDir: ObjCBool = false
        guard st.fm.fileExists(atPath: url.path, isDirectory: &isDir) else { return 0 }
        if isDir.boolValue { return bringInFolder(url) }
        let ext = url.pathExtension.lowercased()
        let dir: URL
        if videoExtensions.contains(ext) { dir = st.films }
        else if audioExtensions.contains(ext) { dir = st.music }
        else { return 0 }
        return place(url, in: dir, name: url.lastPathComponent, copy: copy) ? 1 : 0
    }

    /// A folder keeps its own layout inside Films (if it has films) and Music (if it has songs).
    private func bringInFolder(_ folder: URL) -> Int {
        guard let e = st.fm.enumerator(at: folder, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles, .skipsPackageDescendants]) else { return 0 }
        var files: [URL] = []
        for case let f as URL in e where (try? f.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) != true { files.append(f) }
        let hasVideo = files.contains { videoExtensions.contains($0.pathExtension.lowercased()) }
        let hasAudio = files.contains { audioExtensions.contains($0.pathExtension.lowercased()) }
        guard hasVideo || hasAudio else { return 0 }
        let top = folder.lastPathComponent
        let rootPath = folder.standardizedFileURL.path
        var n = 0
        for f in files {
            let ext = f.pathExtension.lowercased()
            var rel = String(f.standardizedFileURL.path.dropFirst(rootPath.count))
            if rel.hasPrefix("/") { rel.removeFirst() }
            let dest: URL
            if videoExtensions.contains(ext) { dest = st.films }
            else if audioExtensions.contains(ext) { dest = st.music }
            else if sidecarExtensions.contains(ext) { dest = hasVideo ? st.films : st.music }
            else { continue }
            let target = dest.appendingPathComponent(top).appendingPathComponent(rel)
            try? st.fm.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            if st.fm.fileExists(atPath: target.path) { continue } // already imported
            if (try? st.fm.copyItem(at: f, to: target)) != nil, isMedia(f) { n += 1 }
        }
        return n
    }

    private func place(_ url: URL, in dir: URL, name: String, copy: Bool) -> Bool {
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
