import UIKit
import PhotosUI
import UniformTypeIdentifiers

/// Bringing films, songs and pictures in: the Files picker (iCloud Drive, a USB-C drive, other apps) and the
/// photo picker. Films are copied into Documents/Films and songs into Documents/Music.
final class Importer: NSObject, UIDocumentPickerDelegate, PHPickerViewControllerDelegate {
    private let st = Storage.shared
    private var filesDone: ((Int) -> Void)?
    private var photoDone: ((UIImage?) -> Void)?
    private var kind = "any"

    @MainActor
    func pick(kind: String, from host: UIViewController) async -> Int {
        self.kind = kind
        let types: [UTType] = kind == "films" ? [.movie, .mpeg4Movie, .quickTimeMovie]
            : kind == "music" ? [.audio, .mp3, .mpeg4Audio]
            : [.movie, .audio]
        return await withCheckedContinuation { cont in
            filesDone = { n in cont.resume(returning: n) }
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: types, asCopy: true)
            picker.allowsMultipleSelection = true
            picker.delegate = self
            host.present(picker, animated: true)
        }
    }

    func documentPicker(_ c: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        let n = urls.reduce(0) { $0 + (bringIn($1) ? 1 : 0) }
        filesDone?(n)
        filesDone = nil
    }

    func documentPickerWasCancelled(_ c: UIDocumentPickerViewController) {
        filesDone?(0)
        filesDone = nil
    }

    /// Move (or copy) one file into Films or Music. Returns false for anything that isn't a film or a song.
    @discardableResult
    func bringIn(_ url: URL, copy: Bool = false) -> Bool {
        let ext = url.pathExtension.lowercased()
        let dir: URL
        if videoExtensions.contains(ext) { dir = st.films }
        else if audioExtensions.contains(ext) { dir = st.music }
        else { return false }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let dest = st.freeName(in: dir, for: url.lastPathComponent)
        do {
            if copy { try st.fm.copyItem(at: url, to: dest) } else { try st.fm.moveItem(at: url, to: dest) }
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
        for k in kids where bringIn(k) { n += 1 }
        if ((try? st.fm.contentsOfDirectory(atPath: inbox.path)) ?? []).isEmpty { try? st.fm.removeItem(at: inbox) }
        return n
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
