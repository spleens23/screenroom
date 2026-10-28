const { app, BrowserWindow, ipcMain, dialog, shell, screen, powerMonitor } = require('electron');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { scan, loadCached } = require('./lib/library');
const { play, findBinary, control, listAudioDevices } = require('./lib/player');
const remote = require('./lib/remote');
const transfer = require('./lib/transfer');
const system = require('./lib/system');
const audio = require('./lib/audio');
const cleanup = require('./lib/cleanup');
const { setupParlor } = require('./lib/parlor-ipc');
const { Profiles } = require('./lib/profiles');
const { Ratings } = require('./lib/ratings');
const { Recommendations } = require('./lib/social');
const core = require('./lib/media-core');
const qrcode = require('qrcode-generator');

// Keep the same data folder whether running from source or as a packaged app,
// so the library cache, settings and watch history carry over.
// Crisper text when the page is scaled up for a TV (fractional zoom blurs hinted glyphs on Linux).
if (process.platform === 'linux') app.commandLine.appendSwitch('font-render-hinting', 'none');
// TV box: draw the interface with the graphics chip (smoother spinning records and scrolling on small Intel PCs)
if (process.platform === 'linux' && fs.existsSync('/etc/screenroom/appliance')) {
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
}

// Editions: the TV box runs everything in one app ("all"). On Heirloom (the tablet) films and music are two
// apps of their own: `--edition=films` (Screenroom) and `--edition=music` (Parlor), each with its own settings,
// profiles and library, and its own window class so the home screen shows them as two apps.
const EDITION = (() => {
  const a = process.argv.find((x) => x.startsWith('--edition='));
  const e = (a ? a.split('=')[1] : process.env.SCREENROOM_EDITION) || 'all';
  return ['all', 'films', 'music'].includes(e) ? e : 'all';
})();
const WM_CLASS = EDITION === 'music' ? 'dev.screenroom.Parlor' : EDITION === 'films' ? 'dev.screenroom.Screenroom' : null;
if (WM_CLASS) {
  app.setName(EDITION === 'music' ? 'Parlor' : 'Screenroom');
  if (process.platform === 'linux') { app.commandLine.appendSwitch('class', WM_CLASS); try { app.setDesktopName(`${WM_CLASS}.desktop`); } catch {} }
}
app.setPath('userData', path.join(app.getPath('appData'), EDITION === 'music' ? 'parlor' : 'screenroom'));

// TV mode: fullscreen, scaled up for a TV, remote/gamepad friendly.
// Turn it on in Settings, or launch with `--tv` / SCREENROOM_TV=1 (what the mini-PC session does).
const TV_FLAG = process.argv.includes('--tv') || process.env.SCREENROOM_TV === '1';

let win;
const dataDir = () => app.getPath('userData');
const cfgFile = () => path.join(dataDir(), 'config.json');
// Watch progress belongs to the current profile (see lib/profiles.js).
const progFile = () => profiles.progressFile(currentId);

const defaults = {
  dirs: [], passthrough: false, downmix: false, levelVolume: true, truehdPassthrough: true, screensaverMin: 5, fullscreen: true, tvMode: false,
  preferredLang: 'eng', subLang: '', audioDevice: '', mpvArgs: '', mpvPath: '', ffprobePath: '', ffmpegPath: '',
  remote: true, remotePort: 8686, remotePin: '',
};

function readJson(f, fallback) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } }
function writeJson(f, v) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2)); }

let config = defaults;
let progress = {}; // id -> { pos, dur, updated, done? }  (for the current profile)
let profiles = null;
let currentId = 'main';
let needPick = false;   // show "Who's watching?"
const currentProfile = () => (profiles ? profiles.public(profiles.get(currentId)) : null);
let playing = false;
let library = [];
let remoteServer = null;

const isTv = () => TV_FLAG || !!config.tvMode;
// Full screen for the whole app (Settings → Full screen, F11, or the window's green button on a Mac); TV mode always is.
const wantFull = () => isTv() || !!config.appFullscreen;

// The Linux TV box (set up by the Screenroom installer) uses plain ALSA: pick the speaker/TV/headphone jack ourselves.
const isAppliance = () => process.platform === 'linux' && fs.existsSync('/etc/screenroom/appliance');
let mpvIds = null;
async function soundFor() {
  const choice = config.audioDevice || '';
  if (!isAppliance()) return { audioDevice: choice.startsWith('bt:') ? '' : choice, soundKind: process.platform === 'darwin' ? 'mac' : '' };
  try {
    if (!mpvIds) mpvIds = new Set((await listAudioDevices(findBinary('mpv', config.mpvPath))).map((d) => d.id));
    const r = await audio.resolve(choice, { passthrough: !!config.passthrough, mpvIds });
    return { audioDevice: r.device, passthrough: r.passthrough, downmix: r.stereo || config.downmix, notice: r.notice || '', soundKind: r.kind || '', passthroughWanted: !!config.passthrough, hdrOut: false, lightVideo: true,
      pcmChannels: r.kind === 'hdmi' || r.kind === 'other' ? audio.hdmiPcmChannels() : null };
  } catch {
    return { audioDevice: choice.startsWith('bt:') ? '' : choice };
  }
}

// ---- window / TV mode ---------------------------------------------------------
function applyZoom() {
  if (!win || win.isDestroyed()) return;
  // On a TV the UI is read from across the room: scale so the page behaves like a ~1600x900 screen.
  const h = win.getContentSize()[1];
  // TV: read from across the room, so everything is drawn big (the page behaves like a ~1350x760 screen).
  // "Big buttons" on a computer: a fixed, comfortable step up.
  win.webContents.setZoomFactor(isTv() ? Math.min(3, Math.max(1, h / 760)) : config.bigUi ? 1.3 : 1);
}

function applyTv() {
  if (!win || win.isDestroyed()) return;
  if (win.isFullScreen() !== wantFull()) win.setFullScreen(wantFull());
  win.setMenuBarVisibility(!isTv());
  applyZoom();
}

// The screen can change size after we start (a VM resizing its display, a TV waking up and
// reporting its real resolution). Re-fit the full-screen window so it never covers only part of it.
let refitTimer = null;
let lastRefit = 0;
let refitTries = 0; // the safety net gives up after a few tries (never a flickering loop)
// Linux TV box: the screen Screenroom should fill (the TV when one is plugged into a laptop, else the laptop).
const targetDisplay = () => { try { return screen.getPrimaryDisplay(); } catch { return null; } };
function refit(_e, _display, changed) {
  // Only on the Linux TV box (a Mac changes its "work area" every time a window goes full screen, which used
  // to start an endless full screen / windowed loop), only for a real change of the screen, and only
  // when the window doesn't already cover the screen it should.
  if (!isTv() || process.platform !== 'linux') return;
  if (playing) return; // never during a film (the check every few seconds catches up afterwards)
  if (Array.isArray(changed) && !changed.some((c) => c === 'bounds' || c === 'scaleFactor')) return;
  clearTimeout(refitTimer);
  refitTimer = setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    const t = targetDisplay();
    if (!t) return;
    const b = win.getBounds(), d = t.bounds;
    if (b.width === d.width && b.height === d.height && b.x === d.x && b.y === d.y) { refitTries = 0; applyZoom(); return; }
    if (Date.now() - lastRefit < 1500) { refit(null, null, ['bounds']); return; } // settle, then try again
    lastRefit = Date.now(); refitTries++;
    // Plugging a TV in or out: move the window onto the right screen at its size, full screen again,
    // and redo the text size for that screen (so nothing ends up tiny, huge or off the edge).
    win.setFullScreen(false);
    setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      win.setBounds(d);
      win.setFullScreen(true);
      setTimeout(() => { applyZoom(); if (!win.isDestroyed()) win.webContents.invalidate(); }, 300);
      setTimeout(() => { applyZoom(); }, 1500);
    }, 200);
  }, 700);
}
function watchDisplay() {
  screen.on('display-metrics-changed', refit);
  screen.on('display-added', (...a) => { refitTries = 0; refit(...a); });
  screen.on('display-removed', (...a) => { refitTries = 0; refit(...a); });
  // Safety net: keep checking that the window really matches the screen it should fill (a TV plugged in or
  // out without a clean screen event, a TV waking up and reporting its real size).
  setInterval(() => {
    if (!isTv() || process.platform !== 'linux' || !win || win.isDestroyed()) return;
    const t = targetDisplay(); if (!t) return;
    const b = win.getBounds(), d = t.bounds;
    if ((b.width !== d.width || b.height !== d.height || b.x !== d.x || b.y !== d.y) && refitTries < 3) refit(null, null, ['bounds']);
  }, 3000);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 600,
    backgroundColor: '#16110D',
    fullscreen: process.platform === 'darwin' ? false : wantFull(),
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    title: EDITION === 'music' ? 'Parlor' : 'Screenroom',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, additionalArguments: [`--sr-edition=${EDITION}`] },
  });
  if (isTv()) win.setMenuBarVisibility(false);
  // Remember full screen however it was switched (green button, menu, F11), so the app opens that way next time.
  const syncFull = () => {
    if (isTv() || !win || win.isDestroyed()) return;
    const fs_ = win.isFullScreen();
    if (!!config.appFullscreen !== fs_) { config.appFullscreen = fs_; writeJson(cfgFile(), config); win.webContents.send('config-changed', snapshot()); }
  };
  if (process.platform === 'darwin' && wantFull()) win.once('ready-to-show', () => { if (!win.isDestroyed() && !win.isFullScreen()) win.setFullScreen(true); });
  // (listen only after start-up, so the window going full screen at start isn't mistaken for a choice)
  setTimeout(() => { if (win && !win.isDestroyed()) { win.on('enter-full-screen', syncFull); win.on('leave-full-screen', syncFull); } }, 3000);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('did-finish-load', applyZoom);
  win.on('resize', applyZoom);
  watchDisplay();
}

