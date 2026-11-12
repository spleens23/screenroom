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
        // (the page notes what's playing every second, for the build workflow to read afterwards)
        app.launchArguments = ["--ui-script", "setInterval(() => api.parlorState().then(p => console.error('kb player: ' + JSON.stringify(p.player && p.player.track ? { title: p.player.track.title, paused: p.player.paused } : null) + ' focus=' + (document.activeElement && (document.activeElement.title || document.activeElement.className || document.activeElement.tagName)))), 1000)"]
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
