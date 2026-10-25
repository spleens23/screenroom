#!/usr/bin/env node
/*
 * screenroom-subs: English subtitles for every film, made from the copies you already have. No internet needed.
 *
 * Your DVD copies have English subtitles as pictures (VobSub); the HD and 4K copies have none. For every film
 * (and episode) stored on this computer without English subtitles, this finds another copy of it that has
 * them — on this computer or on a plugged-in drive — reads the subtitle pictures into text (Tesseract, on this
 * computer), lines the two copies up by their sound (the DVD may start earlier or run at PAL speed), and saves
 * "<film>.en.srt" next to the HD / 4K copy. Screenroom and the player pick it up from there.
 * A copy with text subtitles (not pictures) is used as it is, without reading pictures.
 *
 * Usage (on the box: screenroom-subs; anywhere: node tools/screenroom-subs.js):
 *   screenroom-subs                      list what can get subtitles, and from which copy (nothing is written)
 *   screenroom-subs --apply              make them all
 *   screenroom-subs --apply --only <film path> [--only ...]   just these
 *   screenroom-subs --json               the list / progress as JSON (what Screenroom's Settings uses)
 *   screenroom-subs --data <dir>         Screenroom's data folder (default: the usual one for this computer)
 * Needs: ffmpeg, python3 with python3-av, python3-numpy, python3-pil, and tesseract-ocr + tesseract-ocr-eng.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const core = require('../lib/media-core');
const { under } = require('../lib/cleanup');

const HELPER = path.join(__dirname, 'subs-helper.py');
// (inside the app's package the helper is unpacked next to it)
const helperPath = () => { const u = HELPER.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`); return u !== HELPER && fs.existsSync(u) ? u : HELPER; };

function defaultDataDir() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'screenroom');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'screenroom');
}
function driveMounts() {
  const out = [];
  if (process.platform === 'linux') {
    let text = '';
    try { text = fs.readFileSync('/proc/self/mounts', 'utf8'); } catch {}
    for (const line of text.split('\n')) {
      const mnt = (line.split(' ')[1] || '').replace(/\\040/g, ' ');
      if (/^\/(media|run\/media|mnt)\//.test(mnt)) out.push(mnt);
    }
  } else if (process.platform === 'darwin') {
    try { for (const n of fs.readdirSync('/Volumes')) { const m = path.join('/Volumes', n); if (fs.realpathSync(m) !== '/') out.push(m); } } catch {}
  }
  return out;
}

// ---- what has English subtitles ---------------------------------------------------------------------------------
const isEng = (l) => /^(en|eng|english)$/i.test(l || '');
const isUnknown = (l) => !l || /^(und|unk|unknown)$/i.test(l);
const stem = (p) => p.slice(0, p.length - path.extname(p).length);
function sidecars(p) {
  const dir = path.dirname(p), base = path.basename(stem(p));
  let names = [];
  try { names = fs.readdirSync(dir); } catch {}
  return names.filter((n) => n.startsWith(base + '.') && n !== path.basename(p)).map((n) => path.join(dir, n));
}
/** Already has English subtitles you can read (inside the file, or an .srt beside it)? */
function hasEnglish(it) {
  if ((it.subs || []).some((s) => isEng(s.lang))) return true;
  return sidecars(it.path).some((f) => /\.(srt|ass|ssa|vtt)$/i.test(f) && (/\.(en|eng|english)\.[a-z]+$/i.test(f) || path.basename(f) === path.basename(stem(it.path)) + path.extname(f)));
}
/** Where a copy's English subtitles can be taken from: { kind: 'text'|'ocr', file, stream } or null. */
function sourceOf(it) {
  const subs = it.subs || [];
  const textEng = subs.find((s) => isEng(s.lang) && /mov_text|subrip|srt|ass|ssa|webvtt|text/i.test(s.codec || ''));
  if (textEng && textEng.external) return { kind: 'text', file: textEng.file, stream: null };
  if (textEng) return { kind: 'text', file: it.path, stream: (it.subs || []).filter((x) => !x.external).indexOf(textEng) };
  const pic = subs.filter((s) => /dvd_subtitle|dvdsub/i.test(s.codec || ''));
  const pe = pic.find((s) => isEng(s.lang)) || (pic.length === 1 && isUnknown(pic[0].lang) ? pic[0] : null);
  if (pe) return { kind: 'ocr', file: it.path, stream: null };
  // a VobSub pair beside the film: Film.idx + Film.sub
  const idx = sidecars(it.path).find((f) => /\.idx$/i.test(f) && fs.existsSync(stem(f) + '.sub'));
  if (idx) {
    let lang = '';
    try { lang = (fs.readFileSync(idx, 'utf8').match(/^id:\s*([a-z]+)/mi) || [])[1] || ''; } catch {}
    if (isEng(lang) || isUnknown(lang)) return { kind: 'ocr', file: idx, stream: null };
  }
  return null;
}
function describe(it) {
  const q = core.qualityOf(it), v = it.video || {};
  return q === '4K' ? '4K' : q === 'HD' ? (v.res || 'HD') : `DVD ${v.height ? v.height + 'p' : ''}`.trim();
}

