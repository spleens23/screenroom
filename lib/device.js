'use strict';
/**
 * Laptop or desktop? The Linux box works a little differently on a laptop's own screen: a touchpad and a keyboard
 * are right there, so the mouse does more (click the DVD menu, touchpad brings up the controls, the volume slider)
 * and the buttons are computer-sized. Plugged into a TV, a laptop is used like the box: the remote, big buttons.
 *
 *   kind()          'laptop' | 'desktop'   (the machine; Settings can say otherwise)
 *   onOwnScreen()   true when it's a laptop showing on its own built-in screen (no TV plugged in)
 */
const fs = require('fs');
const { execFile } = require('child_process');

// What the machine tells about itself (the "chassis type" from its firmware), then: does it have a battery?
// 8 portable, 9 laptop, 10 notebook, 11 hand held, 14 sub-notebook, 30 tablet, 31 convertible, 32 detachable
const PORTABLE = new Set([8, 9, 10, 11, 14, 30, 31, 32]);
function detect() {
  if (process.env.SCREENROOM_TEST_LAPTOP) return 'laptop';
  if (process.platform !== 'linux') return 'desktop';
  try {
    const t = Number(fs.readFileSync('/sys/class/dmi/id/chassis_type', 'utf8').trim());
    if (PORTABLE.has(t)) return 'laptop';
    if ([3, 4, 5, 6, 7, 13, 15, 16, 24, 35, 36].includes(t)) return 'desktop'; // desktops, towers, mini PCs, all-in-ones
  } catch {}
  try { if (fs.readdirSync('/sys/class/power_supply').some((n) => /^BAT/i.test(n))) return 'laptop'; } catch {}
  return 'desktop';
}
const machine = detect();

let ownScreen = machine === 'laptop';
// which screen is in use: the laptop's own (eDP / LVDS / DSI) or a TV. "xrandr --current" only reads what X
// already knows (never probes the HDMI cable, which made the picture stutter).
function checkScreen() {
  return new Promise((resolve) => {
    if (machine !== 'laptop' || process.env.SCREENROOM_TEST_LAPTOP) { ownScreen = machine === 'laptop'; return resolve(ownScreen); }
    execFile('xrandr', ['--current'], { timeout: 4000 }, (err, out) => {
      if (err) return resolve(ownScreen);
      const lines = String(out).split('\n').filter((l) => / connected/.test(l));
      const used = lines.find((l) => / connected primary/.test(l)) || lines.find((l) => /\d+x\d+\+\d+\+\d+/.test(l)) || '';
      ownScreen = /^(eDP|LVDS|DSI)/.test(used);
      resolve(ownScreen);
    });
  });
}

module.exports = {
  kind: () => machine,
  checkScreen,
  onOwnScreen: () => ownScreen,
};
