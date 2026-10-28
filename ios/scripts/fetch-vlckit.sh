#!/usr/bin/env bash
# Downloads VLC's playback engine for iOS (MobileVLCKit, LGPL 2.1, the official build VideoLAN publishes for
# CocoaPods) into ios/vendor/MobileVLCKit.xcframework. Screenroom uses it for films Apple's player can't play
# (DTS / TrueHD sound, MKV and other containers). Run on the build Mac before generating the project.
set -euo pipefail
IOS="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$IOS/vendor"
mkdir -p "$OUT"
if [ -d "$OUT/MobileVLCKit.xcframework" ]; then echo "MobileVLCKit already here"; exit 0; fi
# the newest 3.x release listed in the CocoaPods index (shard b/f/7 = md5("MobileVLCKit"))
VER="${VLCKIT_VERSION:-$(curl -fsSL https://cdn.cocoapods.org/all_pods_versions_b_f_7.txt | grep '^MobileVLCKit/' | tr '/' '\n' | tail -n +2 | grep -E '^3\.[0-9]+\.[0-9]+$' | sort -V | tail -1)}"
echo "MobileVLCKit $VER"
SPEC="$(curl -fsSL "https://cdn.cocoapods.org/Specs/b/f/7/MobileVLCKit/$VER/MobileVLCKit.podspec.json")"
URL="$(printf '%s' "$SPEC" | python3 -c 'import json,sys; s=json.load(sys.stdin); print(s["source"]["http"])')"
printf '%s' "$SPEC" | python3 -c 'import json,sys; s=json.load(sys.stdin); print("frameworks:", s.get("frameworks")); print("libraries:", s.get("libraries")); print("vendored:", s.get("vendored_frameworks"))'
TMP="$(mktemp -d)"
curl -fsSL "$URL" -o "$TMP/vlc.tar.xz"
tar -xf "$TMP/vlc.tar.xz" -C "$TMP"
X="$(find "$TMP" -name 'MobileVLCKit.xcframework' -maxdepth 4 -type d | head -1)"
[ -n "$X" ] || { echo "MobileVLCKit.xcframework not found in $URL"; find "$TMP" -maxdepth 3; exit 1; }
mv "$X" "$OUT/"
find "$TMP" -maxdepth 3 -iname 'COPYING*' -exec cp {} "$OUT/MobileVLCKit-COPYING.txt" \; || true
echo "$VER" > "$OUT/MobileVLCKit-version.txt"
BIN="$(find "$OUT/MobileVLCKit.xcframework" -name MobileVLCKit -type f | head -1)"; ls "$OUT/MobileVLCKit.xcframework"
file "$BIN" || true
rm -rf "$TMP"
