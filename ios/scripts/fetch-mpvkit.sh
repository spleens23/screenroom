#!/usr/bin/env bash
# Downloads mpv's engine and FFmpeg for iOS (MPVKit's LGPL build, https://github.com/mpvkit/MPVKit) into
# ios/vendor/mpvkit/*.xcframework and lists them in project.yml. They're linked into the app directly (static
# libraries stay inside the app's own code; any dynamic one is copied in and signed), instead of through Swift
# Package Manager, which shipped them as unsigned framework folders that App Store Connect rejected.
# Run on the build Mac before generating the project.
set -euo pipefail
IOS="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$IOS/vendor/mpvkit"
REV="${MPVKIT_REVISION:-98c3453e252922e3136422da3fbb2e341ed9edc8}" # 1.1.0-n9.0.2
LIBS="Libmpv Libavcodec Libavdevice Libavformat Libavfilter Libavutil Libswresample Libswscale Libcrypto Libssl gmp nettle hogweed gnutls Libunibreak Libfreetype Libfribidi Libharfbuzz Libass Libbluray Libuavs3d Libdovi MoltenVK Libshaderc_combined lcms2 Libplacebo Libdav1d Libuchardet"
mkdir -p "$OUT"
curl -fsSL "https://raw.githubusercontent.com/mpvkit/MPVKit/$REV/Package.swift" -o "$OUT/Package.swift"
python3 - "$OUT/Package.swift" $LIBS > "$OUT/list.txt" <<'PY'
import re, sys
s = open(sys.argv[1]).read()
want = sys.argv[2:]
found = {m.group(1): (m.group(2), m.group(3)) for m in re.finditer(r'\.binaryTarget\(\s*name:\s*"([^"]+)",\s*url:\s*"([^"]+)",\s*checksum:\s*"([^"]+)"', s)}
for n in want:
    if n not in found: sys.exit(f"{n} not in MPVKit's Package.swift")
    print(n, *found[n])
PY
while read -r name url sum; do
  if [ -d "$OUT/$name.xcframework" ]; then continue; fi
  TMP="$(mktemp -d)"
  curl -fsSL "$url" -o "$TMP/x.zip"
  echo "$sum  $TMP/x.zip" | shasum -a 256 -c - >/dev/null
  unzip -q "$TMP/x.zip" -d "$TMP/u"
  X="$(find "$TMP/u" -maxdepth 2 -name "$name.xcframework" -type d | head -1)"
  [ -n "$X" ] || { echo "$name.xcframework missing in $url"; exit 1; }
  mv "$X" "$OUT/"
  rm -rf "$TMP"
done < "$OUT/list.txt"
# list them in project.yml: static ones linked only, dynamic ones copied into the app and signed
ENTRIES=""
while read -r name url sum; do
  BIN="$(find "$OUT/$name.xcframework" -path '*ios-arm64/*' -type f \( -name "$name" -o -name "*.a" \) | head -1)"
  if [ -n "$BIN" ] && file "$BIN" | grep -q "dynamically linked"; then EMBED=true; else EMBED=false; fi
  echo "$name: $EMBED ($(file -b "$BIN" | head -c 80))"
  ENTRIES="$ENTRIES      - framework: vendor/mpvkit/$name.xcframework\n        embed: $EMBED\n"
done < "$OUT/list.txt"
python3 - "$IOS/project.yml" "$ENTRIES" <<'PY'
import sys
p, entries = sys.argv[1], sys.argv[2].replace('\\n', '\n')
s = open(p).read()
mark = '      # MPVKIT_FRAMEWORKS\n'
assert mark in s, 'project.yml: MPVKIT_FRAMEWORKS marker missing'
open(p, 'w').write(s.replace(mark, entries))
PY
