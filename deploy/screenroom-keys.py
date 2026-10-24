#!/usr/bin/env python3
"""
Screenroom: the computer's own buttons (power button, a laptop's brightness keys).

Started by the Screenroom app on the TV box / laptop. Watches every keyboard-like input device (the power
button, the laptop keyboard, USB / Bluetooth remotes) and prints one line per press for the app:
    power            the power button (the app shows its Sleep / Restart / Turn off menu)
    brightness_up    a brightness key
    brightness_down
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
        if keys & set(WANT):
            open_devs[path] = d
        else:
            d.close()


def main():
    devs = {}
    scan(devs)
    last_scan = time.time()
    parent = os.getppid()
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
            ready, _, _ = select.select(list(devs.values()), [], [], 1.0)
        except (OSError, ValueError):
            ready = []
            for p, d in list(devs.items()):
                try:
                    d.fileno()
                except Exception:
                    devs.pop(p, None)
        for d in ready:
            try:
                for ev in d.read():
                    if ev.type != e.EV_KEY or ev.code not in WANT:
                        continue
                    word = WANT[ev.code]
                    if ev.value == 1 or (ev.value == 2 and word in REPEATS):
                        say(word)
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
