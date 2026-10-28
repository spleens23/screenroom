#!/usr/bin/env bash
# Copies the desktop app's screens into the iPad app (ios/Web), with the iPad's window.api (ios-api.js)
# in place of the desktop's. Run from anywhere; the build workflow runs it before building.
set -euo pipefail
IOS="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$IOS/.." && pwd)"
OUT="$IOS/Web"
rm -rf "$OUT"
mkdir -p "$OUT/lib" "$OUT/ios"
cp -R "$ROOT/renderer" "$OUT/renderer"
cp "$ROOT/lib/media-core.js" "$OUT/lib/"
cp "$IOS/web/ios-api.js" "$IOS/web/ios.css" "$OUT/ios/"
python3 - "$OUT/renderer/index.html" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
s = s.replace('<meta name="viewport" content="width=device-width, initial-scale=1">',
              '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">')
s = s.replace('<link rel="stylesheet" href="theme-heirloom.css">',
              '<link rel="stylesheet" href="theme-heirloom.css">\n<link rel="stylesheet" href="../ios/ios.css">')
s = s.replace('<script src="../lib/media-core.js"></script>',
              '<script src="../lib/media-core.js"></script>\n<script src="../ios/ios-api.js"></script>')
assert 'ios-api.js' in s and 'ios.css' in s, 'index.html changed: update prepare-web.sh'
open(p, 'w', encoding='utf-8').write(s)
PY
echo "Web screens ready in $OUT"
