#!/usr/bin/env bash
# Build the Screenroom automatic-installer ISO from the official Debian 13 netinst image.
#
#   scripts/build-installer-iso.sh <screenroom_x.y.z_amd64.deb> <output.iso> [--test-key ~/.ssh/id.pub]
#
# Needs: curl, xorriso, openssl, sha256sum. Downloads the Debian image (verified against Debian's
# SHA256SUMS) and adds the Screenroom package, setup scripts, answers for the installer, and a boot menu.
set -euo pipefail

DEB="$1"; OUT="$2"; shift 2
TEST_KEY=""
while [ $# -gt 0 ]; do case "$1" in --test-key) TEST_KEY="$2"; shift 2 ;; *) shift ;; esac; done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
CACHE="${DEBIAN_ISO_CACHE:-$HOME/.cache/screenroom-iso}"
mkdir -p "$CACHE"

BASE="https://cdimage.debian.org/debian-cd/current/amd64/iso-cd"
curl -fsSL "$BASE/SHA256SUMS" -o "$WORK/SHA256SUMS"
NAME="$(grep -oE 'debian-[0-9.]+-amd64-netinst\.iso' "$WORK/SHA256SUMS" | head -1)"
[ -n "$NAME" ] || { echo "Couldn't find the Debian netinst image name" >&2; exit 1; }
if [ ! -f "$CACHE/$NAME" ] || ! (cd "$CACHE" && grep " $NAME\$" "$WORK/SHA256SUMS" | sha256sum -c --status); then
  echo "Downloading $NAME"
  curl -fL --retry 3 -o "$CACHE/$NAME" "$BASE/$NAME"
  (cd "$CACHE" && grep " $NAME\$" "$WORK/SHA256SUMS" | sha256sum -c)
fi
echo "Base image: $NAME"

# ---- what goes onto the stick -----------------------------------------------------------------------
STAGE="$WORK/screenroom"
mkdir -p "$STAGE/deploy" "$STAGE/installer"
cp "$DEB" "$STAGE/"
cp -r "$ROOT/deploy/install-tv.sh" "$ROOT/deploy/screenroom-session" "$ROOT/deploy/screenroom-cec.py" \
      "$ROOT/deploy/screenroom-disks" "$ROOT/deploy/screenroom-update" "$ROOT/deploy/splash" "$STAGE/deploy/"
cp "$ROOT/deploy/installer/pick-disk.sh" "$ROOT/deploy/installer/late.sh" "$ROOT/deploy/installer/templates" "$STAGE/installer/"
chmod +x "$STAGE/deploy/"*.sh "$STAGE/deploy/screenroom-"* "$STAGE/installer/"*.sh
[ -n "$TEST_KEY" ] && cp "$TEST_KEY" "$STAGE/test_authorized_keys"

# The admin account gets a throwaway password here; Screenroom's setup replaces it with a random one.
HASH="$(openssl passwd -6 "$(openssl rand -hex 24)")"
sed "s|@ADMIN_HASH@|$HASH|" "$ROOT/deploy/installer/preseed.cfg" > "$WORK/preseed.cfg"

xorriso -indev "$CACHE/$NAME" -outdev "$OUT" \
  -map "$WORK/preseed.cfg" /preseed.cfg \
  -map "$STAGE" /screenroom \
  -map "$ROOT/deploy/installer/grub.cfg" /boot/grub/grub.cfg \
  -map "$ROOT/deploy/installer/isolinux.cfg" /isolinux/isolinux.cfg \
  -map "$ROOT/deploy/installer/screenroom.txt" /isolinux/screenroom.txt \
  -volid "SCREENROOM" \
  -boot_image any replay

ls -la "$OUT"
echo "Done: $OUT"
