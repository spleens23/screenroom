import UIKit
import WebKit
import AVFoundation

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        Storage.shared.prepare()
        return true
    }

    func application(_ application: UIApplication, configurationForConnecting session: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let c = UISceneConfiguration(name: "Default", sessionRole: session.role)
        c.delegateClass = SceneDelegate.self
        return c
    }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private let screen = ScreenController()

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let ws = scene as? UIWindowScene else { return }
        let w = UIWindow(windowScene: ws)
        w.rootViewController = screen
        w.backgroundColor = .black
        w.makeKeyAndVisible()
        window = w
        bringIn(options.urlContexts)
    }

    // AirDrop, "Open in Screenroom", Share → Screenroom
    func scene(_ scene: UIScene, openURLContexts contexts: Set<UIOpenURLContext>) {
        bringIn(contexts)
    }

    private func bringIn(_ contexts: Set<UIOpenURLContext>) {
        guard !contexts.isEmpty else { return }
        var n = 0
        for c in contexts { n += screen.importer.bringIn(c.url, copy: c.options.openInPlace) }
        n += screen.importer.tidyInbox()
        if n > 0 { screen.filesChanged() }
    }

    func sceneWillEnterForeground(_ scene: UIScene) {
        // Finder, the Files app or AirDrop may have added something while Screenroom was away.
        _ = screen.importer.tidyInbox()
        screen.filesChanged()
    }
}

/// The whole app is one full-screen page: the same screens as the desktop Screenroom and Parlor.
final class ScreenController: UIViewController, WKNavigationDelegate, UIDropInteractionDelegate {
    let bridge = Bridge()
    let importer = Importer()
    private var web: WKWebView!
    private var loaded = false

    override func loadView() {
        let cfg = WKWebViewConfiguration()
        cfg.userContentController.add(bridge, name: "screenroom")
        cfg.userContentController.addUserScript(WKUserScript(source: "window.S_IOS = true;", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        // Page errors are kept in a small log (Library/Caches/page-errors.log), and a problem while the screens start
        // up is shown on screen, so it can be reported instead of leaving a half-drawn page.
        cfg.userContentController.addUserScript(WKUserScript(source: """
            (() => { const t0 = Date.now();
              const log = (m) => { try { window.webkit.messageHandlers.screenroom.postMessage({ id: 0, method: 'debugLog', args: JSON.stringify([String(m)]) }); } catch (e) {} };
              const show = (m) => { if (Date.now() - t0 > 20000) return; const put = () => { let b = document.getElementById('ios-problem');
                if (!b) { b = document.createElement('div'); b.id = 'ios-problem'; b.style.cssText = 'position:fixed;left:16px;right:16px;bottom:16px;z-index:99999;background:#3A1E16;color:#FFE2D6;border:1px solid #D2553A;border-radius:14px;padding:14px 18px;font:15px -apple-system,sans-serif;white-space:pre-wrap;max-height:40vh;overflow:auto';
                  b.onclick = () => b.remove(); document.body.appendChild(b); b.textContent = 'Screenroom hit a problem starting up (tap to hide). Please send a screenshot of this:'; }
                b.textContent += '\\n• ' + m; }; document.body ? put() : addEventListener('DOMContentLoaded', put); };
              const report = (m) => { log(m); show(m); }; window.__iosReport = report;
              window.addEventListener('error', (e) => (e.message === 'Script error.' ? log : report)('error: ' + e.message + ' @ ' + String(e.filename).split('/').slice(-2).join('/') + ':' + e.lineno));
              window.addEventListener('unhandledrejection', (e) => report('rejection: ' + (e.reason && (e.reason.stack || e.reason.message) || e.reason)));
              const ce = console.error; console.error = (...a) => { log('console: ' + a.join(' ')); ce.apply(console, a); }; })();
            """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        cfg.allowsInlineMediaPlayback = true
        cfg.mediaTypesRequiringUserActionForPlayback = []
        let v = WKWebView(frame: .zero, configuration: cfg)
        v.isOpaque = false
        v.backgroundColor = .black
        v.scrollView.backgroundColor = .black
        v.scrollView.contentInsetAdjustmentBehavior = .never
        v.scrollView.bounces = false
        v.allowsBackForwardNavigationGestures = false
        v.navigationDelegate = self
        #if DEBUG
        if #available(iOS 16.4, *) { v.isInspectable = true }
        #endif
        web = v
        bridge.web = v
        bridge.host = self
        // The page sits in a plain view that takes films, songs and folders dropped onto Screenroom (from Files,
        // in Split View or Stage Manager). The web view's own drop handling is taken out so drops reach it.
        let root = UIView()
        root.backgroundColor = .black
        v.frame = root.bounds
        v.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        root.addSubview(v)
        root.addInteraction(UIDropInteraction(delegate: self))
        view = root
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        removeWebDrops(web)
    }

    private func removeWebDrops(_ v: UIView) {
        for i in v.interactions where i is UIDropInteraction { v.removeInteraction(i) }
        for sub in v.subviews { removeWebDrops(sub) }
    }

    func dropInteraction(_ interaction: UIDropInteraction, canHandle session: UIDropSession) -> Bool {
        session.hasItemsConforming(toTypeIdentifiers: Importer.dropTypes)
    }

    func dropInteraction(_ interaction: UIDropInteraction, sessionDidUpdate session: UIDropSession) -> UIDropProposal {
        UIDropProposal(operation: .copy)
    }

    func dropInteraction(_ interaction: UIDropInteraction, performDrop session: UIDropSession) {
        bridge.emit("notice", "Importing…")
        importer.takeDrop(session.items.map { $0.itemProvider }) { [weak self] n in
            self?.bridge.emit("notice", n > 0 ? "Added \(n) \(n == 1 ? "file" : "files")" : "Nothing to add there: films and songs only")
            self?.filesChanged()
        }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        let st = Storage.shared
        let index = st.web.appendingPathComponent("renderer/index.html")
        // The page may read anything in the app's own folder: its screens, cover art, and the films' pictures.
        web.loadFileURL(index, allowingReadAccessTo: URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true))
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loaded = true
        #if DEBUG
        // Test builds can be driven from the command line: --ui-script "<JavaScript>" runs once the page is up.
        let args = ProcessInfo.processInfo.arguments
        if let i = args.firstIndex(of: "--ui-script"), i + 1 < args.count {
            let js = args[i + 1]
            DispatchQueue.main.asyncAfter(deadline: .now() + 6) { webView.evaluateJavaScript(js, completionHandler: nil) }
        }
        #endif
    }

    // Links never navigate away from the app.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if action.navigationType == .linkActivated, let url = action.request.url, url.scheme == "https" {
            UIApplication.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(action.request.url?.isFileURL == true ? .allow : .cancel)
    }

    func filesChanged() {
        if loaded { bridge.emit("files-changed", [:]) }
    }

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
}
