#!/bin/sh
# Runs at the end of the Debian installer (preseed/late_command): turns the new system into a
# Screenroom appliance by running the same install-tv.sh used for manual installs.
mkdir -p /target/opt/screenroom-setup
cp -r /cdrom/screenroom/. /target/opt/screenroom-setup/
DEB="$(ls /target/opt/screenroom-setup/screenroom_*_amd64.deb | head -1)"
DEB="/opt/screenroom-setup/$(basename "$DEB")"
# Test builds can carry an ssh key for automated checks.
if [ -f /cdrom/screenroom/test_authorized_keys ]; then
  mkdir -p /target/home/screenroom/.ssh
  cp /cdrom/screenroom/test_authorized_keys /target/home/screenroom/.ssh/authorized_keys
  in-target chown -R screenroom:screenroom /home/screenroom/.ssh
  chmod 700 /target/home/screenroom/.ssh; chmod 600 /target/home/screenroom/.ssh/authorized_keys
  echo 'screenroom ALL=(ALL) NOPASSWD:ALL' > /target/etc/sudoers.d/screenroom-test
  chmod 440 /target/etc/sudoers.d/screenroom-test
fi
# (in-target sends output to the installer's syslog, so redirect inside the new system instead)
if ! in-target sh -c "SCREENROOM_CHROOT=1 SCREENROOM_ADMIN=screenroom bash /opt/screenroom-setup/deploy/install-tv.sh '$DEB' > /var/log/screenroom-install.log 2>&1"; then
  # Show what went wrong on screen (and keep the full log on the new system).
  . /usr/share/debconf/confmodule
  debconf-loadtemplate screenroom /cdrom/screenroom/installer/templates
  db_subst screenroom/setup-failed LOG "$(tail -n 12 /target/var/log/screenroom-install.log | tr -d '\r' | sed 's/[^[:print:]]//g' | tr '\n' ' ' | cut -c1-900)"
  db_input critical screenroom/setup-failed || true
  db_go || true
  exit 1
fi
