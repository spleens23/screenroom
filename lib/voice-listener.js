// The voice listener (Linux box): runs on its own (a child process, so the window never waits on it). It reads the
// microphone, waits for "Hey Screenroom", then writes down what's said after it and hands the words to the app.
// Everything runs on the box: nothing is sent anywhere.
//
//   wake word ......... a tiny keyword spotter (sherpa-onnx, zipformer, 3 MB) listening all the time
//   end of the request  a voice-activity detector (Silero) notices when you stop talking
//   the words ......... Whisper (base.en) writes down just that bit of sound, once
//
// Started by lib/voice.js with SCREENROOM_VOICE_DIR = the folder with runtime/ and models/ in it.
// Messages to the app: ready, status {mic, device, error}, wake, heard {text, raw, ms}, level {v}, gone.
// Messages from the app: {type:'device', device}, {type:'levels', on}, {type:'stop'}.
// For tests: SCREENROOM_VOICE_FILES = sound files (16 kHz mono .wav) played in as if spoken, one after another.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { afterWake } = require('./voice-intent');

const DIR = process.env.SCREENROOM_VOICE_DIR;
const RATE = 16000;
const say = (m) => { try { process.send ? process.send(m) : console.log(JSON.stringify(m)); } catch {} };
const log = (...a) => { if (process.env.SCREENROOM_VOICE_DEBUG) console.error('[voice]', ...a); };

let so;
try { so = require(path.join(DIR, 'runtime', 'sherpa-onnx-node')); } catch (e) { say({ type: 'status', mic: false, error: 'The speech engine is missing from this copy of Screenroom (' + e.message.split('\n')[0] + ')' }); process.exit(3); }

const M = path.join(DIR, 'models');
const K = path.join(M, 'kws');
const W = path.join(M, 'whisper');
// "Hey Screenroom" (and "OK Screenroom"), written the way the spotter's model spells words; the number after # is how
// sure it has to be (lower = hears it more easily, but also mistakes other things for it more often)
const KEYWORDS = [
  '▁HE Y ▁S C RE EN RO OM #0.25 @HEY_SCREENROOM',
  '▁HE Y ▁S C RE EN ▁RO OM #0.25 @HEY_SCREENROOM',
  '▁O K ▁S C RE EN RO OM #0.3 @OK_SCREENROOM',
  '▁O K ▁S C RE EN ▁RO OM #0.3 @OK_SCREENROOM',
].join('\n') + '\n';
const kwFile = path.join(require('os').tmpdir(), `screenroom-keywords-${process.pid}.txt`);
fs.writeFileSync(kwFile, KEYWORDS);

const kws = new so.KeywordSpotter({
  featConfig: { sampleRate: RATE, featureDim: 80 },
  modelConfig: { transducer: { encoder: path.join(K, 'encoder.int8.onnx'), decoder: path.join(K, 'decoder.onnx'), joiner: path.join(K, 'joiner.int8.onnx') }, tokens: path.join(K, 'tokens.txt'), numThreads: 1, provider: 'cpu' },
  keywordsFile: kwFile, keywordsThreshold: 0.25, keywordsScore: 1.5,
});
const asr = new so.OfflineRecognizer({
  featConfig: { sampleRate: RATE, featureDim: 80 },
  modelConfig: { whisper: { encoder: path.join(W, 'encoder.int8.onnx'), decoder: path.join(W, 'decoder.int8.onnx'), language: 'en', task: 'transcribe', tailPaddings: -1 }, tokens: path.join(W, 'tokens.txt'), numThreads: 2, provider: 'cpu' },
});
const vad = new so.Vad({ sileroVad: { model: path.join(M, 'silero_vad.onnx'), threshold: 0.5, minSilenceDuration: 0.25, minSpeechDuration: 0.1, windowSize: 512, maxSpeechDuration: 20 }, sampleRate: RATE }, 30);
try { fs.unlinkSync(kwFile); } catch {}

// ---- the last 20 seconds of sound, so a request said in the same breath as "Hey Screenroom" isn't cut off -------
const RING = RATE * 20;
const ring = new Float32Array(RING);
let total = 0; // samples heard since starting
function pushRing(x) { for (let i = 0; i < x.length; i++) ring[(total + i) % RING] = x[i]; total += x.length; }
function slice(from, to) {
  from = Math.max(from, total - RING, 0); to = Math.min(to, total);
  const out = new Float32Array(Math.max(0, to - from));
  for (let i = from; i < to; i++) out[i - from] = ring[i % RING];
  return out;
}

// ---- listening -------------------------------------------------------------------------------------------
let kstream = kws.createStream();
let speaking = false, speechStart = 0, lastSpeechEnd = 0;
let cmd = null; // { wakeAt, from, heardAfter, silentSince, until }
const WIN = 512;
let pend = new Float32Array(0);
let levelsOn = false, levelPeak = 0, levelAt = 0;

