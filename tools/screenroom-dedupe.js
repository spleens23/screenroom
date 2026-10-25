#!/usr/bin/env node
/*
 * screenroom-dedupe: keep only the best copy of each film and episode on this computer.
 *
 * When the same film (or the same episode) is stored more than once — a DVD copy, a Blu-ray copy, a 4K copy —
 * this keeps the highest-quality one and removes the others. It looks at:
 *   1. picture size (4K over HD over DVD), 2. HDR (Dolby Vision, HDR10, HLG over plain),
 *   3. sound (lossless Atmos / DTS:X over lossless over surround over stereo; more channels better),
 *   4. bitrate (the bigger, less squashed file, when everything else is equal).
 * Different cuts ("Extended Edition", "Director's Cut") are different films and are left alone.
 *
 * Only files stored on this computer count. USB drives / external hard drives are never touched (and a copy
 * that's only on a drive doesn't make the one on this computer a duplicate).
 *
 * Usage (on the box: screenroom-dedupe; anywhere: node tools/screenroom-dedupe.js):
 *   screenroom-dedupe                     show what would be removed (nothing is deleted)
 *   screenroom-dedupe --apply             remove the lower-quality copies
 *   screenroom-dedupe --apply --only <path> [--only <path>...]   remove just these (as listed by a plan)
 *   screenroom-dedupe --json              the plan as JSON (what Screenroom's Settings uses)
 *   screenroom-dedupe --data <dir>        Screenroom's data folder (default: the usual one for this computer)
 * It works from Screenroom's library list (what the app found last time it looked at your folders).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const core = require('../lib/media-core');
const { removeMedia, under } = require('../lib/cleanup');
const { defaultMediaDir } = require('../lib/transfer');

// ---- where things are ----------------------------------------------------------------------------------------
function defaultDataDir() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'screenroom');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || os.homedir(), 'screenroom');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'screenroom');
}
// Drives that are plugged in (USB sticks, external hard drives): never touched.
function driveMounts() {
  const out = [];
  if (process.platform === 'linux') {
    let text = '';
    try { text = fs.readFileSync('/proc/self/mounts', 'utf8'); } catch {}
    for (const line of text.split('\n')) {
      const mnt = (line.split(' ')[1] || '').replace(/\\040/g, ' ').replace(/\\011/g, '\t').replace(/\\134/g, '\\');
      if (/^\/(media|run\/media|mnt)\//.test(mnt)) out.push(mnt);
    }
  } else if (process.platform === 'darwin') {
    try { for (const n of fs.readdirSync('/Volumes')) { const m = path.join('/Volumes', n); if (fs.realpathSync(m) !== '/') out.push(m); } } catch {}
  }
  return out;
}

// ---- quality ---------------------------------------------------------------------------------------------------
const RES = { '4K': 3, HD: 2, SD: 1 };
function hdrRank(v) { return v.dv ? 3 : /HDR10/i.test(v.hdr || '') ? 2 : v.hdr ? 1 : 0; }
function audioRank(a) {
  const l = a.label || '';
  let r = 0;
  if (/TrueHD Atmos|DTS:X/i.test(l)) r = 6;
  else if (/TrueHD|DTS-HD MA|PCM|FLAC|ALAC/i.test(l) || /^pcm/.test(a.codec || '')) r = 5;
  else if (/Plus Atmos/i.test(l)) r = 4;
  else if (/DTS-HD HRA|DTS|Dolby Digital Plus/i.test(l)) r = 3;
  else if (/Dolby Digital/i.test(l)) r = 2;
  else r = 1;
  return r * 100 + Math.min(a.channels || 0, 16);
}
const bestAudio = (it) => Math.max(0, ...(it.audio || []).map(audioRank));
const bitrate = (it) => (it.duration ? (it.size || 0) / it.duration : 0);
/** Higher = better. [resolution, height, HDR, sound, bitrate] compared in that order. */
function score(it) {
  const v = it.video || {};
  return [RES[core.qualityOf(it)] || 0, v.height || 0, hdrRank(v), bestAudio(it), bitrate(it)];
}
function better(a, b) {
  const x = score(a), y = score(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] > y[i] ? -1 : 1;
  return (b.size || 0) - (a.size || 0);
}
// "4K · Dolby Vision · Dolby TrueHD Atmos 7.1 · 48.2 GB"
function describe(it) {
  const v = it.video || {};
  const a = (it.audio || []).slice().sort((x, y) => audioRank(y) - audioRank(x))[0];
  const q = core.qualityOf(it);
  return [q === '4K' ? '4K' : q === 'HD' ? (v.res || 'HD') : `DVD ${v.height ? v.height + 'p' : ''}`.trim(),
    v.dv ? 'Dolby Vision' : v.hdr || '', a ? `${a.label}${a.layout ? ' ' + a.layout : ''}` : '', `${((it.size || 0) / 1e9).toFixed(1)} GB`].filter(Boolean).join(' · ');
}
const LANG = { eng: 'English', en: 'English', spa: 'Spanish', es: 'Spanish', fra: 'French', fre: 'French', fr: 'French', deu: 'German', ger: 'German', de: 'German',
  ita: 'Italian', it: 'Italian', jpn: 'Japanese', ja: 'Japanese', por: 'Portuguese', pt: 'Portuguese', kor: 'Korean', ko: 'Korean', zho: 'Chinese', chi: 'Chinese', zh: 'Chinese',
  rus: 'Russian', ru: 'Russian', nld: 'Dutch', dut: 'Dutch', swe: 'Swedish', dan: 'Danish', nor: 'Norwegian', fin: 'Finnish', pol: 'Polish', hin: 'Hindi', ara: 'Arabic', tur: 'Turkish' };
