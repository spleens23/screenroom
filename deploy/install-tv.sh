#!/usr/bin/env bash
# Turn a fresh Debian 13 / Ubuntu 24.04 install into a Screenroom TV box ("appliance"):
# it boots behind a Screenroom splash straight into Screenroom, full screen, ready for a remote,
# controller or phone. Linux stays out of sight.
#
#   sudo ./install-tv.sh [path/to/screenroom_x.y.z_amd64.deb]
#
# Safe to run again (for example after installing a newer .deb). Also used by the automatic
# installer USB (it runs inside the freshly installed system, where services aren't running yet).
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run this with sudo:  sudo $0 [screenroom.deb]" >&2
  exit 1
fi
command -v apt-get >/dev/null || { echo "This script supports Debian / Ubuntu (apt)." >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TV_USER="${TV_USER:-tv}"
ADMIN_USER="${SCREENROOM_ADMIN:-}"
PORT="${SCREENROOM_PORT:-8686}"
MEDIA_DIR="${SCREENROOM_MEDIA:-/srv/media}"
NEW_HOST="${SCREENROOM_HOSTNAME:-screenroom}"
UPDATE_REPO="${SCREENROOM_UPDATE_REPO:-spleens23/screenroom}"
# Inside the installer's chroot, systemd isn't running: only enable things, don't start them.
IN_CHROOT=0
if [ "${SCREENROOM_CHROOT:-0}" = "1" ] || ! [ -d /run/systemd/system ]; then IN_CHROOT=1; fi
say() { echo "==> $*"; }

# ---- find the Screenroom package ---------------------------------------------------------------
DEB="${1:-}"
if [ -z "$DEB" ]; then
  ARCH="$(dpkg --print-architecture)"
  DEB="$(ls -1t "$HERE"/../dist/screenroom_*_"$ARCH".deb "$HERE"/../screenroom_*_"$ARCH".deb "$HERE"/screenroom_*_"$ARCH".deb ./screenroom_*_"$ARCH".deb 2>/dev/null | head -1 || true)"
fi
if [ -z "$DEB" ] || [ ! -f "$DEB" ]; then
  echo "I couldn't find the Screenroom .deb package." >&2
  echo "Pass it as an argument:  sudo $0 /path/to/screenroom_0.5.0_amd64.deb" >&2
  exit 1
fi
DEB="$(readlink -f "$DEB")"
say "Using package: $DEB"

export DEBIAN_FRONTEND=noninteractive
. /etc/os-release
IS_DEBIAN=0; [ "${ID:-}" = "debian" ] && IS_DEBIAN=1

# ---- packages ------------------------------------------------------------------------------------
say "Installing system packages (this takes a few minutes)"
echo "lightdm shared/default-x-display-manager select lightdm" | debconf-set-selections || true
# The installer USB stays listed as a package source after installation; it's gone once the stick is
# removed, so drop it (otherwise every package update fails).
[ -f /etc/apt/sources.list ] && sed -i -E 's|^(deb(-src)?\s+cdrom:)|# \1|' /etc/apt/sources.list || true
for f in /etc/apt/sources.list.d/*.sources; do
  [ -f "$f" ] && grep -q "cdrom:" "$f" && sed -i -E '/^URIs:\s*cdrom:/,/^$/ s/^/# /' "$f"  || true
done
if [ "$IS_DEBIAN" = "1" ] && [ -f /etc/apt/sources.list ] && ! grep -q "non-free-firmware" /etc/apt/sources.list; then
  # Graphics/Wi-Fi firmware for Intel mini PCs lives in Debian's non-free-firmware section.
  sed -i -E 's/^(deb\s+\S+\s+\S+\s+main)(.*)$/\1 contrib non-free non-free-firmware/' /etc/apt/sources.list
fi
if [ "$IS_DEBIAN" = "1" ] && [ -f /etc/apt/sources.list.d/debian.sources ] && ! grep -q "non-free-firmware" /etc/apt/sources.list.d/debian.sources; then
  sed -i -E 's/^Components:.*/Components: main contrib non-free non-free-firmware/' /etc/apt/sources.list.d/debian.sources
fi
# Offline installer: every package Screenroom needs is on the USB stick, as a package source.
if [ -n "${SCREENROOM_POOL:-}" ] && [ -f "$SCREENROOM_POOL/Packages" ]; then
  say "Using the packages on the USB stick (no internet needed)"
  echo "deb [trusted=yes] file:$SCREENROOM_POOL ./" > /etc/apt/sources.list.d/screenroom-offline.list
fi
# Debian's servers, for updates later (an installation without internet doesn't list them).
if [ "$IS_DEBIAN" = "1" ] && ! grep -rqsE "^[^#]*(deb\.debian\.org|ftp\.[a-z.]*debian\.org|security\.debian\.org)" /etc/apt/sources.list /etc/apt/sources.list.d/; then
  cat > /etc/apt/sources.list.d/debian.sources <<SRC
Types: deb
URIs: http://deb.debian.org/debian
Suites: ${VERSION_CODENAME} ${VERSION_CODENAME}-updates
Components: main contrib non-free non-free-firmware
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg

Types: deb
URIs: http://security.debian.org/debian-security
Suites: ${VERSION_CODENAME}-security
Components: main contrib non-free non-free-firmware
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg
SRC
fi
apt-get update -y || echo "Some package sources couldn't be reached (no internet?); continuing with what is available."

# Plain ALSA audio on purpose (no PulseAudio/PipeWire): that's what lets Dolby/DTS bitstreams reach
# your receiver untouched over HDMI / DisplayPort.
apt-get install -y --no-install-recommends \
  xorg openbox lightdm lightdm-gtk-greeter x11-xserver-utils \
  mpv ffmpeg alsa-utils \
  mesa-va-drivers vainfo \
  udisks2 udiskie exfatprogs ntfs-3g dosfstools \
  samba avahi-daemon libnss-mdns \
  network-manager bluez polkitd \
  plymouth plymouth-themes \
  unattended-upgrades openssh-server \
  ca-certificates curl jq pciutils

# Things whose names differ between Debian and Ubuntu, or that only some machines need.
# Installed together when possible; if that fails (one package can't be installed), one at a time, so one bad
# package never silently drops all the others.
optional() {
  local pkgs=()
  for p in "$@"; do apt-cache show "$p" >/dev/null 2>&1 && pkgs+=("$p"); done
  [ "${#pkgs[@]}" -gt 0 ] || return 0
  apt-get install -y --no-install-recommends "${pkgs[@]}" && return 0
  for p in "${pkgs[@]}"; do apt-get install -y --no-install-recommends "$p" || echo "Skipped optional package $p"; done
}
optional fonts-inter fonts-noto-core gvfs gvfs-backends cec-utils python3-evdev libva-drm2
if [ "$(dpkg --print-architecture)" = "amd64" ]; then
  optional intel-media-va-driver i965-va-driver firmware-misc-nonfree firmware-iwlwifi firmware-realtek firmware-atheros firmware-intel-sound firmware-sof-signed alsa-ucm-conf
fi

say "Installing Screenroom"
apt-get install -y "$DEB"

# ---- the TV user + automatic login ----------------------------------------------------------------
if ! id "$TV_USER" >/dev/null 2>&1; then
  say "Creating user '$TV_USER'"
  adduser --disabled-password --gecos "Screenroom TV" "$TV_USER"
fi
for g in audio video input render plugdev dialout bluetooth netdev; do
  getent group "$g" >/dev/null && usermod -aG "$g" "$TV_USER" || true
done

install -m 0755 "$HERE/screenroom-session" /usr/local/bin/screenroom-session
install -m 0755 "$HERE/screenroom-cec.py" /usr/local/bin/screenroom-cec
install -m 0755 "$HERE/screenroom-disks" /usr/local/sbin/screenroom-disks
install -m 0755 "$HERE/screenroom-update" /usr/local/sbin/screenroom-update

mkdir -p /usr/share/xsessions
cat > /usr/share/xsessions/screenroom.desktop <<'EOF'
[Desktop Entry]
Name=Screenroom TV
Comment=Full-screen Screenroom for the living room
Exec=/usr/local/bin/screenroom-session
Type=Application
EOF

mkdir -p /etc/lightdm/lightdm.conf.d
cat > /etc/lightdm/lightdm.conf.d/50-screenroom.conf <<EOF
[Seat:*]
autologin-user=$TV_USER
autologin-user-timeout=0
autologin-session=screenroom
user-session=screenroom
greeter-hide-users=true
EOF
mkdir -p /etc/X11
echo /usr/sbin/lightdm > /etc/X11/default-display-manager
systemctl enable lightdm >/dev/null 2>&1 || true
systemctl set-default graphical.target >/dev/null 2>&1 || true

# ---- remote-control plumbing (HDMI-CEC bridge needs uinput) -----------------------------------------
echo uinput > /etc/modules-load.d/screenroom-uinput.conf
cat > /etc/udev/rules.d/99-screenroom-uinput.rules <<'EOF'
KERNEL=="uinput", MODE="0660", GROUP="input", OPTIONS+="static_node=uinput"
EOF
if [ "$IN_CHROOT" = "0" ]; then
  modprobe uinput 2>/dev/null || true
  udevadm control --reload-rules 2>/dev/null || true
fi

# ---- networking: NetworkManager runs Wi-Fi (and, on Debian, the cable too) -------------------------
if [ "$IS_DEBIAN" = "1" ] && [ -f /etc/network/interfaces ] && grep -qE '^(auto|allow-hotplug)\s+(e|en)' /etc/network/interfaces; then
  # Hand the network cable over from ifupdown to NetworkManager so Settings can show and manage it.
  cp -n /etc/network/interfaces /etc/network/interfaces.screenroom-backup 2>/dev/null || true
  printf 'auto lo\niface lo inet loopback\n' > /etc/network/interfaces
fi
systemctl enable NetworkManager bluetooth >/dev/null 2>&1 || true

# ---- the media folder, and the drive inside the computer ------------------------------------------
mkdir -p "$MEDIA_DIR"
chown "$TV_USER:$TV_USER" "$MEDIA_DIR"
chmod 775 "$MEDIA_DIR"
mkdir -p /etc/screenroom
cat > /etc/screenroom/screenroom.conf <<EOF
TV_USER=$TV_USER
MEDIA_DIR=$MEDIA_DIR
UPDATE_REPO=$UPDATE_REPO
EOF
cat > /etc/systemd/system/screenroom-disks.service <<'EOF'
[Unit]
Description=Screenroom: set up the internal media drive
After=local-fs.target systemd-udev-settle.service
Before=display-manager.service smbd.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/screenroom-disks
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF
systemctl enable screenroom-disks.service >/dev/null 2>&1 || true

# ---- a friendly name on the network: screenroom.local ------------------------------------------------
if [ "$(cat /etc/hostname 2>/dev/null)" != "$NEW_HOST" ]; then
  say "Naming this computer '$NEW_HOST' (reachable as $NEW_HOST.local)"
  echo "$NEW_HOST" > /etc/hostname
  [ "$IN_CHROOT" = "0" ] && hostnamectl set-hostname "$NEW_HOST" 2>/dev/null || true
  if grep -q '^127.0.1.1' /etc/hosts; then sed -i "s/^127.0.1.1.*/127.0.1.1 $NEW_HOST/" /etc/hosts; else echo "127.0.1.1 $NEW_HOST" >> /etc/hosts; fi
fi

# ---- Samba: a "Screenroom" share for dragging files in from a Mac / Windows PC -----------------------
if ! grep -q '# --- screenroom share ---' /etc/samba/smb.conf; then
  cp -n /etc/samba/smb.conf /etc/samba/smb.conf.screenroom-backup 2>/dev/null || true
  sed -i '/^[[:space:]]*map to guest/d' /etc/samba/smb.conf
  sed -i '0,/^\[global\]/s//[global]\n   map to guest = Bad User\n   server min protocol = SMB2\n   vfs objects = catia fruit streams_xattr\n   fruit:metadata = stream\n   fruit:model = MacSamba\n   fruit:nfs_aces = no/' /etc/samba/smb.conf
  cat >> /etc/samba/smb.conf <<SMBEOF

# --- screenroom share ---
[Screenroom]
   comment = Screenroom media
   path = $MEDIA_DIR
   browseable = yes
   read only = no
   guest ok = yes
   force user = $TV_USER
   force group = $TV_USER
   create mask = 0664
   directory mask = 0775
   hosts allow = 127.0.0.1 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 fe80::/10
   hosts deny = 0.0.0.0/0
# --- end screenroom share ---
SMBEOF
fi
testparm -s >/dev/null 2>&1 || echo "(note: the samba config check reported a problem; run 'testparm' to see it)"
mkdir -p /etc/avahi/services
cat > /etc/avahi/services/screenroom-smb.service <<'AVEOF'
<?xml version="1.0" standalone='no'?>
<!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<service-group>
  <name replace-wildcards="yes">%h</name>
  <service><type>_smb._tcp</type><port>445</port></service>
  <service><type>_device-info._tcp</type><port>0</port><txt-record>model=Xserve</txt-record></service>
</service-group>
AVEOF
systemctl enable smbd nmbd avahi-daemon ssh >/dev/null 2>&1 || true

# ---- appliance behaviour ---------------------------------------------------------------------------------
say "Setting up appliance behaviour (splash, power button, automatic updates)"
# Power button (press = sleep, hold = off) is set up by box-refresh.sh, below.

# Keep logs small.
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=200M\n' > /etc/systemd/journald.conf.d/50-screenroom.conf

# Security updates install themselves (no automatic reboots, so a movie is never interrupted).
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
cat > /etc/apt/apt.conf.d/52screenroom-unattended <<'EOF'
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
EOF

# Boot splash instead of scrolling text.
if [ -d "$HERE/splash" ]; then
  mkdir -p /usr/share/plymouth/themes/screenroom
  cp "$HERE/splash/"* /usr/share/plymouth/themes/screenroom/
  if command -v plymouth-set-default-theme >/dev/null; then
    plymouth-set-default-theme screenroom >/dev/null 2>&1 || true
  else
    update-alternatives --install /usr/share/plymouth/themes/default.plymouth default.plymouth \
      /usr/share/plymouth/themes/screenroom/screenroom.plymouth 200 >/dev/null 2>&1 || true
    update-alternatives --set default.plymouth /usr/share/plymouth/themes/screenroom/screenroom.plymouth >/dev/null 2>&1 || true
  fi
  # Load the Intel graphics driver early so the splash shows at full resolution.
  grep -qx i915 /etc/initramfs-tools/modules 2>/dev/null || echo i915 >> /etc/initramfs-tools/modules
fi
if [ -f /etc/default/grub ]; then
  setv() { if grep -q "^$1=" /etc/default/grub; then sed -i "s|^$1=.*|$1=$2|" /etc/default/grub; else echo "$1=$2" >> /etc/default/grub; fi; }
  setv GRUB_TIMEOUT 0
  setv GRUB_TIMEOUT_STYLE hidden
  setv GRUB_RECORDFAIL_TIMEOUT 0
  setv GRUB_CMDLINE_LINUX_DEFAULT '"quiet splash loglevel=3 rd.udev.log_level=3 systemd.show_status=false vt.global_cursor_default=0 consoleblank=0"'
  update-grub >/dev/null 2>&1 || true
fi
update-initramfs -u >/dev/null 2>&1 || true

# ---- maintenance login + one-button updates ---------------------------------------------------------------
# An admin account for repairs over the network (ssh), with a random password shown in Screenroom's Settings.
if [ -n "$ADMIN_USER" ] && id "$ADMIN_USER" >/dev/null 2>&1; then
  if [ ! -f /etc/screenroom/maintenance ]; then
    PW="$(tr -dc 'a-hjkmnp-z2-9' </dev/urandom | head -c 12 || true)"
    echo "$ADMIN_USER:$PW" | chpasswd
    printf 'user=%s\npassword=%s\n' "$ADMIN_USER" "$PW" > /etc/screenroom/maintenance
  fi
  chgrp "$TV_USER" /etc/screenroom/maintenance && chmod 0640 /etc/screenroom/maintenance
fi
touch /etc/screenroom/appliance

cat > /etc/systemd/system/screenroom-update.service <<'EOF'
[Unit]
Description=Screenroom: install the newest version
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/screenroom-update
EOF
# Let the TV user (the app) start that one service, and nothing else.
mkdir -p /etc/polkit-1/rules.d
cat > /etc/polkit-1/rules.d/50-screenroom.rules <<EOF
polkit.addRule(function(action, subject) {
  if (subject.user == "$TV_USER" &&
      action.id == "org.freedesktop.systemd1.manage-units" &&
      action.lookup("unit") == "screenroom-update.service" &&
      action.lookup("verb") == "start") {
    return polkit.Result.YES;
  }
  if (subject.user == "$TV_USER" &&
      (action.id == "org.freedesktop.login1.power-off" || action.id == "org.freedesktop.login1.reboot" ||
       action.id == "org.freedesktop.login1.power-off-multiple-sessions" || action.id == "org.freedesktop.login1.reboot-multiple-sessions")) {
    return polkit.Result.YES;
  }
});
EOF

# ---- firewall (only if ufw is switched on) --------------------------------------------------------------
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
  for net in 192.168.0.0/16 10.0.0.0/8 172.16.0.0/12; do
    ufw allow from $net to any port "$PORT" proto tcp || true
    ufw allow from $net to any port 445 proto tcp || true
    ufw allow from $net to any port 5353 proto udp || true
  done
fi

# ---- first-boot settings for the app ------------------------------------------------------------------------
CFG_DIR="/home/$TV_USER/.config/screenroom"
if [ ! -f "$CFG_DIR/config.json" ]; then
  mkdir -p "$CFG_DIR"
  cat > "$CFG_DIR/config.json" <<EOF
{ "tvMode": true, "dirs": ["$MEDIA_DIR"], "mediaDir": "$MEDIA_DIR", "passthrough": false, "fullscreen": true, "remote": true, "remotePort": $PORT }
EOF
  chown -R "$TV_USER:$TV_USER" "/home/$TV_USER/.config"
fi

# ---- sound: outputs switched on, Bluetooth speakers (also re-run after every Screenroom update) -----------
say "Setting up sound and Bluetooth speakers"
SCREENROOM_CHROOT="$IN_CHROOT" bash "$HERE/box-refresh.sh" || true

if [ "$IN_CHROOT" = "0" ]; then
  systemctl daemon-reload >/dev/null 2>&1 || true
  systemctl restart systemd-logind smbd avahi-daemon >/dev/null 2>&1 || true
fi

echo
echo "================================================================"
echo " Screenroom is installed. Restart the computer:   sudo reboot"
echo
echo " It starts Screenroom by itself. Then:"
echo "   - Put media on it: a drive inside the computer is set up automatically;"
echo "     USB drives appear by themselves; or from a computer open  smb://$NEW_HOST.local"
echo "   - Wi-Fi, Bluetooth remotes and speakers, and the phone remote are in Screenroom's Settings."
echo "================================================================"
