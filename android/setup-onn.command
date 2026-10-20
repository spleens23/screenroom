#!/bin/bash
# Install Screenroom on an onn 4K Pro (or any Android TV / Google TV box) from your Mac, over Wi-Fi.
#
#   bash android/setup-onn.command 192.168.1.50                 # install / update
#   bash android/setup-onn.command 192.168.1.50 --lock          # install and let Screenroom lock the box
#   bash android/setup-onn.command 192.168.1.50 path/to/Screenroom-12.apk
#
# Before running: on the box, turn on Developer options and USB / network debugging (see android/SETUP.md).

set -u
PKG="com.screenroom.tv"
say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
die() { printf '\n\033[31m%s\033[0m\n' "$1"; exit 1; }

IP=""; APK=""; LOCK=0
for a in "$@"; do
  case "$a" in
    --lock) LOCK=1 ;;
    *.apk) APK="$a" ;;
    *) IP="$a" ;;
  esac
done
[ -n "$IP" ] || die "Tell me the box's address, e.g.:  bash android/setup-onn.command 192.168.1.50
(On the box: Settings > Network & Internet > your Wi-Fi network shows the IP address.)"

# ---- adb (Android's install tool) ----------------------------------------------------------------
if ! command -v adb >/dev/null; then
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && eval "$($b shellenv)"; done
  command -v brew >/dev/null || die "Homebrew isn't installed. Install it from https://brew.sh, then run this again."
  say "Installing Android platform tools (adb)"
  brew install --cask android-platform-tools || die "Couldn't install adb."
fi

# ---- the APK ------------------------------------------------------------------------------------------
if [ -z "$APK" ]; then
  APK="$(ls -t ~/Downloads/Screenroom*.apk ~/Downloads/app-release*.apk 2>/dev/null | head -1 || true)"
fi
[ -n "$APK" ] && [ -f "$APK" ] || die "I couldn't find the Screenroom APK. Download it from your GitHub repository's Releases page
(it's called Screenroom-<number>.apk) into Downloads, or pass its path to this script."
say "Using $APK"

# ---- connect --------------------------------------------------------------------------------------------
TARGET="$IP:5555"
say "Connecting to the box at $IP"
echo "If the TV asks \"Allow network debugging?\", choose Always allow / OK."
adb connect "$TARGET" >/dev/null 2>&1
for i in 1 2 3 4 5 6 7 8 9 10; do
  STATE="$(adb -s "$TARGET" get-state 2>/dev/null || true)"
  [ "$STATE" = "device" ] && break
  sleep 2
  adb connect "$TARGET" >/dev/null 2>&1
done
if [ "$(adb -s "$TARGET" get-state 2>/dev/null || true)" != "device" ]; then
  echo
  echo "Couldn't connect on port 5555. Newer boxes use \"Wireless debugging\" with a pairing code:"
  echo "  On the box: Settings > System > Developer options > Wireless debugging > Pair device with pairing code."
  printf "Type the pairing address shown on the TV (like %s:37123), or press Enter to give up: " "$IP"
  read -r PAIRADDR
  [ -n "$PAIRADDR" ] || die "Not connected. See android/SETUP.md for help."
  printf "Type the 6-digit pairing code: "
  read -r CODE
  adb pair "$PAIRADDR" "$CODE" || die "Pairing failed."
  printf "Now type the address under \"IP address & Port\" on the Wireless debugging screen (like %s:41235): " "$IP"
  read -r TARGET
  adb connect "$TARGET" || die "Couldn't connect to $TARGET."
fi
ADB="adb -s $TARGET"
say "Connected to $($ADB shell getprop ro.product.model 2>/dev/null | tr -d '\r') (Android $($ADB shell getprop ro.build.version.release 2>/dev/null | tr -d '\r'))"

# ---- install ----------------------------------------------------------------------------------------------
say "Installing Screenroom"
$ADB install -r -g "$APK" || die "Install failed. If it says the signatures don't match, uninstall Screenroom from the box first."

say "Giving Screenroom access to your files and drives"
$ADB shell appops set --uid "$PKG" MANAGE_EXTERNAL_STORAGE allow 2>/dev/null || true
$ADB shell pm grant "$PKG" android.permission.READ_EXTERNAL_STORAGE 2>/dev/null || true
$ADB shell pm grant "$PKG" android.permission.READ_MEDIA_VIDEO 2>/dev/null || true

# ---- optional: let Screenroom lock the box ----------------------------------------------------------------
if [ "$LOCK" = "1" ]; then
  say "Letting Screenroom lock the box"
  OUT="$($ADB shell dpm set-device-owner "$PKG/.AdminReceiver" 2>&1)"
  echo "$OUT"
  if echo "$OUT" | grep -qi "success"; then
    echo "Done. In Screenroom: Settings > Lock to Screenroom, choose a PIN, then Lock."
  elif echo "$OUT" | grep -qi "already"; then
    echo "Screenroom already controls this box. Use Settings > Lock to Screenroom."
  else
    echo
    echo "Android only allows this on a box with no accounts signed in."
    echo "To use the lock: factory-reset the box (Settings > System > About > Reset), choose"
    echo "\"Set up basic TV\" / skip signing in to Google, turn on network debugging again,"
    echo "and run:  bash android/setup-onn.command $IP --lock"
    echo "(Everything else in Screenroom works without the lock.)"
  fi
fi

say "Starting Screenroom"
$ADB shell am start -n "$PKG/.MainActivity" >/dev/null 2>&1 || true
echo
echo "Screenroom is on the box. It's in the Apps row; its Settings show the phone-remote QR code."
echo "To update later, download the new APK and run this script again (your library and progress are kept)."
