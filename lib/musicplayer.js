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
    this.state = { playing: false, paused: false, index: -1, pos: 0, dur: 0, volume: 100, queue: [], context: null, shuffle: false, repeat: 'off' };
    this.unshuffled = null; // the queue's own order while shuffled
    this.emitTimer = null;
    this.device = '';
  }

  /**
   * How mpv sends the sound out. Surround songs (5.1 / 7.1 FLAC, AAC, upmixes) go out with all their channels
   * (mpv's default sends stereo to HDMI, so a soundbar saw 2-channel PCM). With "passthrough" on, Dolby (Atmos
   * E-AC-3, TrueHD) and DTS music goes to the soundbar untouched, as for films; and a TV that only passes stereo
   * PCM on gets surround songs as Dolby Digital 5.1 made on the fly (stereo songs stay as they are).
   */
  static audioArgs(s) {
    const a = [];
    if (s.audioDevice) a.push(`--audio-device=${s.audioDevice}`);
    if (s.downmix) { a.push('--audio-channels=stereo'); return a; }
    if (s.passthrough) {
      const keep = ['ac3', 'eac3', 'dts', 'dts-hd', 'truehd'].filter((f) => !(s.truehdPassthrough === false && f === 'truehd') && !(s.dtsPassthrough === false && f.startsWith('dts')));
      a.push(`--audio-spdif=${keep.join(',')}`);
      if (process.platform === 'linux') a.push('--audio-buffer=0.5');
      if (s.pcmChannels != null && s.pcmChannels <= 2) { a.push('--af=lavcac3enc=tospdif=yes:minch=3'); return a; }
    }
    a.push('--audio-channels=7.1,5.1,stereo');
    return a;
  }

  // ---- process / socket ---------------------------------------------------------------------------------
  // One start at a time: two quick clicks (a double-click on a song) used to start two players fighting over one socket.
  ensure(sound) {
    if (!this.starting) this.starting = this.ensureNow(sound).finally(() => { this.starting = null; });
    return this.starting;
  }
  async ensureNow(sound) {
    // sound: the sound settings ({ audioDevice, passthrough, downmix, pcmChannels, … } as for films), or just a device
    if (typeof sound === 'string' || sound == null) sound = { audioDevice: sound || '' };
    const audioArgs = MusicPlayer.audioArgs(sound);
    const key = audioArgs.join(' ');
    if (this.proc && this.client && key === this.soundKey && (sound.audioDevice || '') === this.device) return;
    if (this.proc) await this.stop(true);
    this.sound = sound;
    this.soundKey = key;
    this.device = sound.audioDevice || '';
    const sock = process.platform === 'win32' ? `\\\\.\\pipe\\screenroom-music-${process.pid}` : path.join(os.tmpdir(), `screenroom-music-${process.pid}.sock`);
    try { fs.unlinkSync(sock); } catch {}
    const args = ['--idle=yes', '--no-video', '--no-terminal', '--force-window=no', '--audio-display=no', '--gapless-audio=yes',
      '--keep-open=no', '--load-scripts=no', '--no-config', `--input-ipc-server=${sock}`, `--volume=${this.state.volume}`,
      `--log-file=${path.join(os.tmpdir(), 'screenroom-music.log')}`];
    args.push(...audioArgs);
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
    if (name === 'playlist-pos' && (this.relisting || Date.now() < (this.relistQuiet || 0))) return; // the order is being redone; the song didn't change
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
      volume: s.volume, muted: !!s.muted, track: this.queue[s.index] || null, queue: this.queue, context: s.context,
      shuffle: !!s.shuffle, repeat: s.repeat || 'off' };
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
    await this.ensure(device === undefined ? this.sound : device);
    this.queue = tracks;
    this.unshuffled = null; this.state.shuffle = false;
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
  async next() {
    if (!this.client) return;
    if (this.state.index < this.queue.length - 1) await this.send(['playlist-next', 'force']);
    else if (this.state.repeat === 'all' && this.queue.length) await this.send(['playlist-play-index', 0]);
  }
  /** Repeat: off → the whole queue → this song → off. */
  async cycleRepeat() {
    const r = { off: 'all', all: 'one' }[this.state.repeat] || 'off';
    this.state.repeat = r;
    if (this.client) {
      await this.send(['set_property', 'loop-file', r === 'one' ? 'inf' : 'no']);
      await this.send(['set_property', 'loop-playlist', r === 'all' ? 'inf' : 'no']);
    }
    this.emit();
  }
  /** Shuffle on: this song first, then everything else in a random order. Off: back to the queue's own order. */
  async toggleShuffle() {
    const s = this.state;
    if (!this.client || s.index < 0 || !this.queue[s.index]) { s.shuffle = !s.shuffle; return this.emit(); }
    const cur = this.queue[s.index];
    let q, at;
    if (!s.shuffle) {
      this.unshuffled = this.queue.slice();
      const rest = this.queue.filter((_, i) => i !== s.index);
      for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
      q = [cur, ...rest]; at = 0;
    } else {
      // back in order; anything added while shuffled stays, at the end
      const base = this.unshuffled || this.queue;
      q = base.concat(this.queue.filter((t) => !base.includes(t)));
      at = Math.max(0, q.indexOf(cur));
      this.unshuffled = null;
    }
    s.shuffle = !s.shuffle;
    await this.relist(q, at);
  }
  /** Give mpv a new order without interrupting the song that's playing (it stays where it is). */
  async relist(q, at) {
    this.relisting = true;
    try {
      await this.send(['playlist-clear']); // clears all but the current song, which becomes number 0
      for (const t of q.slice(0, at)) await this.send(['loadfile', t.path, 'append']);
      for (const t of q.slice(at + 1)) await this.send(['loadfile', t.path, 'append']);
      if (at > 0) await this.send(['playlist-move', 0, at + 1]);
    } finally { this.relisting = false; this.relistQuiet = Date.now() + 600; }
    this.queue = q; this.state.index = at;
    this.emit();
  }
  async prev() {
    if (!this.client) return;
    if (this.state.pos > 3 || this.state.index <= 0) await this.send(['seek', 0, 'absolute']);
    else await this.send(['playlist-prev', 'force']);
  }
  async seek(sec) { if (this.client) await this.send(['seek', Math.max(0, sec), 'absolute']); }
  async volume(v) { this.state.volume = Math.max(0, Math.min(100, Math.round(v))); if (this.client) await this.send(['set_property', 'volume', this.state.volume]); this.emit(); }
  async jump(index) { if (this.client && index >= 0 && index < this.queue.length) await this.send(['playlist-play-index', index]); }
  /** Clear Queue: only the song that's playing is left (it carries on). */
  async clearQueue() {
    const cur = this.queue[this.state.index];
    if (!this.client || !cur) return;
    this.unshuffled = null;
    await this.relist([cur], 0);
  }
  /** Add songs after the current one ("Play next") or at the end. */
  async enqueue(tracks, next) {
    if (!this.client || !this.state.playing) return this.play(tracks, 0, { device: this.sound });
    tracks = tracks.map((t) => ({ ...t, queued: true })); // shown under "Playing Next"
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
    this.queue = []; this.state.context = null; this.unshuffled = null; this.state.shuffle = false;
    if (this.client) await this.send(quit ? ['quit'] : ['stop']);
    if (quit && this.proc) { try { this.proc.kill(); } catch {} this.proc = null; this.client = null; }
    this.emit();
  }
}

module.exports = { MusicPlayer };
