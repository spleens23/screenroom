# Screenroom on an onn 4K Pro (Android TV / Google TV)

Screenroom runs as an app on the box's own Android system: no wiping, no subscriptions. It uses the box's hardware for 4K H.265 / H.264, HDR and Dolby Vision, and sends Dolby / DTS to your receiver or soundbar when it supports them.

## 1. Get the app (the APK)

Every change pushed to your GitHub repository builds a new APK automatically.

1. Open your repository on github.com and click **Releases** (right-hand side).
2. Download the newest **Screenroom-<number>.apk** on your Mac (it goes to Downloads).

## 2. Prepare the box (once)

1. **Developer options:** Settings → System → About → click **Android TV OS build** 7 times until it says you're a developer.
2. **Debugging:** Settings → System → Developer options → turn on **USB debugging** and **Network debugging** (on some versions it's called **Wireless debugging**).
3. **The box's address:** Settings → Network & Internet → your Wi-Fi network. Note the IP address (for example `192.168.1.50`).

### Want the lock? Set the box up without a Google account

"Lock to Screenroom" (only Screenroom and Settings can be used, and Home always comes back to Screenroom) needs the box to have **no accounts**. If the box is already signed in to Google:

1. Settings → System → About → **Reset** (this erases the box).
2. During setup choose **Set up basic TV** (or skip signing in). You won't have the Play Store, but Screenroom doesn't need it.
3. Repeat steps 1–3 above.

## 3. Install from your Mac

In Terminal, from the unzipped Screenroom folder:

```
bash android/setup-onn.command 192.168.1.50
```

Or, to also allow the lock:

```
bash android/setup-onn.command 192.168.1.50 --lock
```

The script installs Android's `adb` tool with Homebrew if needed, connects to the box over Wi-Fi, installs the newest APK from your Downloads folder, gives Screenroom access to your files and USB drives, and opens it. **Watch the TV:** the first time it asks "Allow network debugging?" Choose **Always allow**.

To update later, download the new APK and run the same command again. Your library, watch progress and settings are kept.

## 4. Lock it (optional)

In Screenroom: **Settings → Lock to Screenroom**, type a 4–8 digit PIN, then choose **Lock**.

- Home on the remote always returns to Screenroom, including after a restart.
- Other apps (YouTube, Netflix, the Play Store, …) are paused. They stay installed but can't open. The remote's app buttons do nothing.
- Android's **Settings** still work (Wi-Fi, picture, sound, updates). Open them from Screenroom's Settings → **This box**.
- To undo, go to Settings → Lock to Screenroom, enter your PIN, then **Unlock**. **Release control** then turns Screenroom back into an ordinary app you can uninstall.
- If you ever forget the PIN, a factory reset always returns the box to normal.

## 5. Adding movies and shows

- **USB drive or SSD:** plug it into the box's USB port. Its videos join the library while it's plugged in. Settings → Add media → **Copy to library** copies them onto the box (it has about 20 GB free). exFAT, FAT32 and NTFS drives work. Mac-only APFS / HFS+ drives don't.
- **From a phone or computer over Wi-Fi:** Settings → Add media shows a QR code. Scan it (it logs in automatically), tap **Add media**, and pick files or a whole folder.
- Uploads are saved in the box's `Screenroom` folder.

Use the same names as on the desktop: `Show/Season 1/S01E01 Name.mp4`, with `S01E02a` / `S01E02b` for two-part episodes and `S01E03-E04` for double episodes.

## Controls (onn remote)

| Where | Button | Does |
|---|---|---|
| Browsing | arrows / OK | move / open |
| Browsing | Back | close, then go Home; leaves the app from Home (unless locked) |
| Browsing | Menu (≡) | Settings |
| Playing | OK | pause / play, or start the next episode when its card shows |
| Playing | ◀ ▶ | back / forward 10 seconds |
| Playing | ▲ ▼ | show the controls (Audio & Subtitles, Next Episode) |
| Playing | Back | hide the controls, then stop |

Game controllers work too: A = OK, B = Back, Y = audio & subtitles, RB = next episode.

## Good to know

- **Audio:** Android decides passthrough by itself, based on what your TV or receiver reports over HDMI. If Dolby / DTS is silent, check Settings → Display & Sound → Audio output (**Auto** is usually right). The onn supports Dolby Atmos. DTS depends on the box's audio settings and your receiver.
- **Phone remote:** works the same as on the desktop version. The address and PIN are in Settings.
- **Network:** the box's Ethernet port is only 100 Mbps. That's fine for most files, but very high-bitrate 4K may play more smoothly over Wi-Fi 6.
