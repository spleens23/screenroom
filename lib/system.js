// Linux appliance helpers: Wi-Fi (NetworkManager's nmcli) and Bluetooth pairing (bluetoothctl).
// Everything here is optional; if the tools aren't installed the Settings sections simply say so.
const { execFile, spawn } = require('child_process');
const { parseInfo, btEnsureConnected } = require('./audio');

function run(cmd, args, timeout = 20000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || ''), missing: !!(err && err.code === 'ENOENT') });
    });
  });
}

// nmcli -t separates fields with ":" and escapes ":" inside values as "\:".
function splitTerse(line) {
  const out = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && i + 1 < line.length) { cur += line[++i]; continue; }
    if (c === ':') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

// ---- Wi-Fi ------------------------------------------------------------------------------------------
async function wifiStatus() {
  const r = await run('nmcli', ['-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'device']);
  if (r.missing) return { available: false, message: 'Wi-Fi settings need NetworkManager (installed by the Screenroom installer).' };
  const devices = r.out.trim().split('\n').filter(Boolean).map((l) => {
    const [device, type, state, connection] = splitTerse(l);
    return { device, type, state, connection };
  });
  const wifi = devices.find((d) => d.type === 'wifi');
  const wired = devices.find((d) => d.type === 'ethernet' && /^connected/.test(d.state));
  return {
    available: true,
    hasWifi: !!wifi,
    wifiConnected: !!(wifi && /^connected/.test(wifi.state)),
    wifiNetwork: wifi && /^connected/.test(wifi.state) ? wifi.connection : '',
    wired: !!wired,
  };
}

async function wifiScan() {
  const r = await run('nmcli', ['-t', '-f', 'IN-USE,SSID,SIGNAL,SECURITY', 'device', 'wifi', 'list', '--rescan', 'yes'], 30000);
  if (!r.ok) return { ok: false, error: r.err.trim() || 'Could not scan for Wi-Fi networks' };
  const best = new Map();
  for (const line of r.out.split('\n')) {
    if (!line.trim()) continue;
    const [inUse, ssid, signal, security] = splitTerse(line);
    if (!ssid) continue;
    const n = { ssid, signal: Number(signal) || 0, secure: !!security && security !== '--', current: inUse === '*' };
    const prev = best.get(ssid);
    if (!prev || n.signal > prev.signal) best.set(ssid, { ...n, current: n.current || (prev && prev.current) });
  }
  return { ok: true, networks: [...best.values()].sort((a, b) => (b.current - a.current) || (b.signal - a.signal)) };
}

async function wifiConnect(ssid, password) {
  if (typeof ssid !== 'string' || !ssid || ssid.length > 64) return { ok: false, error: 'Pick a network' };
  const args = ['device', 'wifi', 'connect', ssid];
  if (password) args.push('password', String(password));
  const r = await run('nmcli', args, 60000);
  if (r.ok) return { ok: true, message: `Connected to ${ssid}` };
  const msg = (r.err || r.out).trim();
  if (/secrets were required|password|802-1x|psk/i.test(msg)) return { ok: false, error: 'Wrong password, try again.' };
  return { ok: false, error: msg || 'Could not connect' };
}

// ---- Bluetooth ---------------------------------------------------------------------------------------
const MAC = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/i;

function parseDevices(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = line.match(/Device\s+([0-9A-F:]{17})\s+(.*)$/i);
    if (m) out.push({ mac: m[1].toUpperCase(), name: m[2].trim() });
  }
  return out;
}

async function btPaired() {
  let r = await run('bluetoothctl', ['devices', 'Paired']);
  if (r.missing) return null;
  if (!r.ok || !r.out.trim()) r = await run('bluetoothctl', ['paired-devices']);
  return parseDevices(r.out);
}

async function btStatus() {
  const paired = await btPaired();
  if (paired === null) return { available: false, message: 'Bluetooth needs the bluez package (installed by the Screenroom installer).' };
  const show = await run('bluetoothctl', ['show']);
  // Which of them are speakers/headphones (can play sound), and which are connected right now.
  for (const d of paired) {
    const i = parseInfo((await run('bluetoothctl', ['info', d.mac])).out);
    d.audio = i.audio; d.connected = i.connected;
  }
  return { available: true, hasAdapter: /Controller/i.test(show.out), paired };
}

async function btScan(seconds = 12) {
  await run('bluetoothctl', ['power', 'on']);
  await run('bluetoothctl', ['--timeout', String(seconds), 'scan', 'on'], (seconds + 5) * 1000);
  const all = parseDevices((await run('bluetoothctl', ['devices'])).out);
  const paired = new Set(((await btPaired()) || []).map((d) => d.mac));
  // Unnamed entries are usually phones/beacons nearby; keep the list readable.
  return { ok: true, devices: all.filter((d) => !paired.has(d.mac) && d.name && !/^([0-9A-F]{2}-){5}[0-9A-F]{2}$/i.test(d.name)) };
}

/**
 * Talk to bluetoothctl as one interactive session (like typing into it), which is what pairing needs: an
 * "agent" that says yes for us, and the device still being seen by a running scan when we ask to pair.
 * steps: [{ send, until?: RegExp, fail?: RegExp, wait?: ms }]. Resolves with everything bluetoothctl printed.
 */
function btSession(steps, totalMs = 60000) {
  return new Promise((resolve) => {
    let out = '', done = false, child;
    try { child = spawn('bluetoothctl', [], { stdio: ['pipe', 'pipe', 'pipe'] }); } catch { resolve({ ok: false, out: '' }); return; }
    const finish = (ok) => { if (done) return; done = true; clearTimeout(timer); try { child.stdin.write('quit\n'); } catch {} setTimeout(() => { try { child.kill(); } catch {} }, 500); resolve({ ok, out }); };
    const timer = setTimeout(() => finish(false), totalMs);
    child.on('error', () => finish(false));
    child.on('exit', () => finish(false));
    const strip = (t) => t.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '\n');
    let waiter = null;
    child.stdout.on('data', (d) => { out += strip(String(d)); if (waiter) waiter(); });
    child.stderr.on('data', (d) => { out += strip(String(d)); if (waiter) waiter(); });
    (async () => {
      for (const st of steps) {
        if (done) return;
        const from = out.length;
        child.stdin.write(st.send + '\n');
        if (st.until || st.fail) {
          const res = await new Promise((r) => {
            const t = setTimeout(() => { waiter = null; r('timeout'); }, st.wait || 15000);
            waiter = () => {
              const seen = out.slice(from);
              if (st.fail && st.fail.test(seen)) { clearTimeout(t); waiter = null; r('fail'); }
              else if (st.until && st.until.test(seen)) { clearTimeout(t); waiter = null; r('ok'); }
            };
            waiter();
          });
          if (res === 'fail' && st.required) return finish(false);
          if (res === 'timeout' && st.required) return finish(false);
        } else await new Promise((r) => setTimeout(r, st.wait || 300));
      }
      finish(true);
    })();
  });
}

