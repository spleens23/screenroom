#!/usr/bin/env python3
"""
HDMI-CEC remote bridge for Screenroom.

Lets your TV's own remote control Screenroom over the HDMI cable. It listens to `cec-client`
(from the cec-utils package) and turns each remote button press into a normal key press using
uinput, so it works for both Screenroom's menus and the mpv player.

Needs a CEC adapter: a Pulse-Eight USB-CEC adapter, or a computer whose HDMI port supports CEC.
If there isn't one, this exits quietly and everything else still works (use the phone remote,
a keyboard, a USB/Bluetooth remote or a game controller instead).
"""
import re
import shutil
import subprocess
import sys
import time

try:
    from evdev import UInput, ecodes as e
except ImportError:
    sys.exit("screenroom-cec: python3-evdev is not installed")

# CEC button name (as libcec prints it) -> Linux key
KEYS = {
    "up": e.KEY_UP, "down": e.KEY_DOWN, "left": e.KEY_LEFT, "right": e.KEY_RIGHT,
    "select": e.KEY_ENTER, "enter": e.KEY_ENTER,
    "exit": e.KEY_ESC, "return": e.KEY_ESC, "back": e.KEY_ESC,
    "root menu": e.KEY_HOMEPAGE, "contents menu": e.KEY_HOMEPAGE, "favorite menu": e.KEY_HOMEPAGE,
    "setup menu": e.KEY_F1, "display information": e.KEY_F1, "help": e.KEY_F1,
    "play": e.KEY_PLAYPAUSE, "pause": e.KEY_PLAYPAUSE, "play function": e.KEY_PLAYPAUSE,
    "pause-play function": e.KEY_PLAYPAUSE,
    "stop": e.KEY_STOPCD, "stop function": e.KEY_STOPCD,
    "fast forward": e.KEY_FASTFORWARD, "forward": e.KEY_FASTFORWARD,
    "rewind": e.KEY_REWIND, "backward": e.KEY_REWIND,
    "channel up": e.KEY_NEXTSONG, "next favorite": e.KEY_NEXTSONG,
    "channel down": e.KEY_PREVIOUSSONG, "previous channel": e.KEY_PREVIOUSSONG,
    "page up": e.KEY_PAGEUP, "page down": e.KEY_PAGEDOWN,
    "mute": e.KEY_MUTE,
}

PRESS = re.compile(r"key pressed: ([a-z0-9 \-()]+?) \([0-9a-f]+\)", re.IGNORECASE)


def run_once(ui):
    cmd = ["cec-client", "-t", "p", "-o", "Screenroom", "-d", "31"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    started = time.time()
    try:
        for line in proc.stdout:
            if "no adapter found" in line.lower() or "could not open" in line.lower():
                print("screenroom-cec: no CEC adapter found", flush=True)
            m = PRESS.search(line)
            if not m:
                continue
            key = KEYS.get(m.group(1).strip().lower())
            if key is None:
                continue
            # a tap: the remote repeats the "pressed" line while a button is held
            ui.write(e.EV_KEY, key, 1)
            ui.syn()
            ui.write(e.EV_KEY, key, 0)
            ui.syn()
    finally:
        proc.terminate()
    return time.time() - started


def main():
    if not shutil.which("cec-client"):
        sys.exit("screenroom-cec: cec-client not installed (apt install cec-utils)")
    caps = {e.EV_KEY: sorted(set(KEYS.values()))}
    ui = UInput(caps, name="Screenroom CEC remote")
    while True:
        lived = run_once(ui)
        # No adapter (or it unplugged): wait longer before retrying so we don't spin.
        time.sleep(5 if lived > 60 else 60)


if __name__ == "__main__":
    main()
