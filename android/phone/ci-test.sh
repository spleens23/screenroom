#!/usr/bin/env bash
# Both phone apps in one emulated phone (the build workflow runs this): Parlor, then Screenroom.
B=android/phone/build/outputs/apk
bash android/phone/ci-test-parlor.sh "$B/parlor/debug/phone-parlor-debug.apk"
bash android/phone/ci-test-screenroom.sh "$B/screenroom/debug/phone-screenroom-debug.apk"
