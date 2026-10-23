// Parlor's music player: one background mpv with no window, driven over its JSON IPC socket.
// Plays a queue of songs (gapless), and reports what's playing so the UI can show it.
const { spawn } = require('child_process');
const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');

class MusicPlayer {
  /** bin: mpv path; onState(state) is called whenever something changes (throttled). */
  constructor({ bin, onState, onError }) {
    this.bin = bin;
    this.onState = onState || (() => {});
    this.onError = onError || (() => {});
    this.proc = null;
    this.client = null;
    this.reqId = 0;
    this.pending = new Map();
    this.queue = [];          // [{ id, path, title, artist, album, art, duration, albumKey }]
    this.state = { playing: false, paused: false, index: -1, pos: 0, dur: 0, volume: 100, queue: [], context: null };
    this.emitTimer = null;
    this.device = '';
  }

  // ---- process / socket ---------------------------------------------------------------------------------
  // One start at a time: two quick clicks (a double-click on a song) used to start two players fighting over one socket.
  ensure(device) {
    if (!this.starting) this.starting = this.ensureNow(device).finally(() => { this.starting = null; });
    return this.starting;
  }
  async ensureNow(device) {
    if (this.proc && this.client && device === this.device) return;
    if (this.proc && device !== this.device) await this.stop(true);
    this.device = device || '';
    const sock = process.platform === 'win32' ? `\\\\.\\pipe\\screenroom-music-${process.pid}` : path.join(os.tmpdir(), `screenroom-music-${process.pid}.sock`);
    try { fs.unlinkSync(sock); } catch {}
    const args = ['--idle=yes', '--no-video', '--no-terminal', '--force-window=no', '--audio-display=no', '--gapless-audio=yes',
      '--keep-open=no', '--load-scripts=no', '--no-config', `--input-ipc-server=${sock}`, `--volume=${this.state.volume}`,
      `--log-file=${path.join(os.tmpdir(), 'screenroom-music.log')}`];
    if (this.device) args.push(`--audio-device=${this.device}`);
    this.proc = spawn(this.bin, args, { stdio: 'ignore' });
    this.proc.on('exit', () => { this.proc = null; this.client = null; this.state.playing = false; this.emit(); });
    this.proc.on('error', (e) => this.onError(e.message));
    for (let i = 0; i < 40 && !this.client; i++) {
      await new Promise((r) => setTimeout(r, 100));
      await new Promise((resolve) => {
        const c = net.createConnection(sock);
        c.on('connect', () => { this.attach(c); resolve(); });
        c.on('error', () => resolve());
      });
    }
    if (!this.client) throw new Error('The music player did not start.');
    for (const [i, name] of ['playlist-pos', 'time-pos', 'duration', 'pause', 'idle-active', 'volume', 'mute'].entries()) this.send(['observe_property', i + 1, name]);
  }

