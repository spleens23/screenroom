// Parlor (music) for the desktop / Linux-box app: the IPC calls the window makes, wired to the scanner
// (lib/music.js), the per-profile libraries (lib/parlor.js) and the music player (lib/musicplayer.js).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { scanMusic, folderCover } = require('./music');
const { Parlor } = require('./parlor');
const { MusicPlayer } = require('./musicplayer');

function setupParlor(ctx) {
  const { ipcMain, dialog } = ctx;
  const parlor = new Parlor(ctx.dataDir());
  let music = { tracks: {}, albums: [] };
  let scanning = false;
  let player = null;
  const send = (ch, payload) => { const w = ctx.getWin(); if (w && !w.isDestroyed()) w.webContents.send(ch, payload); };

  // ---- scanning --------------------------------------------------------------------------------------
  let chain = Promise.resolve();
  function rescan() {
    const p = chain.then(async () => {
      scanning = true;
      try {
        const t = ctx.toolPaths();
        music = await scanMusic({ dirs: parlor.allDirs(), dataDir: ctx.dataDir(), ffprobe: t.ffprobe, ffmpeg: t.ffmpeg, removable: ctx.drives().map((d) => d.mount),
          onProgress: (pr) => send('scan-progress', pr) });
        // covers picked in the Parlor (kept in the app's own folder when the album folder couldn't take one)
        for (const a of music.albums) { const c = parlor.cover(a.key); if (c) a.art = c; }
      } finally { scanning = false; }
      send('parlor-updated', null);
    });
    chain = p.catch(() => {});
    return p;
  }

  // ---- what the current profile sees -----------------------------------------------------------------
  const prof = () => ctx.currentProfile() || { id: 'main', kids: false };
  const canManage = () => !prof().kids;
  const visibleAlbums = () => music.albums.filter((a) => parlor.canSee(prof().id, a));
  function visibleTrackIds() { const s = new Set(); for (const a of visibleAlbums()) for (const t of a.tracks) s.add(t); return s; }

  function state() {
    const me = prof();
    const albums = visibleAlbums();
    const owned = new Set(albums.filter((a) => parlor.owners(a).includes(me.id)).map((a) => a.key));
    const tracks = {};
    for (const a of albums) {
      for (const id of a.tracks) {
        const t = music.tracks[id];
        if (t) tracks[id] = { id, title: t.title, artist: t.artist, album: t.album, albumKey: a.key, track: t.track, disc: t.disc,
          duration: t.duration, year: t.year, genre: t.genre, codec: t.codec, lossless: t.lossless, bitrate: t.bitrate, explicit: t.explicit };
      }
    }
    const profilesList = ctx.profilesList().map((p) => ({ id: p.id, name: p.name, color: p.color, kids: p.kids }));
    return {
      profile: me.id,
      canManage: canManage(),
      dirs: parlor.of(me.id).dirs,
      suggestions: canManage() ? suggestions() : [],
      scanning,
      albums: albums.map((a) => ({
        key: a.key, title: a.title, artist: a.artist, year: a.year, genre: a.genre, art: a.art, added: a.added,
        tracks: a.tracks, duration: a.duration, lossless: a.lossless, various: a.various,
        mine: owned.has(a.key),
        // who else can hear it (for the Share panel); kids profiles don't manage sharing
        audience: canManage() ? parlor.audience(a) : [],
      })),
      tracks,
      playlists: parlor.playlists(me.id).map((pl) => ({ ...pl, tracks: pl.tracks.filter((id) => tracks[id]) })),
      recent: parlor.of(me.id).recent.filter((k) => albums.some((a) => a.key === k)),
      profiles: profilesList,
      player: player ? publicPlayer(player.snapshot()) : null,
    };
  }
  // The player's queue as the UI needs it (no file paths).
  function publicPlayer(s) {
    const strip = (t) => t && { id: t.id, title: t.title, artist: t.artist, album: t.album, albumKey: t.albumKey, art: t.art, duration: t.duration };
    return { ...s, track: strip(s.track), queue: s.queue.map(strip) };
  }

  // Folders that look like music, to add with one press on the TV box (no file dialog with a remote).
  function suggestions() {
    const out = [];
    const roots = [ctx.mediaRoot(), ...ctx.drives().map((d) => d.mount)].filter(Boolean);
    for (const r of roots) {
      let names = [];
      try { names = fs.readdirSync(r, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { continue; }
      for (const n of names) {
        if (!/^(music|my music|itunes|itunes media|audio)$/i.test(n)) continue;
        const dir = path.join(r, n);
        out.push(dir);
        try {
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory() && !e.name.startsWith('.')) out.push(path.join(dir, e.name));
        } catch {}
      }
    }
    const mine = parlor.of(prof().id).dirs;
    return out.filter((d) => !mine.includes(d)).slice(0, 24);
  }

  // ---- player ----------------------------------------------------------------------------------------
  function getPlayer() {
    if (!player) {
      const bin = ctx.findMpv();
      if (!bin) throw new Error('mpv was not found, so music can\'t play.');
      player = new MusicPlayer({ bin, onState: (s) => send('music-state', publicPlayer(s)), onError: (m) => send('playback-error', m) });
      player.onTrack = (t) => { if (t) parlor.played(prof().id, t.albumKey); };
    }
    return player;
  }
  const trackFor = (id) => {
    const t = music.tracks[id];
    if (!t) return null;
    const a = music.albums.find((x) => x.key === t.albumKey);
    return { id, path: t.path, title: t.title, artist: t.artist, album: t.album, albumKey: t.albumKey, art: a && a.art, duration: t.duration };
  };

  // ---- IPC -------------------------------------------------------------------------------------------
  const deny = (msg) => ({ ok: false, error: msg });
  ipcMain.handle('parlor-state', () => state());
  ipcMain.handle('parlor-rescan', async () => { await rescan(); return state(); });
  ipcMain.handle('parlor-add-dir', async (_e, dir) => {
    if (!canManage()) return deny('Kids profiles can\'t add music.');
    let dirs = [];
    if (dir) dirs = [dir];
    else {
      const r = await dialog.showOpenDialog(ctx.getWin(), { title: 'Add a music folder', properties: ['openDirectory', 'multiSelections'] });
      if (r.canceled) return { ok: true, state: state() };
      dirs = r.filePaths;
    }
    for (const d of dirs) { try { if (fs.statSync(d).isDirectory()) parlor.addDir(prof().id, d); } catch {} }
    await rescan();
    return { ok: true, state: state() };
  });
  ipcMain.handle('parlor-remove-dir', async (_e, dir) => {
    if (!canManage()) return deny('Kids profiles can\'t change music folders.');
    parlor.removeDir(prof().id, dir);
    await rescan();
    return { ok: true, state: state() };
  });
  ipcMain.handle('parlor-share', (_e, albumKey, toPid, on) => {
    if (!canManage()) return deny('Kids profiles can\'t share music.');
    const album = music.albums.find((a) => a.key === albumKey);
    if (!album || !parlor.canSee(prof().id, album)) return deny('Album not found');
    if (!ctx.profilesList().some((p) => p.id === toPid)) return deny('Profile not found');
    if (parlor.owners(album).includes(toPid)) return deny('That profile already has this album in its own folders.');
    parlor.share(album, toPid, !!on);
    return { ok: true, state: state() };
  });
  // ---- album covers ----------------------------------------------------------------------------------
  // Online: Apple's public iTunes Search (no account needed); only used when there's an internet connection.
  async function searchCovers(a) {
    const term = `${a.various ? '' : a.artist} ${a.title}`.replace(/\s*[\[(].*?[\])]\s*/g, ' ').replace(/\s+-\s+(single|ep)$/i, '').trim();
    const url = `https://itunes.apple.com/search?media=music&entity=album&limit=12&term=${encodeURIComponent(term)}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!r.ok) throw new Error(`The cover search answered ${r.status}`);
    const j = await r.json();
    const norm = (s) => String(s || '').toLowerCase().replace(/\s*[\[(].*?[\])]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
    const want = norm(a.title), wantArtist = norm(a.artist);
    return (j.results || []).filter((x) => x.artworkUrl100).map((x) => ({
      url: x.artworkUrl100.replace(/\/\d+x\d+bb\./, '/600x600bb.'),
      thumb: x.artworkUrl100,
      album: x.collectionName, artist: x.artistName, year: (x.releaseDate || '').slice(0, 4),
      // how well it matches: same album title and artist first
      score: (norm(x.collectionName) === want ? 4 : norm(x.collectionName).includes(want) || want.includes(norm(x.collectionName)) ? 2 : 0)
        + (norm(x.artistName) === wantArtist ? 3 : norm(x.artistName).includes(wantArtist) ? 1 : 0),
    })).sort((x, y) => y.score - x.score);
  }
  /** Save a cover for an album: as cover.jpg in the album's folder when possible (so it travels with the music),
      otherwise in Screenroom's own folder. */
  async function saveCover(a, bytes, ext) {
    const dir = a.dirs[0];
    const name = `cover.${ext || 'jpg'}`;
    let dest = null;
    try {
      const existing = await folderCover(dir);
      if (!existing || path.basename(existing).toLowerCase().startsWith('cover.')) {
        dest = path.join(dir, name);
        await fs.promises.writeFile(dest, bytes);
        parlor.setCover(a.key, null);
      }
    } catch { dest = null; }
    if (!dest) {
      const artDir = path.join(ctx.dataDir(), 'music-art');
      await fs.promises.mkdir(artDir, { recursive: true });
      dest = path.join(artDir, `${crypto.createHash('sha1').update(a.key).digest('hex').slice(0, 16)}-chosen-${Date.now()}.${ext || 'jpg'}`);
      await fs.promises.writeFile(dest, bytes);
      parlor.setCover(a.key, dest);
    }
    a.art = dest;
    return dest;
  }
  const albumFor = (key) => music.albums.find((x) => x.key === key && parlor.canSee(prof().id, x));
  ipcMain.handle('parlor-cover-search', async (_e, key) => {
    if (!canManage()) return deny('Kids profiles can\'t change covers.');
    const a = albumFor(key);
    if (!a) return deny('Album not found');
    try {
      const found = await searchCovers(a);
      // pictures already in the album folder (e.g. back.jpg, scans) are offered too
      let local = [];
      try { local = (await fs.promises.readdir(a.dirs[0])).filter((n) => /\.(jpe?g|png|webp)$/i.test(n)).map((n) => path.join(a.dirs[0], n)); } catch {}
      return { ok: true, results: found, local };
    } catch (e) {
      let local = [];
      try { local = (await fs.promises.readdir(a.dirs[0])).filter((n) => /\.(jpe?g|png|webp)$/i.test(n)).map((n) => path.join(a.dirs[0], n)); } catch {}
      return { ok: true, results: [], local, offline: true, error: /fetch|ENOTFOUND|EAI_AGAIN|timeout|network/i.test(String(e.message || e)) ? 'No internet connection: covers can only be looked up online.' : e.message };
    }
  });
  ipcMain.handle('parlor-cover-set', async (_e, key, choice) => {
    if (!canManage()) return deny('Kids profiles can\'t change covers.');
    const a = albumFor(key);
    if (!a) return deny('Album not found');
    try {
      if (choice && choice.url) {
        if (!/^https:\/\/[a-z0-9.-]+\.mzstatic\.com\//i.test(choice.url)) return deny('Unexpected picture address');
        const r = await fetch(choice.url, { signal: AbortSignal.timeout(20000) });
        if (!r.ok) return deny('Could not download that cover');
        await saveCover(a, Buffer.from(await r.arrayBuffer()), 'jpg');
      } else {
        let file = choice && choice.path;
        if (!file) {
          const r = await dialog.showOpenDialog(ctx.getWin(), { title: `Cover for ${a.title}`, properties: ['openFile'], filters: [{ name: 'Pictures', extensions: ['jpg', 'jpeg', 'png', 'webp'] }] });
          if (r.canceled || !r.filePaths[0]) return { ok: true, state: state() };
          file = r.filePaths[0];
        }
        if (!/\.(jpe?g|png|webp)$/i.test(file)) return deny('Pick a JPEG, PNG or WebP picture');
        const ext = path.extname(file).slice(1).toLowerCase().replace('jpeg', 'jpg');
        // a picture already in the album folder: just use it
        if (a.dirs.includes(path.dirname(file))) { parlor.setCover(a.key, file); a.art = file; }
        else await saveCover(a, await fs.promises.readFile(file), ext);
      }
      send('parlor-updated', null);
      return { ok: true, state: state() };
    } catch (e) { return deny(e.message); }
  });
  /** Look up every album without a cover and use the best match (only clear matches). */
  ipcMain.handle('parlor-covers-auto', async () => {
    if (!canManage()) return deny('Kids profiles can\'t change covers.');
    const missing = visibleAlbums().filter((a) => !a.art);
    let found = 0;
    for (const a of missing) {
      try {
        const best = (await searchCovers(a))[0];
        if (best && best.score >= 6) {
          const r = await fetch(best.url, { signal: AbortSignal.timeout(20000) });
          if (r.ok) { await saveCover(a, Buffer.from(await r.arrayBuffer()), 'jpg'); found++; }
        }
      } catch (e) {
        if (!found) return deny('No internet connection: covers can only be looked up online.');
        break;
      }
      send('scan-progress', { done: missing.indexOf(a) + 1, total: missing.length, covers: true });
    }
    send('parlor-updated', null);
    return { ok: true, found, missing: missing.length, state: state() };
  });

  ipcMain.handle('playlist-create', (_e, name, trackIds) => {
    const ok = visibleTrackIds();
    const r = parlor.createPlaylist(prof().id, name, (trackIds || []).filter((id) => ok.has(id)));
    return r.ok ? { ...r, state: state() } : r;
  });
  ipcMain.handle('playlist-update', (_e, id, patch) => {
    const ok = visibleTrackIds();
    const p = { ...(patch || {}) };
    if (Array.isArray(p.add)) p.add = p.add.filter((t) => ok.has(t));
    if (Array.isArray(p.tracks)) p.tracks = p.tracks.filter((t) => ok.has(t));
    const r = parlor.updatePlaylist(prof().id, id, p);
    return r.ok ? { ...r, state: state() } : r;
  });
  ipcMain.handle('playlist-delete', (_e, id) => ({ ...parlor.deletePlaylist(prof().id, id), state: state() }));

  ipcMain.handle('music-play', async (_e, { trackIds, start, context }) => {
    if (ctx.isMoviePlaying()) return deny('A film is playing.');
    const ok = visibleTrackIds();
    const list = (trackIds || []).filter((id) => ok.has(id)).map(trackFor).filter(Boolean);
    if (!list.length) return deny('Nothing to play.');
    try {
      const sound = await ctx.soundDevice();
      await getPlayer().play(list, start || 0, { device: sound, context });
      return { ok: true };
    } catch (e) { return deny(e.message); }
  });
  ipcMain.handle('music-cmd', async (_e, cmd, arg) => {
    if (!player) return { ok: false };
    const p = player;
    if (cmd === 'toggle') await p.toggle();
    else if (cmd === 'pause') await p.pause();
    else if (cmd === 'next') await p.next();
    else if (cmd === 'prev') await p.prev();
    else if (cmd === 'seek') await p.seek(Number(arg) || 0);
    else if (cmd === 'volume') await p.volume(Number(arg));
    else if (cmd === 'volup') await p.volume(p.state.volume + 5);
    else if (cmd === 'voldown') await p.volume(p.state.volume - 5);
    else if (cmd === 'mute') await p.send(['cycle', 'mute']);
    else if (cmd === 'jump') await p.jump(Number(arg));
    else if (cmd === 'stop') await p.stop();
    else if (cmd === 'enqueue') {
      const ok = visibleTrackIds();
      const list = ((arg && arg.trackIds) || []).filter((id) => ok.has(id)).map(trackFor).filter(Boolean);
      await p.enqueue(list, !!(arg && arg.next));
    }
    return { ok: true, player: publicPlayer(p.snapshot()) };
  });

  return {
    rescan,
    /** The sound output changed (a Bluetooth speaker connected or went away): move the playing music over. */
    switchDevice: (dev) => {
      if (!player || !player.proc) return;
      player.device = dev || '';
      player.send(['set_property', 'audio-device', dev || 'auto']).catch(() => {});
    },
    /** Where music copied from a drive goes for this profile: its own music folder on this computer, or a new
        Music/<name> folder (added to its music folders). null for kids profiles. */
    musicDestination: () => {
      const p = prof();
      if (p.kids) return null;
      const mounts = ctx.drives().map((d) => d.mount);
      const onDrive = (d) => mounts.some((m) => d === m || d.startsWith(m + path.sep));
      const local = parlor.of(p.id).dirs.find((d) => !onDrive(d));
      if (local) return local;
      const safe = String(p.name || 'Music').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim() || 'Music';
      const dir = path.join(os.homedir(), 'Music', safe);
      fs.mkdirSync(dir, { recursive: true });
      parlor.addDir(p.id, dir);
      return dir;
    },
    /** A film is starting: pause the music. (On the TV box the sound device can only be used by one player at a
        time, so the music player closes completely.) */
    pause: () => { if (player) (ctx.exclusiveAudio && ctx.exclusiveAudio() ? player.stop(true) : player.pause()).catch(() => {}); },
    /** Another profile: their music, not this one's. */
    profileChanged: () => { if (player) player.stop().catch(() => {}); send('parlor-updated', null); },
    forget: (pid) => parlor.forget(pid),
    quit: () => { if (player) player.stop(true).catch(() => {}); },
    // phone remote: play / pause / skip
    command: (cmd) => {
      if (!player) return false;
      if (cmd === 'toggle') player.toggle(); else if (cmd === 'next') player.next(); else if (cmd === 'prev') player.prev();
      else if (cmd === 'volup') player.volume(player.state.volume + 5); else if (cmd === 'voldown') player.volume(player.state.volume - 5);
      return true;
    },
    nowPlaying: () => (player ? publicPlayer(player.snapshot()) : null),
  };
}

module.exports = { setupParlor };