// ---- library --------------------------------------------------------------------
function toolPaths() {
  return {
    ffprobe: findBinary('ffprobe', config.ffprobePath) || 'ffprobe',
    ffmpeg: findBinary('ffmpeg', config.ffmpegPath) || 'ffmpeg',
  };
}

// ---- Bluetooth speakers follow their connection (TV box) ------------------------------------------------
// A speaker that connects (from Settings, or by switching it on) becomes the sound output; when the chosen
// speaker switches off or goes out of range, sound goes back to Automatic. Music (and a film) move over live.
const btSeen = new Map(); // mac -> connected, as of the last look
let btGone = 0, btLooking = false, btWasOn = false, btTriedStart = false;
async function setSoundOutput(id, message) {
  config.audioDevice = id;
  writeJson(cfgFile(), config);
  sendWin('config-changed', snapshot());
  if (message) sendWin('notice', message);
  const s = await soundFor();
  // A film moves off a speaker that went away straight away; onto a speaker only from the next film (it may be
  // sending Dolby / DTS untouched, which a speaker can't take).
  if (playing) { if (!id.startsWith('bt:')) control(['set', 'audio-device', s.audioDevice || 'auto']); }
  else if (parlorApi && parlorApi.switchDevice) parlorApi.switchDevice(s.audioDevice || '');
}
async function btWatch() {
  if (btLooking || audio.btIsBusy()) return;
  btLooking = true;
  try { await btWatchNow(); } finally { btLooking = false; }
}
async function btWatchNow() {
  if (audio.btIsBusy()) return;
  const paired = ((await system.btStatus()).paired || []).filter((d) => d.audio);
  if (audio.btIsBusy()) return; // a connect started while we were looking
  const choice = (config.audioDevice || '').toUpperCase();
  const chosen = choice.startsWith('BT:') ? choice.slice(3) : '';
  const now = paired.find((d) => d.connected && btSeen.get(d.mac) === false && d.mac !== chosen);
  for (const d of paired) btSeen.set(d.mac, d.connected);
  if (now) { btGone = 0; btWasOn = true; await setSoundOutput(`bt:${now.mac}`, playing ? `${now.name} connected: sound plays there from the next film` : `${now.name} connected: sound plays there now`); return; }
  if (!chosen) { btGone = 0; return; }
  const c = paired.find((d) => d.mac === chosen);
  if (c && c.connected) { btGone = 0; btWasOn = true; btTriedStart = true; return; }
  // The box just started and the speaker sound was on isn't connected: try once to reconnect it first.
  if (!btTriedStart && c) { btTriedStart = true; await audio.btEnsureConnected(c.mac).catch(() => {}); return; }
  // two looks in a row (about 8 seconds) so a speaker that's only reconnecting doesn't flip the sound back and forth
  if (++btGone < 2) return;
  btGone = 0;
  // (no message when the box starts up with the speaker switched off)
  await setSoundOutput('', btWasOn ? `${(c && c.name) || 'The Bluetooth speaker'} disconnected: sound is back on Automatic` : '');
  btWasOn = false;
}

// ---- the computer's own buttons (TV box / laptop): power button menu, laptop brightness keys --------------
// deploy/screenroom-keys.py watches them (logind leaves a short press of the power button to us) and prints a
// line per press.
let lastResume = 0;
function backlight() {
  const dir = '/sys/class/backlight';
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return null; }
  const type = (n) => { try { return fs.readFileSync(path.join(dir, n, 'type'), 'utf8').trim(); } catch { return ''; } };
  const rank = { firmware: 0, platform: 1, raw: 2 };
  names.sort((a, b) => (rank[type(a)] ?? 3) - (rank[type(b)] ?? 3));
  return names[0] ? { name: names[0], dir: path.join(dir, names[0]) } : null;
}
function stepBrightness(up) {
  const b = backlight();
  if (!b) return;
  const rd = (f) => Number(fs.readFileSync(path.join(b.dir, f), 'utf8'));
  let max, cur;
  try { max = rd('max_brightness'); cur = rd('brightness'); } catch { return; }
  if (!max) return;
  const pctNow = (cur / max) * 100;
  // 5% steps; never all the way to black (a laptop screen at 0 looks switched off)
  const pct = Math.max(2, Math.min(100, up ? Math.floor(pctNow / 5 + 1.0001) * 5 : Math.ceil(pctNow / 5 - 1.0001) * 5));
  const val = Math.max(1, Math.round((pct / 100) * max));
  try { fs.writeFileSync(path.join(b.dir, 'brightness'), String(val)); }
  catch {
    // not allowed to write it directly (the box's setup hasn't run since this version): ask the login manager
    execFile('busctl', ['call', 'org.freedesktop.login1', '/org/freedesktop/login1/session/auto', 'org.freedesktop.login1.Session', 'SetBrightness', 'ssu', 'backlight', b.name, String(val)], () => {});
  }
  const msg = `Brightness ${Math.round(pct)}%`;
  if (playing) control(['script-message', 'nf-toast', msg]);
  else sendWin('brightness', Math.round(pct));
}
function onPowerButton() {
  if (Date.now() - lastResume < 4000) return; // the press that woke the computer up
  if (playing) control(['script-message', 'nf-power']);
  else { if (win && !win.isDestroyed()) win.focus(); sendWin('power-menu'); }
}
function startKeys() {
  const script = ['/usr/local/bin/screenroom-keys', path.join(process.resourcesPath || '', 'deploy', 'screenroom-keys.py'), path.join(__dirname, 'deploy', 'screenroom-keys.py')]
    .find((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } });
  if (!script) return;
  let child;
  try { child = spawn('python3', [script], { stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return; }
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const w = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (w === 'power') onPowerButton();
      else if (w === 'brightness_up' || w === 'brightness_down') stepBrightness(w === 'brightness_up');
    }
  });
  child.on('error', () => {});
  // stopped (python3-evdev missing, crashed): try again in a while
  child.on('exit', () => setTimeout(startKeys, 30000));
  app.on('will-quit', () => { try { child.kill(); } catch {} });
}

