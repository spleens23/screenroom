// Getting media onto the box: browser uploads, USB drives, and copying a drive into the library.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

// Files worth keeping. Screenroom plays MP4/M4V; the rest ride along with them.
const ALLOWED = new Set(['.mp4', '.m4v', '.srt', '.vtt', '.ass', '.ssa', '.jpg', '.jpeg', '.png']);
const RESERVE = 1024 * 1024 * 1024; // always leave 1 GB free

const isAllowed = (name) => ALLOWED.has(path.extname(name).toLowerCase());
// music: songs, and the album covers that sit next to them
const MUSIC = new Set(['.mp3', '.m4a', '.aac', '.flac', '.alac', '.ogg', '.oga', '.opus', '.wav', '.aif', '.aiff', '.wma', '.ape', '.wv', '.jpg', '.jpeg', '.png']);
const isMusic = (name) => MUSIC.has(path.extname(name).toLowerCase());
const filterFor = (kind) => (kind === 'music' ? isMusic : isAllowed);

/** Turn a client-supplied relative path ("Show/Season 1/S01E01.mp4") into safe path parts, or null. */
function safeParts(rel) {
  const parts = String(rel || '').normalize('NFC').split(/[\\/]+/)
    .map((p) => p.replace(/[\u0000-\u001f]/g, '').trim())
    .filter((p) => p && p !== '.' && p !== '..');
  if (!parts.length || parts.some((p) => p.length > 200)) return null;
  return parts;
}

function defaultMediaDir() {
  const home = os.homedir();
  if (process.platform === 'linux') {
    try { fs.accessSync('/srv/media', fs.constants.W_OK); return '/srv/media'; } catch {}
    return path.join(home, 'Media');
  }
  return path.join(home, 'Movies', 'Screenroom');
}

async function freeBytes(dir) {
  try { const s = await fs.promises.statfs(dir); return Number(s.bavail) * Number(s.bsize); } catch { return null; }
}

/**
 * Save an uploaded file stream under root/rel. Written to a ".part" file first so a half-sent
 * movie never shows up in the library. Returns { path, skipped }.
 */
async function saveUpload({ root, rel, stream, length }) {
  const parts = safeParts(rel);
  if (!parts) throw Object.assign(new Error('bad file name'), { status: 400 });
  const name = parts[parts.length - 1];
  if (!isAllowed(name)) {
    throw Object.assign(new Error(`${path.extname(name) || 'This file type'} isn't supported. Screenroom plays .mp4 / .m4v files.`), { status: 415 });
  }
  const dest = path.join(root, ...parts);
  if (!path.resolve(dest).startsWith(path.resolve(root) + path.sep)) throw Object.assign(new Error('bad path'), { status: 400 });

  // Already there with the same size? Nothing to do.
  try {
    const st = await fs.promises.stat(dest);
    if (length != null && st.size === length) { stream.resume(); return { path: dest, skipped: true }; }
  } catch {}

  const free = await freeBytes(root);
  if (free != null && length != null && length + RESERVE > free) {
    stream.resume();
    throw Object.assign(new Error('Not enough free space on the box'), { status: 507 });
  }

  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmp);
    let failed = false;
    const fail = (e) => { if (failed) return; failed = true; out.destroy(); fs.promises.unlink(tmp).catch(() => {}); reject(e); };
    stream.on('error', fail);
    stream.on('aborted', () => fail(new Error('upload cancelled')));
    out.on('error', fail);
    out.on('finish', resolve);
    stream.pipe(out);
  });
  await fs.promises.rename(tmp, dest);
  return { path: dest, skipped: false };
}

// ---- USB drives -------------------------------------------------------------------------------
const OK_FS = /^(exfat|ntfs|ntfs3|fuseblk|vfat|msdos|ext[234]|btrfs|xfs|hfsplus|hfs|apfs|f2fs|iso9660|udf)$/i;
const unescapeMount = (s) => s.replace(/\\([0-7]{3})/g, (_m, o) => String.fromCharCode(parseInt(o, 8)));

