# Screenroom TV box: setup guide

Goal: a small PC behind your TV that boots straight into Screenroom and plays your own files. No subscriptions, no accounts, nothing leaves your network.

Not included: live-TV recording (DVR). Screenroom plays files you already have. If you want to record broadcast TV later, a tuner plus a tool like Tvheadend can save recordings into a folder, and Screenroom will show them like any other video.

## 1. Hardware

- **Mini PC:** any Intel N100 / N150 / N305-class box (or a newer Intel/AMD mini PC) with 8 GB RAM and a 128 GB+ SSD. These decode 4K H.265 in hardware and use very little power. A HDMI 2.0 port is needed for 4K at 60 Hz.
- **Storage for movies:** a USB hard drive, or a NAS on your network.
- **TV remote over HDMI-CEC:** most mini PCs cannot send/receive CEC on their own HDMI port. Buy a **Pulse-Eight USB-CEC Adapter** (about $50) and put it between the PC and the TV. Without it you can still use:
  - the **phone remote** (works on any phone's browser),
  - a **keyboard**, a USB/Bluetooth/2.4 GHz air-mouse remote (e.g. a cheap "Fire-TV style" USB remote),
  - an **Xbox/PlayStation/8BitDo controller** (USB or Bluetooth).
- **Sound:** to send Dolby/DTS untouched to a receiver or soundbar, connect the PC to it by HDMI (through the receiver to the TV, or use the TV's eARC).

## 2. Install Ubuntu

Use **Ubuntu Server 24.04 LTS** (or Ubuntu Desktop 24.04, either works).

1. On another computer, download Ubuntu from ubuntu.com and write it to a USB stick with **balenaEtcher**.
2. Plug the stick into the mini PC, power on, and tap F2/F7/F10/Del (varies by brand) to pick the USB stick as the boot device.
3. Follow the installer. Choose "Install Ubuntu Server", accept defaults, tick **Install OpenSSH server** (handy for later), and create your own admin user (this is *not* the TV user).
4. Reboot, remove the stick, and log in.

## 3. Get Screenroom onto the box

On the Mac or PC where you built it, create the Linux package:

```
npm install
npm run dist:linux        # makes dist/screenroom_0.4.0_<arch>.deb
```

Copy the `.deb` and this `deploy` folder to the mini PC, for example:

```
scp dist/screenroom_*_amd64.deb deploy/* you@mini-pc.local:~/
```

## 4. Run the installer

```
chmod +x install-tv.sh
sudo ./install-tv.sh screenroom_0.4.0_<arch>.deb
sudo reboot
```

The installer sets up a graphical session, a `tv` user that logs in automatically, the CEC remote bridge, and Screenroom in TV mode. After the reboot the box goes straight to Screenroom.

## 5. First run

1. Open **Settings** (phone remote → Settings, keyboard F1/right-click key, controller Start, or the remote's setup/menu button).
2. **Add folder…** and pick your movies/TV folder. Library updates itself every 30 minutes and whenever you open the app.
3. Under **Audio output**, pick your HDMI device. Turn on **Passthrough** if your receiver supports Dolby/DTS and you want it to decode them.
4. Settings also shows the **phone remote address and PIN**. Open the address on your phone while on the same Wi-Fi, enter the PIN, and add it to your home screen.

## 6. Getting your movies and shows onto the box

Pick whichever is easiest. They all end up in your Screenroom library.

**A. Plug in a USB drive or SSD (nothing to set up).** The drive mounts by itself and its movies and shows appear in your library while it's plugged in. Open **Settings → Add media** to see it. **Copy to library** puts a copy on the box so you can unplug the drive, and **Eject** lets you remove it safely. Drives formatted exFAT, NTFS, FAT32, ext4 and HFS+ work. APFS (Mac-only) drives do not.

**B. Drag files in from your computer over Wi-Fi.** The box shows up on your network as `screenroom`.
- **Mac:** Finder → Go → Connect to Server → `smb://screenroom.local` → Connect (choose Guest). Drag folders in like any other disk.
- **Windows:** in File Explorer's address bar type `\\screenroom` (or `\\screenroom.local`).
- Works without a password, but only from inside your home network.

**C. Upload from a phone, tablet or any browser.** In **Settings → Add media**, scan the QR code (or open the address shown). Tap the **Add media** tab, then **Choose files** or **Choose a folder**. On a computer you can drag a whole folder onto the page. Uploads show progress, resume on already-sent files, and the library updates when they finish.

Everything from B and C is stored in `/srv/media` (change it with `SCREENROOM_MEDIA=/path` when running the installer, or edit `mediaDir` in the config).

**D. A NAS or an always-on drive.** If your media already lives on a NAS, mount it and add the folder in **Settings → Add folder…**. Example `/etc/fstab` lines:

NFS: `nas.local:/volume1/video  /media/nas  nfs  ro,nofail,_netdev,x-systemd.automount  0  0`

SMB: `//nas.local/video  /media/nas  cifs  ro,guest,nofail,_netdev,x-systemd.automount,uid=1001,gid=1001  0  0`

Then `sudo mkdir -p /media/nas && sudo mount -a`.

### File names

```
Movie Name (2020).mp4
Show Name/Season 1/S01E01 Episode Name.mp4
Show Name/Season 1/S01E02a First Segment.mp4      (two-part episodes: a / b)
Show Name/Season 1/S01E03-E04 Double Episode.mp4
```
A "/" in a name (for example "Help Wanted/Reef Blower") is saved as ":" by macOS and shown as " / " in Screenroom. If the same episode exists twice, the better-quality copy is shown and Settings tells you how many were hidden.

## 7. Controls

| Input | In menus | While playing |
|---|---|---|
| TV remote (CEC) | arrows, OK, Back/Exit, Menu = home | OK = pause, arrows = seek/volume, Play/Pause, Stop, FF/Rew |
| Keyboard | arrows, Enter, Esc/Backspace, `/` search | Space, arrows, Enter, Esc |
| Game controller | D-pad/stick, A, B, Start = settings | A = pause, B = back, Y = audio/subtitles, RB = next episode |
| Phone | D-pad page with search and library tab | transport, volume, audio/subtitle buttons |

## 8. Good to know

- **HDR:** on Linux with X11, HDR video is tone-mapped to SDR, which looks fine but is not true HDR output. Dolby Vision plays as HDR10.
- **Passthrough:** bitstreaming Dolby/DTS needs plain ALSA audio, which the installer uses (no PipeWire/PulseAudio). Atmos (TrueHD) and DTS-HD passthrough also depends on your receiver and the HDMI link.
- **Phone remote security:** it is reachable by anyone on your home network who has the PIN. Do not forward port 8686 on your router.
- **Updating:** install a newer `.deb` with `sudo ./install-tv.sh newer.deb` and reboot.
- **Sharper text:** on a real screen the menus should be crisp. In a virtual machine they can look soft because the VM draws at a lower resolution and the host scales it up. In UTM, edit the VM → Display → turn on **Retina Mode** (or pick the native resolution) to fix it.
- **Troubleshooting:** the player log is at `/tmp/screenroom-mpv.log`; the CEC bridge log is `/tmp/screenroom-cec.log`. `cec-client -l` lists CEC adapters. `mpv --audio-device=help` lists audio outputs.
- **Getting a normal desktop back:** press Ctrl+Alt+F3 for a text login, or choose Quit in Settings.