function onWindow(x) {
  pushRing(x);
  // speech or not (the detector looks a little behind, so a start is noted a bit earlier than it's reported)
  vad.acceptWaveform(x);
  while (!vad.isEmpty()) vad.pop();
  const now = total;
  const det = vad.isDetected();
  if (det && !speaking) { speaking = true; speechStart = Math.max(0, now - Math.round(0.35 * RATE)); }
  if (!det && speaking) { speaking = false; lastSpeechEnd = now; }
  if (levelsOn) {
    for (let i = 0; i < x.length; i++) levelPeak = Math.max(levelPeak, Math.abs(x[i]));
    if (now - levelAt > RATE / 8) { say({ type: 'level', v: Math.min(1, levelPeak * 1.6), speech: det }); levelPeak = 0; levelAt = now; }
  }

  // (the spotter hears everything, all the time: started over, it misses the next wake word)
  kstream.acceptWaveform({ samples: x, sampleRate: RATE });
  let woke = null;
  while (kws.isReady(kstream)) {
    kws.decode(kstream);
    const r = kws.getResult(kstream);
    if (r.keyword) { kws.reset(kstream); if (!woke) woke = r; }
  }
  if (!cmd) {
    if (woke) return startCmd(now, 'spotter:' + woke.keyword);
    // Something playing on the box (a film's talking or a song's singing) drowns out the small spotter; Whisper
    // can still pick "Hey Screenroom" out of it, so while that's on, every 2 s of talk gets a quick look too.
    if (busy && now - busyAt >= RATE * 2 && now - lastWake > RATE * 3 && (speaking || now - lastSpeechEnd < RATE * 2)) {
      busyAt = now;
      const look = slice(now - RATE * 4, now);
      const said = transcribe(look);
      if (WAKE_ANY.test(said)) { log('wake (whisper)', JSON.stringify(said)); return startCmd(now, 'whisper', now - RATE * 4); }
    }
    return;
  }

  // after the wake word: wait until they've finished (0.7 s of quiet after talking), or give up after a while
  if (det) { if (now - cmd.wakeAt > RATE * 0.25) cmd.heardAfter = true; cmd.silentSince = 0; } else if (!cmd.silentSince) cmd.silentSince = now;
  const quiet = cmd.silentSince ? now - cmd.silentSince : 0;
  const done = (cmd.heardAfter && quiet > RATE * 0.7) || (!cmd.heardAfter && quiet > RATE * 5) || now >= cmd.until;
  if (!done) return;
  const c = cmd; cmd = null;
  const sound = slice(c.from, now - Math.max(0, quiet - Math.round(0.3 * RATE)));
  const t = Date.now();
  const raw = transcribe(sound);
  const text = afterWake(raw);
  log('heard', JSON.stringify(raw), '→', JSON.stringify(text), Date.now() - t, 'ms');
  lastWake = total;
  say({ type: 'heard', text, raw, ms: Date.now() - t, secs: +(sound.length / RATE).toFixed(1) });
}

const WAKE_ANY = /\b(?:hey|hay|hi|okay|ok)[\s,.!-]*(?:screen|scream|scene|green|cream)[\s-]*rooms?\b/i;
let busy = false, busyAt = 0, lastWake = -RATE * 10;
function startCmd(now, how, fromAt) {
  // the request starts with the stretch of talking the wake word was in (or 3 s before it, if the TV was talking
  // right up to it)
  const from = fromAt != null ? fromAt : Math.max(speaking || now - lastSpeechEnd < RATE * 0.3 ? speechStart : now - RATE * 1.6, now - RATE * 3) - Math.round(0.15 * RATE);
  // (a request can't go on for ever: with the TV talking there may never be a pause)
  cmd = { wakeAt: now, from, heardAfter: false, silentSince: speaking ? 0 : now, until: now + RATE * 7 };
  lastWake = now;
  log('wake', how, (now / RATE).toFixed(2));
  say({ type: 'wake', how });
}
function transcribe(sound) {
  try { const st = asr.createStream(); st.acceptWaveform({ samples: sound, sampleRate: RATE }); asr.decode(st); return (asr.getResult(st).text || '').trim(); } catch (e) { log('asr', e.message); return ''; }
}

function feed(buf) {
  // 16-bit little-endian samples → floats, cut into the detector's 32 ms windows
  const n = buf.length >> 1;
  const f = new Float32Array(pend.length + n);
  f.set(pend);
  for (let i = 0; i < n; i++) f[pend.length + i] = buf.readInt16LE(i * 2) / 32768;
  let o = 0;
  for (; o + WIN <= f.length; o += WIN) onWindow(f.subarray(o, o + WIN));
  pend = f.slice(o);
}

