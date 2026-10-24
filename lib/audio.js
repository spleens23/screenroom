// Sound outputs on the Linux TV box (plain ALSA, no PulseAudio/PipeWire, so Dolby/DTS reach a receiver untouched).
//
//   ''          "Automatic": headphone jack if something is plugged into it, else the TV (HDMI/DisplayPort with a
//               screen attached), else the computer's default output.
//   'bt:<MAC>'  a paired Bluetooth speaker/headphones, played through BlueALSA. If it's off or out of range when
//               you press play, sound goes to the Automatic choice instead and the player says so.
//   anything else is an mpv device id (alsa/hdmi:CARD=PCH,DEV=0, alsa/plughw:CARD=PCH,DEV=0, ...).
const { execFile } = require('child_process');
const fs = require('fs');
// a laptop (has a battery): its "headphone" output is also its built-in speakers
const LAPTOP = (() => { try { return fs.readdirSync('/sys/class/power_supply').some((n) => /^BAT/i.test(n)); } catch { return false; } })();

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve({ ok: !err, out: String(stdout || '') }));
  });
}

// "card 0: PCH [HDA Intel PCH], device 3: HDMI 0 [HDMI 0]"  ->  { card:'PCH', cardNo:0, dev:3, name:'HDMI 0', hdmi:true }
function parseAplay(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^card (\d+): (\S+) \[([^\]]*)\], device (\d+): ([^[]*?)\s*\[([^\]]*)\]/);
    if (!m) continue;
    const name = m[6] || m[5];
    out.push({ cardNo: +m[1], card: m[2], cardName: m[3], dev: +m[4], name, hdmi: /HDMI|DisplayPort|\bDP\b/i.test(`${m[5]} ${name}`) });
  }
  return out;
}

// amixer "contents" output -> { 'HDMI/DP,pcm=3 Jack': true, 'Front Headphone Jack': false, ... }
function parseJacks(text) {
  const jacks = {};
  let name = null;
  for (const line of text.split('\n')) {
    const n = line.match(/^numid=\d+,iface=CARD,name='(.*)'\s*$/);
    if (n) { name = /Jack$/.test(n[1]) ? n[1] : null; continue; }
    if (!/^numid=/.test(line) && name) {
      const v = line.match(/^\s*:\s*values=(on|off)/);
      if (v) { jacks[name] = v[1] === 'on'; name = null; }
    } else name = null;
  }
  return jacks;
}

/** What the sound hardware looks like right now: [{ id, label, kind:'hdmi'|'analog', connected }]. */
function describe(devices, jacksByCard) {
  const outs = [];
  const cards = [...new Set(devices.map((d) => d.cardNo))];
  for (const c of cards) {
    const devs = devices.filter((d) => d.cardNo === c);
    const jacks = jacksByCard[c] || {};
    const hdmi = devs.filter((d) => d.hdmi).sort((a, b) => a.dev - b.dev);
    hdmi.forEach((d, k) => {
      const j = jacks[`HDMI/DP,pcm=${d.dev} Jack`];
      outs.push({
        id: `alsa/hdmi:CARD=${d.card},DEV=${k}`, alt: `alsa/plughw:CARD=${d.card},DEV=${d.dev}`, kind: 'hdmi',
        label: `TV (HDMI / DisplayPort${hdmi.length > 1 ? ` ${k + 1}` : ''})`, connected: j === true,
      });
    });
    const analog = devs.find((d) => !d.hdmi && !/digital|spdif|iec958/i.test(d.name));
    if (analog) {
      const plugged = Object.entries(jacks).some(([n, on]) => on && /Headphone|Line Out/i.test(n) && !/Phantom/i.test(n));
      outs.push({ id: `alsa/plughw:CARD=${analog.card},DEV=${analog.dev}`, kind: 'analog', label: LAPTOP ? 'Laptop speakers / headphone jack' : 'Headphone jack', connected: plugged });
    }
  }
  return outs;
}

async function hardware() {
  const a = await run('aplay', ['-l']);
  const devices = parseAplay(a.out);
  const jacksByCard = {};
  for (const c of [...new Set(devices.map((d) => d.cardNo))]) {
    jacksByCard[c] = parseJacks((await run('amixer', ['-c', String(c), 'contents'])).out);
  }
  return describe(devices, jacksByCard);
}

// ---- Bluetooth speakers ---------------------------------------------------------------------------
const MAC = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/i;

