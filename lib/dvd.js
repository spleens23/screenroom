'use strict';
/**
 * DVDs on the TV box: a disc in the drive shows up on the home screen, and plays in VLC, with the disc's own
 * menus (mpv, which plays everything else, has no DVD menus). VLC gets the whole screen; the remote reaches it
 * through Screenroom (lib keys helper / phone remote → dvd.key), and Screenroom's own controls (Back) are a small
 * window over the film (renderer/dvd-overlay.html).
 *
 *   const dvd = require('./lib/dvd')({ dataDir, send, sound, onStart, onEnd, overlay, keysNav, log })
 *   dvd.state()          what's in the drive (or null)
 *   dvd.play({ resume }) / dvd.key(name) / dvd.cmd(name) / dvd.stop() / dvd.eject() / dvd.setup()
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const os = require('os');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

const SETUP_STATUS = '/var/lib/screenroom/dvd-setup.json';

function sh(bin, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') }));
  });
}
const which = (name) => ['/usr/bin', '/usr/local/bin', '/bin'].map((d) => path.join(d, name)).find((f) => fs.existsSync(f)) || null;

// the library that reads store-bought (CSS-encrypted) discs
function hasDvdcss() {
  for (const d of ['/usr/lib/x86_64-linux-gnu', '/usr/lib/aarch64-linux-gnu', '/usr/lib', '/usr/local/lib']) {
    try { if (fs.readdirSync(d).some((n) => /^libdvdcss\.so(\.\d+)*$/.test(n))) return true; } catch {}
  }
  return false;
}

/** "THE_DARK_KNIGHT_WS_D1" → "The Dark Knight"; a label that says nothing ("DVD_VIDEO", "DISC1") → '' */
function cleanLabel(label) {
  let t = String(label || '').replace(/[_.]+/g, ' ').replace(/\s+/g, ' ').trim();
  t = t.replace(/\b(WS|FS|W S|F S|WIDESCREEN|FULLSCREEN|FULL SCREEN|16X9|4X3|NTSC|PAL|R1|R2|R4|DVD9|DVD5|SE|CE|SPECIAL EDITION|COLLECTORS EDITION|DELUXE EDITION|UNRATED|THEATRICAL|DIRECTORS CUT|EXTENDED|EDITION)\b/gi, ' ');
  t = t.replace(/\b(DISC|DISK|D|SIDE|VOL|VOLUME)\s*[0-9AB]+\b/gi, ' ').replace(/\s+/g, ' ').trim();
  if (!t || /^(DVD|DVD VIDEO|DVDVIDEO|VIDEO TS|DVDVOLUME|VOLUME|NO NAME|UNTITLED|DISC|MOVIE|FEATURE|CDROM|DVDROM)$/i.test(t)) return '';
  // Title Case, small words kept small; "LOTR" style acronyms stay as they are
  const small = new Set(['a', 'an', 'and', 'the', 'of', 'in', 'on', 'at', 'to', 'for', 'or', 'vs', 'with', 'from']);
  return t.toLowerCase().split(' ').map((w, i) => (i > 0 && small.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ').replace(/\b(Ii|Iii|Iv|Vi|Vii|Viii|Ix)\b/g, (m) => m.toUpperCase());
}

/** lsdvd's plain output → { discTitle, longest, titles: [{ n, secs, chapters, audio }] } */
function parseLsdvd(out) {
  const r = { discTitle: '', longest: 0, titles: [] };
  const dt = /^Disc Title:\s*(.*)$/m.exec(out); if (dt) r.discTitle = dt[1].trim();
  const lg = /^Longest track:\s*(\d+)/m.exec(out); if (lg) r.longest = Number(lg[1]);
  const re = /^Title:\s*(\d+),\s*Length:\s*(\d+):(\d+):(\d+)(?:\.\d+)?\s+Chapters:\s*(\d+).*?Audio streams:\s*(\d+)/gm;
  let m;
  while ((m = re.exec(out))) r.titles.push({ n: Number(m[1]), secs: Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]), chapters: Number(m[5]), audio: Number(m[6]) });
  return r;
}