async function btPair(mac) {
  if (!MAC.test(mac || '')) return { ok: false, error: 'Bad device' };
  const M = mac.toUpperCase();
  const re = (s) => new RegExp(s, 'i');
  const r = await btSession([
    { send: 'power on', wait: 500 },
    { send: 'agent NoInputNoOutput', wait: 300 },
    { send: 'default-agent', wait: 300 },
    // keep looking until the speaker shows up again (it has to be "seen" right now to pair)
    { send: 'scan on', until: re(`(NEW|CHG)\\] Device ${M}|Device ${M}`), wait: 20000 },
    { send: `pair ${M}`, until: re('Pairing successful|AlreadyExists|already paired|Paired: yes'), fail: re('Failed to pair|not available|AuthenticationFailed|AuthenticationCanceled|ConnectionAttemptFailed'), wait: 30000, required: true },
    { send: `trust ${M}`, until: re('trust succeeded|Trusted: yes'), wait: 5000 },
    { send: 'scan off', wait: 300 },
    { send: `connect ${M}`, until: re('Connection successful|Connected: yes'), fail: re('Failed to connect'), wait: 20000 },
  ], 90000);
  if (r.ok) await btEnsureConnected(M);
  const info = parseInfo((await run('bluetoothctl', ['info', M])).out);
  const paired = /Paired:\s*yes/i.test((await run('bluetoothctl', ['info', M])).out);
  if (!r.ok && !paired) {
    const why = /not available/i.test(r.out) ? 'it wasn\'t found — make sure it\'s in pairing mode (light flashing) and close by'
      : /Authentication/i.test(r.out) ? 'it refused — switch it off and on, put it in pairing mode and try again'
      : 'put it in pairing mode (light flashing) and try again';
    return { ok: false, error: `Pairing failed: ${why}.` };
  }
  return { ok: true, message: 'Paired', audio: info.audio, connected: info.connected };
}

async function btConnect(mac) {
  if (!MAC.test(mac || '')) return { ok: false, error: 'Bad device' };
  const M = mac.toUpperCase();
  await btSession([
    { send: 'power on', wait: 500 },
    { send: `trust ${M}`, wait: 300 },
    { send: `connect ${M}`, until: /Connection successful|Connected: yes/i, fail: /Failed to connect/i, wait: 20000 },
  ], 30000);
  // connected isn't enough for a speaker: make sure its sound channel is up too
  const info = await btEnsureConnected(M);
  if (info && info.connected) return { ok: true };
  return { ok: false, error: info && info.audioReady === false
    ? 'It connected but isn\'t taking sound. Switch the speaker off and on, then press Connect again (or Forget it and pair again).'
    : 'Could not connect. Make sure it is switched on and nearby.' };
}

async function btRemove(mac) {
  if (!MAC.test(mac || '')) return { ok: false, error: 'Bad device' };
  const r = await run('bluetoothctl', ['remove', mac]);
  return r.ok ? { ok: true } : { ok: false, error: r.err.trim() || 'Could not remove' };
}

module.exports = { wifiStatus, wifiScan, wifiConnect, btStatus, btScan, btPair, btConnect, btRemove, splitTerse };
