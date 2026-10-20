# Screenroom

A Netflix-style browser and player for your local MP4 library. The interface is Electron; playback is [mpv](https://mpv.io), wrapped in a custom Netflix-style on-screen player.

**Why mpv?** Chromium (and so Electron) can't decode DTS and only partly handles Dolby audio. mpv plays everything in your files (H.264 / H.265, 480p to 4K, AC-3, E-AC-3, TrueHD, DTS, DTS-HD) with hardware decoding, and can pass Dolby/DTS bitstreams through to a receiver.

## Run it

```bash
# Mac
brew install mpv ffmpeg node
# Linux (Debian/Ubuntu)
sudo apt install mpv ffmpeg nodejs npm

cd screenroom
npm install
npm start
```

On first launch click **Choose folders…** and pick the folders that hold your MP4s.

## Build a double-clickable app

**Mac, easiest:** in Terminal, from the project folder, run `bash scripts/build-mac.command`. It installs Homebrew's node, mpv and ffmpeg if missing, builds the app and puts `Screenroom.app` in Applications.

```bash
npm install
npm run dist          # builds for the machine you're on
# or: npm run dist:mac   /   npm run dist:linux
```

Output goes to `dist/`:

- **Mac:** `dist/Screenroom-<version>-arm64.dmg` (or `-x64` on Intel) plus a `.zip`; the app itself is in `dist/mac-arm64/Screenroom.app`. Drag it to Applications.
- **Linux:** `dist/Screenroom-<version>.AppImage` and a `.deb`.

Build on the Mac you'll run it on. The app is ad-hoc signed (not notarised), and an app you built yourself opens normally. If you copy it to a different Mac and macOS says it can't be verified, right-click the app and choose **Open** once.

mpv and ffmpeg are **not** bundled: install them with Homebrew / apt as above. The app looks in `/opt/homebrew/bin`, `/usr/local/bin` and `/usr/bin`, so it finds them even when launched from Finder.

Your library cache, settings and watch history live in `~/Library/Application Support/screenroom` (Mac) or `~/.config/screenroom` (Linux), shared between `npm start` and the packaged app.

## Movies and TV

Metadata (title, year, description, genres, cover art) is read from the tags embedded in each MP4. Nothing is fetched online.

TV shows are grouped by folder and file name:

```
Series Name/
  Season 1/            (also "Season 01", "S1", or "Specials" for season 0)
    S01E01 Episode Name.mp4
    S01E02 - Another Episode.mp4
```

Anything that doesn't follow that pattern is treated as a movie. Episodes roll up into one card per series. Opening a series shows a season picker and an episode list with thumbnails, descriptions, durations, resume bars and watched ticks.

## Browsing

- Tabs: Home, TV Shows, Movies, 4K, HD (720p/1080p), SD (below 720p). A series appears in a resolution tab if any of its episodes match.
- Home rows: Continue Watching (resume a movie or the next episode of a show you've started), Recently Added, TV Shows, Movies, 4K, Dolby Atmos, DTS, and one row per genre.
- Keyboard: arrows move between titles, Enter opens, Esc closes, `/` focuses search.
- Settings: audio passthrough (bitstream to your receiver over HDMI/optical) versus local decode, optional stereo downmix, fullscreen start, folders, rescan.

## The player

Playing a TV episode queues the rest of the series behind it, so it keeps going like a streaming service. A "Next Episode" card appears in the last 30 seconds. Your audio and subtitle choice carries over to the next episode. Position is saved continuously, and an episode is marked watched when you finish it (or get within ~6% of the end).

| Control | Mouse | Keyboard |
|---|---|---|
| Play / pause | click video or the play button | Space |
| Skip 10 s | ⟲10 / ⟳10 buttons | ← / → |
| Seek | click or drag the red bar (hover shows time) | |
| Volume | speaker icon / slider | ↑ / ↓, `m` mutes |
| Audio & subtitles | speech-bubble button | `c` (arrows + Enter to pick) |
| Next episode | ⏭ button or the card | `n` or Enter while the card shows |
| Fullscreen | corner-brackets button, double-click | `f` |
| Back to the library | ← arrow, top left | Esc (leaves fullscreen first) |

Pausing for a moment shows the title, episode and synopsis, like Netflix's pause screen. Audio tracks are labelled by what they really are (Dolby Digital, Dolby Digital Plus, TrueHD, Atmos, DTS, DTS-HD MA, DTS:X) with their channel layout.

## Profiles

Netflix-style **"Who's watching?"** (shown at start when there's more than one profile, or a PIN). Each profile has its own Continue Watching, resume points and watched ticks, its own audio/subtitle language, and an optional 4-digit PIN. You enter the PIN on an on-screen number pad, with the remote, a keyboard, or the phone remote's "Type on TV".

- **Kids profiles** only see titles whose embedded rating fits their age: little kids (G, TV-Y, TV-G), older kids (up to PG, TV-Y7, TV-PG) or teens (up to PG-13, TV-14). The rating comes from the iTunes `iTunEXTC` tag (e.g. `mpaa|PG|200|`). Unrated titles are hidden unless the profile allows them. Kids profiles can't change profiles or settings.
- **Managing profiles:** Settings → Profiles: add (up to 8), edit, colour, PIN, delete.
- **Existing watch history** becomes the first profile ("Main").

Works the same on the Mac/Linux app and the Android TV app.

## What's new in 0.4

- **Episode naming:** multi-segment episodes (`S01E02a` / `S01E02b`), double episodes (`S01E03-E04`) and macOS `/` names (stored as `:`) are understood and sorted properly. A folder added twice, or the same episode found in two places, no longer shows up twice.
- **Add media the easy way:** USB drives appear in the library the moment they're plugged in (with Copy to library and Eject), the box shares a `Screenroom` folder on your network (`smb://screenroom.local`), and any phone or computer can upload files or whole folders from the remote page (scan the QR code in Settings → Add media).
- **Crisper menus:** Inter font, unhinted text rendering and font settings for the TV session.

## Dedicated box: automatic installer (ThinkCentre M910q and similar mini PCs)

Every push builds **Screenroom-Installer-<version>.iso** (a Debian 13 installer that sets up Screenroom with no questions) and tests it by installing it in a UEFI virtual machine. Write it to a USB stick, boot the mini PC from it with a network cable plugged in, and it becomes a Screenroom appliance:
- a boot splash,
- Screenroom only,
- Wi-Fi and Bluetooth in Settings,
- automatic security updates,
- one-button app updates,
- a second internal drive used as the library.

See [`deploy/M910Q.md`](deploy/M910Q.md).

## Android TV / Google TV (onn 4K Pro and others)

`android/` is the Android TV version. It shows the same Netflix-style screens (it reuses `renderer/`, `remote/` and `lib/media-core.js`) and plays through Android's own video player (ExoPlayer/Media3) for hardware 4K, HDR, Dolby Vision and Dolby/DTS passthrough. It includes the phone remote, Wi-Fi uploads, USB drives, and an optional **Lock to Screenroom** mode.

- **Building:** every push to `main` builds an APK on GitHub (`.github/workflows/android.yml`) and attaches it to a Release. You can also build locally with Android Studio or `cd android && ./gradlew assembleRelease`.
- **Installing:** see [`android/SETUP.md`](android/SETUP.md). In short: turn on network debugging on the box, then run `bash android/setup-onn.command <box-ip>` on your Mac.

## Use it as a TV box (Linux mini PC)

Screenroom can run as a streaming box with no subscriptions: it boots straight into a full-screen, remote-friendly Screenroom.

- **Setup:** see [`deploy/SETUP.md`](deploy/SETUP.md) (hardware, installing Ubuntu, media on USB/NAS). Then `sudo deploy/install-tv.sh screenroom_0.4.0_<amd64 or arm64>.deb` and reboot.
- **TV mode:** `screenroom --tv` (or Settings → TV mode) goes full screen and scales the interface for the couch.
- **Controls:** TV remote over HDMI-CEC (needs a Pulse-Eight USB-CEC adapter on most mini PCs), keyboard / USB / Bluetooth remote, game controller (D-pad/stick, A, B, Start = settings; in the player A = pause, B = back, Y = audio/subtitles, RB = next episode), and a **phone remote**.
- **Phone remote:** Settings shows an address like `http://192.168.1.20:8686` and a PIN. Open it on a phone on the same network for a D-pad, transport controls, search, and tap-to-play on the TV. Keep it on your home network only.
- **Library updates itself** every 30 minutes and on launch.
- **Not included:** recording live TV (DVR). Screenroom plays files you already have.

## Troubleshooting

- **Nothing happens on Play / a red message appears:** mpv failed to start. Its log is at `<temp folder>/screenroom-mpv.log` (the message gives the exact path).
- **mpv not found:** install it (`brew install mpv`), or set `mpvPath` in `config.json`.
- **Unusual setup (audio device, video output):** put extra mpv options in `mpvArgs` in `config.json`, for example `"mpvArgs": "--audio-device=coreaudio/..."`, or set the `SCREENROOM_MPV_ARGS` environment variable.
- **DTS/Atmos tracks labelled wrongly:** labels come from ffprobe/mpv codec profiles; the mapping is in `audioLabel()` in `lib/library.js` and `codec_label()` in `mpv/netflix.lua`.
- Your own mpv scripts and on-screen controllers are deliberately not loaded (a second OSC would clash). Your `mpv.conf` still applies, with Screenroom's options taking priority.

## Layout

```
main.js            Electron main process (config, library, playlists, watch history)
preload.js         safe bridge to the UI
lib/library.js     ffprobe scan, TV parsing, artwork, cache
lib/player.js      launches mpv, per-file progress tracking over its IPC socket
mpv/netflix.lua    the Netflix-style on-screen player (shipped inside the app)
renderer/          the browse UI (index.html, styles.css, app.js)
build/icon.png     app icon
```
