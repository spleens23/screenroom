import XCTest

/// Plays a film, lets the controls fade, taps the picture and checks they come back: for a film Apple's engine
/// plays and ones mpv's engine plays, and again after switching the soundtrack. Screenshots go to $SHOTS.
final class PlayerControlsTests: XCTestCase {
    override func setUp() { continueAfterFailure = true }

    private func save(_ name: String, _ app: XCUIApplication) {
        guard let dir = ProcessInfo.processInfo.environment["SHOTS"] else { return }
        try? app.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("ui-\(name).png"))
    }

    private func run(film: String, tag: String) {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-script",
            "api.state().then(s => { const f = s.library.find(i => /\(film)/.test(i.title || i.path)); f && api.play({ id: f.id }); })"]
        app.launch()
        let close = app.buttons["Close"]
        XCTAssertTrue(close.waitForExistence(timeout: 40), "\(tag): the player didn't open")
        save("\(tag)-1-start", app)
        sleep(7) // the controls fade after 4 s
        save("\(tag)-2-faded", app)
        XCTAssertFalse(close.isHittable, "\(tag): controls didn't fade")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35)).tap()
        sleep(1)
        save("\(tag)-3-tapped", app)
        XCTAssertTrue(close.isHittable, "\(tag): a tap didn't bring the controls back")
        // switch the soundtrack, let them fade, tap again
        let tracks = app.buttons["Audio & subtitles"]
        if tracks.isHittable {
            tracks.tap()
            sleep(1)
            save("\(tag)-4-menu", app)
            let items = app.collectionViews.buttons.allElementsBoundByIndex.filter { $0.isHittable && $0.isEnabled }
            if items.count > 1 { items[1].tap() } else { app.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.1)).tap() }
            sleep(7)
            save("\(tag)-5-after-switch-faded", app)
            XCTAssertFalse(close.isHittable, "\(tag): after the menu, the controls didn't fade")
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35)).tap()
            sleep(1)
            save("\(tag)-6-after-switch-tapped", app)
            XCTAssertTrue(close.isHittable, "\(tag): after switching the soundtrack, a tap didn't bring the controls back")
            // and the play button still works
            let pause = app.buttons["Pause"]
            if pause.isHittable { pause.tap(); sleep(1); XCTAssertTrue(app.buttons["Play"].exists, "\(tag): pause didn't work") }
        }
        save("\(tag)-7-end", app)
        // close the player properly (test builds then note whether sound played)
        if !close.isHittable { app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35)).tap() }
        if close.waitForExistence(timeout: 2), close.isHittable { close.tap(); sleep(2) }
        app.terminate()
    }

    func testAppleEngineFilm() { run(film: "Last Signal", tag: "apple") }
    func testVLCFilm() { run(film: "Desert Signal", tag: "vlc") }
    func testVLCMP4Film() { run(film: "Harbor Lights", tag: "vlcmp4") }
    func testTrueHDInMP4() { run(film: "Night Ferry", tag: "truehd") }
}