// ---- the plan ----------------------------------------------------------------------------------------------------
function loadItems(dataDir) {
  const file = path.join(dataDir, 'library.json');
  let db;
  try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error(`Couldn't read Screenroom's library list (${file}). Open Screenroom once so it can look at your folders.`); }
  return require('../lib/library').withSidecarSubs(Object.values(db).map((it) => core.applyTv(it)).filter((it) => it && it.path && fs.existsSync(it.path)));
}
function plan({ dataDir = defaultDataDir(), drives = driveMounts() } = {}) {
  const onDrive = (p) => drives.some((m) => p === m || under(p, m));
  const items = loadItems(dataDir);
  const groups = [];
  for (const g of core.groupMovies(items.filter((it) => !it.tv))) groups.push({ title: g.title + (g.year ? ` (${g.year})` : ''), items: g.versions });
  const eps = new Map();
  for (const it of items.filter((x) => x.tv)) {
    const k = [core.movieTitleKey(it.tv.series) || it.tv.series.toLowerCase(), it.tv.season, it.tv.episode, it.tv.episodeEnd || '', it.tv.part || ''].join('|');
    if (!eps.has(k)) eps.set(k, { title: `${it.tv.series} S${it.tv.season} E${it.tv.label || it.tv.episode}`, items: [] });
    eps.get(k).items.push(it);
  }
  groups.push(...eps.values());
  const jobs = [], missing = [];
  for (const g of groups) {
    const targets = g.items.filter((it) => !onDrive(it.path) && !hasEnglish(it));
    if (!targets.length) continue;
    // the best source: text subtitles first (nothing to read), then a copy on this computer, then on a drive
    const sources = g.items.map((it) => ({ it, src: sourceOf(it) })).filter((x) => x.src && !targets.includes(x.it))
      .sort((a, b) => (a.src.kind === b.src.kind ? 0 : a.src.kind === 'text' ? -1 : 1) || (onDrive(a.it.path) - onDrive(b.it.path)));
    for (const t of targets) {
      const s = sources[0];
      if (!s) { missing.push({ title: g.title, path: t.path, quality: describe(t) }); continue; }
      jobs.push({ title: g.title, target: { path: t.path, quality: describe(t), duration: t.duration || 0 },
        source: { path: s.src.file, quality: describe(s.it), kind: s.src.kind, stream: s.src.stream, onDrive: onDrive(s.it.path), film: s.it.path } });
    }
  }
  jobs.sort((a, b) => a.title.localeCompare(b.title));
  missing.sort((a, b) => a.title.localeCompare(b.title));
  return { jobs, missing, tools: toolsMissing() };
}

// What's not installed (the box's setup installs them; on a Mac: brew install tesseract, pip3 install av numpy pillow)
function toolsMissing() {
  const which = (cmd) => process.env.PATH.split(path.delimiter).some((d) => { try { fs.accessSync(path.join(d, cmd), fs.constants.X_OK); return true; } catch { return false; } });
  const missing = ['ffmpeg', 'ffprobe', 'python3', 'tesseract'].filter((c) => !which(c));
  if (!missing.includes('python3')) {
    try { require('child_process').execFileSync('python3', ['-c', 'import av, numpy, PIL'], { stdio: 'ignore', timeout: 20000 }); }
    catch { missing.push('python3-av / python3-numpy / python3-pil'); }
  }
  if (!missing.includes('tesseract')) {
    try { if (!/\beng\b/.test(require('child_process').execFileSync('tesseract', ['--list-langs'], { encoding: 'utf8', timeout: 20000 }))) missing.push('tesseract-ocr-eng'); } catch {}
  }
  return missing;
}

