const { app, BrowserWindow, ipcMain, dialog, shell, screen, powerMonitor } = require('electron');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { scan, loadCached } = require('./lib/library');
const { play, findBinary, control, listAudioDevices } = require('./lib/player');
const remote = require('./lib/remote');
const transfer = require('./lib/transfer');
const system = require('./lib/system');
const audio = require('./lib/audio');
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

app.setPath('userData', path.join(app.getPath('appData'), 'screenroom'));

// TV mode: fullscreen, scaled up for a TV, remote/gamepad friendly.
// Turn it on in Settings, or launch with `--tv` / SCREENROOM_TV=1 (what the mini-PC session does).
const TV_FLAG = process.argv.includes('--tv') || process.env.SCREENROOM_TV === '1';

let win;
const dataDir = () => app.getPath('userData');
const cfgFile = () => path.join(dataDir(), 'config.json');
// Watch progress belongs to the current profile (see lib/profiles.js).
const progFile = () => profiles.progressFile(currentId);

const defaults = {
  dirs: [], passthrough: false, downmix: false, levelVolume: true, fullscreen: true, tvMode: false,
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
    return { audioDevice: r.device, passthrough: r.passthrough, downmix: r.stereo || config.downmix, notice: r.notice || '', soundKind: r.kind || '', passthroughWanted: !!config.passthrough, hdrOut: false };
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
function refit(_e, _display, changed) {
  // Only on the Linux TV box (a Mac changes its "work area" every time a window goes full screen, which used
  // to start an endless full screen / windowed loop), only for a real change of the screen's size, and only
  // when the window doesn't already cover the screen.
  if (!isTv() || process.platform !== 'linux') return;
  if (Array.isArray(changed) && !changed.some((c) => c === 'bounds' || c === 'scaleFactor')) return;
  if (Date.now() - lastRefit < 5000) return;
  clearTimeout(refitTimer);
  refitTimer = setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds(), d = screen.getDisplayMatching(b).bounds;
    if (b.width === d.width && b.height === d.height && b.x === d.x && b.y === d.y) return;
    lastRefit = Date.now();
    win.setFullScreen(false);
    setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      win.setFullScreen(true);
      setTimeout(() => { applyZoom(); if (!win.isDestroyed()) win.webContents.invalidate(); }, 200);
    }, 150);
  }, 250);
}
function watchDisplay() {
  screen.on('display-metrics-changed', refit);
  screen.on('display-added', refit);
  screen.on('display-removed', refit);
  // Safety net: a few seconds after start, make sure the window really matches the screen.
  for (const ms of [1500, 4000, 9000]) {
    setTimeout(() => {
      if (!isTv() || !win || win.isDestroyed()) return;
      const b = win.getBounds(), d = screen.getDisplayMatching(b).bounds;
      if (b.width !== d.width || b.height !== d.height) refit(null, null, ['bounds']);
    }, ms);
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 600,
    backgroundColor: '#141414',
    fullscreen: process.platform === 'darwin' ? false : wantFull(),
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
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

function snapshot() {
  return {
    // Each profile only receives what it's allowed to see (kids profiles: by rating).
    library: library.filter((it) => core.allowedFor(it, currentProfile())), progress, config, tv: isTv(), appliance: isAppliance(), ratings: ratings ? ratings.all() : {}, recs: recs ? recs.all() : [], watchedBy: watchedBy(), duplicates: (library.dups || []).length,
    profile: currentProfile(), profiles: profiles ? profiles.list() : [], pickProfile: needPick,
    drives, mediaDir: mediaRoot,
    platform: process.platform,
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
  ? path.join(process.resourcesPath, 'mpv', 'netflix.lua')
  : path.join(__dirname, 'mpv', 'netflix.lua'));

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
  config = { ...defaults, ...readJson(cfgFile(), {}) };
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

  ipcMain.handle('state', () => snapshot());

  ipcMain.handle('scan', async () => { await doScan(); return snapshot(); });

  ipcMain.handle('drives', async () => { drives = await transfer.listDrives().catch(() => drives); return drives; });

  let copying = null;
  ipcMain.handle('drive-list', async (_e, mount, rel) => {
    const d = drives.find((x) => x.mount === mount);
    if (!d) return { error: 'Drive not found' };
    try { return { entries: await transfer.listFolder(d.mount, String(rel || '')) }; } catch (e) { return { error: String(e.message || e) }; }
  });
  ipcMain.handle('drive-copy', async (_e, mount, only) => {
    if (copying) return { error: 'A copy is already running' };
    const d = drives.find((x) => x.mount === mount);
    if (!d || !mediaRoot) return { error: 'Drive not found' };
    copying = { stop: false };
    try {
      const r = await transfer.copyTree({
        from: d.mount, to: mediaRoot, cancel: copying, only: Array.isArray(only) ? only.map(String) : null,
        onProgress: (p) => sendWin('copy-progress', { ...p, label: d.label }),
      });
      doScan().then(() => sendWin('library-updated', snapshot())).catch(() => {});
      return r;
    } catch (e) { return { error: String(e.message || e) }; }
    finally { copying = null; }
  });
  ipcMain.handle('drive-copy-cancel', () => { if (copying) copying.stop = true; return true; });

  ipcMain.handle('drive-eject', async (_e, mount) => {
    const d = drives.find((x) => x.mount === mount);
    if (!d) return { ok: false, msg: 'Drive not found' };
    const r = await transfer.eject(d);
    await pollDrives();
    return r;
  });

  ipcMain.handle('add-dir', async () => {
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

  ipcMain.handle('audio-devices', async () => {
    if (!isAppliance()) return listAudioDevices(findBinary('mpv', config.mpvPath));
    const paired = ((await system.btStatus()).paired || []).map((d) => d.mac);
    return audio.listOutputs(paired, config.audioDevice || '');
  });
  ipcMain.handle('remote-info', () => remoteInfo());
  // Linux appliance: Wi-Fi and Bluetooth (remotes, controllers)
  const linuxOnly = (fn) => async (...a) => (process.platform === 'linux' ? fn(...a) : { available: false, ok: false, message: 'Only on Linux' });
  ipcMain.handle('wifi-status', linuxOnly(() => system.wifiStatus()));
  ipcMain.handle('wifi-scan', linuxOnly(() => system.wifiScan()));
  ipcMain.handle('wifi-connect', linuxOnly((_e, ssid, pw) => system.wifiConnect(ssid, pw)));
  ipcMain.handle('bt-status', linuxOnly(() => system.btStatus()));
  ipcMain.handle('bt-scan', linuxOnly(() => system.btScan()));
  ipcMain.handle('bt-pair', linuxOnly((_e, mac) => system.btPair(mac)));
  ipcMain.handle('bt-connect', linuxOnly((_e, mac) => system.btConnect(mac)));
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
      await play(entries, { ...config, ...sound, tv: isTv(), fullscreen: !!config.fullscreen || wantFull(), appFullscreen: wantFull(), preferredLang: prof.preferredLang || config.preferredLang, subLang: prof.subLang || config.subLang, audioTrack, start, scriptPath: scriptPath() }, {
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
        onExit: ({ code, log }) => {
          playing = false;
          save();
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
  ipcMain.handle('profile-photo', async (_e, id, pin) => {
    const err = await authorize(id, pin);
    if (err) return { ok: false, error: err };
    const r = await dialog.showOpenDialog(win, { title: 'Choose a profile picture', properties: ['openFile'], filters: [{ name: 'Pictures', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }] });
    if (r.canceled || !r.filePaths[0]) return { ok: true, state: snapshot() };
    const f = r.filePaths[0];
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
