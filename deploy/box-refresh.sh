#!/bin/bash
# Screenroom TV box: the parts of the box's setup that can change between versions (system packages for sound
# and Bluetooth speakers, helper scripts). Safe to run again and again.
# Runs from install-tv.sh during setup, and in the background after every Screenroom update (the app package's
# install script starts it), so boxes that are already set up get new pieces too.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
in_chroot() { [ "${SCREENROOM_CHROOT:-0}" = "1" ] || ! [ -d /run/systemd/system ] || { [ -x /usr/bin/ischroot ] && /usr/bin/ischroot; }; }
echo "Screenroom box refresh: $(date -Is)"

export DEBIAN_FRONTEND=noninteractive
APT=(apt-get -o DPkg::Lock::Timeout=900 -y --no-install-recommends)

# ---- Bluetooth speakers and headphones (BlueALSA: Bluetooth sound without PulseAudio/PipeWire) -------------
want=()
for p in bluez-alsa-utils libasound2-plugin-bluez; do
  dpkg -s "$p" >/dev/null 2>&1 || want+=("$p")
done
if [ "${#want[@]}" -gt 0 ]; then
  if ! "${APT[@]}" install "${want[@]}"; then
    apt-get -o DPkg::Lock::Timeout=900 update || true
    "${APT[@]}" install "${want[@]}" || echo "Could not install ${want[*]}"
  fi
fi

BIN="$(command -v bluealsad || command -v bluealsa || true)"
if [ -n "$BIN" ]; then
  # Play to speakers/headphones (A2DP source). The stock service may start with other profiles or none.
  UNIT=""
  for f in /lib/systemd/system/bluealsa.service /usr/lib/systemd/system/bluealsa.service; do [ -f "$f" ] && UNIT="$f"; done
  if [ -n "$UNIT" ]; then
    mkdir -p /etc/systemd/system/bluealsa.service.d
    printf '[Service]\nExecStart=\nExecStart=%s -p a2dp-source\n' "$BIN" > /etc/systemd/system/bluealsa.service.d/screenroom.conf
  else
    cat > /etc/systemd/system/bluealsa.service <<UNIT
[Unit]
Description=BlueALSA (Bluetooth sound for Screenroom)
Requires=bluetooth.service
After=bluetooth.service

[Service]
Type=dbus
BusName=org.bluealsa
ExecStart=$BIN -p a2dp-source
Restart=on-failure

[Install]
WantedBy=bluetooth.target
UNIT
  fi
  # Reconnect trusted speakers when they are switched on.
  if [ -f /etc/bluetooth/main.conf ] && ! grep -q '^AutoEnable' /etc/bluetooth/main.conf; then
    sed -i 's/^\[Policy\]/[Policy]\nAutoEnable=true/' /etc/bluetooth/main.conf
  fi
  systemctl daemon-reload >/dev/null 2>&1 || true
  systemctl enable bluealsa.service >/dev/null 2>&1 || true
  in_chroot || systemctl restart bluealsa.service >/dev/null 2>&1 || true
fi

# ---- sound outputs switched on ------------------------------------------------------------------------
install -m 0755 "$HERE/screenroom-audio-setup" /usr/local/bin/screenroom-audio-setup
install -m 0755 "$HERE/screenroom-session" /usr/local/bin/screenroom-session
if ! in_chroot; then
  /usr/local/bin/screenroom-audio-setup
  alsactl store >/dev/null 2>&1 || true
fi
echo "Screenroom box refresh done"
