#!/bin/sh
# Runs inside the Debian installer (partman/early_command). Decides which drive to install on,
# and refuses to guess when it isn't clear, so a drive full of movies is never erased.
#
#  1. Only one internal (non-USB) drive               -> use it
#  2. Exactly one drive with an operating system on it  -> use it (e.g. the Windows the PC came with)
#  3. Exactly one completely blank drive               -> use it (nothing to lose)
#  otherwise stop and explain.
SYS="${SCREENROOM_SYS:-/sys}"   # (tests point this at a fake /sys)
log() { logger -t screenroom "$*" 2>/dev/null; echo "screenroom: $*" >&2; }

stop() {
  . /usr/share/debconf/confmodule
  debconf-loadtemplate screenroom /cdrom/screenroom/installer/templates
  db_subst screenroom/no-disk REASON "$1"
  db_input critical screenroom/no-disk || true
  db_go || true
  log "stopping: $1"
  exit 1
}

# The installer USB itself
CD_DEV="$(mount | awk '$3=="/cdrom"{print $1}' | sed -E 's/p?[0-9]+$//')"
ESP_GUID="c12a7328-f81f-11d2-ba4b-00a0c93ec93b"

CANDS=""
for d in $(list-devices disk); do
  n="$(basename "$d")"
  [ -n "$CD_DEV" ] && [ "$d" = "$CD_DEV" ] && continue
  case "$n" in sr*|loop*|ram*|fd*|zram*|mmcblk*boot*|mmcblk*rpmb) continue ;; esac
  # an SD card in the laptop's card reader is never the system drive (built-in eMMC storage reports "MMC")
  case "$n" in mmcblk*) [ "$(cat $SYS/block/$n/device/type 2>/dev/null)" = "SD" ] && { log "skip SD card $d"; continue; } ;; esac
  if readlink -f "$SYS/block/$n" | grep -q '/usb'; then log "skip USB drive $d"; continue; fi
  [ "$(cat $SYS/block/$n/removable 2>/dev/null)" = "1" ] && { log "skip removable $d"; continue; }
  CANDS="$CANDS $d"
done
CANDS="$(echo $CANDS)"
log "internal drives: ${CANDS:-none}"
[ -n "$CANDS" ] || stop "No internal drive was found to install on."

parts() { n="$(basename "$1")"; for p in $(ls "$SYS/block/$n/" 2>/dev/null | grep "^$n"); do echo "/dev/$p"; done; }
has_os() { # an EFI system partition, or a Windows / Linux system already on it
  for p in $(parts "$1"); do
    t="$(blkid -p -o value -s PART_ENTRY_TYPE "$p" 2>/dev/null || true)"
    [ "$t" = "$ESP_GUID" ] && return 0
    [ "$t" = "0xef" ] && return 0
  done
  return 1
}
is_blank() {
  n="$(basename "$1")"
  [ -n "$(parts "$1")" ] && return 1          # has partitions
  [ -z "$(blkid -p "$1" 2>/dev/null)" ]                   # and no filesystem / table signature
}

count() { echo "$1" | wc -w; }
if [ "$(count "$CANDS")" = "1" ]; then
  DISK="$CANDS"; why="the only internal drive"
else
  OS=""; BLANK=""
  for d in $CANDS; do
    has_os "$d" && OS="$OS $d"
    is_blank "$d" && BLANK="$BLANK $d"
  done
  OS="$(echo $OS)"; BLANK="$(echo $BLANK)"
  if [ "$(count "$OS")" = "1" ]; then DISK="$OS"; why="it has the computer's current operating system"
  elif [ -z "$OS" ] && [ "$(count "$BLANK")" = "1" ]; then DISK="$BLANK"; why="it's the only blank drive"
  else
    stop "This computer has more than one internal drive ($CANDS) and it isn't clear which one Screenroom should erase. Turn it off, remove the drive that holds your movies, install, then put it back: Screenroom will use it automatically."
  fi
fi
log "installing on $DISK ($why)"
debconf-set partman-auto/disk "$DISK"
debconf-set grub-installer/bootdev "$DISK"
exit 0