// ---- the microphone -------------------------------------------------------------------------------------------
/** Sound cards that can record, USB ones (a plugged-in microphone) first. */
function captureCards() {
  let cards = '';
  try { cards = fs.readFileSync('/proc/asound/cards', 'utf8'); } catch { return []; }
  const out = [];
  for (const m of cards.matchAll(/^\s*(\d+)\s+\[(\S+)\s*\]:\s*(\S+)\s+-\s+(.*)$/gm)) {
    const [, num, id, driver, name] = m;
    let capture = false;
    try { capture = fs.readdirSync(`/proc/asound/card${num}`).some((f) => /^pcm\d+c$/.test(f)); } catch {}
    if (!capture) continue;
    out.push({ device: `plughw:CARD=${id},DEV=0`, id, name: name.trim(), usb: /usb/i.test(driver) });
  }
  return out.sort((a, b) => b.usb - a.usb);
}

let rec = null, wanted = process.env.SCREENROOM_VOICE_DEVICE || '', stopping = false, retry = null;
function startMic() {
  clearTimeout(retry);
  const cards = captureCards();
  const pick = wanted ? cards.find((c) => c.device === wanted || c.id === wanted) : cards.find((c) => c.usb);
  if (!pick) {
    say({ type: 'status', mic: false, cards, error: wanted ? 'That microphone isn\'t plugged in.' : 'No USB microphone is plugged in.' });
    retry = setTimeout(startMic, 4000);
    return;
  }
  rec = spawn('arecord', ['-q', '-D', pick.device, '-f', 'S16_LE', '-r', String(RATE), '-c', '1', '-t', 'raw'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  let started = false;
  rec.stdout.on('data', (b) => { if (!started) { started = true; say({ type: 'status', mic: true, device: pick.device, name: pick.name, cards }); } feed(b); });
  rec.stderr.on('data', (d) => { err += d; });
  rec.on('error', (e) => { err += e.message; });
  rec.on('close', () => {
    rec = null;
    if (stopping) return;
    say({ type: 'status', mic: false, cards: captureCards(), error: (err.trim().split('\n').pop() || 'The microphone stopped.').slice(0, 200) });
    retry = setTimeout(startMic, 3000); // (unplugged and plugged back in: picks up again)
  });
}

async function playFiles(files) {
  say({ type: 'status', mic: true, device: 'test', name: 'Test sound', cards: [] });
  // (SCREENROOM_VOICE_BG: a sound playing in the room at the same time, e.g. a film; it's turned down while a request
  // is heard, as the app turns the film down)
  const bg = process.env.SCREENROOM_VOICE_BG ? so.readWave(process.env.SCREENROOM_VOICE_BG, false).samples : null;
  const bgLevel = +(process.env.SCREENROOM_VOICE_BG_LEVEL || 0.35);
  if (bg) busy = true;
  let at = 0;
  for (const f of files) {
    const w = so.readWave(f, false); // (copied: Electron doesn't allow shared outside buffers)
    // real time, in 100 ms pieces, as a microphone would deliver it
    for (let i = 0; i < w.samples.length; i += 1600) {
      const part = w.samples.subarray(i, i + 1600);
      const b = Buffer.alloc(part.length * 2);
      const g = cmd ? bgLevel * 0.25 : bgLevel;
      for (let j = 0; j < part.length; j++) {
        const v = part[j] + (bg ? bg[(at + j) % bg.length] * g : 0);
        b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), j * 2);
      }
      at += part.length;
      feed(b);
      if (!process.env.SCREENROOM_VOICE_FAST) await new Promise((r) => setTimeout(r, 100));
    }
  }
  // a little quiet at the end, so the last request finishes
  for (let i = 0; i < 30; i++) feed(Buffer.alloc(3200));
  say({ type: 'gone' });
}

process.on('message', (m) => {
  if (!m) return;
  if (m.type === 'stop') { stopping = true; if (rec) rec.kill(); process.exit(0); }
  if (m.type === 'levels') { levelsOn = !!m.on; }
  if (m.type === 'busy') { busy = !!m.on; }
  if (m.type === 'device') { wanted = m.device || ''; if (rec) { const r = rec; rec = null; r.removeAllListeners('close'); r.on('close', () => startMic()); r.kill(); } else startMic(); }
});
// (this one runs at low priority: a film's picture and sound come first)
try { require('os').setPriority(process.pid, 10); } catch {}
process.on('disconnect', () => { stopping = true; if (rec) rec.kill(); process.exit(0); });

say({ type: 'ready' });
if (process.env.SCREENROOM_VOICE_FILES) playFiles(process.env.SCREENROOM_VOICE_FILES.split(path.delimiter).filter(Boolean));
else startMic();

