// Voice control on the Linux box: "Hey Screenroom, play Night Drive in the living room."
// Starts the listener (lib/voice-listener.js, its own process) when a USB microphone is plugged in, works out what
// was asked for (lib/voice-intent.js) and does it with the same players the remote uses. Music goes to the Sonos
// room asked for (or the one music last played in); films and shows play on the TV.
const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const { understand } = require('./voice-intent');

function setupVoice(ctx) {
  // ctx: { dir, getConfig, setConfig, send(ch, payload), parlor (parlorApi.voice), films() → [{key,name,kind,year}],
  //        isFilmPlaying(), control(cmd) (the film player), playEntry(key) → Promise, stopFilm() → Promise, profile() }
  let child = null, status = { on: false, mic: false, name: '', cards: [], error: '' }, last = null;
  let levelsWanted = false, busyTimer = null, pollTimer = null, filmDucked = false, duckTimer = null;
  const cfg = () => ({ on: true, device: '', room: '', ...(ctx.getConfig().voice || {}) });
  const tellUi = (m) => ctx.send('voice', m);
  const filmToast = (t) => { if (ctx.isFilmPlaying()) ctx.control(['script-message', 'nf-toast', t]); };

  function usbMicPresent() {
    try {
      const cards = fs.readFileSync('/proc/asound/cards', 'utf8');
      for (const m of cards.matchAll(/^\s*(\d+)\s+\[(\S+)\s*\]:\s*(\S+)/gm)) {
        const want = cfg().device;
        if (want ? want.includes(`CARD=${m[2]},`) : /usb/i.test(m[3])) {
          if (fs.readdirSync(`/proc/asound/card${m[1]}`).some((f) => /^pcm\d+c$/.test(f))) return true;
        }
      }
    } catch {}
    return false;
  }

  function start() {
    if (child) return;
    const script = path.join(__dirname, 'voice-listener.js');
    if (!fs.existsSync(path.join(ctx.dir, 'models', 'whisper'))) { status = { ...status, on: true, mic: false, error: 'The speech files aren\'t in this copy of Screenroom.' }; return; }
    child = fork(script, [], {
      execPath: process.execPath,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SCREENROOM_VOICE_DIR: ctx.dir, SCREENROOM_VOICE_DEVICE: cfg().device || '' },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let err = '';
    child.stderr.on('data', (d) => { err = (err + d).slice(-2000); if (process.env.SCREENROOM_VOICE_DEBUG) process.stderr.write(d); });
    child.on('message', onMessage);
    child.on('exit', (code) => {
      child = null;
      status = { ...status, mic: false, error: code ? (status.error || `The voice listener stopped (${code}). ${err.trim().split('\n').pop() || ''}`.trim()) : status.error };
      tellUi({ type: 'status', status: publicStatus() });
    });
    child.send({ type: 'levels', on: levelsWanted });
    status.on = true;
    // the rooms, looked up ahead of time (a request shouldn't wait for the network)
    ctx.parlor.refreshRooms();
  }
  function stop() { if (child) { try { child.send({ type: 'stop' }); } catch {} const c = child; setTimeout(() => { try { c.kill(); } catch {} }, 1500); child = null; } status = { ...status, mic: false }; }

  function onMessage(m) {
    if (!m || !m.type) return;
    if (m.type === 'status') {
      status = { ...status, mic: !!m.mic, name: m.name || '', device: m.device || '', cards: m.cards || status.cards, error: m.mic ? '' : (m.error || '') };
      tellUi({ type: 'status', status: publicStatus() });
    } else if (m.type === 'level') {
      tellUi({ type: 'level', v: m.v, speech: m.speech });
    } else if (m.type === 'wake') {
      // turn down whatever's playing, so the request is heard (and so you know it's listening)
      ctx.parlor.duck(true);
      if (ctx.isFilmPlaying() && !filmDucked) { filmDucked = true; ctx.control(['multiply', 'volume', 0.3]); }
      tellUi({ type: 'listening' });
      filmToast('🎙 Listening…');
      // (never left turned down, whatever happens to the request)
      clearTimeout(duckTimer); duckTimer = setTimeout(() => unduck().catch(() => {}), 15000);
    } else if (m.type === 'heard') {
      handle(m).catch((e) => finish({ ok: false, msg: e.message || 'Something went wrong.' }));
    } else if (m.type === 'gone') {
      tellUi({ type: 'status', status: publicStatus() });
    }
  }

  async function unduck() {
    clearTimeout(duckTimer);
    await ctx.parlor.duck(false);
    if (filmDucked) { filmDucked = false; if (ctx.isFilmPlaying()) ctx.control(['multiply', 'volume', 1 / 0.3]); }
  }
  function finish(r) {
    last = { at: Date.now(), said: r.said || '', ok: !!r.ok, msg: r.msg || '' };
    tellUi({ type: 'done', ...last });
    if (r.msg) filmToast(r.msg);
  }

  async function lib() {
    const music = ctx.parlor.library();
    const films = ctx.films();
    return {
      ...music,
      films: films.filter((f) => f.kind === 'movie').map((f) => ({ id: f.key, title: f.name, year: f.year })),
      shows: films.filter((f) => f.kind === 'series').map((f) => ({ key: f.key, name: f.name })),
      rooms: await ctx.parlor.rooms(),
    };
  }

  async function handle(m) {
    const said = (m.text || '').trim();
    if (!said) { await unduck(); tellUi({ type: 'done', ok: false, said: '', msg: '' }); return; }
    tellUi({ type: 'heard', said });
    const L = await lib();
    const r = understand(said, L);
    if (process.env.SCREENROOM_VOICE_DEBUG) console.error('[voice] understood', JSON.stringify({ ...r, album: r.album && r.album.title, song: r.song && r.song.title }));
    await unduck();
    const film = ctx.isFilmPlaying();
    const done = (ok, msg) => finish({ ok, msg, said });

    // ---- the player: the film if one's on, otherwise the music ----
    const controls = { pause: 'pause', resume: 'resume', stop: 'stop', next: 'next', prev: 'prev', volume: 'volume', mute: 'mute', shuffle: 'shuffle', seek: 'seek' };
    if (controls[r.do]) {
      if (film) {
        const c = { pause: ['set_property', 'pause', true], resume: ['set_property', 'pause', false], stop: ['quit'], next: ['playlist-next', 'force'], prev: ['seek', 0, 'absolute'],
          mute: ['set_property', 'mute', r.on !== false], seek: ['seek', r.by || 0, 'relative'],
          volume: r.to != null ? ['set_property', 'volume', r.to] : ['add', 'volume', r.by || 0] }[r.do];
        if (!c) return done(false, 'That works for music, not films.');
        ctx.control(c);
        return done(true, { pause: 'Paused', resume: 'Playing', stop: 'Stopped', next: 'Next episode', prev: 'From the start', mute: r.on === false ? 'Sound on' : 'Muted', seek: r.by > 0 ? 'Forward' : 'Back', volume: r.to != null ? `Volume ${r.to}%` : (r.by > 0 ? 'Louder' : 'Quieter') }[r.do]);
      }
      const ok = await ctx.parlor.cmd(r.do, r.do === 'volume' ? { to: r.to, by: r.by } : r.do === 'mute' || r.do === 'shuffle' ? r.on !== false : r.by);
      if (!ok) return done(false, 'Nothing is playing.');
      const where = ctx.parlor.speaker();
      return done(true, ({ pause: 'Paused', resume: 'Playing', stop: 'Stopped', next: 'Next song', prev: 'Previous song', mute: r.on === false ? 'Sound on' : 'Muted', shuffle: r.on === false ? 'Shuffle off' : 'Shuffle on', seek: r.by > 0 ? 'Forward' : 'Back',
        volume: r.to != null ? `Volume ${r.to}` : (r.by > 0 ? 'Louder' : 'Quieter') }[r.do]) + (where && ['volume', 'mute'].includes(r.do) ? ` · ${where.name}` : ''));
    }
    if (r.do === 'cancel' || r.do === 'nothing') return done(true, '');
    if (r.do === 'whats-on') {
      const t = ctx.parlor.track();
      return done(!!t, t ? `${t.title} — ${t.artist} · ${t.where}` : 'Nothing is playing.');
    }
    if (r.do === 'move') {
      const res = await ctx.parlor.moveTo(r.room ? r.room.id : '');
      return done(res.ok, res.ok ? `Playing in ${r.room ? r.room.name : 'here on the TV'}` : res.error);
    }
    if (r.do === 'not-found') return done(false, `Couldn’t find “${r.what}”` + (r.near && r.near.length ? ` (did you mean ${r.near[0]}?)` : ''));
    if (r.do === 'unknown') return done(false, `Didn’t understand “${said}”`);

    // ---- films and shows: on the TV ----
    if (r.do === 'play-film' || r.do === 'play-show') {
      if (film) await ctx.stopFilm();
      const key = r.do === 'play-film' ? r.film.id : r.show.key;
      await ctx.playEntry(key);
      return done(true, r.do === 'play-film' ? `Playing ${r.film.title}` : `Playing ${r.show.name}`);
    }

    // ---- music ----
    if (r.do === 'play-music') {
      let ids = [], start = 0, name = '', shuffle = !!r.shuffle;
      if (r.album) { ids = r.album.tracks; name = r.album.title; }
      else if (r.song) { const a = L.albums.find((x) => x.key === r.song.albumKey); ids = a ? a.tracks : [r.song.id]; start = Math.max(0, ids.indexOf(r.song.id)); name = r.song.title; if (shuffle) { ids = [r.song.id, ...ids.filter((x) => x !== r.song.id)]; } }
      else if (r.artist) { ids = L.albums.filter((a) => a.artist === r.artist.name).flatMap((a) => a.tracks); ids = [...ids, ...L.tracks.filter((t) => t.artist === r.artist.name && !ids.includes(t.id)).map((t) => t.id)]; name = r.artist.name; shuffle = true; }
      else if (r.playlist) { ids = r.playlist.tracks; name = r.playlist.name; }
      else if (r.favourites) { ids = L.albums.filter((a) => (L.pinned || []).includes(a.key)).flatMap((a) => a.tracks); name = 'your favourites'; shuffle = true; }
      else { ids = L.tracks.map((t) => t.id); name = 'some music'; shuffle = true; }
      if (r.song && shuffle) start = 0;
      if (!ids.length) return done(false, 'There’s nothing to play there.');
      // where: the room asked for; otherwise wherever music is playing now; otherwise the room set in Settings
      let room;
      if (r.room === null) room = '';
      else if (r.room) room = r.room.id;
      else if (ctx.parlor.speaker()) room = undefined;
      else if (cfg().room === 'tv') room = '';
      else if (cfg().room) room = cfg().room;
      else room = (ctx.getConfig().lastSonosRoom || {}).id || '';
      if (room === '' && film) return done(false, 'A film is playing on the TV.');
      const rooms = L.rooms || [];
      const res = await ctx.parlor.play(ids, start, { room, shuffle: r.song ? false : shuffle, queue: r.queue });
      if (!res.ok) return done(false, res.error || 'Couldn’t play that.');
      const where = room === '' ? 'the TV' : (rooms.find((x) => x.id === room) || ctx.parlor.speaker() || {}).name;
      return done(true, `${r.queue ? 'Added' : 'Playing'} ${name}${where ? ` · ${where}` : ''}`);
    }
    return done(false, `Didn’t understand “${said}”`);
  }

  // ---- running: whenever a microphone is plugged in and voice control is on ---------------------------------------
  function tick() {
    const want = cfg().on && (usbMicPresent() || process.env.SCREENROOM_VOICE_FILES);
    if (want && !child) start();
    if (!want && child) { stop(); status = { ...status, on: cfg().on, mic: false, error: cfg().on ? 'No USB microphone is plugged in.' : '' }; tellUi({ type: 'status', status: publicStatus() }); }
    if (!want && !child && cfg().on && !status.error) status.error = 'No USB microphone is plugged in.';
    status.on = cfg().on;
  }
  function publicStatus() { return { on: cfg().on, mic: status.mic, name: status.name, device: status.device || '', cards: status.cards || [], error: status.error || '', room: cfg().room, last }; }

  tick();
  pollTimer = setInterval(tick, 5000);
  // something playing on the box makes "Hey Screenroom" harder to hear: the listener looks harder then
  let wasBusy = null;
  busyTimer = setInterval(() => {
    const busy = ctx.isFilmPlaying() || (ctx.parlor.playing() && !ctx.parlor.speaker());
    if (child && busy !== wasBusy) { wasBusy = busy; try { child.send({ type: 'busy', on: busy }); } catch {} }
  }, 2000);
  setInterval(() => { if (child) ctx.parlor.refreshRooms(); }, 10 * 60 * 1000);

  return {
    status: publicStatus,
    set(patch) {
      const v = { ...cfg(), ...patch };
      ctx.setConfig({ voice: { on: !!v.on, device: v.device || '', room: v.room || '' } });
      if ('device' in patch && child) { try { child.send({ type: 'device', device: v.device || '' }); } catch {} }
      tick();
      return publicStatus();
    },
    levels(on) { levelsWanted = !!on; if (child) try { child.send({ type: 'levels', on: levelsWanted }); } catch {} },
    async rooms() { return ctx.parlor.rooms(); },
    /** (for tests and Settings → Try it: a request typed instead of said) */
    async simulate(text) { await handle({ text }); return last; },
    quit() { clearInterval(pollTimer); clearInterval(busyTimer); stop(); },
  };
}

module.exports = { setupVoice };
