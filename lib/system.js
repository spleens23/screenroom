// Linux appliance helpers: Wi-Fi (NetworkManager's nmcli) and Bluetooth pairing (bluetoothctl).
// Everything here is optional; if the tools aren't installed the Settings sections simply say so.
const { execFile } = require('child_process');

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

async function btPair(mac) {
  if (!MAC.test(mac || '')) return { ok: false, error: 'Bad device' };
  await run('bluetoothctl', ['power', 'on']);
  const p = await run('bluetoothctl', ['--agent', 'NoInputNoOutput', 'pair', mac], 40000);
  if (!p.ok && !/AlreadyExists|already paired/i.test(p.out + p.err)) {
    return { ok: false, error: 'Pairing failed. Put the remote/controller in pairing mode and try again.' };
  }
  await run('bluetoothctl', ['trust', mac]);
  await run('bluetoothctl', ['connect', mac], 20000);
  return { ok: true, message: 'Paired' };
}

async function btRemove(mac) {
  if (!MAC.test(mac || '')) return { ok: false, error: 'Bad device' };
  const r = await run('bluetoothctl', ['remove', mac]);
  return r.ok ? { ok: true } : { ok: false, error: r.err.trim() || 'Could not remove' };
}

module.exports = { wifiStatus, wifiScan, wifiConnect, btStatus, btScan, btPair, btRemove, splitTerse };
