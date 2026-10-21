// Library scanner: walks folders, reads metadata embedded in MP4 files via ffprobe,
// extracts cover art (covr atom) and a backdrop frame via ffmpeg. No Electron dependency.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const VIDEO_EXT = new Set(['.mp4', '.m4v']);

function run(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stderr }));
      resolve(stdout);
    });
  });
}

async function* walk(dir) {
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (VIDEO_EXT.has(path.extname(e.name).toLowerCase())) yield full;
  }
}

const core = require('./media-core');
const { audioLabel, parseTv, applyTv, dedupeEpisodes } = core;

// Bump when buildItemFromProbe reads more from a file, so cached items are read again.
const ITEM_VERSION = 2;
function buildItem(file, stat, probe) {
  const id = crypto.createHash('sha1').update(file).digest('hex').slice(0, 16);
  const item = core.buildItemFromProbe(file, stat, probe, id);
  item.v = ITEM_VERSION;
  return item;
}


// ---- artwork ---------------------------------------------------------------
async function extractArt(item, probe, artDir, ffmpeg) {
  const streams = probe.streams || [];
  const cover = streams.find((s) => s.disposition && s.disposition.attached_pic);
  const out = {};
  if (cover) {
    const dest = path.join(artDir, `${item.id}-cover.jpg`);
    try {
      await run(ffmpeg, ['-y', '-v', 'error', '-i', item.path, '-map', `0:${cover.index}`, '-frames:v', '1', '-vf', 'scale=600:-2', dest]);
      out.art = dest;
    } catch { /* fall through to frame grab */ }
  }
  const back = path.join(artDir, `${item.id}-back.jpg`);
  const ts = Math.max(5, Math.floor((item.duration || 60) * 0.2));
  try {
    await run(ffmpeg, ['-y', '-v', 'error', '-ss', String(ts), '-i', item.path, '-frames:v', '1', '-vf', 'scale=1280:-2', '-q:v', '3', back]);
    out.backdrop = back;
  } catch { /* leave null */ }
  if (!out.art && out.backdrop) out.art = out.backdrop;
  return out;
}

// ---- scanning --------------------------------------------------------------
async function scan({ dirs, dataDir, ffprobe = 'ffprobe', ffmpeg = 'ffmpeg', onProgress = () => {}, concurrency = 4 }) {
  const artDir = path.join(dataDir, 'art');
  await fs.promises.mkdir(artDir, { recursive: true });
  const dbFile = path.join(dataDir, 'library.json');
  let cache = {};
  try { cache = JSON.parse(await fs.promises.readFile(dbFile, 'utf8')); } catch {}

  // Folders can overlap (e.g. both /media/share and /media/share/Shows are added), so never visit a file twice.
  const files = [];
  const seenFiles = new Set();
  for (const d of dirs) {
    for await (const f of walk(d)) {
      const k = path.resolve(f).normalize('NFC');
      if (seenFiles.has(k)) continue;
      seenFiles.add(k);
      files.push(f);
    }
  }

  const items = [];
  let done = 0;
  let idx = 0;
  async function worker() {
    while (idx < files.length) {
      const file = files[idx++];
      try {
        const stat = await fs.promises.stat(file);
        const hit = cache[file];
        const same = hit && hit.mtime === stat.mtimeMs && hit.size === stat.size && (!hit.art || fs.existsSync(hit.art));
        if (same && hit.v === ITEM_VERSION) {
          items.push(applyTv(hit));
        } else {
          const raw = await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
          const probe = JSON.parse(raw);
          const item = buildItem(file, stat, probe);
          // Unchanged file, just read again by a newer version: keep its artwork.
          if (same && (hit.art || hit.backdrop)) Object.assign(item, { art: hit.art, backdrop: hit.backdrop });
          else Object.assign(item, await extractArt(item, probe, artDir, ffmpeg));
          items.push(applyTv(item));
        }
      } catch (e) {
        onProgress({ error: `${file}: ${e.message}` });
      }
      onProgress({ done: ++done, total: files.length });
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  const next = {};
  for (const it of items) next[it.path] = it;
  await fs.promises.writeFile(dbFile, JSON.stringify(next));
  core.fillSeriesRatings(items);
  const deduped = dedupeEpisodes(items);
  const dups = deduped.dups;
  const finalItems = deduped.sort((a, b) => a.title.localeCompare(b.title));
  finalItems.dups = dups;
  return finalItems;
}

async function loadCached(dataDir) {
  try {
    const db = JSON.parse(await fs.promises.readFile(path.join(dataDir, 'library.json'), 'utf8'));
    const list = dedupeEpisodes(core.fillSeriesRatings(Object.values(db).map(applyTv)));
    const dups = list.dups;
    const sorted = list.sort((a, b) => a.title.localeCompare(b.title));
    sorted.dups = dups;
    return sorted;
  } catch { return []; }
}

module.exports = { scan, loadCached, buildItem, audioLabel, parseTv, dedupeEpisodes };
