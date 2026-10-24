// Deleting films, episodes and songs from the box's own storage (Settings → Free up space).
// Only ever inside the library's own folders (never a folder itself that you added, never a USB drive):
// the files you picked go, with their subtitles / posters next to them, and any folder that has no films or
// songs left in it afterwards (a film's folder, an empty season, an album's folder with just its cover).
const fs = require('fs');
const path = require('path');

const MEDIA = /\.(mp4|m4v|mkv|avi|mov|webm|ts|m2ts|mts|wmv|mpe?g|flac|mp3|m4a|aac|ogg|oga|opus|wav|aiff?|alac|wma|dsf|dff|ape|wv)$/i;

const under = (p, root) => p !== root && p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
const rootOf = (p, roots) => roots.filter((r) => under(p, r)).sort((a, b) => b.length - a.length)[0] || null;

async function sizeOf(p) {
  let st;
  try { st = await fs.promises.lstat(p); } catch { return 0; }
  if (!st.isDirectory()) return st.size;
  let total = 0;
  let list = [];
  try { list = await fs.promises.readdir(p); } catch { return 0; }
  for (const n of list) total += await sizeOf(path.join(p, n));
  return total;
}

async function hasMedia(dir) {
  let list = [];
  try { list = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of list) {
    if (e.isDirectory()) { if (await hasMedia(path.join(dir, e.name))) return true; }
    else if (MEDIA.test(e.name)) return true;
  }
  return false;
}

// Files next to a video / song that belong to it: "Film.en.srt", "Film-poster.jpg", "Film.nfo"…
async function sidecars(file) {
  const dir = path.dirname(file);
  const stem = path.basename(file, path.extname(file));
  let names = [];
  try { names = await fs.promises.readdir(dir); } catch { return []; }
  return names.filter((n) => n !== path.basename(file) && !MEDIA.test(n) && n.startsWith(stem) && /^[.\-_ ]/.test(n.slice(stem.length)))
    .map((n) => path.join(dir, n));
}

/**
 * Delete these media files (and what belongs to them). roots: the library's folders on this computer; a file
 * outside them is left alone. Returns { removed, freed, skipped }.
 */
async function removeMedia(files, roots) {
  roots = roots.filter(Boolean).map((r) => path.resolve(r));
  let freed = 0, removed = 0, skipped = 0;
  const dirs = new Set();
  for (const f0 of new Set(files)) {
    const f = path.resolve(f0);
    const root = rootOf(f, roots);
    if (!root || !MEDIA.test(f)) { skipped++; continue; }
    for (const x of [f, ...(await sidecars(f))]) {
      const sz = await sizeOf(x);
      try { await fs.promises.unlink(x); freed += sz; if (x === f) removed++; } catch { if (x === f) skipped++; }
    }
    dirs.add(path.dirname(f));
  }
  // folders left without any films / songs: gone too, up to (never including) the library folder itself
  for (const d0 of [...dirs].sort((a, b) => b.length - a.length)) {
    let d = d0;
    const root = rootOf(d0, roots) || (roots.includes(d0) ? d0 : null);
    while (root && under(d, root)) {
      if (!fs.existsSync(d)) { d = path.dirname(d); continue; }
      if (await hasMedia(d)) break;
      const sz = await sizeOf(d);
      try { await fs.promises.rm(d, { recursive: true, force: true }); freed += sz; } catch { break; }
      d = path.dirname(d);
    }
  }
  return { removed, freed, skipped };
}

module.exports = { removeMedia, under, rootOf, MEDIA };