const langName = (l) => LANG[l] || l.toUpperCase();
// What the removed copy has that the kept one doesn't (another language, subtitles), so you can decide.
function losses(keep, drop) {
  const langs = (it, k) => new Set((it[k] || []).map((t) => (t.lang || '').toLowerCase()).filter((l) => l && l !== 'und').map(langName));
  const out = [];
  const ka = langs(keep, 'audio'), da = [...langs(drop, 'audio')].filter((l) => !ka.has(l));
  if (da.length) out.push(`${da.join(', ')} audio`);
  const ks = langs(keep, 'subs'), ds = [...langs(drop, 'subs')].filter((l) => !ks.has(l));
  if (ds.length) out.push(`${ds.join(', ')} subtitles`);
  if (!(keep.subs || []).length && (drop.subs || []).length && !ds.length) out.push('subtitles');
  return out;
}

// ---- the plan --------------------------------------------------------------------------------------------------
function loadItems(dataDir) {
  const file = path.join(dataDir, 'library.json');
  let db;
  try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error(`Couldn't read Screenroom's library list (${file}). Open Screenroom once so it can look at your folders.`); }
  return require('../lib/library').withSidecarSubs(Object.values(db).map((it) => core.applyTv(it)).filter((it) => it && it.path && fs.existsSync(it.path)));
}

