// Launches mpv with the Screenroom (Netflix-style) overlay script, queues the following
// episodes as a playlist, and tracks position per file over mpv's JSON IPC socket so the UI
// can offer "Continue Watching" and mark episodes as watched.
const { spawn, execFile, execFileSync } = require('child_process');
const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');

const PASSTHROUGH = 'ac3,eac3,dts,dts-hd,truehd';

function findBinary(name, configured) {
  if (configured && fs.existsSync(configured)) return configured;
  const dirs = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/snap/bin', '/Applications/mpv.app/Contents/MacOS'];
  for (const d of dirs) {
    const p = path.join(d, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Does this mpv build support game controllers? (Unknown options would stop mpv from starting.)
const capCache = {};
function mpvProfiles(bin) {
  const key = bin + '#profiles';
  if (capCache[key] === undefined) {
    try { capCache[key] = execFileSync(bin, ['--profile=help'], { encoding: 'utf8', timeout: 5000 }).split('\n').map((l) => l.trim().split(/\s/)[0]).filter(Boolean); }
    catch { capCache[key] = []; }
  }
  return capCache[key];
}

function mpvHas(bin, option) {
  const key = bin + option;
  if (capCache[key] === undefined) {
    try { capCache[key] = execFileSync(bin, ['--list-options'], { encoding: 'utf8', timeout: 5000 }).includes(option); }
    catch { capCache[key] = false; }
  }
  return capCache[key];
}

// [{ id, label }] of audio outputs mpv can see, e.g. alsa/hdmi:CARD=PCH,DEV=0
function listAudioDevices(bin) {
  return new Promise((resolve) => {
    if (!bin) return resolve([]);
    execFile(bin, ['--audio-device=help'], { timeout: 8000 }, (err, stdout) => {
      const out = [];
      for (const line of String(stdout || '').split('\n')) {
        const m = line.match(/^\s*'([^']+)'\s*\((.*)\)\s*$/);
        if (m) out.push({ id: m[1], label: m[2] });
      }
      resolve(out);
    });
  });
}

// Send a command to the running mpv (used by the phone remote).
let activeSock = null;
function control(command) {
  if (!activeSock) return false;
  const c = net.createConnection(activeSock);
  c.on('error', () => {});
  c.write(JSON.stringify({ command }) + '\n');
  setTimeout(() => c.destroy(), 300);
  return true;
}

function buildArgs(entries, opts, sock, metaFile) {
  const statsFile = path.join(os.tmpdir(), `screenroom-stats-${process.pid}.jsonl`);
  const first = entries[0].item;
  const args = [
    `--log-file=${path.join(os.tmpdir(), 'screenroom-mpv.log')}`, // handy when troubleshooting playback
    '--load-scripts=no', // ignore the user's other mpv scripts (a second on-screen controller would clash)
    `--input-ipc-server=${sock}`,
    '--force-window=yes',
    '--keep-open=no',
    '--hwdec=auto-safe',
    '--vo=gpu-next,gpu,x11',
    '--target-colorspace-hint=yes',
    `--title=${first.tv ? first.tv.series : first.title}`,
    '--audio-file-auto=no',
    '--osc=no',
    '--osd-bar=no',
    '--cursor-autohide=2000',
    '--cursor-autohide-fs-only=no',
    '--input-default-bindings=yes',
    '--stop-screensaver=yes',
    '--volume-max=130',
    // subtitles: clean white text with a soft outline, like a streaming service
    '--sub-color=#FFFFFF',
    '--sub-border-color=#000000',
    '--sub-border-size=2.4',
    '--sub-shadow-offset=1.2',
    '--sub-font-size=48',
    `--script=${opts.scriptPath}`,
    `--script-opts=netflix-meta=${metaFile},netflix-font=${process.platform === 'darwin' ? 'Helvetica Neue' : ''},netflix-tv=${opts.tv ? 'yes' : 'no'},netflix-passthru=${(opts.passthroughWanted != null ? opts.passthroughWanted : opts.passthrough) ? 'yes' : 'no'},netflix-sound=${opts.soundKind || ''},netflix-hdrout=${opts.hdrOut === false ? 'no' : ''},netflix-stats=${statsFile},netflix-theme=${opts.theme || ''}${opts.theme === 'heirloom' ? ',netflix-accent=5FA6DE' : ''}`,
  ];
  // 1990s theme: the on-screen display's lettering ships with Screenroom (mpv/fonts)
  if (opts.theme === '1990s' && opts.bin && mpvHas(opts.bin, '--osd-fonts-dir')) args.push(`--osd-fonts-dir=${path.join(path.dirname(opts.scriptPath), 'fonts')}`);
  if (opts.fullscreen) args.push('--fs');
  // Mac: when Screenroom itself is full screen, play full screen in the same Space (no slide to a new one).
  if (process.platform === 'darwin' && opts.appFullscreen && opts.bin && mpvHas(opts.bin, '--native-fs ')) args.push('--native-fs=no');
  if (opts.passthrough) {
    // "Dolby TrueHD: as 7.1": every format still goes out untouched except TrueHD, which is decoded to 7.1 here
    // (the same lossless sound, minus the Atmos height channels) for setups where TrueHD cuts out.
    const list = opts.truehdPassthrough === false ? PASSTHROUGH.replace(',truehd', '') : PASSTHROUGH;
    args.push(`--audio-spdif=${list}`);
    if (opts.truehdPassthrough === false) {
      // TrueHD decoded here. If the TV only takes stereo PCM (many do, even with a surround soundbar on eARC),
      // send it on as Dolby Digital 5.1 instead (made on the fly; everything else still goes out untouched);
      // otherwise as 7.1 / 5.1 PCM.
      if (opts.pcmChannels != null && opts.pcmChannels <= 2) args.push('--af=lavcac3enc');
      else args.push('--audio-channels=7.1,5.1,stereo');
    }
    if (process.platform === 'darwin') args.push('--audio-exclusive=yes');
    // a little more sound buffered for bitstreams (Dolby TrueHD / Atmos is big and bursty over HDMI)
    if (process.platform === 'linux') args.push('--audio-buffer=0.5');
  } else {
    args.push(opts.downmix ? '--audio-channels=stereo' : '--audio-channels=auto-safe');
    // "Even out volume": films are mixed much quieter than music; lift quiet passages and dialogue so a film
    // plays about as loud as a song at the same volume (light on the CPU; never used with passthrough).
    if (opts.levelVolume) args.push('--af=lavfi=[dynaudnorm=f=250:g=15:p=0.9:m=8]');
  }
  if (opts.audioDevice) args.push(`--audio-device=${opts.audioDevice}`);
  if (opts.bin && mpvHas(opts.bin, '--input-gamepad')) args.push('--input-gamepad=yes');
  // Small TV boxes and laptops (e.g. Celeron / Pentium Silver): mpv's lighter picture settings, so 4K and HDR
  // don't stutter on a modest graphics chip (the picture itself is the same, scaling is simpler).
  if (opts.lightVideo && opts.bin && mpvProfiles(opts.bin).includes('fast')) args.push('--profile=fast');
  // mpv's own pop-up menus and info screens (newer mpv opens one from a remote's Menu button), which the
  // remote can't get out of: switched off; Screenroom's overlay has its own menu.
  for (const o of ['--load-select', '--load-console', '--load-stats-overlay', '--load-commands', '--load-context-menu']) {
    if (opts.bin && mpvHas(opts.bin, o + ' ')) args.push(`${o}=no`);
  }
  if (opts.preferredLang) args.push(`--alang=${opts.preferredLang}`);
  if (opts.subLang) args.push(`--slang=${opts.subLang}`);
  // No subtitle language chosen: subtitles stay off, even for tracks the file marks as "default"
  // (forced subtitles for foreign-language bits still show). Older mpv: just off.
  else if (opts.bin && mpvHas(opts.bin, '--subs-fallback ')) args.push('--subs-fallback=no');
  else args.push('--sid=no');
  // Escape hatch for odd setups, e.g. "--vo=gpu --gpu-context=x11egl --audio-device=coreaudio/...".
  const extra = [opts.mpvArgs, process.env.SCREENROOM_MPV_ARGS].filter(Boolean).join(' ').split(/\s+/).filter(Boolean);
  args.push(...extra);

  // File-local options for the first entry only; later episodes use the defaults
  // (the overlay re-applies the viewer's audio/subtitle choice to each new episode).
  args.push('--{');
  if (opts.audioTrack) args.push(`--aid=${opts.audioTrack}`);
  if (opts.start > 5) args.push(`--start=${Math.floor(opts.start)}`);
  // e.g. "The Bluetooth speaker isn't connected, so sound is playing on the TV"
  if (opts.notice) args.push(`--osd-playing-msg=${opts.notice.replace(/\$/g, '$$$$')}`, '--osd-duration=6000');
  args.push(first.path, '--}');
  for (const e of entries.slice(1)) args.push(e.item.path);
  return args;
}

/**
 * entries: [{ item, meta }]  — first entry is played now, the rest are queued behind it.
 * hooks:   { onProgress(id,pos,dur), onSwitch(id,pos,dur,reason)  // an item finished/stopped, onExit({code, ms, log}) }
 */
function play(entries, opts, hooks) {
  const bin = findBinary('mpv', opts.mpvPath);
  if (!bin) return Promise.reject(new Error('mpv not found. Install it (brew install mpv / apt install mpv) or set its path in Settings.'));
  if (!fs.existsSync(opts.scriptPath)) return Promise.reject(new Error('Player overlay script is missing: ' + opts.scriptPath));

  const tag = `${process.pid}-${Date.now()}`;
  const tmp = os.tmpdir();
  const sock = process.platform === 'win32' ? `\\\\.\\pipe\\screenroom-${tag}` : path.join(tmp, `screenroom-${tag}.sock`);
  const metaFile = path.join(tmp, `screenroom-meta-${tag}.json`);
  const meta = {};
  for (const e of entries) meta[e.item.path] = e.meta;
  fs.writeFileSync(metaFile, JSON.stringify(meta));

  const byPath = new Map(entries.map((e) => [e.item.path, e.item]));
  activeSock = sock;
  const proc = spawn(bin, buildArgs(entries, { ...opts, bin }, sock, metaFile), { stdio: 'ignore' });

  let current = entries[0].item;
  let pos = 0;
  let dur = current.duration || 0;
  let client = null;
  let tries = 0;
  let exited = false;
  let ended = false; // true between an end-file event and the next file's path event

  const finish = (reason) => {
    if (ended) return;
    ended = true;
    hooks.onSwitch && hooks.onSwitch(current.id, pos, dur || current.duration, reason);
  };

  const connect = () => {
    if (exited) return;
    client = net.createConnection(sock);
    let buf = '';
    client.on('connect', () => {
      client.write(JSON.stringify({ command: ['observe_property', 1, 'time-pos'] }) + '\n');
      client.write(JSON.stringify({ command: ['observe_property', 2, 'duration'] }) + '\n');
      client.write(JSON.stringify({ command: ['observe_property', 3, 'path'] }) + '\n');
    });
    client.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.event === 'client-message' && Array.isArray(m.args) && m.args[0] === 'nf-sub-choice') {
          hooks.onSubChoice && hooks.onSubChoice(m.args[1] || '');
        } else if (m.event === 'end-file') {
          finish(m.reason);
        } else if (m.event === 'property-change') {
          if (m.name === 'time-pos' && typeof m.data === 'number' && !ended) {
            pos = m.data;
            hooks.onProgress && hooks.onProgress(current.id, pos, dur);
          } else if (m.name === 'duration' && typeof m.data === 'number' && !ended) {
            dur = m.data;
          } else if (m.name === 'path' && typeof m.data === 'string') {
            const next = byPath.get(m.data);
            if (next && (ended || next.id !== current.id)) {
              current = next; pos = 0; dur = next.duration || 0; ended = false;
            }
          }
        }
      }
    });
    client.on('error', () => {
      if (!exited && tries++ < 25) setTimeout(connect, 250);
    });
  };
  setTimeout(connect, 300);

  const startedAt = Date.now();
  proc.on('exit', (code) => {
    exited = true;
    if (activeSock === sock) activeSock = null;
    try { client && client.destroy(); } catch {}
    try { fs.unlinkSync(sock); } catch {}
    try { fs.unlinkSync(metaFile); } catch {}
    finish('quit'); // no-op if end-file already reported it
    hooks.onExit && hooks.onExit({ code, ms: Date.now() - startedAt, log: path.join(os.tmpdir(), 'screenroom-mpv.log'), stats: path.join(os.tmpdir(), `screenroom-stats-${process.pid}.jsonl`) });
  });
  return new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.on('spawn', () => resolve({ pid: proc.pid }));
  });
}

module.exports = { play, findBinary, control, listAudioDevices };