const fmt = (s) => { s = Math.max(0, Math.round(s || 0)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`; };

module.exports = function dvdPlayer(ctx) {
  const cacheDir = path.join(ctx.dataDir(), 'dvd');
  const resumeFile = path.join(cacheDir, 'resume.json');
  try { fs.mkdirSync(cacheDir, { recursive: true }); } catch {}
  let disc = null;          // what's in the drive
  let probing = null;
  let vlc = null;           // the player while a disc plays
  let rc = null;            // its remote-control socket
  let live = { time: 0, length: 0, title: 0, chapter: 0, paused: false, audio: '', subs: '' };
  let overlayOpen = false, overlayPeek = false;
  let lastSeen = '';

  const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
  const resumes = () => readJson(resumeFile, {});
  const setupStatus = () => readJson(SETUP_STATUS, null);

  function publicState() {
    if (!disc) return null;
    const r = resumes()[disc.id];
    const st = setupStatus();
    return {
      device: disc.device, label: disc.label, title: disc.title, year: disc.year, overview: disc.overview, rating: disc.rating, genre: disc.genre,
      poster: disc.poster || '', runtime: disc.runtime ? fmt(disc.runtime) : '', probing: !!disc.probing, problem: disc.problem || '',
      resume: r && r.time > 60 ? { title: r.title, time: r.time, at: fmt(r.time) } : null,
      ready: hasDvdcss(), setup: st && !hasDvdcss() ? st : null, playing: !!vlc, live: vlc ? { ...live, at: fmt(live.time), len: fmt(live.length) } : null,
    };
  }
  const tell = () => ctx.send('dvd-state', publicState());

  // ---- the drive: a disc going in or out (udev keeps these up to date, from the drive's own media events) ----
  async function poll() {
    let drives = [];
    try { drives = fs.readdirSync('/sys/block').filter((n) => /^sr\d+$/.test(n)); } catch {}
    let found = null;
    // (testing: a disc image in place of a drive)
    if (process.env.SCREENROOM_DVD_TEST) found = fs.existsSync(process.env.SCREENROOM_DVD_TEST) ? { device: process.env.SCREENROOM_DVD_TEST, label: process.env.SCREENROOM_DVD_TEST_LABEL || 'TEST', uuid: 'test' } : null;
    else for (const d of drives) {
      const p = await sh('udevadm', ['info', '--query=property', `--name=/dev/${d}`], 5000);
      const prop = Object.fromEntries(p.out.split('\n').map((l) => l.split('=')).filter((x) => x.length >= 2).map(([k, ...v]) => [k, v.join('=')]));
      if (prop.ID_CDROM_MEDIA === '1' && (prop.ID_CDROM_MEDIA_DVD === '1' || /^DVD/.test(prop.ID_CDROM_MEDIA_STATE || '') || prop.ID_FS_TYPE === 'udf')) {
        found = { device: `/dev/${d}`, label: prop.ID_FS_LABEL_ENC ? prop.ID_FS_LABEL_ENC.replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))) : (prop.ID_FS_LABEL || ''), uuid: prop.ID_FS_UUID || '' };
        break;
      }
    }
    const key = found ? `${found.device}|${found.label}|${found.uuid}` : '';
    if (key === lastSeen) return;
    lastSeen = key;
    if (!found) {
      if (disc && !vlc) { disc = null; tell(); }
      return;
    }
    probe(found);
  }

  async function probe(found) {
    const id0 = crypto.createHash('sha1').update(`${found.label}|${found.uuid}`).digest('hex').slice(0, 16);
    disc = { ...found, id: id0, title: cleanLabel(found.label) || 'DVD', probing: true };
    tell();
    ctx.inserted && ctx.inserted(publicState());
    const me = disc;
    probing = me;
    // the disc's titles (the film is usually the longest); lsdvd only reads the disc's tables, which aren't encrypted
    let info = null;
    if (which('lsdvd')) {
      for (let i = 0; i < 3 && !info; i++) {
        const r = await sh('lsdvd', [found.device], 30000);
        if (r.ok || /Title:/.test(r.out)) info = parseLsdvd(r.out);
        else await new Promise((res) => setTimeout(res, 2500)); // (the drive still spinning up)
      }
    }
    if (disc !== me) return;
    if (info) {
      me.titles = info.titles;
      const main = info.titles.find((t) => t.n === info.longest) || info.titles.slice().sort((a, b) => b.secs - a.secs)[0];
      me.main = main ? main.n : 1; me.runtime = main ? main.secs : 0;
      me.id = crypto.createHash('sha1').update(`${found.label}|${info.titles.map((t) => `${t.n}:${t.secs}`).join(',')}`).digest('hex').slice(0, 16);
      if (!cleanLabel(found.label) && info.discTitle) me.title = cleanLabel(info.discTitle) || 'DVD';
    } else if (which('lsdvd')) {
      me.problem = 'This disc couldn\'t be read. It may be dirty or scratched, or not a film DVD.';
    }
    me.probing = false;
    tell();
    // store-bought discs need libdvdcss: set it up now if it isn't there yet (needs internet once)
    if (!hasDvdcss()) setup();
  }

  let setupRunning = false;
  function setup() {
    if (setupRunning || hasDvdcss() || process.platform !== 'linux') return;
    setupRunning = true;
    execFile('systemctl', ['start', '--no-block', 'screenroom-dvd-setup.service'], () => {});
    const t = setInterval(() => {
      tell();
      const st = setupStatus();
      if (hasDvdcss() || (st && /^(error|offline)$/.test(st.state))) { clearInterval(t); setupRunning = false; tell(); }
    }, 3000);
    setTimeout(() => { clearInterval(t); setupRunning = false; }, 15 * 60000);
  }

  // ---- VLC's remote control ----------------------------------------------------------------------------------
  // One question at a time. VLC's answers: "get_time" etc. are a bare line; other commands end with
  // "<command>: returned 0 (no error)". "status change: ( play state: 4 )" lines can come at any time.
  let rcBuf = '', rcWait = null, rcQueue = Promise.resolve();
  function rcSend(line) { if (rc && !rc.destroyed) try { rc.write(line + '\n'); } catch {} }
  function rcAsk(line, ms = 800) {
    const job = rcQueue.then(() => new Promise((resolve) => {
      if (!rc || rc.destroyed) return resolve('');
      rcBuf = '';
      const bare = /^get_/.test(line);
      rcWait = { resolve, bare, t: setTimeout(() => { rcWait = null; resolve(rcBuf); }, ms) };
      rcSend(line);
    }));
    rcQueue = job.catch(() => {});
    return job;
  }
  function connectRc(sock, tries = 0) {
    const c = net.createConnection(sock);
    let pending = '';
    c.on('connect', () => { rc = c; });
    c.on('data', (d) => {
      pending += d.toString();
      let i;
      while ((i = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, i).replace(/\r$/, '').replace(/^>\s*/, ''); pending = pending.slice(i + 1);
        const ps = /play state:\s*(\d+)/.exec(line);
        if (ps) { live.paused = ps[1] === '4'; continue; }
        if (/^status change:/.test(line) || !rcWait) continue;
        rcBuf += line + '\n';
        if (rcWait.bare ? line.trim() !== '' : /: returned -?\d+/.test(line)) { clearTimeout(rcWait.t); const w = rcWait; rcWait = null; w.resolve(rcBuf); }
      }
    });
    c.on('error', () => { if (vlc && tries < 40) setTimeout(() => connectRc(sock, tries + 1), 250); });
    c.on('close', () => { if (rc === c) rc = null; });
  }
  const num = (s) => { const m = /(-?\d+(?:\.\d+)?)/.exec(String(s || '')); return m ? Number(m[1]) : 0; };
  // the track marked * in VLC's list: "Track 1 - [English]" → "English"
  const current = (s) => {
    const m = /^\|\s*-?\d+\s*-\s*(.+?)\s*\*\s*$/m.exec(String(s || '')); if (!m) return '';
    const br = /\[([^\]]+)\]/.exec(m[1]); if (br) return br[1];
    return m[1].replace(/^Track \d+\s*-?\s*/, '') || m[1];
  };
  let refreshing = false;
  async function refresh() {
    if (!rc || refreshing) return;
    refreshing = true;
    try {
      const t = num(await rcAsk('get_time')), l = num(await rcAsk('get_length'));
      const ti = /title (\d+)\//.exec(await rcAsk('title')), ch = /chapter (\d+)\//.exec(await rcAsk('chapter'));
      const au = current(await rcAsk('atrack')), su = current(await rcAsk('strack'));
      const vo = num(await rcAsk('volume'));
      live = { ...live, time: t, length: l, title: ti ? Number(ti[1]) : live.title, chapter: ch ? Number(ch[1]) + 1 : live.chapter, audio: au, subs: su, volume: Math.round((vo / 256) * 100) };
      if (overlayOpen) ctx.overlay('state', { ...publicState(), peek: overlayPeek });
    } finally { refreshing = false; }
  }

  // ---- playing ------------------------------------------------------------------------------------------------
  async function play({ resume } = {}) {
    if (vlc) return { ok: false, error: 'The DVD is already playing.' };
    if (!disc) return { ok: false, error: 'There\'s no DVD in the drive.' };
    const bin = process.env.SCREENROOM_VLC || which('vlc') || which('cvlc');
    if (!bin) return { ok: false, error: 'The DVD player isn\'t installed yet. Connect the box to the internet and it sets itself up within a few minutes.' };
    const sound = await ctx.sound().catch(() => ({}));
    const sock = path.join(os.tmpdir(), `screenroom-dvd-${process.pid}.sock`);
    try { fs.unlinkSync(sock); } catch {}
    const r = resume ? resumes()[disc.id] : null;
    const mrl = r && r.title ? `dvd://${disc.device}#${r.title}` : `dvd://${disc.device}`;
    // the remote reaches the disc through Screenroom (so Back can bring up Screenroom's controls); without the
    // remote helper (a computer, not the box), VLC takes the keyboard itself
    const viaUs = ctx.keysNav(true);
    const args = [
      '-I', 'dummy', '--no-dbus', '--extraintf=oldrc', `--rc-unix=${sock}`, '--rc-fake-tty',
      '--fullscreen', '--video-on-top', '--no-video-title-show', '--no-osd', '--no-video-deco', '--no-embedded-video',
      ...(viaUs ? ['--no-keyboard-events'] : []), '--no-mouse-events', '--mouse-hide-timeout=0', '--no-snapshot-preview',
      '--no-media-library', '--no-loop', '--no-repeat', '--no-random', '--play-and-exit',
      '--deinterlace=-1', '--deinterlace-mode=yadif2x',
      '--aout=alsa',
    ];
    const dev = String(sound.audioDevice || sound.device || '').replace(/^alsa\//, '');
    if (dev && dev !== 'auto') args.push(`--alsa-audio-device=${dev}`);
    if (sound.passthrough) args.push('--spdif');
    const lang = (ctx.lang && ctx.lang()) || {};
    if (lang.audio) args.push(`--audio-language=${lang.audio}`);
    if (lang.sub) args.push(`--sub-language=${lang.sub}`);
    if (r && r.time && r.title) args.push(`--start-time=${Math.max(0, r.time - 5)}`);
    args.push(mrl);
    const log = path.join(cacheDir, 'vlc.log');
    let out;
    try { out = fs.openSync(log, 'w'); } catch {}
    try { vlc = spawn(bin, args, { stdio: ['ignore', out || 'ignore', out || 'ignore'], env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' } }); } catch (e) { ctx.keysNav(false); return { ok: false, error: e.message }; }
    if (out) try { fs.closeSync(out); } catch {}
    live = { time: r ? r.time : 0, length: 0, title: r ? r.title : 0, chapter: 0, paused: false, audio: '', subs: '' };
    const started = Date.now();
    const me = vlc;
    setTimeout(() => connectRc(sock), 400);
    const tick = setInterval(refresh, 2000);
    ctx.onStart && ctx.onStart();
    vlc.on('exit', (code) => {
      clearInterval(tick);
      if (vlc !== me) return;
      vlc = null; rc = null;
      ctx.keysNav(false);
      closeOverlay();
      // where to pick up next time: the film (a long title), not a trailer or the menu
      const t = (disc && disc.titles || []).find((x) => x.n === live.title);
      if (disc && live.time > 60 && (!t || t.secs > 1200)) {
        const all = resumes();
        const nearEnd = live.length && live.length - live.time < 240;
        if (nearEnd) delete all[disc.id]; else all[disc.id] = { title: live.title, time: Math.round(live.time), at: Date.now() };
        try { fs.writeFileSync(resumeFile, JSON.stringify(all)); } catch {}
      }
      let problem = '';
      if (Date.now() - started < 8000 && code) {
        let text = ''; try { text = fs.readFileSync(log, 'utf8'); } catch {}
        problem = /dvdcss|css|encrypt|scrambl/i.test(text) && !hasDvdcss()
          ? 'This disc is copy-protected, and the box is still getting ready to play those. Connect it to the internet and try again in a few minutes.'
          : 'The DVD couldn\'t be played. If it\'s dirty or scratched, clean it and try again.';
        if (!hasDvdcss()) setup();
      }
      ctx.onEnd && ctx.onEnd(problem);
      tell();
    });
    tell();
    return { ok: true };
  }

  function stop() { if (vlc) { rcSend('quit'); const me = vlc; setTimeout(() => { if (vlc === me) try { me.kill('SIGTERM'); } catch {} }, 2500); } }

  async function eject() {
    if (vlc) { stop(); await new Promise((r) => setTimeout(r, 1500)); }
    const dev = disc ? disc.device : '/dev/sr0';
    const r = await sh('eject', [dev], 20000);
    if (!r.ok) await sh('udisksctl', ['eject', '-b', dev], 20000);
    disc = null; lastSeen = '__ejected'; tell();
    setTimeout(() => { lastSeen = ''; }, 4000);
    return { ok: true };
  }

  // ---- the remote ---------------------------------------------------------------------------------------------
  const VLC_KEYS = { up: 'key-nav-up', down: 'key-nav-down', left: 'key-nav-left', right: 'key-nav-right', ok: 'key-nav-activate' };
  // Back (or the ≡ menu button) brings up the controls; the volume buttons show them briefly, with the volume
  let peekTimer = null;
  function openOverlay(peek) {
    clearTimeout(peekTimer);
    if (peek) peekTimer = setTimeout(() => { if (overlayPeek) closeOverlay(); }, 2500);
    if (overlayOpen) { overlayPeek = overlayPeek && !!peek; ctx.overlay('state', { ...publicState(), peek: overlayPeek }); refresh(); return; }
    overlayOpen = true; overlayPeek = !!peek;
    ctx.overlay('open', { ...publicState(), peek: overlayPeek });
    refresh();
  }
  function closeOverlay() { clearTimeout(peekTimer); overlayPeek = false; if (overlayOpen) { overlayOpen = false; ctx.overlay('close'); } }
  /** one button on the remote (or the phone): while the controls are up they go there, otherwise to the disc */
  function key(k) {
    if (!vlc) return false;
    if (k === 'home') { stop(); return true; }
    if (k === 'volup' || k === 'voldown') { cmd(k); openOverlay(true); return true; }
    if (overlayOpen) {
      if (k === 'back' || k === 'info' || k === 'menu') { closeOverlay(); return true; }
      if (k === 'playpause' || k === 'stop' || k === 'eject' || k === 'next' || k === 'prev' || k === 'ffwd' || k === 'rew') return cmd(k);
      if (overlayPeek) { overlayPeek = false; clearTimeout(peekTimer); ctx.overlay('state', { ...publicState(), peek: false }); }
      ctx.overlay('key', k);
      return true;
    }
    if (VLC_KEYS[k]) { rcSend(`key ${VLC_KEYS[k]}`); return true; }
    if (k === 'back' || k === 'info' || k === 'menu') { openOverlay(false); return true; }
    return cmd(k);
  }
  function cmd(c) {
    if (!vlc) return false;
    switch (c) {
      case 'playpause': case 'pause': rcSend('pause'); live.paused = !live.paused; if (overlayOpen) ctx.overlay('state', publicState()); break;
      case 'stop': stop(); break;
      case 'discmenu': rcSend('key key-disc-menu'); closeOverlay(); break;
      case 'next': rcSend('chapter_n'); break;
      case 'prev': rcSend('chapter_p'); break;
      case 'ffwd': case 'seekfwd': rcSend(`seek ${Math.round(live.time + 30)}`); live.time += 30; break;
      case 'rew': case 'seekback': rcSend(`seek ${Math.max(0, Math.round(live.time - 10))}`); live.time = Math.max(0, live.time - 10); break;
      case 'audio': rcSend('key key-audio-track'); break;
      case 'subtitle': case 'subs': rcSend('key key-subtitle-track'); break;
      case 'volup': rcSend('volup 1'); break;
      case 'voldown': rcSend('voldown 1'); break;
      case 'rewind': return cmd('rew');
      case 'forward': return cmd('ffwd');
      case 'eject': eject(); break;
      case 'close': closeOverlay(); break;
      default: return false;
    }
    setTimeout(refresh, 300);
    return true;
  }

  let timer = null;
  return {
    start() { if (process.platform !== 'linux' || timer) return; poll(); timer = setInterval(poll, 2500); timer.unref && timer.unref(); },
    state: publicState,
    active: () => !!vlc,
    play, stop, eject, key, cmd, setup,
    overlayState: publicState,
    _test: { cleanLabel, parseLsdvd },
  };
};