// ---- making one ---------------------------------------------------------------------------------------------------
const run = (cmd, args, opts = {}) => new Promise((resolve) => {
  execFile(cmd, args, { maxBuffer: 256 * 1024 * 1024, timeout: 3 * 3600 * 1000, ...opts }, (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
});
const lastJson = (s) => { const l = s.trim().split('\n').filter(Boolean).pop(); try { return JSON.parse(l); } catch { return null; } };

function parseSrt(text) {
  const out = [];
  const t = (h, m, s, ms) => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
  for (const block of text.replace(/\r/g, '').split(/\n\s*\n/)) {
    const m = block.match(/(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)[^\n]*\n([\s\S]*)/);
    if (m) out.push({ start: t(m[1], m[2], m[3], m[4]), end: t(m[5], m[6], m[7], m[8]), text: m[9].trim() });
  }
  return out;
}
function srtTime(s) {
  const ms = Math.max(0, Math.round(s * 1000));
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
}

async function makeOne(job) {
  const py = helperPath();
  // 1. line the two copies up by their sound
  const sync = lastJson((await run('python3', [py, 'sync', job.source.film, job.target.path])).stdout);
  if (!sync || sync.error) return { ok: false, error: `couldn't compare the sound (${(sync && sync.error) || 'no answer'})` };
  if (!sync.ok) return { ok: false, error: 'the two copies don\'t line up (a different cut?)' };
  // 2. the subtitles, as text, in the source's timing
  let cues;
  if (job.source.kind === 'text') {
    const r = job.source.stream == null
      ? await run('ffmpeg', ['-v', 'error', '-i', job.source.path, '-f', 'srt', '-'])
      : await run('ffmpeg', ['-v', 'error', '-i', job.source.path, '-map', `0:s:${job.source.stream}`, '-f', 'srt', '-']);
    cues = parseSrt(r.stdout);
    if (!cues.length) return { ok: false, error: 'no subtitles could be read' };
  } else {
    const r = await run('python3', [py, 'ocr', job.source.path]);
    cues = r.stdout.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((c) => c && c.text);
    if (!cues.length) { const e = lastJson(r.stdout + '\n' + r.stderr); return { ok: false, error: (e && e.error) || 'no subtitles could be read' }; }
  }
  // 3. moved to the HD / 4K copy's timing, saved beside it
  const dur = job.target.duration || Infinity;
  const moved = cues.map((c) => ({ start: sync.a * c.start + sync.b, end: sync.a * c.end + sync.b, text: c.text }))
    .filter((c) => c.end > 0 && c.start < dur).map((c) => ({ ...c, start: Math.max(0, c.start) }));
  const srt = moved.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join('\n');
  const out = stem(job.target.path) + '.en.srt';
  await fs.promises.writeFile(out + '.part', srt, 'utf8');
  await fs.promises.rename(out + '.part', out);
  return { ok: true, file: out, count: moved.length, shift: Math.round(sync.b * 1000) / 1000, speed: Math.round(sync.a * 10000) / 10000 };
}

// ---- command line ----------------------------------------------------------------------------------------------
async function main(argv) {
  const args = { apply: false, json: false, only: [], data: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--json') args.json = true;
    else if (a === '--only') args.only.push(path.resolve(argv[++i]));
    else if (a === '--data') args.data = argv[++i];
    else if (a === '-h' || a === '--help') { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\n?/, '').replace(/^ \* ?/gm, '')); return 0; }
    else { console.error(`Unknown option: ${a} (try --help)`); return 2; }
  }
  let p;
  try { p = plan({ dataDir: args.data || defaultDataDir() }); } catch (e) { if (args.json) console.log(JSON.stringify({ error: e.message })); else console.error(e.message); return 1; }
  if (!args.apply) {
    if (args.json) { console.log(JSON.stringify(p)); return 0; }
    if (p.tools.length) console.log(`Missing: ${p.tools.join(', ')} (needed to make subtitles).`);
    if (!p.jobs.length) console.log('Nothing to do: every film on this computer has English subtitles, or no other copy has any.');
    for (const j of p.jobs) console.log(`${j.title}\n  ${j.target.quality}  ${j.target.path}\n  from the ${j.source.quality} copy${j.source.onDrive ? ' (on a drive)' : ''}: ${j.source.kind === 'text' ? 'text subtitles' : 'DVD subtitles (read from the pictures)'}`);
    if (p.missing.length) console.log(`\nNo copy with English subtitles for: ${p.missing.map((m) => m.title).join(', ')}`);
    if (p.jobs.length) console.log(`\n${p.jobs.length} to make. Nothing was written; run with --apply to make them.`);
    return 0;
  }
  if (p.tools.length) { const msg = `Missing: ${p.tools.join(', ')}`; if (args.json) console.log(JSON.stringify({ error: msg })); else console.error(msg); return 1; }
  const jobs = args.only.length ? p.jobs.filter((j) => args.only.includes(path.resolve(j.target.path))) : p.jobs;
  const results = [];
  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i];
    if (args.json) console.log(JSON.stringify({ progress: i, total: jobs.length, title: j.title }));
    else process.stdout.write(`[${i + 1}/${jobs.length}] ${j.title} … `);
    let r;
    try { r = await makeOne(j); } catch (e) { r = { ok: false, error: e.message }; }
    results.push({ title: j.title, path: j.target.path, ...r });
    if (!args.json) console.log(r.ok ? `${r.count} subtitles` : `skipped: ${r.error}`);
  }
  const made = results.filter((r) => r.ok).length;
  if (args.json) console.log(JSON.stringify({ done: true, made, failed: results.filter((r) => !r.ok), results }));
  else console.log(`Made ${made} of ${jobs.length}.`);
  return 0;
}

module.exports = { plan, makeOne, hasEnglish, sourceOf };
if (require.main === module) main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(e.message); process.exit(1); });
