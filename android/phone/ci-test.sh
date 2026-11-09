#!/usr/bin/env bash
# Both phone apps in one emulated phone (the build workflow runs this): Parlor, then Screenroom.
B=android/phone/build/outputs/apk
timeout 900 bash android/phone/ci-test-parlor.sh "$B/parlor/debug/phone-parlor-debug.apk"
# (the emulated phone back on its feet if Parlor's test left it in a bad way)
timeout 120 adb wait-for-device
timeout 900 bash android/phone/ci-test-screenroom.sh "$B/screenroom/debug/phone-screenroom-debug.apk"
