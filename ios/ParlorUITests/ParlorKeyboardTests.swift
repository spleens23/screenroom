import XCTest

/// Parlor with a keyboard (an iPad's, or a Mac's when Parlor runs there): ⌘F searches, Return opens and plays,
/// Escape goes back, ⌘→ skips to the next song, Space pauses. The build workflow then asks the page what's playing.
final class ParlorKeyboardTests: XCTestCase {
    override func setUp() { continueAfterFailure = true }

    private func save(_ name: String) {
        guard let dir = ProcessInfo.processInfo.environment["SHOTS"] else { return }
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("parlor-kb-\(name).png"))
    }

    func testKeyboard() {
        let app = XCUIApplication()
        // (the page shows, in a strip at the bottom, the last few keys it got, where the highlight is and what's
        // playing, so the screenshots say what happened; it also notes them for the build workflow)
        app.launchArguments = ["--ui-script", """
            (() => { const d = document.createElement('div'); d.style.cssText = 'position:fixed;left:8px;right:8px;bottom:8px;z-index:99999;background:#000c;color:#fff;font:13px monospace;padding:6px 10px;border-radius:8px;white-space:pre;pointer-events:none';
              document.body.appendChild(d); const keys = [];
              const who = (el) => el ? (el.id ? '#' + el.id : '') + (el.tagName || '') + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').slice(0, 2).join('.') : '') + (el.title ? ' "' + el.title + '"' : '') : '-';
              addEventListener('keydown', (e) => { keys.push((e.metaKey ? '⌘' : '') + (e.ctrlKey ? '^' : '') + JSON.stringify(e.key) + '/' + e.keyCode + (e.isComposing ? ' composing' : '') + ' on ' + who(e.target)); keys.splice(0, keys.length - 6); }, true);
              setInterval(() => api.parlorState().then((p) => { const line = 'player: ' + JSON.stringify(p.player && p.player.track ? { title: p.player.track.title, paused: p.player.paused } : null) + '  focus: ' + who(document.activeElement);
                d.textContent = keys.join('\\n') + '\\n' + line; console.error('kb ' + line + ' | ' + keys.slice(-1)[0]); }), 500); })()
            """]
        app.launch()
        let web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 40), "Parlor's page didn't open")
        sleep(12) // the library
        let sb = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        if sb.alerts.firstMatch.waitForExistence(timeout: 1) { sb.alerts.firstMatch.buttons.firstMatch.tap() }
        // give the page the keyboard: the simulator only sends keys to a web view that's taken focus, which a
        // click on a text box does (a click on an empty bit of the page doesn't count there)
        let box = web.searchFields.firstMatch.exists ? web.searchFields.firstMatch : web.textFields.firstMatch
        if box.waitForExistence(timeout: 5) { box.tap() } else { web.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.06)).tap() }
        sleep(1)
        save("1-home")

        app.typeKey("f", modifierFlags: .command)
        app.typeText("Long")
        sleep(2)
        save("2-search")
        XCTAssertTrue(web.staticTexts["Results for “Long”"].waitForExistence(timeout: 5), "⌘F didn't search")

        app.typeKey(.return, modifierFlags: [])   // from the search box: to the first result
        sleep(1)
        save("2b-result")
        app.typeKey(.return, modifierFlags: [])   // open it
        sleep(2)
        save("3-album")
        XCTAssertTrue(web.buttons["Shuffle"].waitForExistence(timeout: 5), "Return didn't open the album")
        app.typeKey(.return, modifierFlags: [])   // Play (highlighted when the album opens)
        sleep(3)
        app.typeKey(.escape, modifierFlags: [])   // close the album
        sleep(1)
        save("4-closed")
        XCTAssertFalse(web.buttons["Shuffle"].exists, "Escape didn't close the album")
        app.typeKey(.rightArrow, modifierFlags: .command) // next song
        sleep(2)
        app.typeKey(" ", modifierFlags: [])       // pause
        sleep(2)
        save("5-paused")
    }
}
