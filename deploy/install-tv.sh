#!/usr/bin/env bash
# Turn a fresh Ubuntu / Debian install into a Screenroom TV box:
# it boots straight into Screenroom, full screen, ready for a remote or controller.
#
#   sudo ./install-tv.sh [path/to/screenroom_x.y.z_amd64.deb]
#
# Safe to run again (for example after installing a newer .deb).
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run this with sudo:  sudo $0 [screenroom.deb]" >&2
  exit 1
fi
if ! command -v apt-get >/dev/null; then
  echo "This script supports Ubuntu / Debian (apt). On other distros, see deploy/SETUP.md." >&2
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TV_USER="${TV_USER:-tv}"
PORT="${SCREENROOM_PORT:-8686}"

# ---- find the Screenroom package ---------------------------------------------------
DEB="${1:-}"
if [ -z "$DEB" ]; then
  ARCH="$(dpkg --print-architecture)"
  DEB="$(ls -1t "$HERE"/../dist/screenroom_*_"$ARCH".deb "$HERE"/../screenroom_*_"$ARCH".deb "$HERE"/screenroom_*_"$ARCH".deb ./screenroom_*_"$ARCH".deb 2>/dev/null | head -1 || true)"
fi
if [ -z "$DEB" ] || [ ! -f "$DEB" ]; then
  echo "I couldn't find the Screenroom .deb package." >&2
  echo "Pass it as an argument:  sudo $0 /path/to/screenroom_0.4.0_amd64.deb" >&2
  exit 1
fi
DEB="$(readlink -f "$DEB")"
echo "==> Using package: $DEB"

export DEBIAN_FRONTEND=noninteractive

# ---- packages -------------------------------------------------------------------------
echo "==> Installing system packages (this takes a few minutes)"
echo "lightdm shared/default-x-display-manager select lightdm" | debconf-set-selections || true
apt-get update -y
# Plain ALSA audio on purpose (no PulseAudio/PipeWire): that's what lets Dolby/DTS bitstreams
# reach your receiver untouched over HDMI.
apt-get install -y --no-install-recommends \
  xorg openbox lightdm lightdm-gtk-greeter x11-xserver-utils \
  mpv ffmpeg alsa-utils fonts-inter fonts-noto-core \
  mesa-va-drivers vainfo libva-drm2 \
  cec-utils python3-evdev \
  udisks2 udiskie gvfs gvfs-backends policykit-1 exfatprogs ntfs-3g \
  samba avahi-daemon libnss-mdns \
  ca-certificates curl

# Intel hardware video decoding driver (x86 PCs only)
if [ "$(dpkg --print-architecture)" = "amd64" ]; then
  apt-get install -y --no-install-recommends intel-media-va-driver || true
fi

echo "==> Installing Screenroom"
apt-get install -y "$DEB"

# ---- the TV user + automatic login --------------------------------------------------
if ! id "$TV_USER" >/dev/null 2>&1; then
  echo "==> Creating user '$TV_USER'"
  adduser --disabled-password --gecos "Screenroom TV" "$TV_USER"
fi
for g in audio video input render plugdev dialout; do
  getent group "$g" >/dev/null && usermod -aG "$g" "$TV_USER" || true
done

install -m 0755 "$HERE/screenroom-session" /usr/local/bin/screenroom-session
install -m 0755 "$HERE/screenroom-cec.py" /usr/local/bin/screenroom-cec

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
EOF
echo /usr/sbin/lightdm > /etc/X11/default-display-manager
systemctl enable lightdm >/dev/null 2>&1 || true
systemctl set-default graphical.target >/dev/null 2>&1 || true

