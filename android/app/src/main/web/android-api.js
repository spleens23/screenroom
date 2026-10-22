// window.api for the Android app. It plays the role the desktop app's preload.js + main.js play:
// the Kotlin side (exposed as `Android`) scans files, plays video and runs the phone remote, and this file
// turns its raw scan data into library items using the same shared code as the desktop (MediaCore).
(() => {
  'use strict';
  const native = window.Android;
  const pending = new Map();
  const listeners = {};
  let seq = 0;

  // Kotlin answers calls and sends events by running these.
  window.__androidReply = (id, json) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    let v = null;
    try { v = JSON.parse(json); } catch (e) { p.reject(e); return; }
    if (v && typeof v === 'object' && v.__error) p.reject(new Error(v.__error));
    else p.resolve(v);
  };
  window.__androidEvent = (name, json) => {
    let payload = null;
    try { payload = json ? JSON.parse(json) : null; } catch {}
    handleEvent(name, payload);
  };

  function call(method, ...args) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      try { native.call(id, method, JSON.stringify(args)); } catch (e) { pending.delete(id); reject(e); }
    });
  }
  const emit = (name, payload) => (listeners[name] || []).forEach((cb) => { try { cb(payload); } catch (e) { console.error(e); } });
  const on = (name) => (cb) => { (listeners[name] = listeners[name] || []).push(cb); };

  // ---- turning raw scan entries into library items -----------------------------------------------
  let library = [];
  function finish(raw) {
    const all = (raw.library || []).map((r) => {
      const it = MediaCore.buildItemFromProbe(r.path, { mtimeMs: r.mtime, size: r.size }, r.probe || {}, r.id);
      it.art = r.art || null;
      it.backdrop = r.backdrop || null;
      return MediaCore.applyTv(it);
    });
    MediaCore.fillSeriesRatings(all);
    const items = all.filter((it) => MediaCore.allowedFor(it, raw.profile)); // kids profiles only see what's rated for them
    const deduped = MediaCore.dedupeEpisodes(items);
    const dups = deduped.dups || [];
    library = deduped.sort((a, b) => a.title.localeCompare(b.title));
    pushCatalog();
    return { ...raw, library, duplicates: dups.length };
  }
  const state = async () => finish(await call('state'));
  // Profile calls answer { ok, state? }: turn the raw state into library items like everything else.
  const withState = (r) => (r && r.state ? { ...r, state: finish(r.state) } : r);

  // The phone remote's Library tab is served by the Kotlin web server, so hand it the same list the desktop builds.
  function pushCatalog() {
    const movies = [];
    const series = new Map();
    for (const it of library) {
      if (it.tv) {
        const key = it.tv.series.toLowerCase();
        if (!series.has(key)) series.set(key, { key, name: it.tv.series, kind: 'series', seasons: new Set(), episodes: 0 });
        const s = series.get(key); s.seasons.add(it.tv.season); s.episodes++;
      }
    }
    for (const g of MediaCore.groupMovies(library)) movies.push({ key: g.versions[0].id, name: g.title, kind: 'movie', year: g.year });
    const shows = [...series.values()].map((s) => ({ ...s, seasons: s.seasons.size }));
    call('setCatalog', [...movies, ...shows].sort((a, b) => a.name.localeCompare(b.name))).catch(() => {});
  }

  // What the player shows for each file (title, S1:E2, episode name, synopsis), like main.js does on desktop.
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

  async function play({ id, audioTrack, fromStart }) {
    const item = library.find((i) => i.id === id);
    if (!item) return { ok: false, error: 'That file is no longer in the library.' };
    const queue = queueFor(item).map((i) => ({ id: i.id, path: i.path, duration: i.duration, ...playerMeta(i) }));
    return call('play', { queue, audioTrack: audioTrack || null, fromStart: !!fromStart });
  }

  async function remoteInfo() {
    const r = await call('remoteInfo');
    r.smb = r.smb || [];
    r.qr = '';
    if (r.enabled && r.urls && r.urls[0] && typeof qrcode === 'function') {
      try {
        const q = qrcode(0, 'M');
        q.addData(`${r.urls[0]}/#pin=${r.pin}`);
        q.make();
        r.qr = q.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
      } catch {}
    }
    return r;
  }

  // ---- events from Kotlin ------------------------------------------------------------------------------
  function handleEvent(name, payload) {
    switch (name) {
      case 'library-updated':
      case 'playback-ended':
      case 'config-changed':
        state().then((s) => emit(name, s)).catch(() => {});
        break;
      default:
        emit(name, payload);
    }
  }

  window.api = {
    state,
    scan: async () => finish(await call('scan')),
    addDir: async () => finish(await call('addDir')),
    removeDir: async (d) => finish(await call('removeDir', d)),
    setConfig: async (p) => finish(await call('setConfig', p)),
    play,
    setWatched: async (ids, watched) => finish(await call('setWatched', { ids, watched })),
    reveal: () => {},
    audioDevices: async () => [],
    remoteInfo,
    quit: () => call('quit'),
    exitApp: () => call('quit'),
    power: async () => ({ ok: false }),
    drives: () => call('drives'),
    copyDrive: (mount) => call('copyDrive', mount),
    cancelCopy: () => call('cancelCopy'),
    ejectDrive: (mount) => call('ejectDrive', mount),
    openSystemSettings: (which) => call('openSettings', which || 'main'),
    selectProfile: async (id, pin) => withState(await call('profileSelect', id, pin || '')),
    showProfilePicker: async () => finish(await call('profilePicker')),
    saveProfile: async (profile, pin) => withState(await call('profileSave', profile, pin || '')),
    setProfilePin: async (id, newPin, pin) => withState(await call('profileSetPin', id, newPin, pin || '')),
    deleteProfile: async (id, pin) => withState(await call('profileDelete', id, pin || '')),
    clearProblems: async () => finish(await call('clearProblems')),
    rate: async (key, stars) => finish(await call('rate', key, stars)),
    recommend: async (to, item) => finish(await call('recommend', to, item)),
    dismissRec: async (id) => finish(await call('dismissRec', id)),
    setVoteState: (blob) => call('setVoteState', blob).catch(() => {}),
    onConfigChanged: on('config-changed'),
    kioskStatus: () => call('kioskStatus'),
    kioskLock: (pin) => call('kioskLock', pin),
    kioskUnlock: (pin) => call('kioskUnlock', pin),
    kioskRelease: (pin) => call('kioskRelease', pin),
    onScanProgress: on('scan-progress'),
    onLibraryUpdated: on('library-updated'),
    onRemote: on('remote'),
    onPlaybackError: on('playback-error'),
    onPlaybackEnded: on('playback-ended'),
    onDrivesChanged: on('drives-changed'),
    onCopyProgress: on('copy-progress'),
  };
})();