/** Removable / external drives that are mounted right now. */
async function listDrives() {
  const out = [];
  // (automated tests: pretend these folders are plugged-in drives)
  if (process.env.SCREENROOM_TEST_DRIVES) { try { return JSON.parse(process.env.SCREENROOM_TEST_DRIVES).map((d) => ({ device: '', fs: 'exfat', ...d })); } catch {} }
  if (process.platform === 'linux') {
    let text = '';
    try { text = await fs.promises.readFile('/proc/self/mounts', 'utf8'); } catch { return out; }
    const seen = new Set();
    for (const line of text.split('\n')) {
      const [dev, mnt0, type] = line.split(' ');
      if (!dev || !dev.startsWith('/dev/') || !mnt0) continue;
      const mount = unescapeMount(mnt0);
      if (!OK_FS.test(type)) continue;
      // Only places where drives get mounted for people (not /, /boot, snaps...).
      if (!/^\/(media|run\/media|mnt)\//.test(mount)) continue;
      if (seen.has(mount)) continue;
      seen.add(mount);
      out.push({ mount, device: dev, fs: type, label: path.basename(mount) });
    }
  } else if (process.platform === 'darwin') {
    let names = [];
    try { names = await fs.promises.readdir('/Volumes'); } catch { return out; }
    for (const n of names) {
      const mount = path.join('/Volumes', n);
      try { if (fs.realpathSync(mount) === '/') continue; } catch { continue; }
      out.push({ mount, device: '', fs: '', label: n });
    }
  }
  for (const d of out) d.internal = await isInternal(d);
  for (const d of out) {
    try { const s = await fs.promises.statfs(d.mount); d.total = Number(s.blocks) * Number(s.bsize); d.free = Number(s.bavail) * Number(s.bsize); } catch {}
  }
  return out;
}

/** A drive built into the computer (it can't be unplugged, so it gets no Eject button). USB drives, SD cards
 *  and anything marked removable count as external; when in doubt, external. */
async function isInternal(d) {
  try {
    if (process.platform === 'linux') {
      if (!d.device) return false;
      const name = path.basename(fs.realpathSync(d.device));
      if (/^(loop|sr)/.test(name)) return false;
      let sys = fs.realpathSync(path.join('/sys/class/block', name));
      if (/\/usb\d*\/|\/mmc_host\/|\/memstick/.test(sys)) return false;
      if (fs.existsSync(path.join(sys, 'partition'))) sys = path.dirname(sys); // a partition: look at its disk
      const removable = fs.readFileSync(path.join(sys, 'removable'), 'utf8').trim() === '1';
      return !removable;
    }
    if (process.platform === 'darwin') {
      const info = await new Promise((r) => execFile('diskutil', ['info', '-plist', d.mount], { timeout: 8000 }, (e, so) => r(e ? '' : String(so))));
      const flag = (k) => new RegExp(`<key>${k}</key>\\s*<true/>`).test(info);
      if (!info) return false;
      return flag('Internal') && !flag('Ejectable') && !flag('RemovableMediaOrExternalDevice');
    }
  } catch {}
  return false;
}

function eject(drive) {
  return new Promise((resolve) => {
    const run = (cmd, args) => new Promise((r) => execFile(cmd, args, { timeout: 20000 }, (e, so, se) => r({ ok: !e, msg: String(se || so || (e && e.message) || '').trim() })));
    (async () => {
      if (process.platform === 'darwin') return resolve(await run('diskutil', ['eject', drive.mount]));
      const u = await run('udisksctl', ['unmount', '-b', drive.device]);
      if (!u.ok) return resolve(u);
      await run('udisksctl', ['power-off', '-b', drive.device]); // best effort
      resolve({ ok: true, msg: '' });
    })();
  });
}

// ---- copy a drive into the library -------------------------------------------------------------------
async function* walkFiles(dir, ok = isAllowed) {
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (skipName(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkFiles(full, ok);
    else if (ok(e.name)) yield full;
  }
}

// (names exactly as they are on the drive: no Unicode clean-up, or accented names wouldn't be found)
const relParts = (rel) => { const p = String(rel || '').split(/[\\/]+/).filter((x) => x && x !== '.' && x !== '..'); return p.length ? p : null; };
const skipName = (n) => n.startsWith('.') || n === 'System Volume Information' || n === '$RECYCLE.BIN';

/**
 * One folder of a drive for the "Choose what to copy" list: its sub-folders that hold videos (with how many
 * files and how big) and its own video / subtitle / picture files. rel is relative to the drive ('' = top).
 */
async function listFolder(root, rel, kind = 'video') {
  const ok = filterFor(kind);
  const parts = rel ? relParts(rel) : [];
  if (!parts) throw new Error('Bad folder');
  const dir = path.join(root, ...parts);
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { throw new Error('That folder can\'t be opened'); }
  const out = [];
  for (const e of entries) {
    if (skipName(e.name)) continue;
    const r = parts.concat(e.name).join('/');
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      let count = 0, size = 0;
      for await (const f of walkFiles(full, ok)) { if (kind === 'music' && /\.(jpe?g|png)$/i.test(f)) continue; count++; try { size += (await fs.promises.stat(f)).size; } catch {} }
      if (count) out.push({ name: e.name, rel: r, dir: true, count, size });
    } else if (ok(e.name)) {
      let size = 0; try { size = (await fs.promises.stat(full)).size; } catch {}
      out.push({ name: e.name, rel: r, dir: false, size });
    }
  }
  out.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return out;
}

/**
 * What a copy would do: every chosen file on the drive, where it goes, and whether this box already has it
 * (same name and size, wherever it is in the library — so a sync never copies anything twice, even after
 * files were moved around on the box).
 */
async function planCopy({ from, to, only = null, kind = 'video' }) {
  const picked = only && only.length ? only.map((r) => (relParts(r) || []).join('/')).filter(Boolean) : null;
  const wanted = (f) => {
    if (!picked) return true;
    const rel = path.relative(from, f).split(path.sep).join('/');
    return picked.some((p) => rel === p || rel.startsWith(p + '/'));
  };
  // what's already on the box: "name|size"
  const have = new Set();
  // (films, episodes and songs only: covers and subtitles often share a name and size without being the same file)
  const big = (f) => !/\.(jpe?g|png|srt|vtt|ass|ssa)$/i.test(f);
  for await (const f of walkFiles(to, filterFor(kind))) {
    if (!big(f)) continue;
    try { have.add(`${path.basename(f).toLowerCase()}|${(await fs.promises.stat(f)).size}`); } catch {}
  }
  const files = [];
  let newBytes = 0, existing = 0;
  for await (const f of walkFiles(from, filterFor(kind))) {
    if (!wanted(f)) continue;
    const st = await fs.promises.stat(f);
    let parts = path.relative(from, f).split(path.sep);
    // music: an outer "Music" / "iTunes Media" folder on the drive isn't repeated inside the music folder
    if (kind === 'music') while (parts.length > 2 && /^(music|my music|itunes|itunes media|itunes music|audio)$/i.test(parts[0])) parts = parts.slice(1);
    const dest = path.join(to, ...parts);
    let got = big(f) && have.has(`${path.basename(f).toLowerCase()}|${st.size}`);
    if (!got) { try { got = (await fs.promises.stat(dest)).size === st.size; } catch {} }
    if (got) existing++; else newBytes += st.size;
    files.push({ f, size: st.size, dest, got });
  }
  // films: covers and subtitles only come along when they sit next to a video (not an album's cover.jpg)
  if (kind !== 'music') {
    const isVid = (f) => /\.(mp4|m4v)$/i.test(f);
    const vidDirs = new Set(files.filter((x) => isVid(x.f)).map((x) => path.dirname(x.f)));
    const keep = files.filter((x) => isVid(x.f) || vidDirs.has(path.dirname(x.f)));
    return { files: keep, newFiles: keep.filter((x) => !x.got).length, newBytes: keep.filter((x) => !x.got).reduce((t, x) => t + x.size, 0), existing: keep.filter((x) => x.got).length };
  }
  return { files, newFiles: files.filter((x) => !x.got).length, newBytes, existing };
}

/**
 * Copy every video/subtitle/image under `from` into `to`, keeping folder layout — only what the box doesn't
 * have yet (a sync). only: a list of files / folders (relative to `from`) instead of everything.
 * onProgress({ file, index, total, bytesDone, bytesTotal }); cancel.stop = true to stop.
 */
async function copyTree({ from, to, only = null, kind = 'video', onProgress = () => {}, cancel = {} }) {
  const plan = await planCopy({ from, to, only, kind });
  const files = plan.files.filter((x) => !x.got);
  const bytesTotal = plan.newBytes;
  const free = await freeBytes(to);
  if (free != null && bytesTotal + RESERVE > free) {
    const need = Math.ceil((bytesTotal + RESERVE - free) / 1e9);
    throw Object.assign(new Error(`Not enough space: about ${need} GB more is needed`), { status: 507 });
  }
  let bytesDone = 0, copied = 0;
  const skipped = plan.existing;
  for (let i = 0; i < files.length; i++) {
    if (cancel.stop) break;
    const { f, dest } = files[i];
    onProgress({ file: path.basename(f), index: i + 1, total: files.length, bytesDone, bytesTotal });
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.part`;
    let last = 0;
    await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(f), ws = fs.createWriteStream(tmp);
      rs.on('data', (c) => {
        if (cancel.stop) { rs.destroy(); return; }
        last += c.length;
        if (last > 8 * 1024 * 1024) { bytesDone += last; last = 0; onProgress({ file: path.basename(f), index: i + 1, total: files.length, bytesDone, bytesTotal }); }
      });
      rs.on('error', reject); ws.on('error', reject);
      ws.on('finish', resolve); rs.on('close', () => { if (cancel.stop) ws.end(); });
      rs.pipe(ws);
    }).catch(async (e) => { await fs.promises.unlink(tmp).catch(() => {}); throw e; });
    bytesDone += last;
    if (cancel.stop) { await fs.promises.unlink(tmp).catch(() => {}); break; }
    await fs.promises.rename(tmp, dest);
    copied++;
  }
  return { copied, skipped, total: files.length + skipped, cancelled: !!cancel.stop };
}

module.exports = { saveUpload, safeParts, isAllowed, defaultMediaDir, freeBytes, listDrives, isInternal, eject, copyTree, planCopy, listFolder, ALLOWED };
