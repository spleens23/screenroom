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
cp "$IOS/support/ios-api.js" "$IOS/support/ios.css" "$OUT/ios/"
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
# Each script runs inside try/catch: a script loaded from a file only reports "Script error." to the page, so
# catching its exception here is what gets the real message (shown on screen and logged by the app).
python3 - "$OUT" <<'PY'
import sys, os
out = sys.argv[1]
for rel in ['lib/media-core.js', 'ios/ios-api.js', 'renderer/avatars.js', 'renderer/parlor.js', 'renderer/app.js']:
    p = os.path.join(out, rel)
    s = open(p, encoding='utf-8').read()
    name = os.path.basename(rel)
    s = ('try {\n' + s + '\n} catch (e) {\n'
         '  const m = "' + name + ': " + (e && e.message ? e.message : e) + (e && e.stack ? "\\n" + e.stack : "");\n'
         '  if (window.__iosReport) window.__iosReport(m); else setTimeout(() => window.__iosReport && window.__iosReport(m), 0);\n'
         '  throw e;\n}\n')
    open(p, 'w', encoding='utf-8').write(s)
PY
echo "Web screens ready in $OUT"