function parseInfo(text) {
  return {
    name: ((text.match(/^\s*(?:Alias|Name):\s*(.+)$/m) || [])[1] || '').trim(),
    connected: /^\s*Connected:\s*yes/m.test(text),
    // A2DP "Audio Sink" = something we can play sound to (speaker, headphones, soundbar).
    audio: /UUID:.*\(0000110b-/i.test(text) || /^\s*Icon:\s*audio-(card|headphones|headset|speakers)/m.test(text),
  };
}

async function btInfo(mac) {
  if (!MAC.test(mac || '')) return null;
  const r = await run('bluetoothctl', ['info', mac]);
  return r.ok ? { mac: mac.toUpperCase(), ...parseInfo(r.out) } : null;
}

const btDevice = (mac) => `alsa/bluealsa:DEV=${mac.toUpperCase()},PROFILE=a2dp`;

const A2DP_SINK = '0000110b-0000-1000-8000-00805f9b34fb';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Is BlueALSA offering this speaker as a sound output right now? true / false, or null if we can't tell. */
async function btPcmReady(mac) {
  const dev = 'dev_' + mac.toUpperCase().replace(/:/g, '_');
  for (const tool of ['bluealsactl', 'bluealsa-cli']) {
    const r = await run(tool, ['list-pcms'], 5000);
    if (r.ok) return r.out.split('\n').some((l) => l.includes(dev) && /a2dp/i.test(l));
  }
  return null;
}

// Ask BlueZ for the speaker's music profile (A2DP) specifically: a plain "connect" to a speaker that was
// already remembered sometimes only half-connects (connected, but no sound channel).
async function btConnectProfile(mac) {
  const dev = 'dev_' + mac.toUpperCase().replace(/:/g, '_');
  for (const hci of ['hci0', 'hci1', 'hci2']) {
    const r = await run('dbus-send', ['--system', '--print-reply', '--dest=org.bluez', `/org/bluez/${hci}/${dev}`, 'org.bluez.Device1.ConnectProfile', `string:${A2DP_SINK}`], 20000);
    if (r.ok || !/UnknownObject|doesn't exist/i.test(r.out)) return r.ok;
  }
  return false;
}

/**
 * Get a remembered speaker ready to play: connected AND offering sound. Tries a normal connect, then the
 * music profile directly, then a fresh disconnect + connect. Returns its info (connected / audioReady).
 */
async function btEnsureConnected(mac, seconds = 8) {
  const M = mac.toUpperCase();
  let info = await btInfo(M);
  if (!info) return null;
  if (!info.connected) { await run('bluetoothctl', ['connect', M], seconds * 1000); await sleep(1500); }
  let ready = await btPcmReady(M);
  if (ready === false) { await btConnectProfile(M); await sleep(2000); ready = await btPcmReady(M); }
  if (ready === false) {
    await run('bluetoothctl', ['disconnect', M], 8000); await sleep(2000);
    await run('bluetoothctl', ['connect', M], seconds * 1000); await sleep(2500);
    ready = await btPcmReady(M);
    if (ready === false) { await btConnectProfile(M); await sleep(2000); ready = await btPcmReady(M); }
  }
  info = await btInfo(M);
  return info ? { ...info, connected: info.connected && ready !== false, audioReady: ready } : null;
}

// ---- what Settings shows, and what the player uses ------------------------------------------------
async function listOutputs(pairedMacs = [], current = '') {
  const all = await hardware();
  // Intel graphics list up to 5 HDMI/DisplayPort outputs; only show the ones with a screen attached
  // (or just the first, if none is), plus whatever is selected now.
  const hdmi = all.filter((o) => o.kind === 'hdmi');
  const shownHdmi = hdmi.filter((o) => o.connected || o.id === current);
  if (!shownHdmi.length && hdmi.length) shownHdmi.push(hdmi[0]);
  const hw = all.filter((o) => o.kind !== 'hdmi' || shownHdmi.includes(o));
  const out = [{ id: '', label: LAPTOP ? 'Automatic (the TV when one is plugged in, otherwise the laptop)' : 'Automatic (headphone jack when plugged in, otherwise the TV)', nice: true }];
  for (const o of hw) out.push({ id: o.id, label: `${o.label}${o.connected ? (o.kind === 'hdmi' ? ' · TV connected' : ' · plugged in') : ''}`, nice: true });
  // the speaker chosen for sound stays in the list even if pairing didn't finish (no blank choice)
  const cur = (current || '').toUpperCase().startsWith('BT:') ? current.slice(3).toUpperCase() : '';
  const macs = [...new Set([...pairedMacs.map((m) => m.toUpperCase()), ...(cur ? [cur] : [])])];
  for (const mac of macs) {
    const i = await btInfo(mac);
    if (i && mac === cur && !i.audio) { out.push({ id: `bt:${i.mac}`, label: `Bluetooth: ${i.name || i.mac}${i.connected ? ' · connected' : ''}`, nice: true }); continue; }
    if (i && i.audio) out.push({ id: `bt:${i.mac}`, label: `Bluetooth: ${i.name || i.mac}${i.connected ? ' · connected' : ''}`, nice: true });
  }
  return out;
}

function pickAutomatic(hw, mpvIds) {
  const usable = (o) => (mpvIds && mpvIds.size && !mpvIds.has(o.id) && o.alt ? o.alt : o.id);
  const jack = hw.find((o) => o.kind === 'analog' && o.connected);
  if (jack) return { device: usable(jack), kind: 'analog' };
  const tv = hw.find((o) => o.kind === 'hdmi' && o.connected);
  if (tv) return { device: usable(tv), kind: 'hdmi' };
  // Nothing plugged in: the computer's own sound (a laptop's speakers). Named outright: on some laptops the
  // system's "default" isn't the speakers.
  const own = hw.find((o) => o.kind === 'analog');
  if (own) return { device: usable(own), kind: 'analog' };
  return { device: '', kind: 'default' };
}

/**
 * Turn the saved choice into what mpv gets: { device, passthrough, stereo, notice }.
 * Passthrough only makes sense on HDMI/DisplayPort; Bluetooth is always plain stereo.
 */
async function resolve(choice, { passthrough, mpvIds } = {}) {
  if (choice && choice.startsWith('bt:')) {
    const mac = choice.slice(3);
    const info = await btEnsureConnected(mac);
    if (info && info.connected) return { device: btDevice(info.mac), passthrough: false, stereo: true, kind: 'bluetooth' };
    const auto = pickAutomatic(await hardware(), mpvIds);
    return {
      device: auto.device, passthrough: passthrough && auto.kind === 'hdmi', stereo: false, kind: auto.kind,
      notice: `${(info && info.name) || 'The Bluetooth speaker'} isn't connected, so sound is playing on the ${auto.kind === 'analog' ? 'headphone jack' : 'TV'}`,
    };
  }
  if (!choice) {
    const auto = pickAutomatic(await hardware(), mpvIds);
    return { device: auto.device, passthrough: passthrough && auto.kind !== 'analog', stereo: false, kind: auto.kind };
  }
  const hw = await hardware();
  // The chosen output isn't there any more (sound driver changed, card renamed…): use Automatic instead of silence.
  if (choice.startsWith('alsa/') && hw.length && !hw.some((o) => o.id === choice || o.alt === choice)) {
    const auto = pickAutomatic(hw, mpvIds);
    return { device: auto.device, passthrough: passthrough && auto.kind === 'hdmi', stereo: false, kind: auto.kind, notice: 'The chosen sound output wasn\'t found, so Automatic is used' };
  }
  const analog = /plughw:/.test(choice) && !/HDMI/i.test(choice) && hw.some((o) => o.id === choice && o.kind === 'analog');
  return { device: choice, passthrough: passthrough && !analog, stereo: false, kind: analog ? 'analog' : 'other' };
}

/**
 * How many plain (PCM) sound channels the TV / receiver on HDMI says it takes (from its "ELD": the formats it
 * announced). Many TVs only announce stereo PCM even with a surround soundbar on eARC. null if unknown.
 */
function hdmiPcmChannels() {
  let best = null;
  try {
    for (const card of fs.readdirSync('/proc/asound').filter((n) => /^card\d+$/.test(n))) {
      for (const f of fs.readdirSync(`/proc/asound/${card}`).filter((n) => /^eld#/.test(n))) {
        const t = fs.readFileSync(`/proc/asound/${card}/${f}`, 'utf8');
        if (!/monitor_present\s+1/.test(t) || !/eld_valid\s+1/.test(t)) continue;
        const re = /sad(\d+)_coding_type\s+\[0x1\][^\n]*\n\s*sad\1_channels\s+(\d+)/g;
        let m; while ((m = re.exec(t))) best = Math.max(best || 0, Number(m[2]));
        if (best == null) best = 2;
      }
    }
  } catch {}
  return best;
}

module.exports = { hdmiPcmChannels, listOutputs, resolve, btInfo, btEnsureConnected, btPcmReady, parseAplay, parseJacks, parseInfo, describe, pickAutomatic };
