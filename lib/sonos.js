// Parlor playing on Sonos speakers, from the box (and the desktop app): as the phone apps do (ios/Screenroom/Sonos.swift,
// android/…/Sonos.kt). The speaker is told where each song is on the network (a small web server here hands it the
// file exactly as it is: a Dolby Atmos song arrives as Dolby Atmos on a speaker that plays it; a stereo-only one,
// like a Five, gets the album's stereo version of the song, or a stereo copy made here with ffmpeg) and plays it
// itself. Parlor keeps the queue; the speaker gets the songs from the one playing onwards, a few at a time, and is
// asked every second where it's got to.
'use strict';
const http = require('http');
const dgram = require('dgram');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

// ---- bits of XML ----------------------------------------------------------------------------------------------
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unesc = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
function tag(name, s) {
  const a = s.indexOf(`<${name}>`); if (a < 0) return null;
  const b = s.indexOf(`</${name}>`, a); if (b < 0) return null;
  return s.slice(a + name.length + 2, b);
}
const attrs = (s) => { const o = {}; for (const m of s.matchAll(/([A-Za-z_:]+)="([^"]*)"/g)) o[m[1]] = unesc(m[2]); return o; };
const hms = (t) => { const s = Math.max(0, Math.floor(t || 0)); return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const secs = (s) => (!s || s === 'NOT_IMPLEMENTED' ? 0 : s.split(':').reduce((a, p) => a * 60 + (parseFloat(p) || 0), 0));

function request(url, { method = 'GET', headers = {}, body = null, timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers, timeout }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('The speaker didn\'t answer.')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---- the files, on the network ----------------------------------------------------------------------------------
const MIME = { m4a: 'audio/mp4', mp4: 'audio/mp4', m4b: 'audio/mp4', aac: 'audio/aac', alac: 'audio/mp4', mp3: 'audio/mpeg', flac: 'audio/flac', wav: 'audio/wav',
  aif: 'audio/aiff', aiff: 'audio/aiff', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', ec3: 'audio/eac3', eac3: 'audio/eac3', ac3: 'audio/ac3',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const mime = (name) => MIME[path.extname(name).slice(1).toLowerCase()] || 'application/octet-stream';

const FileServer = {
  server: null, port: 0, files: new Map(), secret: crypto.randomBytes(16).toString('hex'),
  async ensure() {
    if (this.server && this.server.listening) return;
    for (const want of [51400, 0]) {
      const s = http.createServer((req, res) => this.answer(req, res));
      const ok = await new Promise((resolve) => { s.once('error', () => resolve(false)); s.listen(want, '0.0.0.0', () => resolve(true)); });
      if (ok) { this.server = s; this.port = s.address().port; return; }
    }
    throw new Error('Parlor couldn\'t share songs on the network.');
  },
  /** The address a speaker uses for this file. `host` is this computer's address on the speaker's network. */
  url(file, host) {
    const token = crypto.createHash('sha256').update(this.secret + file).digest('hex').slice(0, 32);
    this.files.set(token, file);
    const ext = path.extname(file).slice(1).toLowerCase() || 'bin';
    return `http://${host}:${this.port}/p/${token}.${ext}`;
  },
  answer(req, res) {
    const m = /^\/p\/([0-9a-f]{32})\./.exec(req.url || '');
    const file = m && this.files.get(m[1]);
    let st = null;
    try { st = file && fs.statSync(file); } catch {}
    if (!st || !st.isFile() || !['GET', 'HEAD'].includes(req.method)) { res.writeHead(404); res.end(); return; }
    const size = st.size;
    let start = 0, end = size - 1, partial = false;
    const r = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (r) {
      partial = true;
      if (r[1] === '' && r[2] !== '') start = Math.max(0, size - Number(r[2]));
      else if (r[1] !== '') { start = Number(r[1]); if (r[2] !== '') end = Math.min(Number(r[2]), size - 1); }
    }
    if (start >= size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
    const headers = { 'Content-Type': mime(file), 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 };
    if (partial) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    res.writeHead(partial ? 206 : 200, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = fs.createReadStream(file, { start, end });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  },
};

/** This computer's address on the same network as `ip` (the one the speaker is on). */
function localAddress(ip) {
  const toInt = (a) => a.split('.').reduce((x, p) => ((x << 8) | (Number(p) & 255)) >>> 0, 0);
  let any = null;
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal) continue;
      if (ip && a.netmask && ((toInt(a.address) & toInt(a.netmask)) >>> 0) === ((toInt(ip) & toInt(a.netmask)) >>> 0)) return a.address;
      if (!any) any = a.address;
    }
  }
  return any;
}

// ---- the speakers ------------------------------------------------------------------------------------------------
/** A room (or a group of rooms playing together) on the Sonos system: commands go to the group's coordinator. */
class SonosRoom {
  constructor({ id, name, host, model = '', atmos = false }) { Object.assign(this, { id, name, host, model, atmos }); }
  get ip() { return this.host.split(':')[0]; }
  get json() { return { id: this.id, name: this.name, model: this.model, atmos: this.atmos }; }
  async soap(p, service, action, args = []) {
    const inner = args.map(([k, v]) => `<${k}>${esc(v)}</${k}>`).join('');
    const body = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="urn:schemas-upnp-org:service:${service}:1">${inner}</u:${action}></s:Body></s:Envelope>`;
    const r = await request(`http://${this.host}${p}`, { method: 'POST', body, headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPACTION: `"urn:schemas-upnp-org:service:${service}:1#${action}"`, 'Content-Length': Buffer.byteLength(body) } });
    if (r.status >= 300) throw new Error(`${this.name} said no to ${action} (${tag('errorCode', r.text) || r.status})`);
    return r.text;
  }
  av(action, ...args) { return this.soap('/MediaRenderer/AVTransport/Control', 'AVTransport', action, [['InstanceID', '0'], ...args]); }
  group(action, ...args) { return this.soap('/MediaRenderer/GroupRenderingControl/Control', 'GroupRenderingControl', action, [['InstanceID', '0'], ...args]); }
}

/** Speakers answer a "who's there?" on the network (SSDP); their own web address is on port 1400. */
function ssdp(ms = 2500) {
  return new Promise((resolve) => {
    const found = new Set();
    const msg = Buffer.from('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: urn:schemas-upnp-org:device:ZonePlayer:1\r\n\r\n');
    const socks = [];
    const addrs = [];
    for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if ((a.family === 'IPv4' || a.family === 4) && !a.internal) addrs.push(a.address);
    for (const addr of addrs.length ? addrs : [null]) {
      const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      s.on('error', () => { try { s.close(); } catch {} });
      s.on('message', (m) => {
        const loc = /^location:\s*(\S+)/im.exec(String(m));
        if (!loc) return;
        try { const u = new URL(loc[1]); found.add(`${u.hostname}:${u.port || 1400}`); } catch {}
      });
      s.bind(0, addr || undefined, () => {
        try { if (addr) s.setMulticastInterface(addr); } catch {}
        const send = () => { try { s.send(msg, 1900, '239.255.255.250'); } catch {} };
        send(); setTimeout(send, 400); setTimeout(send, 1200);
      });
      socks.push(s);
    }
    setTimeout(() => { for (const s of socks) { try { s.close(); } catch {} } resolve(found); }, ms);
  });
}

class Sonos {
  constructor({ dataDir }) { this.file = path.join(dataDir, 'sonos-hosts.json'); this.rooms = []; }
  cached() { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')).filter((h) => typeof h === 'string'); } catch { return []; } }
  /** The rooms on the network, found afresh (a few seconds at most). */
  async findRooms() {
    const tried = new Set();
    const attempt = async (hosts) => {
      for (const h of hosts) {
        if (tried.has(h)) continue;
        tried.add(h);
        const list = await this.topology(h).catch(() => null);
        if (list && list.length) {
          this.rooms = list;
          try { fs.writeFileSync(this.file, JSON.stringify([...new Set(list.map((r) => r.host))])); } catch {}
          return list;
        }
      }
      return null;
    };
    // (the speakers seen last time first: usually they're still there, and it's quicker)
    const quick = await attempt(this.cached());
    if (quick) { ssdp(1500).then(() => {}); return quick; }
    const fresh = await attempt([...(await ssdp())]);
    return fresh || [];
  }
  room(id) { return this.rooms.find((r) => r.id === id) || null; }

  /** The groups, from one speaker: each group's coordinator, its name, and what kind of speaker it is. */
  async topology(host) {
    const r = await new SonosRoom({ id: '', name: 'The speaker', host }).soap('/ZoneGroupTopology/Control', 'ZoneGroupTopology', 'GetZoneGroupState');
    const st = tag('ZoneGroupState', r);
    if (!st) return null;
    const state = unesc(st);
    const out = [];
    for (const g of state.matchAll(/<ZoneGroup\s([^>]*)>([\s\S]*?)<\/ZoneGroup>/g)) {
      const coord = attrs(g[1]).Coordinator;
      if (!coord) continue;
      let lead = null;
      const others = [];
      for (const m of g[2].matchAll(/<ZoneGroupMember\s([^>]*?)\/?>/g)) {
        const a = attrs(m[1]);
        if (a.UUID === coord) lead = a; else if (a.Invisible !== '1' && a.ZoneName) others.push(a.ZoneName);
      }
      if (!lead || !lead.ZoneName || !lead.Location) continue;
      let u;
      try { u = new URL(lead.Location); } catch { continue; }
      const room = new SonosRoom({ id: coord, name: [lead.ZoneName, ...others.sort()].join(' + '), host: `${u.hostname}:${u.port || 1400}` });
      try {
        const x = (await request(lead.Location, { timeout: 4000 })).text;
        const model = (tag('displayName', x) || tag('modelName', x) || '').replace(/^Sonos /, '');
        const number = tag('modelNumber', x) || '';
        const m = model.toLowerCase();
        room.model = model;
        room.atmos = m.startsWith('arc') || m.includes('era 300') || (m.startsWith('beam') && number !== 'S14');
      } catch {}
      out.push(room);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }
}

// ---- stereo copies ------------------------------------------------------------------------------------------------
/**
 * Stereo copies of Dolby Atmos and surround songs, for Sonos speakers that only play stereo (a Five, a One, a Move…):
 * ffmpeg mixes the song down to two channels as 256 kbps AAC, kept for next time (about 1.5 GB at most).
 */
class Downmix {
  constructor({ dir, ffmpeg }) { this.dir = dir; this.ffmpeg = ffmpeg || 'ffmpeg'; this.making = new Map(); }
  stereo(file) {
    const st = fs.statSync(file);
    const key = crypto.createHash('sha256').update(`${file}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 24);
    const out = path.join(this.dir, key + '.m4a');
    if (fs.existsSync(out) && fs.statSync(out).size > 0) { try { const t = new Date(); fs.utimesSync(out, t, t); } catch {} return Promise.resolve(out); }
    if (this.making.has(key)) return this.making.get(key);
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = path.join(this.dir, `making-${key}.m4a`);
    const job = new Promise((resolve, reject) => {
      execFile(this.ffmpeg, ['-nostdin', '-v', 'error', '-y', '-i', file, '-map', '0:a:0', '-vn', '-ac', '2', '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', tmp],
        { timeout: 5 * 60000 }, (err) => {
          if (err) { try { fs.unlinkSync(tmp); } catch {} reject(new Error('The stereo copy couldn\'t be made.')); return; }
          try { fs.renameSync(tmp, out); } catch (e) { reject(e); return; }
          this.prune();
          resolve(out);
        });
    }).finally(() => this.making.delete(key));
    this.making.set(key, job);
    return job;
  }
  prune() {
    try {
      const files = fs.readdirSync(this.dir).filter((n) => !n.startsWith('making-')).map((n) => { const p = path.join(this.dir, n); return { p, st: fs.statSync(p) }; })
        .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
      let total = 0;
      for (const f of files) { total += f.st.size; if (total > 1.5e9) fs.unlinkSync(f.p); }
    } catch {}
  }
}

// ---- playing on a room ---------------------------------------------------------------------------------------------
/** Parlor's queue on a Sonos room: what the speaker has, and where it's got to. */
class SonosLink {
  constructor(room, tracks, { downmix }) {
    this.room = room; this.tracks = tracks; this.downmix = downmix;
    this.onUpdate = () => {}; this.onProblem = () => {}; this.onVolume = () => {};
    this.pos = 0; this.dur = 0; this.at = Date.now(); this.paused = true; this.volume = 30; this.muted = false;
    this.base = 0; this.filled = 0; this.gen = 0; this.filling = false; this.wasPlaying = false; this.holdUntil = 0;
    this.calls = Promise.resolve(); this.prep = Promise.resolve();
    this.volumeSetAt = 0; this.pollCount = 0; this.polling = false; this.alive = true; this.timer = null;
  }
  get now() { return this.paused ? this.pos : Math.min(this.dur > 0 ? this.dur : Infinity, this.pos + (Date.now() - this.at) / 1000); }

  run(what, op) {
    this.calls = this.calls.then(op).catch((e) => { console.warn('Sonos:', what, 'failed:', e.message); this.onProblem(e.message || `${what} failed`); });
    return this.calls;
  }
  didl(t, file, host) {
    const uri = FileServer.url(file, host);
    const art = t.art && fs.existsSync(t.art) ? `<upnp:albumArtURI>${esc(FileServer.url(t.art, host))}</upnp:albumArtURI>` : '';
    const d = Number(t.duration) || 0;
    const meta = '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" '
      + 'xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">'
      + `<item id="-1" parentID="-1" restricted="true"><dc:title>${esc(t.title)}</dc:title><upnp:class>object.item.audioItem.musicTrack</upnp:class>`
      + `<dc:creator>${esc(t.artist)}</dc:creator><upnp:album>${esc(t.album)}</upnp:album>${art}`
      + `<res protocolInfo="http-get:*:${mime(file)}:*"${d > 0 ? ` duration="${hms(d)}"` : ''}>${esc(uri)}</res></item></DIDL-Lite>`;
    return { uri, meta };
  }
  /** Whether a Dolby Atmos or surround song goes to this speaker in stereo (one that doesn't play Dolby Atmos music
   *  plays nothing at all if sent it). */
  stereoFor(t) { return !!t && !this.room.atmos && !!t.spatial; }
  /** The file the speaker gets: the song, or for a stereo-only speaker the album's stereo version of a Dolby Atmos /
   *  surround song, or a stereo copy made here (kept for next time). */
  async source(t) {
    if (!t || !t.path) return null;
    if (!this.stereoFor(t)) return t.path;
    if (t.stereoPath && fs.existsSync(t.stereoPath)) return t.stereoPath;
    try { return await this.downmix.stereo(t.path); } catch (e) {
      this.onProblem(`${t.title || 'A song'} couldn't be made into stereo for ${this.room.name}, so it may not play there.`);
      return t.path;
    }
  }
  async add(t, file) {
    const host = localAddress(this.room.ip);
    if (!host) throw new Error('This box isn\'t on the speaker\'s network.');
    const { uri, meta } = this.didl(t, file, host);
    await this.room.av('AddURIToQueue', ['EnqueuedURI', uri], ['EnqueuedURIMetaData', meta], ['DesiredFirstTrackNumberEnqueued', '0'], ['EnqueueAsNext', '0']);
  }

  /** The speaker starts again from queue index `i` (at `start` seconds into it). */
  load(i, start, play) {
    const list = this.tracks();
    if (i < 0 || i >= list.length) return;
    const g = ++this.gen;
    this.base = i; this.filled = 0; this.filling = false;
    this.pos = start; this.at = Date.now(); this.dur = Number(list[i].duration) || 0;
    this.paused = !play; this.holdUntil = Date.now() + 3000;
    const first = list[i];
    const mode = this.playMode || 'NORMAL';
    this.run('start', async () => {
      await FileServer.ensure();
      const file = await this.source(first); // (a stereo copy, if the speaker needs one, is made first)
      if (!file || g !== this.gen) return;
      await this.room.av('RemoveAllTracksFromQueue');
      await this.add(first, file);
      if (g === this.gen) this.filled = 1;
      await this.room.av('SetAVTransportURI', ['CurrentURI', `x-rincon-queue:${this.room.id}#0`], ['CurrentURIMetaData', '']);
      // in Parlor's order: a room left on shuffle (in the Sonos app) would otherwise play the queue at random
      await this.room.av('SetPlayMode', ['NewPlayMode', mode]).catch(() => {});
      await this.room.av('Seek', ['Unit', 'TRACK_NR'], ['Target', '1']);
      if (start > 1) await this.room.av('Seek', ['Unit', 'REL_TIME'], ['Target', hms(start)]).catch(() => {});
      if (play) await this.room.av('Play', ['Speed', '1']);
      this.fill(g);
    });
  }
  /** The rest of the queue onto the speaker, a few songs at a time: the files first (stereo copies take a few seconds
   *  each), apart from the speaker commands so Play / Pause don't wait for them. */
  fill(g) {
    if (g !== this.gen || this.filling) return;
    const list = this.tracks();
    const from = Math.max(0, this.base + this.filled);
    if (from >= list.length) return;
    const batch = list.slice(from, from + 4);
    this.filling = true;
    this.prep = this.prep.then(async () => {
      const ready = [];
      for (const t of batch) {
        if (g !== this.gen) break;
        const f = await this.source(t);
        if (!f) break;
        ready.push([t, f]);
      }
      if (g !== this.gen) return;
      if (!ready.length) { this.filling = false; return; }
      this.run('add songs', async () => {
        try {
          for (const [t, f] of ready) {
            if (g !== this.gen) break;
            await this.add(t, f);
            if (g === this.gen) this.filled++;
          }
        } finally { if (g === this.gen) { this.filling = false; this.fill(g); } }
      });
    }).catch(() => { this.filling = false; });
  }
  /** The queue's gone (Parlor stopped): what the speaker has no longer matches it. */
  forget() { this.gen++; this.filled = 0; this.filling = false; this.wasPlaying = false; }
  /** Songs were added to the end of the queue. */
  grew() { if (!this.filling) this.fill(this.gen); }
  /** The queue changed after the song that's playing: it carries on, and what follows is put back in the new order. */
  rebuild(was, now) {
    const k = was - this.base;
    if (k < 0 || k >= this.filled) { this.load(now, this.now, !this.paused); return; }
    const g = ++this.gen;
    this.filling = false;
    this.base = now - k;
    const drop = this.filled - (k + 1);
    this.filled = k + 1;
    this.run('redo the queue', async () => {
      if (drop > 0) await this.room.av('RemoveTrackRangeFromQueue', ['UpdateID', '0'], ['StartingIndex', String(k + 2)], ['NumberOfTracks', String(drop)]);
      this.fill(g);
    });
  }
  jump(i) {
    const k = i - this.base;
    if (k < 0 || k >= this.filled) { this.load(i, 0, true); return; }
    this.pos = 0; this.at = Date.now(); this.paused = false; this.holdUntil = Date.now() + 3000;
    this.dur = Number((this.tracks()[i] || {}).duration) || 0;
    this.run('skip', async () => { await this.room.av('Seek', ['Unit', 'TRACK_NR'], ['Target', String(k + 1)]); await this.room.av('Play', ['Speed', '1']); });
  }
  play() { this.pos = this.now; this.at = Date.now(); this.paused = false; this.holdUntil = this.at + 3000; this.run('play', () => this.room.av('Play', ['Speed', '1'])); }
  pause() { this.pos = this.now; this.at = Date.now(); this.paused = true; this.holdUntil = this.at + 3000; this.run('pause', () => this.room.av('Pause')); }
  seek(s) { this.pos = s; this.at = Date.now(); this.holdUntil = this.at + 3000; this.run('seek', () => this.room.av('Seek', ['Unit', 'REL_TIME'], ['Target', hms(s)])); }
  setVolume(v) {
    this.volume = Math.max(0, Math.min(100, Math.round(v))); this.volumeSetAt = Date.now(); this.onVolume();
    const x = this.volume;
    this.run('volume', () => this.room.group('SetGroupVolume', ['DesiredVolume', String(x)]));
  }
  setMuted(m) { this.muted = m; this.onVolume(); this.run('mute', () => this.room.group('SetGroupMute', ['DesiredMute', m ? '1' : '0'])); }
  /** The speaker's play mode: always in order (Parlor does its own shuffling); repeat-one when asked. */
  repeatOne(on) { this.playMode = on ? 'REPEAT_ONE' : 'NORMAL'; this.run('repeat', () => this.room.av('SetPlayMode', ['NewPlayMode', on ? 'REPEAT_ONE' : 'NORMAL'])); }

  start() {
    this.room.group('GetGroupVolume').then((r) => { const v = parseInt(tag('CurrentVolume', r), 10); if (!Number.isNaN(v)) { this.volume = v; this.onVolume(); } }).catch(() => {});
    this.room.group('GetGroupMute').then((r) => { this.muted = tag('CurrentMute', r) === '1'; }).catch(() => {});
    this.timer = setInterval(() => this.poll(), 1000);
  }
  /** Parlor lets go of the speaker (the music stops there, if asked). */
  release(pause) {
    this.alive = false; this.gen++;
    if (this.timer) clearInterval(this.timer);
    if (pause) return this.run('pause', () => this.room.av('Pause').catch(() => {}));
    return Promise.resolve();
  }
  async poll() {
    if (this.polling || !this.alive) return;
    this.polling = true;
    const askVolume = ++this.pollCount % 3 === 0;
    try {
      const [p, t, v] = await Promise.all([
        this.room.av('GetPositionInfo').catch(() => null),
        this.room.av('GetTransportInfo').catch(() => null),
        // (the volume too, every few seconds: it may have been changed in the Sonos app or on the speaker)
        askVolume ? this.room.group('GetGroupVolume').then((r) => parseInt(tag('CurrentVolume', r), 10)).catch(() => null) : null,
      ]);
      if (v != null && !Number.isNaN(v) && v !== this.volume && Date.now() - this.volumeSetAt > 3000) { this.volume = v; this.onVolume(); }
      if (!p || !t || !this.alive) return;
      const state = tag('CurrentTransportState', t) || '';
      const track = parseInt(tag('Track', p), 10) || 0;
      const playing = state === 'PLAYING' || state === 'TRANSITIONING';
      // (just told to play, pause or seek: the speaker may not have got there yet, so its time waits)
      if (Date.now() >= this.holdUntil) {
        this.pos = secs(tag('RelTime', p));
        const d = secs(tag('TrackDuration', p)); if (d > 0) this.dur = d;
        this.at = Date.now();
        this.paused = !playing;
      }
      // the speaker ran out of songs (the end of the queue): stopped, not paused
      const lastFilled = this.base + this.filled >= this.tracks().length;
      if (state === 'STOPPED' && this.wasPlaying && lastFilled && !this.filling) { this.wasPlaying = false; this.onUpdate(null, true); return; }
      this.wasPlaying = playing;
      this.onUpdate(state !== 'STOPPED' && track >= 1 && track <= this.filled ? this.base + track - 1 : null, false);
    } finally { this.polling = false; }
  }
}

/**
 * Parlor's player when a Sonos room is chosen: the same controls as the box's own (lib/musicplayer.js), so the
 * screens, the phone remote and Parlor's commands don't need to know which one is playing.
 */
class SonosPlayer {
  constructor({ room, downmix, onState, onProblem }) {
    this.room = room;
    this.onState = onState || (() => {});
    this.queue = [];
    this.state = { index: -1, shuffle: false, repeat: 'off', context: null, playing: false };
    this.unshuffled = null;
    this.link = new SonosLink(room, () => this.queue, { downmix });
    this.link.onProblem = onProblem || (() => {});
    this.link.onVolume = () => this.emit();
    this.link.onUpdate = (i, ended) => {
      const s = this.state;
      if (ended) {
        if (s.repeat === 'all' && this.queue.length) { s.index = 0; this.link.load(0, 0, true); this.onTrack && this.onTrack(this.queue[0]); }
        else { s.playing = false; }
      } else if (i != null && i !== s.index) { s.index = i; if (this.onTrack) this.onTrack(this.queue[i]); }
      this.emit();
    };
    this.link.start();
  }
  get output() { return { id: this.room.id, name: this.room.name }; }
  emit() { this.onState(this.snapshot()); }
  snapshot() {
    const s = this.state, l = this.link, t = this.queue[s.index] || null;
    const downmix = l.stereoFor(t);
    return { playing: s.playing && s.index >= 0, paused: l.paused, index: s.index, pos: l.now, dur: l.dur || (t && t.duration) || 0,
      volume: l.volume, muted: !!l.muted, track: t, queue: this.queue, context: s.context, shuffle: !!s.shuffle, repeat: s.repeat || 'off',
      output: this.output,
      route: { sonos: true, name: this.room.name, model: this.room.model, atmos: !!this.room.atmos, downmix, twin: !!(downmix && t && t.stereoPath && fs.existsSync(t.stereoPath)) } };
  }

  /** Play these songs from `start` (at `at` seconds into it; paused if asked: the music moving over from the TV). */
  async play(tracks, start = 0, { context, at = 0, paused = false } = {}) {
    if (!tracks.length) return;
    this.queue = tracks; this.unshuffled = null;
    Object.assign(this.state, { index: Math.max(0, Math.min(start, tracks.length - 1)), shuffle: false, context: context || null, playing: true });
    this.link.load(this.state.index, at, !paused);
    if (this.onTrack) this.onTrack(this.queue[this.state.index]);
    this.emit();
  }
  async toggle() { if (this.link.paused) this.link.play(); else this.link.pause(); this.emit(); }
  async pause() { this.link.pause(); this.emit(); }
  async next() {
    const s = this.state;
    if (s.index < this.queue.length - 1) this.jump(s.index + 1);
    else if (s.repeat === 'all' && this.queue.length) { s.index = 0; this.link.load(0, 0, true); this.emit(); }
  }
  async prev() {
    if (this.link.now > 3 || this.state.index <= 0) this.link.seek(0); else this.jump(this.state.index - 1);
    this.emit();
  }
  async seek(sec) { this.link.seek(Math.max(0, sec)); this.emit(); }
  async volume(v) { this.link.setVolume(v); }
  async mute() { this.link.setMuted(!this.link.muted); }
  async jump(i) {
    if (i < 0 || i >= this.queue.length) return;
    this.state.index = i; this.state.playing = true;
    this.link.jump(i);
    if (this.onTrack) this.onTrack(this.queue[i]);
    this.emit();
  }
  async cycleRepeat() {
    const r = { off: 'all', all: 'one' }[this.state.repeat] || 'off';
    this.state.repeat = r;
    this.link.repeatOne(r === 'one');
    this.emit();
  }
  async toggleShuffle() {
    const s = this.state, cur = this.queue[s.index];
    if (!cur) { s.shuffle = !s.shuffle; return this.emit(); }
    let q, at;
    if (!s.shuffle) {
      this.unshuffled = this.queue.slice();
      const rest = this.queue.filter((_, i) => i !== s.index);
      for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
      q = [cur, ...rest]; at = 0;
    } else {
      const base = this.unshuffled || this.queue;
      q = base.concat(this.queue.filter((t) => !base.includes(t)));
      at = Math.max(0, q.indexOf(cur));
      this.unshuffled = null;
    }
    s.shuffle = !s.shuffle;
    const was = s.index;
    this.queue = q; s.index = at;
    this.link.rebuild(was, at);
    this.emit();
  }
  async clearQueue() {
    const cur = this.queue[this.state.index];
    if (!cur) return;
    const was = this.state.index;
    this.unshuffled = null; this.queue = [cur]; this.state.index = 0;
    this.link.rebuild(was, 0);
    this.emit();
  }
  async enqueue(tracks, next) {
    if (!this.state.playing || this.state.index < 0) return this.play(tracks, 0);
    tracks = tracks.map((t) => ({ ...t, queued: true }));
    if (next) {
      const i = this.state.index;
      this.queue = [...this.queue.slice(0, i + 1), ...tracks, ...this.queue.slice(i + 1)];
      this.link.rebuild(i, i);
    } else { this.queue = this.queue.concat(tracks); this.link.grew(); }
    this.emit();
  }
  async stop() {
    this.link.forget();
    this.link.pause();
    this.queue = []; this.unshuffled = null;
    Object.assign(this.state, { index: -1, playing: false, shuffle: false, context: null });
    this.emit();
  }
  /** Parlor lets go of this speaker (pausing it, if asked). */
  release(pause) { return this.link.release(pause); }
}

module.exports = { Sonos, SonosPlayer, SonosRoom, Downmix, FileServer, localAddress, ssdp, _test: { tag, unesc, hms, secs } };
