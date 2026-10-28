#!/usr/bin/env bash
# Downloads VLC's playback engine for iOS (VLCKit 4, LGPL 2.1, the official build VideoLAN publishes for
# CocoaPods) into ios/vendor/VLCKit.xcframework. Screenroom uses it for films Apple's player can't play
# (DTS / TrueHD sound, TrueHD inside an MP4, MKV and other containers). Run on the build Mac before generating
# the project. VLCKit 3 couldn't decode TrueHD stored in an MP4 ('mlpa'); VLC 4 can.
set -euo pipefail
IOS="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$IOS/vendor"
mkdir -p "$OUT"
if [ -d "$OUT/VLCKit.xcframework" ]; then echo "VLCKit already here: $(cat "$OUT/VLCKit-version.txt" 2>/dev/null)"; exit 0; fi
VER="${VLCKIT_VERSION:-4.0.0a25}"
echo "VLCKit $VER"
# shard 5/f/4 = md5("VLCKit")
SPEC="$(curl -fsSL "https://cdn.cocoapods.org/Specs/5/f/4/VLCKit/$VER/VLCKit.podspec.json")"
URL="$(printf '%s' "$SPEC" | python3 -c 'import json,sys; s=json.load(sys.stdin); print(s["source"]["http"])')"
SUM="$(printf '%s' "$SPEC" | python3 -c 'import json,sys; s=json.load(sys.stdin); print(s["source"].get("sha256",""))')"
printf '%s' "$SPEC" | python3 -c 'import json,sys; s=json.load(sys.stdin); print("frameworks:", s.get("frameworks")); print("libraries:", s.get("libraries")); print("vendored:", s.get("vendored_frameworks"))'
TMP="$(mktemp -d)"
NAME="$(basename "$URL")"
curl -fsSL "$URL" -o "$TMP/$NAME"
if [ -n "$SUM" ]; then echo "$SUM  $TMP/$NAME" | shasum -a 256 -c -; fi
mkdir "$TMP/x"
case "$NAME" in
  *.zip) unzip -q "$TMP/$NAME" -d "$TMP/x" ;;
  *) tar -xf "$TMP/$NAME" -C "$TMP/x" ;;
esac
X="$(find "$TMP/x" -name 'VLCKit.xcframework' -maxdepth 4 -type d | head -1)"
[ -n "$X" ] || { echo "VLCKit.xcframework not found in $URL"; find "$TMP/x" -maxdepth 3; exit 1; }
mv "$X" "$OUT/"
find "$TMP/x" -maxdepth 3 -iname 'COPYING*' -exec cp {} "$OUT/VLCKit-COPYING.txt" \; || true
echo "$VER" > "$OUT/VLCKit-version.txt"
ls "$OUT/VLCKit.xcframework"
BIN="$(find "$OUT/VLCKit.xcframework" -path '*ios-arm64/*' -name VLCKit -type f | head -1)"
file "$BIN" || true
rm -rf "$TMP"
