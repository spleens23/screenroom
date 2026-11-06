#!/usr/bin/env bash
# Archives one app (Screenroom or Parlor), signs it for the App Store with Apple's cloud-managed certificate and
# uploads it to App Store Connect (TestFlight). Run from ios/ after `xcodegen generate`, with KEY (the App Store
# Connect key file), ASC_KEY_ID, ASC_ISSUER_ID, TEAM_ID and BUILD (the build number) set.
# Notes go to ../shots/testflight-<scheme>-*.txt. Exits non-zero if the upload didn't go through.
set -o pipefail
S="$1"
L="$(echo "$S" | tr '[:upper:]' '[:lower:]')"
mkdir -p ../shots
AUTH=(-allowProvisioningUpdates -authenticationKeyPath "$KEY" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")
# The archive is built unsigned: signing it for development would need a registered device. The export signs it.
xcodebuild -project Screenroom.xcodeproj -scheme "$S" -configuration Release -destination 'generic/platform=iOS' \
  -archivePath "build/$S.xcarchive" DEVELOPMENT_TEAM="$TEAM_ID" CURRENT_PROJECT_VERSION="$BUILD" \
  CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY="" CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=NO \
  archive 2>&1 | tee "archive-$L.log" | grep -E "error:|ARCHIVE (SUCCEEDED|FAILED)" || true
if ! grep -q "ARCHIVE SUCCEEDED" "archive-$L.log"; then
  { grep -E "error:" -B2 -A3 "archive-$L.log" | head -100; tail -30 "archive-$L.log"; } > "../shots/testflight-$L-errors.txt"; exit 1
fi
# mpv's libraries are built into the app; any empty framework folder Xcode copies in would be rejected as unsigned
APPDIR="$(find "build/$S.xcarchive/Products" -maxdepth 3 -name '*.app' -type d | head -1)"
for f in "$APPDIR"/Frameworks/*.framework; do
  [ -d "$f" ] || continue
  file -b "$f/$(basename "$f" .framework)" 2>/dev/null | grep -q "dynamically linked" || rm -rf "$f"
done
sed "s/TEAM_ID_HERE/$TEAM_ID/" ExportOptions.plist > build/ExportOptions.plist
xcodebuild -exportArchive -archivePath "build/$S.xcarchive" -exportOptionsPlist build/ExportOptions.plist \
  -exportPath "build/export-$L" "${AUTH[@]}" > "export-$L.log" 2>&1 || true
cp "export-$L.log" "../shots/testflight-$L-export.log"
tail -20 "export-$L.log"
if grep -q "EXPORT SUCCEEDED" "export-$L.log" && ! grep -qiE "EXPORT FAILED|Upload failed|Validation failed" "export-$L.log"; then
  echo "::notice title=TestFlight::$S build $BUILD sent to App Store Connect. It shows up in TestFlight once Apple has processed it (usually 10–30 minutes)."
  rm -f "../shots/testflight-$L-errors.txt"
  exit 0
fi
{ grep -iE "error|fail" "export-$L.log" | head -40; echo ----; tail -80 "export-$L.log"; } > "../shots/testflight-$L-errors.txt"
exit 1
