// Parlor's per-profile music libraries (parlor.json).
//
//   - Every profile starts with no music. A (grown-up) profile adds its own music folders: the albums found
//     there are that profile's.
//   - Albums are shared one at a time with other profiles. Sharing doesn't copy anything: the album just shows
//     up in their library too, and can be unshared.
//   - Kids profiles can't add folders or share: they hear only what has been shared with them.
//   - Playlists, "recently played" and the play counts belong to each profile.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function readJson(f, fallback) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } }
function writeJson(f, v) { const tmp = `${f}.tmp`; fs.writeFileSync(tmp, JSON.stringify(v)); fs.renameSync(tmp, f); }
const under = (file, dir) => { const rel = path.relative(dir, file); return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel); };
const MAX_PLAYLISTS = 200;
const MAX_TRACKS = 5000;

class Parlor {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'parlor.json');
    this.data = readJson(this.file, null) || { profiles: {} };
    if (!this.data.profiles) this.data.profiles = {};
  }
  save() { fs.mkdirSync(this.dir, { recursive: true }); writeJson(this.file, this.data); }

  of(pid) {
    if (!this.data.profiles[pid]) this.data.profiles[pid] = { dirs: [], shared: [], playlists: [], recent: [] };
    const p = this.data.profiles[pid];
    for (const k of ['dirs', 'shared', 'playlists', 'recent']) if (!Array.isArray(p[k])) p[k] = [];
    return p;
  }
  forget(pid) { delete this.data.profiles[pid]; this.save(); }

  /** Every folder any profile has added (the scanner reads them all). */
  allDirs() { return [...new Set(Object.values(this.data.profiles).flatMap((p) => p.dirs || []))]; }

  // ---- folders -----------------------------------------------------------------------------------------
  addDir(pid, dir) {
    const p = this.of(pid);
    const d = path.resolve(dir);
    if (!p.dirs.includes(d)) p.dirs.push(d);
    this.save();
  }
  removeDir(pid, dir) { const p = this.of(pid); p.dirs = p.dirs.filter((d) => d !== dir); this.save(); }

  // ---- who can see what --------------------------------------------------------------------------------
  /** Profiles whose own folders hold this album. */
  owners(album) {
    return Object.entries(this.data.profiles)
      .filter(([, p]) => (p.dirs || []).some((d) => album.dirs.some((ad) => ad === d || under(ad, d))))
      .map(([id]) => id);
  }
  canSee(pid, album) { return this.owners(album).includes(pid) || this.of(pid).shared.includes(album.key); }
  /** Profiles that can see the album (owners + shared with). */
  audience(album) {
    const out = new Set(this.owners(album));
    for (const [id, p] of Object.entries(this.data.profiles)) if ((p.shared || []).includes(album.key)) out.add(id);
    return [...out];
  }
  share(album, toPid, on) {
    const p = this.of(toPid);
    p.shared = p.shared.filter((k) => k !== album.key);
    if (on) p.shared.push(album.key);
    this.save();
  }

  // ---- playlists ---------------------------------------------------------------------------------------
  playlists(pid) { return this.of(pid).playlists; }
  createPlaylist(pid, name, trackIds = []) {
    const p = this.of(pid);
    if (p.playlists.length >= MAX_PLAYLISTS) return { ok: false, error: 'That is a lot of playlists already.' };
    const clean = String(name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60) || 'New Playlist';
    const pl = { id: crypto.randomBytes(4).toString('hex'), name: clean, tracks: trackIds.slice(0, MAX_TRACKS), created: Date.now() };
    p.playlists.push(pl);
    this.save();
    return { ok: true, playlist: pl };
  }
  updatePlaylist(pid, id, patch) {
    const pl = this.of(pid).playlists.find((x) => x.id === id);
    if (!pl) return { ok: false, error: 'Playlist not found' };
    if (patch.name !== undefined) pl.name = String(patch.name).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60) || pl.name;
    if (Array.isArray(patch.add)) pl.tracks = pl.tracks.concat(patch.add.filter((t) => typeof t === 'string')).slice(0, MAX_TRACKS);
    if (Array.isArray(patch.tracks)) pl.tracks = patch.tracks.filter((t) => typeof t === 'string').slice(0, MAX_TRACKS);
    if (typeof patch.removeAt === 'number') pl.tracks.splice(patch.removeAt, 1);
    this.save();
    return { ok: true, playlist: pl };
  }
  deletePlaylist(pid, id) { const p = this.of(pid); p.playlists = p.playlists.filter((x) => x.id !== id); this.save(); return { ok: true }; }

  // ---- covers chosen in the Parlor (when the album folder couldn't take a cover.jpg) ------------------------
  cover(albumKey) { const c = (this.data.covers || {})[albumKey]; return c && fs.existsSync(c) ? c : null; }
  setCover(albumKey, file) { this.data.covers = this.data.covers || {}; if (file) this.data.covers[albumKey] = file; else delete this.data.covers[albumKey]; this.save(); }

  // ---- recently played (album keys, newest first) --------------------------------------------------------
  played(pid, albumKey) {
    const p = this.of(pid);
    p.recent = [albumKey, ...p.recent.filter((k) => k !== albumKey)].slice(0, 30);
    this.save();
  }
}

module.exports = { Parlor };
