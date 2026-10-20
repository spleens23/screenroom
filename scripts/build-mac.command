#!/bin/bash
# Build Screenroom as a Mac app and put it in /Applications.
# Run it from Terminal:   bash scripts/build-mac.command
# (It can also be double-clicked, but macOS may ask you to right-click > Open the first time.)

cd "$(dirname "$0")/.." || exit 1
set -e

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

if [ "$(uname)" != "Darwin" ]; then
  echo "This script is for a Mac. On Linux use:  npm run dist:linux"; exit 1
fi

# Homebrew (the Mac package manager) is needed for mpv, ffmpeg and node.
for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && eval "$($b shellenv)"; done
if ! command -v brew >/dev/null; then
  echo "Homebrew isn't installed. Install it first by pasting the command from https://brew.sh into Terminal,"
  echo "then run this script again."
  exit 1
fi

say "Installing node, mpv and ffmpeg (skips anything you already have)"
for pkg in node mpv ffmpeg; do
  brew list "$pkg" >/dev/null 2>&1 || brew install "$pkg"
done

say "Installing app dependencies"
npm install

say "Building the app (a few minutes)"
npm run dist:mac

APP="$(ls -d dist/mac-arm64/Screenroom.app dist/mac/Screenroom.app 2>/dev/null | head -1 || true)"
if [ -z "$APP" ]; then echo "The build finished but I couldn't find Screenroom.app in dist/."; exit 1; fi

say "Installing to /Applications"
rm -rf /Applications/Screenroom.app
cp -R "$APP" /Applications/Screenroom.app
xattr -dr com.apple.quarantine /Applications/Screenroom.app 2>/dev/null || true

say "Done. Opening Screenroom"
open /Applications/Screenroom.app
echo
echo "Screenroom is in your Applications folder. Add your movie folders in Settings (the gear icon)."
echo "A disk image (.dmg) is also in the dist folder if you want to move it to another Mac."