// ---- playback problems (Settings): films that stuttered, with what the box was doing -------------------
const problemsFile = () => path.join(dataDir(), 'playback-problems.json');
function problems() { try { return JSON.parse(fs.readFileSync(problemsFile(), 'utf8')); } catch { return []; } }
function noteStutter(statsFile, logFile) {
  let lines = [];
  try { lines = fs.readFileSync(statsFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return; }
  try { fs.unlinkSync(statsFile); } catch {}
  const list = problems();
  // Sound sent untouched (passthrough) that kept cutting out: what the player's log says about the sound output
  let log = '';
  try { log = fs.readFileSync(logFile, 'utf8').slice(-400000); } catch {}
  const underruns = (log.match(/underrun/gi) || []).length;
  const aoErrors = log.split('\n').filter((l) => /\[ao(\/alsa)?\]|\[ad\]|spdif/i.test(l) && /error|fail|lost|reopen|underrun|xrun/i.test(l)).slice(-3);
  const passthru = lines.find((s) => /spdif/i.test(s.audio_out || ''));
  if (passthru && (underruns || aoErrors.length)) {
    list.unshift({ at: Date.now(), title: passthru.title || path.basename(passthru.path || ''), code: 'Sound cut out',
      details: [`${passthru.audio || 'audio'} sent untouched (${passthru.audio_out}) to ${passthru.audio_dev || 'the default output'}`, underruns ? `${underruns} sound underruns` : '', ...aoErrors.map((l) => l.replace(/^\[[^\]]*\]\s*/, '').slice(0, 160))].filter(Boolean).join(' · ') });
  }
  for (const s of lines) {
    const drops = (s.dropped || 0) + (s.decoder_dropped || 0);
    const mins = (s.watched || 0) / 60;
    if (mins < 0.5 || drops < Math.max(24, mins * 6)) continue; // a few dropped frames now and then is normal
    const bits = [`${drops} frames dropped in ${Math.round(mins)} min`];
    bits.push(s.hwdec && s.hwdec !== 'no' ? `hardware decoding (${s.hwdec})` : 'decoded by the processor (no hardware decoding)');
    if (s.w) bits.push(`${s.w}×${s.h} ${s.codec || ''}`.trim());
    if (Number(s.fps) > 0) bits.push(`film ${Number(s.fps).toFixed(3).replace(/\.?0+$/, '')} fps`);
    if (Number(s.display_fps) > 0) bits.push(`screen ${Math.round(Number(s.display_fps))} Hz`);
    if (s.out_w) bits.push(`screen ${s.out_w}×${s.out_h}`);
    list.unshift({ at: Date.now(), title: s.title || path.basename(s.path || ''), code: 'Stuttered', details: bits.join(' · ') });
  }
  try { fs.writeFileSync(problemsFile(), JSON.stringify(list.slice(0, 10))); } catch {}
}

// Laptop battery (Linux): { percent, charging } or null on a computer without one.
function battery() {
  if (process.platform !== 'linux') return null;
  try {
    const dir = '/sys/class/power_supply';
    const bats = fs.readdirSync(dir).filter((n) => /^BAT/i.test(n));
    if (!bats.length) return null;
    let now = 0, full = 0, pct = null, charging = false;
    for (const b of bats) {
      const rd = (f) => { try { return fs.readFileSync(path.join(dir, b, f), 'utf8').trim(); } catch { return ''; } };
      const cap = Number(rd('capacity'));
      const st = rd('status');
      if (/Charging|Full/i.test(st)) charging = true;
      const en = Number(rd('energy_now') || rd('charge_now')), ef = Number(rd('energy_full') || rd('charge_full'));
      if (en && ef) { now += en; full += ef; } else if (!Number.isNaN(cap)) pct = cap;
    }
    const plugged = fs.readdirSync(dir).some((n) => { try { return fs.readFileSync(path.join(dir, n, 'type'), 'utf8').trim() === 'Mains' && fs.readFileSync(path.join(dir, n, 'online'), 'utf8').trim() === '1'; } catch { return false; } });
    const percent = full ? Math.round((now / full) * 100) : pct;
    return percent == null ? null : { percent: Math.max(0, Math.min(100, percent)), charging: charging || plugged };
  } catch { return null; }
}

// Themes: '2020s' (Matinee, the default), 'heirloom' (glossy light blue, to match
// the Heirloom tablet system, and the default there).
const THEMES = ['2020s', 'heirloom'];
const onHeirloom = (() => { try { return /^VARIANT_ID=heirloom$/m.test(fs.readFileSync('/etc/os-release', 'utf8')); } catch { return false; } })();
const defaultTheme = () => (onHeirloom || process.env.SCREENROOM_HEIRLOOM === '1' ? 'heirloom' : '2020s');
// The look: each profile picks its own theme, unless "same theme for every profile" is ticked.
function themeNow() {
  if (config.themeAll) return { theme: THEMES.includes(config.theme) ? config.theme : defaultTheme(), fx: !!config.retroFx };
  const p = currentProfile();
  return { theme: p && THEMES.includes(p.theme) ? p.theme : defaultTheme(), fx: !!(p && p.retroFx) };
}
// (the OpenSubtitles password stays in the main process)
function publicConfig() {
  const o = config.opensubtitles;
  return o ? { ...config, opensubtitles: { apiKey: o.apiKey || '', username: o.username || '', hasPassword: !!o.password } } : config;
}
function snapshot() {
  return {
    // Each profile only receives what it's allowed to see (kids profiles: by rating).
    library: library.filter((it) => core.allowedFor(it, currentProfile())), progress, config: publicConfig(), tv: isTv(), appliance: isAppliance(), ratings: ratings ? ratings.all() : {}, recs: recs ? recs.all() : [], watchedBy: watchedBy(), duplicates: (library.dups || []).length,
    profile: currentProfile(), profiles: profiles ? profiles.list() : [], pickProfile: needPick,
    drives, mediaDir: mediaRoot,
    platform: process.platform,
    canDelete: isAppliance() || !!process.env.SCREENROOM_TEST_DELETE,
    theme: themeNow().theme, retroFx: themeNow().fx, edition: EDITION,
    battery: battery(),
    playbackProblems: problems(),
    mpvFound: !!findBinary('mpv', config.mpvPath),
    ffprobeFound: !!findBinary('ffprobe', config.ffprobePath),
  };
}

// ---- USB drives + the folder uploads land in ------------------------------------------------
let drives = [];
let ratings = null;
let recs = null;
// Who's watched it: { itemId: [profile ids that finished it] } from every profile's progress.
function watchedBy() {
  const out = {};
  if (!profiles) return out;
  for (const p of profiles.list()) {
    const prog = p.id === currentId ? progress : profiles.loadProgress(p.id);
    for (const [id, v] of Object.entries(prog || {})) {
      if (v && (v.done || (v.dur > 0 && v.pos / v.dur > 0.9))) (out[id] || (out[id] = [])).push(p.id);
    }
  }
  return out;
}
let parlorApi = null;
let mediaRoot = null;

async function ensureMediaDir() {
  const root = config.mediaDir || transfer.defaultMediaDir();
  try { await fs.promises.mkdir(root, { recursive: true }); } catch { return null; }
  const covered = config.dirs.some((d) => root === d || root.startsWith(d + path.sep));
  if (!covered) { config.dirs = [...config.dirs, root]; writeJson(cfgFile(), config); }
  mediaRoot = root;
  return root;
}

// Drives that are plugged in count as part of the library while they're there.
function scanDirs() {
  if (EDITION === 'music') return []; // (Parlor on its own has no film library)
  const extra = drives.map((d) => d.mount).filter((m) => !config.dirs.some((d) => m === d || m.startsWith(d + path.sep)));
  return [...config.dirs, ...extra];
}

const sendWin = (ch, payload) => { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); };
const driveSig = (list) => list.map((d) => d.mount).sort().join('|');

async function pollDrives() {
  let next;
  try { next = await transfer.listDrives(); } catch { return; }
  const changed = driveSig(next) !== driveSig(drives);
  const prev = drives;
  drives = next;
  if (!changed) return;
  sendWin('drives-changed', {
    drives,
    added: drives.filter((n) => !prev.some((p) => p.mount === n.mount)).map((d) => d.label),
    removed: prev.filter((p) => !drives.some((n) => n.mount === p.mount)).map((d) => d.label),
  });
  if (!playing) doScan().then(() => sendWin('library-updated', snapshot())).catch(() => {});
}

async function runScan() {
  const dirs = scanDirs();
  if (!dirs.length) { library = []; library.dups = []; return library; }
  const t = toolPaths();
  library = await scan({
    dirs, dataDir: dataDir(), ffprobe: t.ffprobe, ffmpeg: t.ffmpeg,
    onProgress: (p) => win && !win.isDestroyed() && win.webContents.send('scan-progress', p),
  });
  return library;
}
// Scans run one at a time, so a background rescan never overlaps one you asked for.
let scanChain = Promise.resolve();
function doScan() {
  const p = scanChain.then(runScan);
  scanChain = p.catch(() => {});
  return p;
}

// New files show up on their own: rescan on launch and every half hour (cached, so it's quick).
function backgroundScan() {
  if (!config.dirs.length) return;
  doScan().then(() => { win && !win.isDestroyed() && win.webContents.send('library-updated', snapshot()); }).catch(() => {});
}

const scriptPath = () => (app.isPackaged
  ? path.join(process.resourcesPath, 'mpv', 'screenroom-player.lua')
  : path.join(__dirname, 'mpv', 'screenroom-player.lua'));

