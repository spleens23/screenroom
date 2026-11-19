#!/usr/bin/env python3
"""
Screenroom: the computer's own buttons (power button, a laptop's brightness keys).

Started by the Screenroom app on the TV box / laptop. Watches every keyboard-like input device (the power
button, the laptop keyboard, USB / Bluetooth remotes) and prints one line per press for the app:
    power            the power button (the app shows its Sleep / Restart / Turn off menu)
    brightness_up    a brightness key
    brightness_down
While a DVD plays (the app writes "nav on" / "nav off" on this helper's input), the remote's other buttons too,
as "key <name>" (up, down, left, right, ok, back, home, menu, info, playpause, stop, next, prev, ffwd, rew,
audio, subtitle, eject), so the DVD player can be worked with the same remote.
The keys still reach everything else as usual; nothing is grabbed. Exits when the app goes away.
"""
import os
import select
import sys
import time

try:
    from evdev import InputDevice, ecodes as e, list_devices
except ImportError:
    sys.exit("screenroom-keys: python3-evdev is not installed")

WANT = {
    e.KEY_POWER: "power",
    e.KEY_BRIGHTNESSUP: "brightness_up",
    e.KEY_BRIGHTNESSDOWN: "brightness_down",
}
REPEATS = {"brightness_up", "brightness_down"}  # held down: keep stepping

NAV = {}
for name, codes in {
    "up": ["KEY_UP"], "down": ["KEY_DOWN"], "left": ["KEY_LEFT"], "right": ["KEY_RIGHT"],
    "ok": ["KEY_ENTER", "KEY_KPENTER", "KEY_SELECT", "KEY_OK"],
    "back": ["KEY_ESC", "KEY_BACK", "KEY_BACKSPACE", "KEY_EXIT"],
    "home": ["KEY_HOMEPAGE", "KEY_HOME"],
    "menu": ["KEY_MENU", "KEY_COMPOSE", "KEY_CONTEXT_MENU", "KEY_ROOT_MENU", "KEY_DVD", "KEY_TITLE"],
    "info": ["KEY_F1", "KEY_INFO", "KEY_PROGRAM"],
    "playpause": ["KEY_PLAYPAUSE", "KEY_PLAY", "KEY_PAUSE", "KEY_PLAYCD", "KEY_PAUSECD", "KEY_SPACE"],
    "stop": ["KEY_STOPCD", "KEY_STOP"],
    "next": ["KEY_NEXTSONG", "KEY_NEXT"], "prev": ["KEY_PREVIOUSSONG", "KEY_PREVIOUS"],
    "ffwd": ["KEY_FASTFORWARD", "KEY_FORWARD"], "rew": ["KEY_REWIND"],
    "audio": ["KEY_LANGUAGE", "KEY_AUDIO"], "subtitle": ["KEY_SUBTITLE"],
    "eject": ["KEY_EJECTCD", "KEY_EJECTCLOSECD"],
    "volup": ["KEY_VOLUMEUP"], "voldown": ["KEY_VOLUMEDOWN"],
}.items():
    for c in codes:
        if hasattr(e, c):
            NAV[getattr(e, c)] = name
NAV_REPEATS = {"up", "down", "left", "right", "ffwd", "rew", "volup", "voldown"}
nav_on = False


def say(word):
    try:
        sys.stdout.write(word + "\n")
        sys.stdout.flush()
    except BrokenPipeError:
        sys.exit(0)


def scan(open_devs):
    for path in list_devices():
        if path in open_devs:
            continue
        try:
            d = InputDevice(path)
            keys = set(d.capabilities().get(e.EV_KEY, []))
        except OSError:
            continue
        if keys & (set(WANT) | set(NAV)):
            open_devs[path] = d
        else:
            d.close()


def main():
    devs = {}
    scan(devs)
    last_scan = time.time()
    parent = os.getppid()
    global nav_on
    stdin_open = True
    while True:
        if os.getppid() != parent:  # the app is gone
            return
        if time.time() - last_scan > 3:  # a remote / keyboard plugged in or connected later
            scan(devs)
            last_scan = time.time()
        if not devs:
            time.sleep(1)
            continue
        try:
            ready, _, _ = select.select(list(devs.values()) + ([sys.stdin] if stdin_open else []), [], [], 1.0)
        except (OSError, ValueError):
            ready = []
            for p, d in list(devs.items()):
                try:
                    d.fileno()
                except Exception:
                    devs.pop(p, None)
        for d in ready:
            if d is sys.stdin:
                line = sys.stdin.readline()
                if not line:
                    stdin_open = False
                elif line.strip() in ("nav on", "nav off"):
                    nav_on = line.strip() == "nav on"
                continue
            try:
                for ev in d.read():
                    if ev.type != e.EV_KEY:
                        continue
                    if ev.code in WANT:
                        word = WANT[ev.code]
                        if ev.value == 1 or (ev.value == 2 and word in REPEATS):
                            say(word)
                    elif nav_on and ev.code in NAV:
                        word = NAV[ev.code]
                        if ev.value == 1 or (ev.value == 2 and word in NAV_REPEATS):
                            say("key " + word)
            except OSError:  # unplugged
                devs.pop(d.path, None)
                try:
                    d.close()
                except Exception:
                    pass


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
