// window.api for the iPad app. It plays the role the desktop app's preload.js + main.js play, with the same
// rules: profiles (with PINs and kids' ratings), watch progress per profile, star ratings, recommendations,
// themes, and Parlor (music: albums, sharing, playlists, covers). The Swift side does only what a web page
// can't: read and write files, probe films and songs, play them, and import new ones.
//
// Everything is kept as small JSON files in the app's private folder (see Storage.swift); films and music
// live in the app's Documents folder, which the Files app, Finder and AirDrop can put things in.
(() => {
  'use strict';
  const handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.screenroom;
  const pending = new Map();
  const listeners = {};
  let seq = 0;

  window.__iosReply = (id, json) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    let v = null;
    try { v = JSON.parse(json); } catch (e) { p.reject(e); return; }
    if (v && typeof v === 'object' && v.__error) p.reject(new Error(v.__error));
    else p.resolve(v);
  };
  window.__iosEvent = (name, json) => {
    let payload = null;
    try { payload = json ? JSON.parse(json) : null; } catch {}
    handleEvent(name, payload);
  };

  function native(method, ...args) {
    return new Promise((resolve, reject) => {
      if (!handler) { reject(new Error('Not running in the iPad app')); return; }
      const id = ++seq;
      pending.set(id, { resolve, reject });
      try { handler.postMessage({ id, method, args: JSON.stringify(args) }); } catch (e) { pending.delete(id); reject(e); }
    });
  }
  const emit = (name, payload) => (listeners[name] || []).forEach((cb) => { try { cb(payload); } catch (e) { console.error(e); } });
  const on = (name) => (cb) => { (listeners[name] = listeners[name] || []).push(cb); };
  const ok = (extra = {}) => ({ ok: true, ...extra });
  const fail = (error) => ({ ok: false, error });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- storage -------------------------------------------------------------------------------------------
  let env = null;           // { docs, films, music, data, art, avatars, device }
  const cache = {};
  async function load(name, fallback) {
    if (name in cache) return cache[name];
    let v = null;
    try { v = await native('readJson', name); } catch {}
    cache[name] = v == null ? fallback : v;
    return cache[name];
  }
  // Saves are queued so two quick changes can't land in the wrong order.
  let saving = Promise.resolve();
  function save(name, value) {
    cache[name] = value;
    saving = saving.then(() => native('writeJson', name, value)).catch((e) => console.error('save', name, e));
    return saving;
  }

  // ---- config --------------------------------------------------------------------------------------------
  const DEFAULTS = { preferredLang: 'eng', subLang: '', screensaverMin: 0, theme: '2020s', themeAll: false, retroFx: false };
  let config = null;
  const THEMES = ['2020s', '1990s', 'heirloom'];

  // ---- profiles (the same rules as lib/profiles.js) -------------------------------------------------------
  const COLORS = ['#b5523a', '#2f80ed', '#27ae60', '#f2c94c', '#9b51e0', '#f2994a', '#56ccf2', '#eb5757'];
  const MAX_PROFILES = 8;
  let pdata = null;         // { profiles: [...], last }
  let currentId = 'main';
  let needPick = false;
  let progress = {};

  const progressName = (id) => (id === 'main' ? 'progress' : `progress-${id}`);
  const pall = () => pdata.profiles;
  const pget = (id) => pall().find((p) => p.id === id) || null;
  const plast = () => pget(pdata.last) || pall()[0];
  const needsPicker = () => pall().length > 1 || !!pall()[0].pinHash;
  const savePro = () => save('profiles', pdata);
  async function pinHash(salt, pin) { return native('sha256', `${salt}:${pin}`); }
  async function checkPin(id, pin) {
    const p = pget(id);
    if (!p) return false;
    if (!p.pinHash) return true;
    return (await pinHash(p.pinSalt, pin || '')) === p.pinHash;
  }
  function publicProfile(p) {
    if (!p) return null;
    const photo = p.photo ? `${env.avatars}/${p.photo}` : '';
    return {
      id: p.id, name: p.name, color: p.color === '#e50914' ? '#b5523a' : p.color, kids: !!p.kids, maxLevel: p.maxLevel || 1, allowUnrated: !!p.allowUnrated,
      hasPin: !!p.pinHash, preferredLang: p.preferredLang || '', subLang: p.subLang || '',
      avatar: p.avatar === 'photo' && !photo ? '' : (p.avatar || ''), photo: photo || undefined,
      theme: p.theme || '', retroFx: !!p.retroFx,
    };
  }
  const currentProfile = () => publicProfile(pget(currentId));
  const profilesList = () => pall().map(publicProfile);

  async function selectProfile(id) {
    currentId = id;
    progress = await load(progressName(id), {});
    needPick = false;
    pdata.last = id;
    savePro();
    musicStop();
  }

  // ---- ratings and the house (lib/ratings.js, lib/social.js) ------------------------------------------------
  let ratings = {};
  let recs = [];
  async function watchedBy() {
    const out = {};
    for (const p of pall()) {
      const prog = p.id === currentId ? progress : await load(progressName(p.id), {});
      for (const [id, v] of Object.entries(prog || {})) {
        if (v && (v.done || (v.dur > 0 && v.pos / v.dur > 0.9))) (out[id] = out[id] || []).push(p.id);
      }
    }
    return out;
  }

  // ---- films ---------------------------------------------------------------------------------------------
  let rawFilms = [];        // [{ id, path, mtime, size, probe, art, backdrop }]
  let library = [];
  let scanning = null;

  function buildLibrary() {
    const all = rawFilms.map((r) => {
      const it = MediaCore.buildItemFromProbe(r.path, { mtimeMs: r.mtime, size: r.size }, r.probe || {}, r.id);
      it.art = r.art || null;
      it.backdrop = r.backdrop || null;
      return MediaCore.applyTv(it);
    });
    MediaCore.fillSeriesRatings(all);
    const prof = currentProfile();
    const items = all.filter((it) => MediaCore.allowedFor(it, prof));
    const deduped = MediaCore.dedupeEpisodes(items);
    const dups = deduped.dups || [];
    library = deduped.sort((a, b) => a.title.localeCompare(b.title));
    return dups.length;
  }

  async function scanFilms() {
    if (!scanning) {
      scanning = (async () => {
        try { rawFilms = await native('scanVideos'); } finally { scanning = null; }
      })();
    }
    return scanning;
  }

  function themeNow() {
    const p = pget(currentId);
    if (config.themeAll) return { theme: THEMES.includes(config.theme) ? config.theme : '2020s', fx: !!config.retroFx };
    return { theme: p && THEMES.includes(p.theme) ? p.theme : (THEMES.includes(config.theme) ? config.theme : '2020s'), fx: !!(p && p.retroFx) };
  }

  async function snapshot() {
    const dups = buildLibrary();
    const t = themeNow();
    return {
      library, progress, config, tv: false, platform: 'ios', device: env.device,
      mpvFound: true, ffprobeFound: true, drives: [], mediaDir: env.films, docsDir: env.docs,
      profile: currentProfile(), profiles: profilesList(), pickProfile: needPick,
      playbackProblems: await load('playback-problems', []),
      ratings, recs, watchedBy: await watchedBy(), duplicates: dups,
      theme: t.theme, retroFx: t.fx, edition: 'all', canDelete: true,
    };
  }

  // ---- Parlor: albums from the songs' tags (the same rules as lib/music.js) ---------------------------------
  let rawTracks = [];       // [{ id, path, mtime, size, tags, codec, duration, bitrate, sampleRate, lossless, art }]
  let music = { tracks: {}, albums: [] };
  let pstore = null;        // parlor.json: { profiles: { pid: { dirs, shared, playlists, recent } }, covers }
  let musicScanning = null;

  const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const albumKeyOf = (artist, album) => `${norm(artist)}|${norm(album)}`;
  const dirOf = (p) => p.replace(/\/[^/]*$/, '');
  const baseOf = (p) => p.replace(/^.*\//, '');
  const under = (file, dir) => file !== dir && file.startsWith(dir.replace(/\/$/, '') + '/');
  function tagOf(tags, ...keys) {
    for (const k of keys) for (const tk of Object.keys(tags || {})) if (tk.toLowerCase() === k) { const v = String(tags[tk]).trim(); if (v) return v; }
    return '';
  }
  const num = (v) => { const n = parseInt(String(v || '').split('/')[0], 10); return Number.isFinite(n) ? n : 0; };
  const total = (v) => { const n = parseInt(String(v || '').split('/')[1], 10); return Number.isFinite(n) ? n : 0; };

  function buildTrack(r) {
    const tags = r.tags || {};
    const dir = dirOf(r.path);
    const folderAlbum = baseOf(dir);
    const folderArtist = baseOf(dirOf(dir));
    const insideMusic = (d) => d && under(d, env.music);
    const artist = tagOf(tags, 'artist', 'album_artist', 'albumartist') || (insideMusic(dirOf(dir)) ? folderArtist : '') || 'Unknown Artist';
    const albumArtist = tagOf(tags, 'album_artist', 'albumartist', 'album artist') || artist;
    const album = tagOf(tags, 'album') || (insideMusic(dir) ? folderAlbum : '') || 'Unknown Album';
    const date = tagOf(tags, 'date', 'year', 'originaldate');
    const y = date.match(/\d{4}/);
    return {
      id: r.id, path: r.path, mtime: r.mtime, size: r.size,
      title: MediaCore.plainChars(tagOf(tags, 'title')) || baseOf(r.path).replace(/\.[^.]+$/, '').replace(/^\d+[\s.-]+/, ''),
      artist, albumArtist, album,
      track: num(tagOf(tags, 'track', 'tracknumber')),
      trackTotal: total(tagOf(tags, 'track', 'tracknumber')) || num(tagOf(tags, 'tracktotal', 'totaltracks')),
      disc: num(tagOf(tags, 'disc', 'discnumber')) || 1,
      year: y ? Number(y[0]) : null,
      genre: tagOf(tags, 'genre'),
      compilation: tagOf(tags, 'compilation') === '1',
      explicit: /^(1|4)$/.test(tagOf(tags, 'itunesadvisory', 'rtng')),
      duration: r.duration || 0,
      codec: r.codec || '',
      lossless: !!r.lossless,
      bitrate: r.bitrate || 0,
      sampleRate: r.sampleRate || 0,
      art: r.art || null,
      folderArt: r.folderArt || null,
    };
  }

  function groupAlbums() {
    const tracks = rawTracks.map(buildTrack);
    const byKey = new Map();
    for (const t of tracks) {
      const k = albumKeyOf(t.compilation ? 'Various Artists' : t.albumArtist, t.album);
      t.albumKey = k;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(t);
    }
    const albums = [];
    const byId = {};
    for (const [key, all] of byKey) {
      const seen = new Map();
      for (const t of all) {
        const k = `${t.disc || 1}|${t.track || ''}|${String(t.title || '').toLowerCase()}|${Math.round(t.duration || 0)}`;
        if (!seen.has(k)) seen.set(k, t);
      }
      const list = [...seen.values()];
      list.sort((a, b) => (a.disc - b.disc) || ((a.track || 999) - (b.track || 999)) || a.path.localeCompare(b.path));
      const first = list[0];
      const artists = new Set(list.map((t) => t.artist));
      const years = list.map((t) => t.year).filter(Boolean);
      const chosen = (pstore.covers || {})[key];
      const art = chosen || list.map((t) => t.folderArt).find(Boolean) || list.map((t) => t.art).find(Boolean) || null;
      for (const t of list) byId[t.id] = t;
      albums.push({
        key, title: first.album, artist: first.compilation ? 'Various Artists' : first.albumArtist,
        various: first.compilation || artists.size > 2, year: years.length ? Math.min(...years) : null, genre: first.genre,
        art, added: Math.max(...list.map((t) => t.mtime || 0)), tracks: list.map((t) => t.id),
        duration: list.reduce((s, t) => s + (t.duration || 0), 0), lossless: list.every((t) => t.lossless),
        dirs: [...new Set(all.map((t) => dirOf(t.path)))],
      });
    }
    albums.sort((a, b) => a.artist.localeCompare(b.artist) || (a.year || 0) - (b.year || 0) || a.title.localeCompare(b.title));
    music = { tracks: byId, albums };
  }

  async function scanMusic() {
    if (!musicScanning) {
      musicScanning = (async () => {
        try {
          rawTracks = await native('scanAudio');
          groupAlbums();
        } finally { musicScanning = null; }
        emit('parlor-updated', null);
      })();
    }
    return musicScanning;
  }

  const pOf = (pid) => {
    pstore.profiles = pstore.profiles || {};
    if (!pstore.profiles[pid]) pstore.profiles[pid] = { dirs: [], shared: [], playlists: [], recent: [] };
    const p = pstore.profiles[pid];
    for (const k of ['dirs', 'shared', 'playlists', 'recent']) if (!Array.isArray(p[k])) p[k] = [];
    return p;
  };
  const savePar = () => save('parlor', pstore);
  // Folders are stored relative to Documents ("Music", "Music/Jazz"), since the app's folder moves between installs.
  const absDir = (rel) => (rel === '' ? env.docs : `${env.docs}/${rel}`);
  const relDir = (abs) => (abs === env.docs ? '' : abs.startsWith(env.docs + '/') ? abs.slice(env.docs.length + 1) : abs);
  const owners = (album) => Object.entries(pstore.profiles || {})
    .filter(([, p]) => (p.dirs || []).some((d) => album.dirs.some((ad) => ad === absDir(d) || under(ad, absDir(d)))))
    .map(([id]) => id);
  const canSee = (pid, album) => owners(album).includes(pid) || pOf(pid).shared.includes(album.key);
  const audience = (album) => { const s = new Set(owners(album)); for (const [id, p] of Object.entries(pstore.profiles || {})) if ((p.shared || []).includes(album.key)) s.add(id); return [...s]; };
  const prof = () => pget(currentId) || { id: 'main', kids: false };
  const canManage = () => !prof().kids;
  const visibleAlbums = () => music.albums.filter((a) => canSee(prof().id, a));
  function visibleTrackIds() { const s = new Set(); for (const a of visibleAlbums()) for (const t of a.tracks) s.add(t); return s; }

  function parlorState() {
    const me = prof();
    const albums = visibleAlbums();
    const owned = new Set(albums.filter((a) => owners(a).includes(me.id)).map((a) => a.key));
    const tracks = {};
    for (const a of albums) {
      for (const id of a.tracks) {
        const t = music.tracks[id];
        if (t) tracks[id] = { id, title: t.title, artist: t.artist, album: t.album, albumKey: a.key, track: t.track, disc: t.disc,
          duration: t.duration, year: t.year, genre: t.genre, codec: t.codec, lossless: t.lossless, bitrate: t.bitrate, explicit: t.explicit };
      }
    }
    const mine = pOf(me.id);
    const musicRel = relDir(env.music);
    return {
      profile: me.id, canManage: canManage(),
      dirs: mine.dirs.map(absDir),
      // The iPad's own music folder, one tap away for a profile that hasn't got it yet.
      suggestions: canManage() && !mine.dirs.includes(musicRel) ? [env.music] : [],
      scanning: !!musicScanning,
      albums: albums.map((a) => ({
        key: a.key, title: a.title, artist: a.artist, year: a.year, genre: a.genre, art: a.art, added: a.added,
        tracks: a.tracks, duration: a.duration, lossless: a.lossless, various: a.various, mine: owned.has(a.key),
        audience: canManage() ? audience(a) : [],
      })),
      tracks,
      playlists: mine.playlists.map((pl) => ({ ...pl, tracks: pl.tracks.filter((id) => tracks[id]) })),
      recent: mine.recent.filter((k) => albums.some((a) => a.key === k)),
      profiles: profilesList().map((p) => ({ id: p.id, name: p.name, color: p.color === '#e50914' ? '#b5523a' : p.color, kids: p.kids })),
      player: player ? publicPlayer(player) : null,
    };
  }

  // ---- the music player (native) ---------------------------------------------------------------------------
  let player = null;        // the last snapshot from Swift: { playing, paused, index, pos, dur, volume, queue: [ids], context }
  const trackFor = (id) => {
    const t = music.tracks[id];
    if (!t) return null;
    const a = music.albums.find((x) => x.key === t.albumKey);
    return { id, path: t.path, title: t.title, artist: t.artist, album: t.album, albumKey: t.albumKey, art: a && a.art, duration: t.duration };
  };
  function publicPlayer(s) {
    const strip = (id) => { const t = trackFor(id); return t && { id: t.id, title: t.title, artist: t.artist, album: t.album, albumKey: t.albumKey, art: t.art, duration: t.duration }; };
    const queue = (s.queue || []).map(strip).filter(Boolean);
    return { playing: !!s.playing, paused: !!s.paused, index: s.index, pos: s.pos || 0, dur: s.dur || 0, volume: s.volume == null ? 100 : s.volume,
      muted: !!s.muted, track: queue[s.index] || null, queue, context: s.context || null };
  }
  function musicStop() { if (player && player.playing) native('musicCmd', 'stop').catch(() => {}); }

  // ---- deleting (Settings → Free up space) -----------------------------------------------------------------
  function deletableAlbums() {
    return music.albums.map((a) => {
      const files = a.tracks.map((id) => music.tracks[id]).filter(Boolean);
      return { key: a.key, title: a.title, artist: a.artist, year: a.year, count: files.length, size: files.reduce((n, t) => n + (t.size || 0), 0) };
    });
  }

  // ---- events from Swift -----------------------------------------------------------------------------------
  async function handleEvent(name, payload) {
    switch (name) {
      case 'video-progress': {
        const { id, pos, dur, done } = payload || {};
        if (!id) return;
        const o = { pos: done ? 0 : pos, dur, updated: Date.now() };
        if (done) o.done = true;
        progress[id] = o;
        save(progressName(currentId), progress);
        return;
      }
      case 'video-ended':
        emit('playback-ended', await snapshot());
        return;
      case 'playback-error': {
        const list = await load('playback-problems', []);
        list.unshift({ at: Date.now(), title: (payload && payload.title) || '', code: (payload && payload.code) || '', details: (payload && payload.details) || '' });
        save('playback-problems', list.slice(0, 10));
        emit('playback-error', (payload && payload.message) || 'That file could not be played.');
        return;
      }
      case 'music-state': {
        const prev = player;
        player = payload;
        // a new album started: remember it under "recently played"
        const id = payload && payload.queue && payload.queue[payload.index];
        const prevId = prev && prev.queue && prev.queue[prev.index];
        if (id && id !== prevId) {
          const t = music.tracks[id];
          if (t) { const p = pOf(prof().id); p.recent = [t.albumKey, ...p.recent.filter((k) => k !== t.albumKey)].slice(0, 30); savePar(); }
        }
        emit('music-state', publicPlayer(payload));
        return;
      }
      case 'files-changed':
        // something new arrived (Files app, Finder, AirDrop, an import): look again
        await Promise.all([scanFilms(), scanMusic()]);
        emit('library-updated', await snapshot());
        return;
      default:
        emit(name, payload);
    }
  }

  // ---- what the player shows (like main.js on the desktop) --------------------------------------------------
  function playerMeta(item) {
    if (item.tv) return { title: item.tv.series, sub: `S${item.tv.season}:E${item.tv.label || item.tv.episode}`, name: item.tv.name, desc: item.description || '' };
    return { title: item.title, sub: item.year ? String(item.year) : '', name: '', desc: item.description || '' };
  }
  function queueFor(item) {
    if (!item.tv) return [item];
    const key = item.tv.series.toLowerCase();
    const eps = library.filter((i) => i.tv && i.tv.series.toLowerCase() === key)
      .sort((a, b) => (a.tv.order - b.tv.order) || a.path.localeCompare(b.path));
    const at = eps.findIndex((e) => e.id === item.id);
    return at >= 0 ? eps.slice(at) : [item];
  }

  // ---- start-up ----------------------------------------------------------------------------------------------
  let ready = null;
  function boot() {
    if (!ready) {
      ready = (async () => {
        env = await native('boot');
        config = { ...DEFAULTS, ...(await load('config', {})) };
        pdata = await load('profiles', null);
        if (!pdata || !Array.isArray(pdata.profiles) || !pdata.profiles.length) {
          pdata = { profiles: [{ id: 'main', name: 'Main', color: COLORS[0], kids: false }], last: 'main' };
          savePro();
        }
        currentId = plast().id;
        needPick = needsPicker();
        progress = await load(progressName(currentId), {});
        ratings = await load('ratings', {});
        recs = await load('recommendations', []);
        pstore = await load('parlor', null);
        if (!pstore) {
          // The first profile owns the iPad's Music folder, so songs put there show up straight away.
          pstore = { profiles: {}, covers: {} };
          pOf('main').dirs.push(relDir(env.music));
          savePar();
        }
        rawFilms = await native('scanVideos', { cacheOnly: true }).catch(() => []);
        rawTracks = await native('scanAudio', { cacheOnly: true }).catch(() => []);
        groupAlbums();
        // then a real look, in the background
        Promise.all([scanFilms(), scanMusic()]).then(async () => emit('library-updated', await snapshot())).catch(() => {});
      })();
    }
    return ready;
  }

  const authorize = async (id, pin) => {
    const me = pget(currentId);
    if (me && me.kids) return 'Kids profiles can\'t change profiles.';
    const target = id ? pget(id) : null;
    if (target && id !== currentId && target.pinHash && !(await checkPin(id, pin))) { await sleep(600); return 'Wrong PIN'; }
    return null;
  };
  const withState = async (r) => (r && r.ok ? { ...r, state: await snapshot() } : r);

  window.api = {
    edition: 'all',
    platform: 'ios',
    state: async () => { await boot(); return snapshot(); },
    scan: async () => { await boot(); emit('scan-progress', { done: 0, total: 1 }); await scanFilms(); return snapshot(); },
    addDir: async () => { await boot(); await native('importFiles', 'films'); await scanFilms(); return snapshot(); },
    removeDir: async () => snapshot(),
    importFiles: async (kind) => { await boot(); const r = await native('importFiles', kind || 'any'); await Promise.all([scanFilms(), scanMusic()]); return { ...r, state: await snapshot() }; },
    setConfig: async (p) => { await boot(); Object.assign(config, p || {}); save('config', config); return snapshot(); },
    setTheme: async ({ theme, fx, all } = {}) => {
      await boot();
      if (all === true && !config.themeAll) { const t = themeNow(); config.theme = t.theme; config.retroFx = t.fx; }
      if (all != null) config.themeAll = !!all;
      if (config.themeAll) {
        if (theme != null) config.theme = THEMES.includes(theme) ? theme : '2020s';
        if (fx != null) config.retroFx = !!fx;
      } else {
        const p = pget(currentId);
        if (p) { if (theme != null) p.theme = THEMES.includes(theme) ? theme : ''; if (fx != null) p.retroFx = !!fx; savePro(); }
      }
      save('config', config);
      return snapshot();
    },
    play: async ({ id, audioTrack, fromStart }) => {
      await boot();
      musicStop();
      const item = library.find((i) => i.id === id);
      if (!item) return fail('That file is no longer in the library.');
      const prof = currentProfile() || {};
      const queue = queueFor(item).map((i, n) => {
        const pr = progress[i.id];
        const start = n === 0 && !fromStart && pr && !pr.done && pr.pos > 10 && (!pr.dur || pr.pos < pr.dur - 30) ? pr.pos : 0;
        return { id: i.id, path: i.path, duration: i.duration, start, art: i.art || i.backdrop || '', ...playerMeta(i), fmt: MediaCore.formatBadges(i) };
      });
      return native('playVideo', {
        queue, audioTrack: audioTrack || null,
        audioLang: prof.preferredLang || config.preferredLang || 'eng', subLang: prof.subLang || config.subLang || '',
      });
    },
    setWatched: async (ids, watched) => {
      await boot();
      for (const id of ids || []) {
        if (watched) progress[id] = { pos: 0, dur: (progress[id] && progress[id].dur) || 0, updated: Date.now(), done: true };
        else delete progress[id];
      }
      save(progressName(currentId), progress);
      return snapshot();
    },
    clearInProgress: async () => {
      for (const k of Object.keys(progress)) if (!(progress[k] && progress[k].done)) delete progress[k];
      save(progressName(currentId), progress);
      return snapshot();
    },
    reveal: () => {},
    audioDevices: async () => [],
    remoteInfo: async () => ({ enabled: false, urls: [], smb: [], pin: '', qr: '' }),
    quit: async () => ({ ok: false }),
    power: async () => ({ ok: false }),
    drives: async () => [],

    // ---- profiles ----
    selectProfile: async (id, pin) => {
      await boot();
      if (!pget(id)) return fail('Profile not found');
      if (!(await checkPin(id, pin))) { await sleep(600); return fail('Wrong PIN'); }
      await selectProfile(id);
      emit('parlor-updated', null);
      return withState(ok());
    },
    showProfilePicker: async () => { await boot(); needPick = true; return snapshot(); },
    saveProfile: async (input = {}, pin) => {
      await boot();
      const err = await authorize(input.id, pin);
      if (err) return fail(err);
      const name = String(input.name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 24);
      if (!name) return fail('Give the profile a name.');
      let p = input.id ? pget(input.id) : null;
      if (input.id && !p) return fail('Profile not found');
      if (pall().some((x) => x.name.toLowerCase() === name.toLowerCase() && (!p || x.id !== p.id))) return fail('There is already a profile with that name.');
      if (!p) {
        if (pall().length >= MAX_PROFILES) return fail(`Up to ${MAX_PROFILES} profiles.`);
        const used = new Set(pall().map((x) => x.color));
        p = { id: await native('random', 4), color: COLORS.find((c) => !used.has(c)) || COLORS[0] };
        pall().push(p);
      }
      p.name = name;
      if (/^#[0-9a-fA-F]{6}$/.test(input.color || '')) p.color = input.color;
      if ('kids' in input) p.kids = !!input.kids;
      if ('maxLevel' in input) p.maxLevel = Math.min(3, Math.max(1, Number(input.maxLevel) || 1));
      if ('allowUnrated' in input) p.allowUnrated = !!input.allowUnrated;
      if ('preferredLang' in input) p.preferredLang = String(input.preferredLang || '').slice(0, 8);
      if ('subLang' in input) p.subLang = String(input.subLang || '').slice(0, 8);
      if ('avatar' in input) {
        const av = String(input.avatar || '');
        if (!av || /^char:[a-z]{2,20}$/.test(av) || (av === 'photo' && p.photo)) p.avatar = av;
      }
      savePro();
      needPick = needsPicker() && needPick;
      return withState(ok({ profile: publicProfile(p) }));
    },
    setProfilePin: async (id, newPin, pin) => {
      await boot();
      const err = await authorize(id, pin);
      if (err) return fail(err);
      const p = pget(id);
      if (!p) return fail('Profile not found');
      if (!newPin) { delete p.pinHash; delete p.pinSalt; }
      else {
        if (!/^\d{4}$/.test(newPin)) return fail('A PIN is 4 digits.');
        p.pinSalt = await native('random', 8);
        p.pinHash = await pinHash(p.pinSalt, newPin);
      }
      savePro();
      return withState(ok());
    },
    deleteProfile: async (id, pin) => {
      await boot();
      const err = await authorize(id, pin);
      if (err) return fail(err);
      if (pall().length <= 1) return fail('You can\'t delete the only profile.');
      const p = pget(id);
      if (!p) return fail('Profile not found');
      if (p.photo) native('deleteFiles', [`${env.avatars}/${p.photo}`]).catch(() => {});
      pdata.profiles = pall().filter((x) => x.id !== id);
      if (pdata.last === id) pdata.last = pall()[0].id;
      savePro();
      if (id !== 'main') save(progressName(id), {});
      for (const k of Object.keys(ratings)) { delete ratings[k][id]; if (!Object.keys(ratings[k]).length) delete ratings[k]; }
      save('ratings', ratings);
      recs = recs.filter((r) => r.from !== id && r.to !== id);
      save('recommendations', recs);
      if (pstore.profiles) { delete pstore.profiles[id]; savePar(); }
      if (id === currentId) { currentId = plast().id; progress = await load(progressName(currentId), {}); needPick = needsPicker(); }
      return withState(ok());
    },
    profilePhoto: async (id, pin) => {
      await boot();
      const err = await authorize(id, pin);
      if (err) return fail(err);
      const p = pget(id);
      if (!p) return fail('Profile not found');
      const r = await native('pickPhoto', `${id}-${Date.now()}`);
      if (!r || !r.name) return withState(ok());
      if (p.photo) native('deleteFiles', [`${env.avatars}/${p.photo}`]).catch(() => {});
      p.photo = r.name;
      p.avatar = 'photo';
      savePro();
      return withState(ok({ profile: publicProfile(p) }));
    },

    // ---- the house ----
    rate: async (key, stars) => {
      const k = String(key || '').slice(0, 300);
      if (!k || stars < 0 || stars > 5) return snapshot();
      const e = ratings[k] || {};
      if (stars > 0) e[currentId] = { stars, at: Date.now() }; else delete e[currentId];
      if (Object.keys(e).length) ratings[k] = e; else delete ratings[k];
      save('ratings', ratings);
      return snapshot();
    },
    recommend: async (to, item) => {
      const key = String((item && item.key) || '').slice(0, 300);
      if (!key || !['movie', 'series', 'album'].includes(item.kind)) return snapshot();
      for (const pid of to || []) {
        if (!pid || pid === currentId || !pget(pid)) continue;
        recs = recs.filter((r) => !(r.from === currentId && r.to === pid && r.key === key));
        recs.push({ id: await native('random', 8), from: currentId, to: pid, key, kind: item.kind, name: String(item.name || '').slice(0, 120), at: Date.now() });
      }
      recs = recs.slice(-600);
      save('recommendations', recs);
      return snapshot();
    },
    dismissRec: async (id) => { recs = recs.filter((r) => !(r.id === id && r.to === currentId)); save('recommendations', recs); return snapshot(); },
    setVoteState: async () => true,
    clearProblems: async () => { save('playback-problems', []); return snapshot(); },

    // ---- Free up space ----
    deleteList: async () => {
      await boot();
      if (prof().kids) return { error: 'Kids profiles can\'t delete anything.' };
      const films = [], shows = new Map();
      for (const i of library) {
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
      return { films, shows: showList, albums: deletableAlbums(), free: await native('freeSpace') };
    },
    deleteMedia: async (what) => {
      await boot();
      if (prof().kids) return { error: 'Kids profiles can\'t delete anything.' };
      const files = [];
      const wantFilms = new Set((what && what.films) || []);
      for (const i of library) {
        if (!i.tv && wantFilms.has(i.id)) files.push(i.path);
        if (i.tv) {
          const pick = ((what && what.shows) || []).find((s) => s && String(s.series).toLowerCase() === i.tv.series.toLowerCase());
          if (pick && (!Array.isArray(pick.seasons) || pick.seasons.includes(i.tv.season || 0))) files.push(i.path);
        }
      }
      const albums = new Set((what && what.albums) || []);
      for (const a of music.albums) if (albums.has(a.key)) for (const id of a.tracks) { const t = music.tracks[id]; if (t) files.push(t.path); }
      if (player && player.queue && player.queue.some((id) => files.includes((music.tracks[id] || {}).path))) await native('musicCmd', 'stop').catch(() => {});
      const r = files.length ? await native('deleteFiles', files) : { removed: 0, freed: 0 };
      await Promise.all([scanFilms(), scanMusic()]);
      return { ok: true, removed: r.removed, freed: r.freed, free: await native('freeSpace'), state: await snapshot() };
    },

    // ---- Parlor ----
    parlorState: async () => { await boot(); return parlorState(); },
    parlorRescan: async () => { await boot(); await scanMusic(); return parlorState(); },
    parlorAddDir: async (dir) => {
      await boot();
      if (!canManage()) return fail('Kids profiles can\'t add music.');
      const mine = pOf(prof().id);
      if (dir) { const rel = relDir(dir); if (!mine.dirs.includes(rel)) mine.dirs.push(rel); savePar(); await scanMusic(); return ok({ state: parlorState() }); }
      // No folder given: make the iPad's Music folder this profile's, and offer to import songs into it.
      const rel = relDir(env.music);
      if (!mine.dirs.includes(rel)) { mine.dirs.push(rel); savePar(); }
      await native('importFiles', 'music');
      await scanMusic();
      return ok({ state: parlorState() });
    },
    parlorRemoveDir: async (dir) => {
      if (!canManage()) return fail('Kids profiles can\'t change music folders.');
      const p = pOf(prof().id);
      const rel = relDir(dir);
      p.dirs = p.dirs.filter((d) => d !== rel);
      savePar();
      return ok({ state: parlorState() });
    },
    parlorShare: async (albumKey, toPid, on) => {
      if (!canManage()) return fail('Kids profiles can\'t share music.');
      const album = music.albums.find((a) => a.key === albumKey);
      if (!album || !canSee(prof().id, album)) return fail('Album not found');
      if (!pget(toPid)) return fail('Profile not found');
      if (owners(album).includes(toPid)) return fail('That profile already has this album in its own folders.');
      const p = pOf(toPid);
      p.shared = p.shared.filter((k) => k !== album.key);
      if (on) p.shared.push(album.key);
      savePar();
      return ok({ state: parlorState() });
    },
    parlorCoverSearch: async (key) => {
      if (!canManage()) return fail('Kids profiles can\'t change covers.');
      const a = music.albums.find((x) => x.key === key);
      if (!a) return fail('Album not found');
      let local = [];
      try { local = await native('listImages', a.dirs[0]); } catch {}
      try {
        const term = `${a.various ? '' : a.artist} ${a.title}`.replace(/\s*[\[(].*?[\])]\s*/g, ' ').replace(/\s+-\s+(single|ep)$/i, '').trim();
        const j = await native('httpGetJson', `https://itunes.apple.com/search?media=music&entity=album&limit=12&term=${encodeURIComponent(term)}`);
        const n = (s) => String(s || '').toLowerCase().replace(/\s*[\[(].*?[\])]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
        const want = n(a.title), wantArtist = n(a.artist);
        const results = (j.results || []).filter((x) => x.artworkUrl100).map((x) => ({
          url: x.artworkUrl100.replace(/\/\d+x\d+bb\./, '/600x600bb.'), thumb: x.artworkUrl100,
          album: x.collectionName, artist: x.artistName, year: (x.releaseDate || '').slice(0, 4),
          score: (n(x.collectionName) === want ? 4 : n(x.collectionName).includes(want) || want.includes(n(x.collectionName)) ? 2 : 0)
            + (n(x.artistName) === wantArtist ? 3 : n(x.artistName).includes(wantArtist) ? 1 : 0),
        })).sort((x, y) => y.score - x.score);
        return ok({ results, local });
      } catch (e) {
        return ok({ results: [], local, offline: true, error: 'No internet connection: covers can only be looked up online.' });
      }
    },
    parlorCoverSet: async (key, choice) => {
      if (!canManage()) return fail('Kids profiles can\'t change covers.');
      const a = music.albums.find((x) => x.key === key);
      if (!a) return fail('Album not found');
      try {
        let file = null;
        if (choice && choice.url) {
          if (!/^https:\/\/[a-z0-9.-]+\.mzstatic\.com\//i.test(choice.url)) return fail('Unexpected picture address');
          file = await native('download', choice.url, `${a.dirs[0]}/cover.jpg`);
        } else if (choice && choice.path) {
          file = choice.path;
        } else {
          const r = await native('pickPhoto', null, `${a.dirs[0]}/cover`);
          file = r && r.path;
        }
        if (!file) return ok({ state: parlorState() });
        pstore.covers = pstore.covers || {};
        pstore.covers[a.key] = file;
        savePar();
        groupAlbums();
        emit('parlor-updated', null);
        return ok({ state: parlorState() });
      } catch (e) { return fail(e.message); }
    },
    parlorCoversAuto: async () => {
      if (!canManage()) return fail('Kids profiles can\'t change covers.');
      const missing = visibleAlbums().filter((a) => !a.art);
      let found = 0;
      for (const a of missing) {
        const r = await window.api.parlorCoverSearch(a.key);
        if (r.offline) { if (!found) return fail('No internet connection: covers can only be looked up online.'); break; }
        const best = (r.results || [])[0];
        if (best && best.score >= 6) { const s = await window.api.parlorCoverSet(a.key, { url: best.url }); if (s.ok) found++; }
        emit('scan-progress', { done: missing.indexOf(a) + 1, total: missing.length, covers: true });
      }
      emit('parlor-updated', null);
      return ok({ found, missing: missing.length, state: parlorState() });
    },
    playlistCreate: async (name, trackIds) => {
      const okIds = visibleTrackIds();
      const p = pOf(prof().id);
      if (p.playlists.length >= 200) return fail('That is a lot of playlists already.');
      const pl = { id: await native('random', 4), name: String(name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60) || 'New Playlist',
        tracks: (trackIds || []).filter((id) => okIds.has(id)).slice(0, 5000), created: Date.now() };
      p.playlists.push(pl);
      savePar();
      return ok({ playlist: pl, state: parlorState() });
    },
    playlistUpdate: async (id, patch = {}) => {
      const okIds = visibleTrackIds();
      const pl = pOf(prof().id).playlists.find((x) => x.id === id);
      if (!pl) return fail('Playlist not found');
      if (patch.name !== undefined) pl.name = String(patch.name).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60) || pl.name;
      if (Array.isArray(patch.add)) pl.tracks = pl.tracks.concat(patch.add.filter((t) => okIds.has(t))).slice(0, 5000);
      if (Array.isArray(patch.tracks)) pl.tracks = patch.tracks.filter((t) => okIds.has(t)).slice(0, 5000);
      if (typeof patch.removeAt === 'number') pl.tracks.splice(patch.removeAt, 1);
      savePar();
      return ok({ playlist: pl, state: parlorState() });
    },
    playlistDelete: async (id) => { const p = pOf(prof().id); p.playlists = p.playlists.filter((x) => x.id !== id); savePar(); return ok({ state: parlorState() }); },
    musicPlay: async ({ trackIds, start, context } = {}) => {
      await boot();
      const okIds = visibleTrackIds();
      const list = (trackIds || []).filter((id) => okIds.has(id)).map(trackFor).filter(Boolean);
      if (!list.length) return fail('Nothing to play.');
      await native('musicPlay', { tracks: list, start: start || 0, context: context || null });
      return ok();
    },
    musicCmd: async (cmd, arg) => {
      if (cmd === 'enqueue') {
        const okIds = visibleTrackIds();
        const list = ((arg && arg.trackIds) || []).filter((id) => okIds.has(id)).map(trackFor).filter(Boolean);
        const s = await native('musicCmd', 'enqueue', { tracks: list, next: !!(arg && arg.next) });
        return ok({ player: s ? publicPlayer(s) : null });
      }
      const s = await native('musicCmd', cmd, arg == null ? null : arg);
      return s ? ok({ player: publicPlayer(s) }) : { ok: false };
    },

    onConfigChanged: on('config-changed'),
    onScanProgress: on('scan-progress'),
    onLibraryUpdated: on('library-updated'),
    onRemote: on('remote'),
    onPlaybackError: on('playback-error'),
    onPlaybackEnded: on('playback-ended'),
    onDrivesChanged: on('drives-changed'),
    onCopyProgress: on('copy-progress'),
    onNotice: on('notice'),
    onMusicState: on('music-state'),
    onParlorUpdated: on('parlor-updated'),
  };
})();