// Episodes of one series in watch order (season, then episode, then path).
function seriesEpisodes(seriesName) {
  const key = seriesName.toLowerCase();
  return library
    .filter((i) => i.tv && i.tv.series.toLowerCase() === key)
    .sort((a, b) => (a.tv.order - b.tv.order) || a.path.localeCompare(b.path));
}

// The chosen episode followed by every later one, so playback continues like a streaming service.
function episodesFrom(item) {
  const eps = seriesEpisodes(item.tv.series).filter((e) => core.allowedFor(e, currentProfile()));
  const at = eps.findIndex((e) => e.id === item.id);
  return at < 0 ? [item] : eps.slice(at);
}

// Text the on-screen player shows for each file (title, S1:E2, episode name, synopsis).
function metaFor(item) {
  if (item.tv) {
    return { title: item.tv.series, sub: `S${item.tv.season}:E${item.tv.label}`, name: item.tv.name, desc: item.description || '', fmt: core.formatBadges(item) };
  }
  return { title: item.title, sub: item.year ? String(item.year) : '', name: '', desc: item.description || '', fmt: core.formatBadges(item) };
}

// ---- phone remote ---------------------------------------------------------------
const remotePage = () => (app.isPackaged
  ? path.join(process.resourcesPath, 'remote', 'index.html')
  : path.join(__dirname, 'remote', 'index.html'));

// While something is playing the phone's D-pad works the player's on-screen controls like a TV remote
// (the phone page has its own skip / volume buttons); otherwise it drives the browse screens.
const PLAYER_KEYS = {
  up: ['keypress', 'UP'], down: ['keypress', 'DOWN'], left: ['keypress', 'LEFT'], right: ['keypress', 'RIGHT'],
  ok: ['keypress', 'ENTER'], back: ['keypress', 'ESC'], home: ['quit'],
};
const PLAYER_CMDS = {
  pause: ['cycle', 'pause'], seekback: ['seek', -10, 'relative+exact'], seekfwd: ['seek', 10, 'relative+exact'],
  next: ['playlist-next', 'force'], stop: ['quit'], volup: ['add', 'volume', 5], voldown: ['add', 'volume', -5],
  mute: ['cycle', 'mute'], audio: ['cycle', 'audio'], subs: ['cycle', 'sub'], fullscreen: ['cycle', 'fullscreen'],
};

function remoteLibrary() {
  const movies = [];
  const series = new Map();
  const prof = currentProfile();
  for (const it of library) {
    if (!core.allowedFor(it, prof)) continue;
    if (it.tv) {
      const key = it.tv.series.toLowerCase();
      if (!series.has(key)) series.set(key, { key, name: it.tv.series, kind: 'series', seasons: new Set(), episodes: 0 });
      const s = series.get(key); s.seasons.add(it.tv.season); s.episodes++;
    }
  }
  // the same movie in several qualities is listed once (opens the movie, where the quality can be picked)
  for (const g of core.groupMovies(library.filter((it) => core.allowedFor(it, prof)))) {
    movies.push({ key: g.versions[0].id, name: g.title, kind: 'movie', year: g.year });
  }
  const shows = [...series.values()].map((s) => ({ ...s, seasons: s.seasons.size }));
  return [...movies, ...shows].sort((a, b) => a.name.localeCompare(b.name));
}

const tell = (msg) => { if (win && !win.isDestroyed()) win.webContents.send('remote', msg); };

// Movie night: the vote runs in the window (renderer); it hands its state here for the phones to show,
// and phones' votes go back to it. Only the candidates' posters may be fetched.
let voteBlob = null;
const remoteHandlers = {
  library: remoteLibrary,
  profiles: () => (profiles ? profiles.list().map((p) => ({ id: p.id, name: p.name, color: p.color, kids: p.kids, avatar: p.avatar, hasPhoto: !!p.photo, hasPin: p.hasPin })) : []),
  photoFile: (id) => { const p = profiles && profiles.public(profiles.get(id)); return p && p.photo ? p.photo : null; },
  avatar: (id, bytes, ext, ppin) => {
    const target = profiles && profiles.get(id);
    if (!target) return { ok: false, error: 'Profile not found' };
    if (target.pinHash && !profiles.checkPin(id, ppin)) return { ok: false, error: 'That profile has a PIN — type it above the buttons.' };
    const r = profiles.setPhoto(id, bytes, ext);
    if (r.ok) sendWin('config-changed', snapshot());
    return r.ok ? { ok: true } : r;
  },
  voteState: () => voteBlob,
  vote: (v) => { if (voteBlob && voteBlob.open) tell({ type: 'vote', ...v }); },
  artFile: (id) => {
    if (!voteBlob || !(voteBlob.candidates || []).some((c) => c.art === id)) return null;
    const it = library.find((i) => i.id === id);
    return it ? (it.art || it.backdrop) : null;
  },
  key: (k) => {
    if (playing) { const c = PLAYER_KEYS[k]; if (c) control(c); return; }
    tell({ type: 'key', key: k });
  },
  player: (cmd) => {
    // No film playing: the phone's play/pause, skip and volume buttons work the Parlor's music instead.
    if (!playing && parlorApi) {
      const m = { pause: 'toggle', next: 'next', seekfwd: 'next', seekback: 'prev', volup: 'volup', voldown: 'voldown', stop: 'toggle' }[cmd];
      if (m && parlorApi.command(m)) return;
    }
    const c = PLAYER_CMDS[cmd]; if (c) control(c);
  },
  open: (key) => { if (!playing) tell({ type: 'open', key }); },
  search: (q) => { if (!playing) tell({ type: 'search', q }); },
  text: (t) => { if (!playing) tell({ type: 'text', text: t }); },
  info: async () => ({
    mediaDir: mediaRoot, free: await transfer.freeBytes(mediaRoot || os.homedir()),
    smb: smbUrls(), hostname: os.hostname(), drives: drives.map((d) => d.label),
  }),
  rescan: () => scheduleRescan(500),
  upload: async (rel, req, len) => {
    if (!mediaRoot) throw Object.assign(new Error('No media folder is set up'), { status: 500 });
    const r = await transfer.saveUpload({ root: mediaRoot, rel, stream: req, length: len });
    scheduleRescan(10000); // after the last file in a batch
    return r;
  },
};

let rescanTimer = null;
function scheduleRescan(ms) {
  clearTimeout(rescanTimer);
  rescanTimer = setTimeout(() => { if (!playing) doScan().then(() => sendWin('library-updated', snapshot())).catch(() => {}); }, ms);
}

function smbUrls() {
  if (process.platform !== 'linux') return [];
  return [`smb://${os.hostname()}.local`, ...remote.lanAddresses().map((a) => `smb://${a}`)];
}

function startRemote() {
  if (EDITION !== 'all') return; // (the phone remote is the TV box's)
  if (remoteServer) { remoteServer.close(); remoteServer = null; }
  if (!config.remote) return;
  if (!config.remotePin) {
    config.remotePin = String(crypto.randomInt(1000, 10000));
    writeJson(cfgFile(), config);
  }
  remoteServer = remote.start({
    port: Number(config.remotePort) || 8686,
    pin: () => config.remotePin,
    pageFile: remotePage(),
    avatarsFile: path.join(__dirname, 'renderer', 'avatars.js'),
    handlers: remoteHandlers,
    log: (m) => console.warn(m),
  });
}

function remoteInfo() {
  const port = Number(config.remotePort) || 8686;
  const urls = remote.lanAddresses().map((a) => `http://${a}:${port}`);
  let qr = '';
  if (config.remote && urls[0]) {
    try { const q = qrcode(0, 'M'); q.addData(`${urls[0]}/#pin=${config.remotePin}`); q.make(); qr = q.createSvgTag({ cellSize: 6, margin: 2, scalable: true }); } catch {}
  }
  return {
    enabled: !!config.remote, pin: config.remotePin, urls, qr,
    smb: smbUrls(), mediaDir: mediaRoot,
  };
}

// ---- app ------------------------------------------------------------------------
// One instance only: launching Screenroom again just brings the existing window forward.
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