# ---- remote-control plumbing -----------------------------------------------------------
# uinput lets the CEC bridge type key presses; /dev/uinput must be usable by the tv user.
echo uinput > /etc/modules-load.d/screenroom-uinput.conf
cat > /etc/udev/rules.d/99-screenroom-uinput.rules <<'EOF'
KERNEL=="uinput", MODE="0660", GROUP="input", OPTIONS+="static_node=uinput"
EOF
modprobe uinput 2>/dev/null || true
udevadm control --reload-rules 2>/dev/null || true
udevadm trigger 2>/dev/null || true


# ---- media folder + network share (drag files in from a Mac / Windows PC) -----------------------------
MEDIA_DIR="${SCREENROOM_MEDIA:-/srv/media}"
mkdir -p "$MEDIA_DIR"
chown -R "$TV_USER:$TV_USER" "$MEDIA_DIR"
chmod 775 "$MEDIA_DIR"

# A friendly name on the network: screenroom.local
NEW_HOST="${SCREENROOM_HOSTNAME:-screenroom}"
if [ "$(hostname)" != "$NEW_HOST" ]; then
  echo "==> Naming this computer '$NEW_HOST' (reachable as $NEW_HOST.local)"
  hostnamectl set-hostname "$NEW_HOST" 2>/dev/null || echo "$NEW_HOST" > /etc/hostname
  if grep -q '^127.0.1.1' /etc/hosts; then sed -i "s/^127.0.1.1.*/127.0.1.1 $NEW_HOST/" /etc/hosts; else echo "127.0.1.1 $NEW_HOST" >> /etc/hosts; fi
fi

# Samba: one share called "Screenroom", open to your home network only (no password needed there).
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

# Show up in Finder's sidebar
cat > /etc/avahi/services/screenroom-smb.service <<'AVEOF'
<?xml version="1.0" standalone='no'?>
<!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<service-group>
  <name replace-wildcards="yes">%h</name>
  <service><type>_smb._tcp</type><port>445</port></service>
  <service><type>_device-info._tcp</type><port>0</port><txt-record>model=Xserve</txt-record></service>
</service-group>
AVEOF
systemctl enable --now smbd nmbd avahi-daemon >/dev/null 2>&1 || true
systemctl restart smbd avahi-daemon >/dev/null 2>&1 || true

# Phone remote port (only if the ufw firewall is switched on)
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
  echo "==> Opening the phone-remote port ($PORT) on the local network"
  ufw allow from 192.168.0.0/16 to any port "$PORT" proto tcp || true
  ufw allow from 10.0.0.0/8 to any port "$PORT" proto tcp || true
  ufw allow from 172.16.0.0/12 to any port "$PORT" proto tcp || true
  for net in 192.168.0.0/16 10.0.0.0/8 172.16.0.0/12; do
    ufw allow from $net to any port 445 proto tcp || true
    ufw allow from $net to any port 5353 proto udp || true
  done
fi

# Preload a config so first boot goes straight into the big TV layout.
CFG_DIR="/home/$TV_USER/.config/screenroom"
if [ ! -f "$CFG_DIR/config.json" ]; then
  mkdir -p "$CFG_DIR"
  cat > "$CFG_DIR/config.json" <<EOF
{ "tvMode": true, "dirs": ["$MEDIA_DIR"], "mediaDir": "$MEDIA_DIR", "passthrough": false, "fullscreen": true, "remote": true, "remotePort": $PORT }
EOF
  chown -R "$TV_USER:$TV_USER" "/home/$TV_USER/.config"
fi

echo
echo "================================================================"
echo " Done. Restart the computer:   sudo reboot"
echo
echo " It will start Screenroom by itself. On first start:"
echo "   1. Press the settings key (or use the phone remote) -> Settings"
echo "   2. Put media on the box: plug in a USB drive (it appears by itself),"
echo "      or from a computer open  smb://$NEW_HOST.local  (Mac: Finder > Go > Connect to Server),"
echo "      or scan the QR code in Settings > Add media and upload from a phone."
echo "   3. Pick your HDMI device under 'Audio output'"
echo " The phone-remote address and PIN are shown in Settings."
echo "================================================================"