function plan({ dataDir = defaultDataDir(), drives = driveMounts() } = {}) {
  const onDrive = (p) => drives.some((m) => p === m || under(p, m));
  const items = loadItems(dataDir).filter((it) => !onDrive(it.path));
  const groups = [];
  // films: the same title (and year), whatever the quality words in the name
  for (const g of core.groupMovies(items.filter((it) => !it.tv))) {
    if (g.versions.length < 2) continue;
    groups.push({ kind: 'movie', title: g.title + (g.year ? ` (${g.year})` : ''), items: g.versions });
  }
  // episodes: the same show, season and episode
  const eps = new Map();
  for (const it of items.filter((x) => x.tv)) {
    const k = [core.movieTitleKey(it.tv.series) || it.tv.series.toLowerCase(), it.tv.season, it.tv.episode, it.tv.episodeEnd || '', it.tv.part || ''].join('|');
    if (!eps.has(k)) eps.set(k, []);
    eps.get(k).push(it);
  }
  for (const list of eps.values()) {
    if (list.length < 2) continue;
    const t = list.slice().sort(better)[0].tv; // named after the copy that stays
    groups.push({ kind: 'episode', title: `${t.series} S${t.season} E${t.label || t.episode}${t.name ? ' · ' + t.name : ''}`, items: list });
  }
  const out = [];
  for (const g of groups) {
    const sorted = g.items.slice().sort(better);
    const keep = sorted[0];
    out.push({
      kind: g.kind, title: g.title,
      keep: { id: keep.id, path: keep.path, quality: describe(keep), size: keep.size || 0 },
      remove: sorted.slice(1).map((d) => ({ id: d.id, path: d.path, quality: describe(d), size: d.size || 0, loses: losses(keep, d) })),
    });
  }
  out.sort((a, b) => (a.kind === b.kind ? a.title.localeCompare(b.title) : a.kind === 'movie' ? -1 : 1));
  const roots = libraryRoots(dataDir).filter((r) => !onDrive(r));
  return { groups: out, files: out.reduce((n, g) => n + g.remove.length, 0), bytes: out.reduce((n, g) => n + g.remove.reduce((m, r) => m + r.size, 0), 0), roots };
}

// The folders the library is made of (deleting never goes above them).
function libraryRoots(dataDir) {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')); } catch {}
  return [...new Set([...(cfg.dirs || []), cfg.mediaDir || defaultMediaDir()])].filter(Boolean);
}

async function apply(p, only) {
  const want = only && only.length ? new Set(only.map((x) => path.resolve(x))) : null;
  const files = [];
  const moves = []; // { from: removed id, to: kept id } so watch progress can follow the kept copy
  for (const g of p.groups) for (const r of g.remove) {
    if (want && !want.has(path.resolve(r.path))) continue;
    files.push(r.path); moves.push({ from: r.id, to: g.keep.id });
  }
  if (!files.length) return { removed: 0, freed: 0, moves };
  const r = await removeMedia(files, p.roots);
  return { ...r, moves };
}

// ---- command line ----------------------------------------------------------------------------------------------
const gb = (n) => `${(n / 1e9).toFixed(1)} GB`;
async function main(argv) {
  const args = { apply: false, json: false, only: [], data: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--json') args.json = true;
    else if (a === '--only') args.only.push(argv[++i]);
    else if (a === '--data') args.data = argv[++i];
    else if (a === '-h' || a === '--help') { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\n?/, '').replace(/^ \* ?/gm, '')); return 0; }
    else { console.error(`Unknown option: ${a} (try --help)`); return 2; }
  }
  let p;
  try { p = plan({ dataDir: args.data || defaultDataDir() }); } catch (e) { if (args.json) console.log(JSON.stringify({ error: e.message })); else console.error(e.message); return 1; }
  if (!args.apply) {
    if (args.json) { console.log(JSON.stringify(p)); return 0; }
    if (!p.groups.length) { console.log('No duplicates: every film and episode on this computer is stored once.'); return 0; }
    for (const g of p.groups) {
      console.log(`\n${g.title}`);
      console.log(`  keep    ${g.keep.quality}   ${g.keep.path}`);
      for (const r of g.remove) console.log(`  remove  ${r.quality}   ${r.path}${r.loses.length ? `\n          (has ${r.loses.join(' and ')} that the kept copy doesn't)` : ''}`);
    }
    console.log(`\n${p.files} lower-quality cop${p.files === 1 ? 'y' : 'ies'}, ${gb(p.bytes)}. Nothing was deleted; run with --apply to remove them.`);
    return 0;
  }
  const r = await apply(p, args.only);
  if (args.json) console.log(JSON.stringify(r));
  else console.log(`Removed ${r.removed} file${r.removed === 1 ? '' : 's'}, ${gb(r.freed)} freed.${r.skipped ? ` ${r.skipped} couldn't be removed.` : ''}`);
  return 0;
}

module.exports = { plan, apply, score, describe };
if (require.main === module) main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(e.message); process.exit(1); });