app.whenReady().then(async () => {
  // Going to sleep (power button or Settings): pause the film so it's where you left it when the box wakes.
  powerMonitor.on('suspend', () => { if (playing) control(['set', 'pause', 'yes']); });
  powerMonitor.on('resume', () => { lastResume = Date.now(); });
  if (isAppliance()) startKeys();
  const firstRun = !fs.existsSync(cfgFile());
  config = { ...defaults, ...readJson(cfgFile(), {}) };
  // Screenroom on its own (e.g. on Heirloom): start with the Videos folder, if there is one.
  if (firstRun && EDITION === 'films') { const v = path.join(os.homedir(), 'Videos'); try { if (fs.statSync(v).isDirectory()) config.dirs = [v]; } catch {} }
  profiles = new Profiles(dataDir());
  ratings = new Ratings(dataDir());
  recs = new Recommendations(dataDir());
  currentId = profiles.last().id;
  needPick = profiles.needsPicker();
  progress = profiles.loadProgress(currentId);
  library = await loadCached(dataDir());
  await ensureMediaDir();
  drives = await transfer.listDrives().catch(() => []);
  createWindow();
  startRemote();
  // Parlor: each profile's music (see lib/parlor-ipc.js)
  parlorApi = setupParlor({
    ipcMain, dialog, getWin: () => win, dataDir, toolPaths, findMpv: () => findBinary('mpv', config.mpvPath),
    currentProfile, profilesList: () => profiles.list(), isMoviePlaying: () => playing,
    soundDevice: async () => (await soundFor()).audioDevice || '', mediaRoot: () => mediaRoot, drives: () => drives,
    exclusiveAudio: isAppliance,
  });
  win.webContents.once('did-finish-load', () => setTimeout(() => { backgroundScan(); parlorApi.rescan().catch(() => {}); }, 1500));
  setInterval(backgroundScan, 30 * 60 * 1000);
  setInterval(pollDrives, 5000);
  if (isAppliance()) setInterval(() => { btWatch().catch(() => {}); }, 4000);
  // Laptops: battery level for the top bar (and the player reads it itself)
  let lastBatt = '';
  setInterval(() => { const b = battery(); const k = JSON.stringify(b); if (k !== lastBatt) { lastBatt = k; sendWin('battery', b); } }, 30000);

  ipcMain.handle('state', () => snapshot());

  ipcMain.handle('scan', async () => { await doScan(); return snapshot(); });

  ipcMain.handle('drives', async () => { drives = await transfer.listDrives().catch(() => drives); return drives; });

  let copying = null;
  ipcMain.handle('drive-list', async (_e, mount, rel, kind) => {
    const d = drives.find((x) => x.mount === mount);
    if (!d) return { error: 'Drive not found' };
    try { return { entries: await transfer.listFolder(d.mount, String(rel || ''), kind === 'music' ? 'music' : 'video') }; } catch (e) { return { error: String(e.message || e) }; }
  });
  // Before a sync: how much is new on the drive (the rest is already on this box and is skipped).
  ipcMain.handle('drive-plan', async (_e, mount, kind) => {
    const d = drives.find((x) => x.mount === mount);
    if (!d) return { error: 'Drive not found' };
    const music = kind === 'music';
    let dest = mediaRoot;
    if (music) { try { dest = parlorApi && parlorApi.musicDestination(); } catch { dest = null; } }
    if (!dest) return { error: music ? 'Music can only be copied in a grown-up profile.' : 'No media folder is set up' };
    try {
      const p = await transfer.planCopy({ from: d.mount, to: dest, kind: music ? 'music' : 'video' });
      return { newFiles: p.newFiles, newBytes: p.newBytes, existing: p.existing, free: await transfer.freeBytes(dest) };
    } catch (e) { return { error: String(e.message || e) }; }
  });
  ipcMain.handle('drive-copy', async (_e, mount, only, kind) => {
    if (copying) return { error: 'A copy is already running' };
    const d = drives.find((x) => x.mount === mount);
    const music = kind === 'music';
    // music goes into this profile's music folder (the Parlor), films and shows into the library folder
    let dest = mediaRoot;
    if (music) { try { dest = parlorApi && parlorApi.musicDestination(); } catch { dest = null; } if (!dest) return { error: 'Music can only be copied in a grown-up profile.' }; }
    if (!d || !dest) return { error: 'Drive not found' };
    copying = { stop: false };
    try {
      const r = await transfer.copyTree({
        from: d.mount, to: dest, kind: music ? 'music' : 'video', cancel: copying, only: Array.isArray(only) ? only.map(String) : null,
        onProgress: (p) => sendWin('copy-progress', { ...p, label: d.label }),
      });
      if (music) { if (parlorApi) parlorApi.rescan().then(() => sendWin('parlor-updated', null)).catch(() => {}); return { ...r, music: true }; }
      doScan().then(() => sendWin('library-updated', snapshot())).catch(() => {});
      return r;
    } catch (e) { return { error: String(e.message || e) }; }
    finally { copying = null; }
  });
  ipcMain.handle('drive-copy-cancel', () => { if (copying) copying.stop = true; return true; });

  ipcMain.handle('drive-eject', async (_e, mount) => {
    const d = drives.find((x) => x.mount === mount);
    if (!d) return { ok: false, msg: 'Drive not found' };
    if (d.internal) return { ok: false, msg: 'That drive is built into this computer.' };
    const r = await transfer.eject(d);
    await pollDrives();
    return r;
  });

  // Screenroom's own folder / picture browser (Linux: instead of the system's file dialog).
  // dir '' = the starting places (home folders, plugged-in drives); mode 'folder' or 'image'.
  ipcMain.handle('browse', async (_e, dir, mode) => {
    const isDir = (d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } };
    if (!dir) {
      const home = os.homedir();
      const places = [];
      const add = (p, label, kind) => { if (isDir(p) && !places.some((x) => x.path === p)) places.push({ name: label, path: p, dir: true, kind }); };
      for (const d of drives) add(d.mount, d.label, 'drive');
      if (mediaRoot) add(mediaRoot, 'Screenroom library', 'folder');
      add(path.join(home, 'Music'), 'Music', 'folder');
      add(path.join(home, 'Videos'), 'Videos', 'folder');
      add(path.join(home, 'Pictures'), 'Pictures', 'folder');
      add(path.join(home, 'Downloads'), 'Downloads', 'folder');
      add(home, 'Home folder', 'home');
      return { dir: '', entries: places };
    }
    try {
      const IMG = /\.(jpe?g|png|webp|gif)$/i;
      const list = await fs.promises.readdir(dir, { withFileTypes: true });
      const entries = [];
      for (const d of list) {
        if (d.name.startsWith('.') || d.name === 'lost+found' || d.name === '$RECYCLE.BIN' || d.name === 'System Volume Information') continue;
        const full = path.join(dir, d.name);
        const folder = d.isDirectory() || (d.isSymbolicLink() && isDir(full));
        if (folder) entries.push({ name: d.name, path: full, dir: true });
        else if (mode === 'image' && IMG.test(d.name)) entries.push({ name: d.name, path: full, dir: false });
      }
      entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : a.dir ? -1 : 1));
      const home = os.homedir();
      const top = [home, ...['Music', 'Videos', 'Pictures', 'Downloads'].map((n) => path.join(home, n)), ...drives.map((d) => d.mount), mediaRoot].filter(Boolean).find((r) => dir === r);
      return { dir, name: path.basename(dir) || dir, parent: top || dir === '/' ? '' : path.dirname(dir), entries };
    } catch (e) { return { dir, name: path.basename(dir), parent: '', entries: [], error: 'This folder can\'t be opened.' }; }
  });

  // Settings → Free up space: films, shows and music stored on this box (USB drives are never touched).
  const internalRoots = () => {
    const onDrive = (p) => drives.some((d) => p === d.mount || cleanup.under(p, d.mount));
    return [...new Set([...config.dirs, mediaRoot].filter(Boolean))].filter((d) => !onDrive(d));
  };
  const deletableItems = () => { const roots = internalRoots(); return library.filter((i) => roots.some((r) => cleanup.under(i.path, r))); };
  const canDelete = () => isAppliance() || !!process.env.SCREENROOM_TEST_DELETE;
  ipcMain.handle('delete-list', async () => {
    if (!canDelete()) return { error: 'Only on the Screenroom box.' };
    if (currentProfile() && currentProfile().kids) return { error: 'Kids profiles can\'t delete anything.' };
    const films = [], shows = new Map();
    for (const i of deletableItems()) {
      if (!i.tv) { films.push({ id: i.id, title: i.title, year: i.year, size: i.size || 0 }); continue; }
      const key = i.tv.series;
      const sh = shows.get(key.toLowerCase()) || { series: key, size: 0, count: 0, seasons: new Map() };
      sh.size += i.size || 0; sh.count++;
      const sn = i.tv.season || 0;
      const se = sh.seasons.get(sn) || { season: sn, size: 0, count: 0 };
      se.size += i.size || 0; se.count++;
      sh.seasons.set(sn, se); shows.set(key.toLowerCase(), sh);
    }
    films.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true }));
    const showList = [...shows.values()].map((s) => ({ ...s, seasons: [...s.seasons.values()].sort((a, b) => a.season - b.season) }))
      .sort((a, b) => a.series.localeCompare(b.series, undefined, { sensitivity: 'base' }));
    const albums = parlorApi ? parlorApi.deletableAlbums() : [];
    const free = await transfer.freeBytes(mediaRoot || os.homedir());
    return { films, shows: showList, albums, free };
  });
  // Settings → Free up space → Remove lower-quality copies: tools/screenroom-dedupe.js (also a program of its own,
  // "screenroom-dedupe" on the box) finds films and episodes stored more than once and keeps the best copy.
  const runDedupe = (args, tool = 'screenroom-dedupe.js') => new Promise((resolve) => {
    execFile(process.execPath, [path.join(__dirname, 'tools', tool), '--json', '--data', dataDir(), ...args],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60 * 1000 }, (err, stdout, stderr) => {
        try { resolve(JSON.parse(String(stdout).trim().split('\n').pop())); }
        catch { resolve({ error: String(stderr || (err && err.message) || 'It stopped unexpectedly.').trim().split('\n').pop() }); }
      });
  });
  ipcMain.handle('dedupe-plan', async () => {
    if (!canDelete()) return { error: 'Only on the Screenroom box.' };
    if (currentProfile() && currentProfile().kids) return { error: 'Kids profiles can\'t delete anything.' };
    await doScan(); // (the tool works from the library list: make it up to date)
    const p = await runDedupe([]);
    if (!p.error) p.free = await transfer.freeBytes(mediaRoot || os.homedir());
    return p;
  });
  // Settings → Subtitles: tools/screenroom-subs.js (also "screenroom-subs" on the box) makes English subtitles
  // for films without any, from a DVD copy's subtitle pictures. Runs in the background; progress goes to Settings.
  let subsJob = null; // { running, i, total, title, made, failed }
  // tool: 'dvd' = read them from a DVD copy (screenroom-subs), 'net' = download them (screenroom-getsubs)
  const SUBS_TOOL = { dvd: 'screenroom-subs.js', net: 'screenroom-getsubs.js' };
  ipcMain.handle('subs-plan', async (_e, tool = 'dvd') => {
    if (currentProfile() && currentProfile().kids) return { error: 'Kids profiles can\'t change the films.' };
    await doScan();
    return runDedupe([], SUBS_TOOL[tool] || SUBS_TOOL.dvd);
  });
  ipcMain.handle('osub-account', (_e, a = {}) => {
    const cur = config.opensubtitles || {};
    config.opensubtitles = { apiKey: String(a.apiKey != null ? a.apiKey : cur.apiKey || '').trim(), username: String(a.username != null ? a.username : cur.username || '').trim(),
      password: a.password ? String(a.password) : (cur.password || '') };
    writeJson(cfgFile(), config);
    return snapshot();
  });
  ipcMain.handle('subs-status', () => subsJob);
  ipcMain.handle('subs-start', async (_e, paths, tool = 'dvd') => {
    if (subsJob && subsJob.running) return { error: 'Already making subtitles.' };
    const list = (Array.isArray(paths) ? paths : []).filter((x) => typeof x === 'string' && x);
    if (!list.length) return { error: 'Nothing chosen.' };
    subsJob = { running: true, tool, i: 0, total: list.length, title: '', made: 0, failed: [] };
    // (at low priority, so a film playing meanwhile doesn't stutter)
    const cmd = [process.execPath, path.join(__dirname, 'tools', SUBS_TOOL[tool] || SUBS_TOOL.dvd), '--json', '--apply', '--data', dataDir(), ...list.flatMap((x) => ['--only', x])];
    const nice = process.platform === 'linux' && fs.existsSync('/usr/bin/nice');
    const child = spawn(nice ? '/usr/bin/nice' : cmd[0], nice ? ['-n', '15', ...cmd] : cmd.slice(1),
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '', errText = '';
    child.stdout.on('data', (d) => {
      buf += d;
      let k;
      while ((k = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, k); buf = buf.slice(k + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.progress != null) Object.assign(subsJob, { i: m.progress, total: m.total, title: m.title });
        if (m.done) Object.assign(subsJob, { made: m.made, failed: m.failed || [], stopped: m.stopped || null });
        if (m.error) subsJob.error = m.error;
        sendWin('subs-progress', subsJob);
      }
    });
    child.stderr.on('data', (d) => { errText = (errText + d).slice(-2000); });
    child.on('error', (e) => { subsJob.error = e.message; });
    child.on('exit', async () => {
      subsJob.running = false;
      if (!subsJob.made && !subsJob.error && errText.trim()) subsJob.error = errText.trim().split('\n').pop();
      await doScan().catch(() => {});
      sendWin('library-updated', snapshot());
      sendWin('subs-progress', subsJob);
      sendWin('notice', subsJob.error ? `Subtitles: ${subsJob.error}`
        : `${subsJob.tool === 'net' ? 'Downloaded' : 'Made'} English subtitles for ${subsJob.made} of ${subsJob.total}${subsJob.failed.length ? ` (${subsJob.failed.length} not found or couldn't be lined up)` : ''}${subsJob.stopped ? `. ${subsJob.stopped}` : ''}`);
    });
    return { ok: true, job: subsJob };
  });

  ipcMain.handle('dedupe-apply', async (_e, paths) => {
    if (!canDelete()) return { error: 'Only on the Screenroom box.' };
    if (currentProfile() && currentProfile().kids) return { error: 'Kids profiles can\'t delete anything.' };
    if (playing) return { error: 'Stop the film first.' };
    const list = (Array.isArray(paths) ? paths : []).filter((x) => typeof x === 'string' && x);
    if (!list.length) return { error: 'Nothing chosen.' };
    const r = await runDedupe(['--apply', ...list.flatMap((x) => ['--only', x])]);
    if (r.error) return r;
    // where each profile was in a removed copy carries over to the copy that stays
    for (const pr of profiles.list()) {
      const prog = pr.id === currentId ? progress : profiles.loadProgress(pr.id);
      let changed = false;
      for (const m of r.moves || []) {
        const from = prog[m.from];
        if (!from) continue;
        if (!prog[m.to] || (from.updated || 0) > (prog[m.to].updated || 0)) prog[m.to] = from;
        delete prog[m.from]; changed = true;
      }
      if (changed) profiles.saveProgress(pr.id, prog);
    }
    await doScan();
    sendWin('library-updated', snapshot());
    return { ok: true, removed: r.removed, freed: r.freed, free: await transfer.freeBytes(mediaRoot || os.homedir()), state: snapshot() };
  });
  // what: { films: [id], shows: [{ series, seasons: [n] | null }], albums: [key] }
  ipcMain.handle('delete-media', async (_e, what) => {
    if (!canDelete()) return { error: 'Only on the Screenroom box.' };
    if (currentProfile() && currentProfile().kids) return { error: 'Kids profiles can\'t delete anything.' };
    if (playing) return { error: 'Stop the film first.' };
    const items = deletableItems();
    const films = new Set((what && what.films) || []);
    const files = [];
    for (const i of items) {
      if (!i.tv && films.has(i.id)) files.push(i.path);
      if (i.tv) {
        const pick = ((what && what.shows) || []).find((s) => s && String(s.series).toLowerCase() === i.tv.series.toLowerCase());
        if (pick && (!Array.isArray(pick.seasons) || pick.seasons.includes(i.tv.season || 0))) files.push(i.path);
      }
    }
    let removed = 0, freed = 0;
    if (files.length) {
      const r = await cleanup.removeMedia(files, internalRoots());
      removed += r.removed; freed += r.freed;
      await doScan();
    }
    if (parlorApi && what && Array.isArray(what.albums) && what.albums.length) {
      const r = await parlorApi.deleteAlbums(what.albums);
      removed += r.removed; freed += r.freed;
    }
    sendWin('library-updated', snapshot());
    return { ok: true, removed, freed, free: await transfer.freeBytes(mediaRoot || os.homedir()), state: snapshot() };
  });

  ipcMain.handle('add-dir', async (_e, picked) => {
    if (Array.isArray(picked)) {
      const ok = picked.filter((d) => typeof d === 'string' && d && fs.existsSync(d));
      if (!ok.length) return snapshot();
      config.dirs = [...new Set([...config.dirs, ...ok])];
      writeJson(cfgFile(), config);
      await doScan();
      return snapshot();
    }
    // Start where removable drives are mounted, if we can find it.
    const me = os.userInfo().username;
    const defaultPath = [`/media/${me}`, `/run/media/${me}`, '/media', '/mnt', os.homedir()].find((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
    const r = await dialog.showOpenDialog(win, { defaultPath, properties: ['openDirectory', 'multiSelections'] });
    if (r.canceled) return snapshot();
    config.dirs = [...new Set([...config.dirs, ...r.filePaths])];
    writeJson(cfgFile(), config);
    await doScan();
    return snapshot();
  });

  ipcMain.handle('remove-dir', async (_e, dir) => {
    config.dirs = config.dirs.filter((d) => d !== dir);
    writeJson(cfgFile(), config);
    await doScan();
    return snapshot();
  });

  ipcMain.handle('set-config', (_e, patch) => {
    const before = { ...config };
    config = { ...config, ...patch };
    writeJson(cfgFile(), config);
    if (('tvMode' in patch && patch.tvMode !== before.tvMode) || ('appFullscreen' in patch && patch.appFullscreen !== before.appFullscreen)) applyTv();
    if ('bigUi' in patch && patch.bigUi !== before.bigUi) applyZoom();
    if (('remote' in patch && patch.remote !== before.remote) || ('remotePort' in patch && patch.remotePort !== before.remotePort)) startRemote();
    return snapshot();
  });

  // Settings → Theme. all: true = this look for every profile (and the profile picker); false = just this profile.
  ipcMain.handle('set-theme', (_e, { theme, fx, all } = {}) => {
    if (all === true && !config.themeAll) {
      // ticking the box: everyone gets the look this profile has now
      const t = themeNow();
      config.theme = t.theme; config.retroFx = t.fx;
    }
    if (all != null) config.themeAll = !!all;
    if (config.themeAll) {
      if (theme != null) config.theme = THEMES.includes(theme) ? theme : '2020s';
      if (fx != null) config.retroFx = !!fx;
    } else if (currentId) profiles.setTheme(currentId, theme, fx);
    writeJson(cfgFile(), config);
    return snapshot();
  });

  ipcMain.handle('audio-devices', async () => {
    if (!isAppliance()) return listAudioDevices(findBinary('mpv', config.mpvPath));
    const paired = ((await system.btStatus()).paired || []).map((d) => d.mac);
    return audio.listOutputs(paired, config.audioDevice || '');
  });
  // Settings → Sound → Test sound: a short chime through the output a film would use now.
  ipcMain.handle('sound-test', async () => {
    const bin = findBinary('mpv', config.mpvPath);
    if (!bin) return { ok: false, error: 'mpv is missing' };
    const s = await soundFor();
    const args = ['--no-config', '--no-video', '--really-quiet', '--msg-level=all=error', '--volume=80', '--length=1.6',
      'av://lavfi:sine=frequency=660:sample_rate=48000', ...(s.audioDevice ? [`--audio-device=${s.audioDevice}`] : [])];
    return new Promise((resolve) => {
      execFile(bin, args, { timeout: 15000 }, (err, stdout, stderr) => {
        const msg = String(stderr || stdout || '').trim().split('\n').filter(Boolean).slice(-2).join(' ');
        const where = s.soundKind === 'bluetooth' ? 'the Bluetooth speaker' : s.soundKind === 'hdmi' ? 'the TV (HDMI)' : s.soundKind === 'analog' ? 'the headphone jack' : s.audioDevice ? s.audioDevice : 'the computer\'s speakers';
        resolve(err || /error|fail|could not/i.test(msg) ? { ok: false, error: msg || String(err && err.message), where, notice: s.notice || '' } : { ok: true, where, notice: s.notice || '' });
      });
    });
  });
  ipcMain.handle('remote-info', () => remoteInfo());
  // Linux appliance: Wi-Fi and Bluetooth (remotes, controllers)
  const linuxOnly = (fn) => async (...a) => (process.platform === 'linux' ? fn(...a) : { available: false, ok: false, message: 'Only on Linux' });
  ipcMain.handle('wifi-status', linuxOnly(() => system.wifiStatus()));
  ipcMain.handle('wifi-scan', linuxOnly(() => system.wifiScan()));
  ipcMain.handle('wifi-connect', linuxOnly((_e, ssid, pw) => system.wifiConnect(ssid, pw)));
  ipcMain.handle('bt-status', linuxOnly(() => system.btStatus()));
  const btBusyWhile = (fn) => async (...a) => { audio.btBusy(120000); try { return await fn(...a); } finally { audio.btBusy(0); } };
  ipcMain.handle('bt-scan', linuxOnly(btBusyWhile(() => system.btScan())));
  ipcMain.handle('bt-pair', linuxOnly(btBusyWhile((_e, mac) => system.btPair(mac))));
  // Connecting a speaker means you want to hear it: sound goes there (the Connect button in Settings).
  ipcMain.handle('bt-connect', linuxOnly(btBusyWhile(async (_e, mac) => {
    const r = await system.btConnect(mac);
    if (r.ok) {
      const i = await audio.btInfo(mac);
      if (i && i.audio) { btSeen.set(i.mac, true); btWasOn = true; await setSoundOutput(`bt:${i.mac}`); r.sound = true; }
    }
    return r;
  })));
  ipcMain.handle('bt-remove', linuxOnly(async (_e, mac) => {
    const r = await system.btRemove(mac);
    // Forgetting the speaker that sound was going to: back to Automatic.
    if (r.ok && (config.audioDevice || '').toUpperCase() === `BT:${String(mac).toUpperCase()}`) { config.audioDevice = ''; writeJson(cfgFile(), config); }
    return r;
  }));

  // Installed by the Screenroom installer as an "appliance": version, updates, maintenance login.
  ipcMain.handle('appliance-info', () => {
    const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
    const isAppliance = process.platform === 'linux' && fs.existsSync('/etc/screenroom/appliance');
    const maint = {};
    for (const line of read('/etc/screenroom/maintenance').split('\n')) { const m = line.match(/^(\w+)=(.*)$/); if (m) maint[m[1]] = m[2]; }
    let update = null;
    try { update = JSON.parse(read('/var/lib/screenroom/update-status.json')); } catch {}
    return { appliance: isAppliance, version: app.getVersion(), host: `${os.hostname()}.local`, maintenance: maint.user ? maint : null, update };
  });
  // A newer Screenroom on a plugged-in USB drive (the installer stick, or a screenroom_*.deb): no internet needed.
  const usbUpdates = () => {
    const out = [];
    const cmp = (a, b) => { const x = String(a).split(/[.+~-]/).map(Number), y = String(b).split(/[.+~-]/).map(Number); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; };
    for (const d of drives) {
      for (const dir of [path.join(d.mount, 'screenroom'), d.mount]) {
        let names = [];
        try { names = fs.readdirSync(dir); } catch { continue; }
        for (const n of names) {
          const m = n.match(/^screenroom_(.+)_amd64\.deb$/);
          if (m && cmp(m[1], app.getVersion()) > 0) out.push({ mount: d.mount, label: d.label, version: m[1] });
        }
      }
    }
    return out.sort((a, b) => cmp(b.version, a.version));
  };
  ipcMain.handle('usb-updates', () => (process.platform === 'linux' && fs.existsSync('/etc/screenroom/appliance') ? usbUpdates() : []));
  ipcMain.handle('usb-update', (_e, mount) => new Promise((resolve) => {
    const d = drives.find((x) => x.mount === mount);
    if (!d) return resolve({ ok: false, error: 'Drive not found' });
    try { fs.writeFileSync(path.join(app.getPath('userData'), 'update-from'), d.mount + '\n'); } catch (e) { return resolve({ ok: false, error: e.message }); }
    execFile('systemctl', ['start', '--no-block', 'screenroom-update.service'], (err) => resolve(err ? { ok: false, error: 'Could not start the update: ' + err.message.split('\n')[0] } : { ok: true }));
  }));
  ipcMain.handle('appliance-update', () => new Promise((resolve) => {
    execFile('systemctl', ['start', '--no-block', 'screenroom-update.service'], (err) => resolve(err ? { ok: false, error: /Access denied|not authorized/i.test(err.message)
      ? 'This box isn\'t set up to let Screenroom install updates. Set it up again with the newest installer USB, or run "sudo screenroom-update" over the maintenance login.'
      : 'Could not start the update: ' + err.message.split('\n')[0] } : { ok: true }));
  }));
  ipcMain.handle('quit', () => app.quit());
  ipcMain.handle('power', (_e, action) => new Promise((resolve) => {
    if (process.platform !== 'linux' || !['poweroff', 'reboot', 'suspend'].includes(action)) return resolve({ ok: false, error: 'Not available here' });
    execFile('systemctl', [action], (err) => resolve(err ? { ok: false, error: err.message } : { ok: true }));
  }));

  ipcMain.handle('play', async (_e, { id, audioTrack, fromStart }) => {
    if (playing) return { ok: false, error: 'Something is already playing.' };
    if (parlorApi) parlorApi.pause(); // music stops for the film
    const item = library.find((i) => i.id === id);
    if (!item) return { ok: false, error: 'Item not found' };

    const prev = progress[id];
    const start = !fromStart && prev && !prev.done && prev.pos ? prev.pos : 0;
    const queue = item.tv ? episodesFrom(item) : [item];
    const entries = queue.map((it) => ({ item: it, meta: metaFor(it) }));

    let lastSave = 0;
    const file = progFile();
    const save = () => { try { writeJson(file, progress); } catch {} lastSave = Date.now(); };
    const prof = currentProfile() || {};
    const getItem = (pid) => library.find((i) => i.id === pid);

    try {
      playing = true;
      const sound = await soundFor();
      await play(entries, { ...config, ...sound, tv: isTv(), fullscreen: !!config.fullscreen || wantFull(), appFullscreen: wantFull(), preferredLang: prof.preferredLang || config.preferredLang, subLang: prof.subLang || config.subLang, audioTrack, start, scriptPath: scriptPath(), theme: themeNow().theme }, {
        onProgress: (pid, pos, dur) => {
          if (pos <= 5) return; // don't clobber an existing resume point with the first few seconds
          progress[pid] = { pos, dur, updated: Date.now() };
          if (Date.now() - lastSave > 30000) save();
        },
        // Subtitles turned off (or to a language) in the player: remember it for this profile.
        onSubChoice: (lang) => {
          const p = currentProfile();
          if (!p || lang === undefined) return;
          const subLang = lang === 'no' ? '' : lang;
          if (lang !== 'no' && !lang) return; // a track without a language: nothing useful to remember
          if ((p.subLang || '') !== subLang) { try { profiles.upsert({ id: p.id, name: p.name, subLang }); } catch {} }
        },
        onSwitch: (pid, pos, dur, reason) => {
          const it = getItem(pid);
          const d = dur || (it && it.duration) || 0;
          const finished = reason === 'eof' || (reason !== 'error' && d > 0 && (pos / d > 0.94 || (d > 600 && d - pos < 60)));
          if (finished) progress[pid] = { pos: 0, dur: d, updated: Date.now(), done: true };
          else if (pos > 5) progress[pid] = { pos, dur: d, updated: Date.now() };
          save();
        },
        onExit: ({ code, log, stats }) => {
          playing = false;
          save();
          noteStutter(stats, log);
          if (code !== 0 && code !== null && win) {
            win.webContents.send('playback-error', `mpv stopped unexpectedly (code ${code}). Details are in ${log}`);
          }
          win && win.webContents.send('playback-ended', snapshot());
          if (win && !win.isDestroyed()) win.focus();
        },
      });
      return { ok: true };
    } catch (e) {
      playing = false;
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('set-watched', (_e, { ids, watched }) => {
    for (const id of ids) {
      const it = library.find((i) => i.id === id);
      if (!it) continue;
      if (watched) progress[id] = { pos: 0, dur: it.duration, updated: Date.now(), done: true };
      else delete progress[id];
    }
    writeJson(progFile(), progress);
    return snapshot();
  });

  // Settings → Continue Watching → Clear: forget where this profile stopped in films and episodes it hasn't
  // finished (what it finished stays marked as watched).
  ipcMain.handle('clear-in-progress', () => {
    for (const id of Object.keys(progress)) if (!progress[id].done) delete progress[id];
    writeJson(progFile(), progress);
    return snapshot();
  });

  ipcMain.handle('clear-problems', () => { try { fs.unlinkSync(problemsFile()); } catch {} return snapshot(); });
  ipcMain.handle('reveal', (_e, p) => shell.showItemInFolder(p));

  // ---- profiles ----------------------------------------------------------------------------------
  const slow = () => new Promise((r) => setTimeout(r, 600)); // after a wrong PIN
  const canManage = () => !(currentProfile() || {}).kids;
  // Star ratings: everyone sees everyone's (that's the point), each profile changes only its own.
  ipcMain.handle('vote-state', (_e, blob) => { voteBlob = blob && typeof blob === 'object' ? blob : null; return true; });
  ipcMain.handle('recommend', (_e, to, item) => {
    const p = currentProfile();
    if (p && Array.isArray(to)) recs.add(p.id, to.filter((id) => profiles.get(id)), item);
    return snapshot();
  });
  ipcMain.handle('rec-dismiss', (_e, id) => { const p = currentProfile(); if (p) recs.dismiss(String(id), p.id); return snapshot(); });
  ipcMain.handle('rate', (_e, key, stars) => {
    const p = currentProfile();
    if (!p || !ratings.set(key, p.id, stars)) return snapshot();
    return snapshot();
  });
  ipcMain.handle('profile-select', async (_e, id, pin) => {
    if (playing) return { ok: false, error: 'Stop playback first.' };
    if (!profiles.get(id)) return { ok: false, error: 'Profile not found' };
    if (!profiles.checkPin(id, pin)) { await slow(); return { ok: false, error: 'Wrong PIN' }; }
    if (id !== currentId && parlorApi) parlorApi.profileChanged();
    currentId = id;
    progress = profiles.loadProgress(id);
    needPick = false;
    profiles.setLast(id);
    return { ok: true, state: snapshot() };
  });
  ipcMain.handle('profile-picker', () => { if (!playing) needPick = true; return snapshot(); });
  // Changing someone else's PIN-protected profile needs their PIN; kids profiles can't manage profiles.
  const authorize = async (id, pin) => {
    if (!canManage()) return 'Kids profiles can\'t change profiles.';
    const target = id && profiles.get(id);
    if (target && id !== currentId && target.pinHash && !profiles.checkPin(id, pin)) { await slow(); return 'Wrong PIN'; }
    return null;
  };
  ipcMain.handle('profile-save', async (_e, input, pin) => {
    const err = await authorize(input && input.id, pin);
    if (err) return { ok: false, error: err };
    const r = profiles.upsert(input || {});
    return r.ok ? { ...r, state: snapshot() } : r;
  });
  ipcMain.handle('profile-set-pin', async (_e, id, newPin, pin) => {
    const err = await authorize(id, pin);
    if (err) return { ok: false, error: err };
    const r = profiles.setPin(id, newPin);
    return r.ok ? { ...r, state: snapshot() } : r;
  });
  // A photo from a file (Mac / Linux with a mouse); on the TV the phone remote sends one instead.
  ipcMain.handle('profile-photo', async (_e, id, pin, file) => {
    const err = await authorize(id, pin);
    if (err) return { ok: false, error: err };
    let f = typeof file === 'string' && file ? file : null;
    if (f && !/\.(jpe?g|png|webp|gif)$/i.test(f)) return { ok: false, error: 'Pick a JPEG, PNG, WebP or GIF picture' };
    if (!f) {
      const r = await dialog.showOpenDialog(win, { title: 'Choose a profile picture', properties: ['openFile'], filters: [{ name: 'Pictures', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }] });
      if (r.canceled || !r.filePaths[0]) return { ok: true, state: snapshot() };
      f = r.filePaths[0];
    }
    const res = profiles.setPhoto(id, fs.readFileSync(f), path.extname(f).slice(1));
    return res.ok ? { ...res, state: snapshot() } : res;
  });
  ipcMain.handle('profile-delete', async (_e, id, pin) => {
    const err = await authorize(id, pin);
    if (err) return { ok: false, error: err };
    const r = profiles.remove(id);
    if (!r.ok) return r;
    if (parlorApi) parlorApi.forget(id);
    if (ratings) ratings.forget(id);
    if (recs) recs.forget(id);
    if (id === currentId) { currentId = profiles.last().id; progress = profiles.loadProgress(currentId); needPick = profiles.needsPicker(); }
    return { ok: true, state: snapshot() };
  });

  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { if (parlorApi) parlorApi.quit(); });