  attach(c) {
    this.client = c;
    let buf = '';
    c.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.request_id && this.pending.has(m.request_id)) { this.pending.get(m.request_id)(m); this.pending.delete(m.request_id); continue; }
        if (m.event === 'property-change') this.onProp(m.name, m.data);
      }
    });
    c.on('error', () => {});
    c.on('close', () => { if (this.client === c) this.client = null; });
  }

  send(command) {
    if (!this.client) return Promise.resolve(null);
    const request_id = ++this.reqId;
    return new Promise((resolve) => {
      this.pending.set(request_id, resolve);
      this.client.write(JSON.stringify({ command, request_id }) + '\n');
      setTimeout(() => { if (this.pending.delete(request_id)) resolve(null); }, 3000);
    });
  }

  onProp(name, v) {
    const s = this.state;
    if (name === 'playlist-pos') { s.index = typeof v === 'number' ? v : -1; s.pos = 0; if (this.onTrack && s.index >= 0) this.onTrack(this.queue[s.index]); }
    else if (name === 'time-pos') s.pos = typeof v === 'number' ? v : 0;
    else if (name === 'duration') s.dur = typeof v === 'number' ? v : 0;
    else if (name === 'pause') s.paused = !!v;
    else if (name === 'volume' && typeof v === 'number') s.volume = Math.round(v);
    else if (name === 'mute') s.muted = !!v;
    else if (name === 'idle-active') { s.playing = !v; if (v) { s.index = -1; s.pos = 0; } }
    this.emit(name === 'time-pos' ? 500 : 0);
  }

  emit(delay = 0) {
    if (this.emitTimer) { if (delay) return; clearTimeout(this.emitTimer); }
    this.emitTimer = setTimeout(() => { this.emitTimer = null; this.onState(this.snapshot()); }, delay);
  }

  snapshot() {
    const s = this.state;
    return { playing: s.playing, paused: s.paused, index: s.index, pos: s.pos, dur: s.dur || (this.queue[s.index] || {}).duration || 0,
      volume: s.volume, muted: !!s.muted, track: this.queue[s.index] || null, queue: this.queue, context: s.context };
  }

  // ---- controls -----------------------------------------------------------------------------------------
  /** Play these songs, starting at `start`. context = what it came from ({ kind:'album'|'playlist'|'songs', id, name }). */
  /** Requests are handled one after another, newest wins (a double-click plays the song once, cleanly). */
  play(tracks, start = 0, opts = {}) {
    const run = () => this.playNow(tracks, start, opts);
    this.chain = (this.chain || Promise.resolve()).catch(() => {}).then(run);
    return this.chain;
  }
  async playNow(tracks, start = 0, { device, context } = {}) {
    if (!tracks.length) return;
    await this.ensure(device);
    this.queue = tracks;
    this.state.context = context || null;
    await this.send(['playlist-clear']);
    await this.send(['stop']);
    if (tracks.length > 30) {
      // a long list (Shuffle on all songs) goes over in one go as a playlist file
      const list = path.join(os.tmpdir(), `screenroom-queue-${process.pid}.m3u`);
      fs.writeFileSync(list, tracks.map((t) => t.path).join('\n') + '\n');
      await this.send(['loadlist', list, 'append']);
    } else for (const t of tracks) await this.send(['loadfile', t.path, 'append']);
    await this.send(['set_property', 'pause', false]);
    await this.send(['playlist-play-index', Math.max(0, Math.min(start, tracks.length - 1))]);
    this.emit();
  }
  async toggle() { if (this.client) await this.send(['cycle', 'pause']); }
  async pause() { if (this.client) await this.send(['set_property', 'pause', true]); }
  async next() { if (this.client && this.state.index < this.queue.length - 1) await this.send(['playlist-next', 'force']); }
  async prev() {
    if (!this.client) return;
    if (this.state.pos > 3 || this.state.index <= 0) await this.send(['seek', 0, 'absolute']);
    else await this.send(['playlist-prev', 'force']);
  }
  async seek(sec) { if (this.client) await this.send(['seek', Math.max(0, sec), 'absolute']); }
  async volume(v) { this.state.volume = Math.max(0, Math.min(100, Math.round(v))); if (this.client) await this.send(['set_property', 'volume', this.state.volume]); this.emit(); }
  async jump(index) { if (this.client && index >= 0 && index < this.queue.length) await this.send(['playlist-play-index', index]); }
  /** Add songs after the current one ("Play next") or at the end. */
  async enqueue(tracks, next) {
    if (!this.client || !this.state.playing) return this.play(tracks, 0, { device: this.device });
    for (const t of tracks) await this.send(['loadfile', t.path, 'append']);
    const from = this.queue.length;
    this.queue = this.queue.concat(tracks);
    if (next) {
      for (let i = 0; i < tracks.length; i++) await this.send(['playlist-move', from + i, this.state.index + 1 + i]);
      const moved = this.queue.splice(from, tracks.length);
      this.queue.splice(this.state.index + 1, 0, ...moved);
    }
    this.emit();
  }
  async stop(quit) {
    this.queue = []; this.state.context = null;
    if (this.client) await this.send(quit ? ['quit'] : ['stop']);
    if (quit && this.proc) { try { this.proc.kill(); } catch {} this.proc = null; this.client = null; }
    this.emit();
  }
}

module.exports = { MusicPlayer };
