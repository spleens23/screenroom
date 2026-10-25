#!/usr/bin/env node
/*
 * screenroom-getsubs: download English subtitles from the internet (OpenSubtitles.com) for every film and
 * episode that doesn't have any, and save them as "<film>.en.srt" beside it.
 *
 * Each film is first looked up by its fingerprint (the "movie hash": subtitles made for exactly that file, so
 * they're in time). If there's none, by its title and year (or show, season and episode); those are then lined
 * up with the film's speech before they're saved.
 *
 * It needs a free OpenSubtitles.com account and an API key from https://www.opensubtitles.com/consumers
 * (Screenroom keeps them in Settings → Subtitles). OpenSubtitles limits downloads per day; when the day's run
 * out, the rest wait for the next run.
 *
 * Films on plugged-in drives get subtitles too (saved on the drive). So a computer without internet can get
 * them through another one: plug the drive into a computer that's online, run this there, and the subtitles
 * travel with the films when they're copied (or synced) to the box.
 *
 * Usage (on the box: screenroom-getsubs; anywhere: node tools/screenroom-getsubs.js):
 *   screenroom-getsubs                       list the films without English subtitles (nothing is downloaded)
 *   screenroom-getsubs --apply               download them
 *   screenroom-getsubs --apply --only <film path> [--only ...]
 *   screenroom-getsubs --json                list / progress as JSON (what Screenroom's Settings uses)
 *   --data <dir>  Screenroom's data folder;  --api-key K --user U --password P  instead of the saved ones
 */
const fs = require('fs');
const path = require('path');
const core = require('../lib/media-core');
const { under } = require('../lib/cleanup');
const subs = require('./screenroom-subs');

const API = process.env.SCREENROOM_OSUB_API || 'https://api.opensubtitles.com/api/v1';
const UA = 'Screenroom v1.0';

const plainName = (t) => String(t || '').replace(/\s*[\[(](19|20)\d\d[\])]\s*$/, '').trim();
// ---- which films need subtitles ---------------------------------------------------------------------------------
function plan({ dataDir = subs.defaultDataDir(), drives = subs.driveMounts() } = {}) {
  const onDrive = (p) => drives.some((m) => p === m || under(p, m));
  const items = subs.loadItems(dataDir);
  const movieTitle = new Map();
  for (const g of core.groupMovies(items.filter((it) => !it.tv))) for (const v of g.versions) movieTitle.set(v.path, { title: g.title, year: g.year });
  const jobs = items.filter((it) => !subs.hasEnglish(it)).map((it) => {
    const m = movieTitle.get(it.path);
    const job = { path: it.path, quality: subs.describe(it), size: it.size || 0, duration: it.duration || 0, onDrive: onDrive(it.path) };
    if (it.tv) Object.assign(job, { kind: 'episode', series: it.tv.series, season: it.tv.season, episode: it.tv.episode, title: `${it.tv.series} S${it.tv.season} E${it.tv.label || it.tv.episode}` });
    else { const name = plainName(m ? m.title : it.title), year = m ? m.year : it.year; Object.assign(job, { kind: 'movie', name, year, title: name + (year ? ` (${year})` : '') }); }
    return job;
  });
  jobs.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
  return { jobs };
}

// ---- OpenSubtitles ----------------------------------------------------------------------------------------------
// The "movie hash": the file's size plus the sum of its first and last 64 KB as 64-bit numbers.
function movieHash(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size < 131072) return null;
    let h = BigInt(size);
    const buf = Buffer.alloc(65536);
    for (const pos of [0, size - 65536]) {
      fs.readSync(fd, buf, 0, 65536, pos);
      for (let i = 0; i < 65536; i += 8) h = (h + buf.readBigUInt64LE(i)) & 0xffffffffffffffffn;
    }
    return h.toString(16).padStart(16, '0');
  } finally { fs.closeSync(fd); }
}

class Client {
  constructor({ apiKey, username, password }) { this.apiKey = apiKey; this.username = username; this.password = password; this.token = null; this.remaining = null; }
  headers(json) {
    const h = { 'Api-Key': this.apiKey, 'User-Agent': UA, Accept: 'application/json' };
    if (json) h['Content-Type'] = 'application/json';
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }
  async call(method, p, body, tries = 3) {
    for (let i = 0; ; i++) {
      let r;
      try { r = await fetch(API + p, { method, headers: this.headers(!!body), body: body ? JSON.stringify(body) : undefined, redirect: 'follow', signal: AbortSignal.timeout(30000) }); }
      catch (e) { if (i + 1 < tries) { await sleep(2000); continue; } throw new Error('No internet connection (or OpenSubtitles can\'t be reached).'); }
      if (r.status === 429 && i + 1 < tries) { await sleep(1500 * (i + 1)); continue; }
      const text = await r.text();
      let data = null; try { data = JSON.parse(text); } catch {}
      if (!r.ok) {
        const msg = (data && (data.message || (data.errors && data.errors.join(' ')))) || `HTTP ${r.status}`;
        const e = new Error(r.status === 401 || r.status === 403 ? `OpenSubtitles refused the account or API key (${msg})` : msg);
        e.status = r.status; e.data = data; throw e;
      }
      return data;
    }
  }
  async login() {
    if (!this.username) return; // (downloads without an account get a much smaller daily allowance)
    const d = await this.call('POST', '/login', { username: this.username, password: this.password });
    this.token = d.token;
    if (d.user && d.user.allowed_downloads != null) this.remaining = d.user.allowed_downloads;
  }
  // parameters in alphabetical order, lower case (what the API asks for)
  async search(params) {
    const q = Object.keys(params).filter((k) => params[k] != null && params[k] !== '').sort()
      .map((k) => `${k}=${encodeURIComponent(String(params[k]).toLowerCase())}`).join('&');
    const d = await this.call('GET', `/subtitles?${q}`);
    return (d && d.data) || [];
  }
  async download(fileId) {
    const d = await this.call('POST', '/download', { file_id: fileId, sub_format: 'srt' });
    this.remaining = d.remaining;
    const r = await fetch(d.link, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`download failed (HTTP ${r.status})`);
    return { text: await r.text(), remaining: d.remaining, reset: d.reset_time_utc || d.reset_time };
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The best English subtitle: made for this exact file first, then complete (not "foreign parts only"),
// not machine-translated, without hearing-impaired notes if there's a choice, the most downloaded.
function pick(results) {
  const ok = results.filter((x) => x.attributes && /^en/i.test(x.attributes.language || '') && (x.attributes.files || []).length
    && !x.attributes.foreign_parts_only && !x.attributes.machine_translated && !x.attributes.ai_translated);
  ok.sort((a, b) => (b.attributes.moviehash_match ? 1 : 0) - (a.attributes.moviehash_match ? 1 : 0)
    || (a.attributes.hearing_impaired ? 1 : 0) - (b.attributes.hearing_impaired ? 1 : 0)
    || (b.attributes.download_count || 0) - (a.attributes.download_count || 0));
  return ok[0] || null;
}

async function getOne(client, job) {
  let hash = null;
  try { hash = movieHash(job.path); } catch {}
  let found = null;
  if (hash) found = pick((await client.search({ languages: 'en', moviehash: hash })).filter((x) => x.attributes.moviehash_match));
  if (!found) {
    const params = job.kind === 'episode'
      ? { languages: 'en', query: job.series, season_number: job.season, episode_number: job.episode }
      : { languages: 'en', query: job.name, year: job.year || undefined };
    found = pick(await client.search(params));
  }
  if (!found) return { ok: false, error: 'no English subtitles found online' };
  const exact = !!found.attributes.moviehash_match;
  const dl = await client.download(found.attributes.files[0].file_id);
  let cues = subs.parseSrt(dl.text);
  if (!cues.length) return { ok: false, error: 'the download wasn\'t a subtitle file' };
  // not made for this exact file: line it up with the film's speech
  let timing = exact ? 'made for this file' : 'not checked';
  if (!exact) {
    const tmp = path.join(require('os').tmpdir(), `screenroom-sub-${process.pid}.srt`);
    fs.writeFileSync(tmp, dl.text);
    const a = subs.lastJson((await subs.run('python3', [subs.helperPath(), 'align', job.path, tmp])).stdout);
    try { fs.unlinkSync(tmp); } catch {}
    if (a && a.ok) {
      cues = cues.map((c) => ({ start: a.a * c.start + a.b, end: a.a * c.end + a.b, text: c.text })).filter((c) => c.end > 0).map((c) => ({ ...c, start: Math.max(0, c.start) }));
      timing = Math.abs(a.b) < 0.2 && Math.abs(a.a - 1) < 1e-6 ? 'already in time' : `moved ${a.b > 0 ? 'later' : 'earlier'} by ${Math.abs(a.b).toFixed(1)} s${Math.abs(a.a - 1) > 1e-6 ? ' and stretched to the film\'s speed' : ''}`;
    }
  }
  const srt = cues.map((c, i) => `${i + 1}\n${subs.srtTime(c.start)} --> ${subs.srtTime(c.end)}\n${c.text}\n`).join('\n');
  const out = subs.stem(job.path) + '.en.srt';
  await fs.promises.writeFile(out + '.part', srt, 'utf8');
  await fs.promises.rename(out + '.part', out);
  return { ok: true, file: out, exact, timing, release: found.attributes.release || '', remaining: dl.remaining, reset: dl.reset };
}

// ---- command line ----------------------------------------------------------------------------------------------
function savedAccount(dataDir) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')).opensubtitles || {}; } catch { return {}; }
}
async function main(argv) {
  const args = { apply: false, json: false, only: [], data: null, apiKey: null, user: null, password: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--json') args.json = true;
    else if (a === '--only') args.only.push(path.resolve(argv[++i]));
    else if (a === '--data') args.data = argv[++i];
    else if (a === '--api-key') args.apiKey = argv[++i];
    else if (a === '--user') args.user = argv[++i];
    else if (a === '--password') args.password = argv[++i];
    else if (a === '-h' || a === '--help') { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\n?/, '').replace(/^ \* ?/gm, '')); return 0; }
    else { console.error(`Unknown option: ${a} (try --help)`); return 2; }
  }
  const dataDir = args.data || subs.defaultDataDir();
  const say = (o, text) => { if (args.json) console.log(JSON.stringify(o)); else if (text) console.log(text); };
  let p;
  try { p = plan({ dataDir }); } catch (e) { say({ error: e.message }, e.message); return 1; }
  if (!args.apply) {
    if (args.json) { console.log(JSON.stringify(p)); return 0; }
    if (!p.jobs.length) console.log('Every film and episode already has English subtitles.');
    for (const j of p.jobs) console.log(`${j.title} · ${j.quality}${j.onDrive ? ' (on a drive)' : ''}`);
    if (p.jobs.length) console.log(`\n${p.jobs.length} without English subtitles. Nothing was downloaded; run with --apply to get them.`);
    return 0;
  }
  const saved = savedAccount(dataDir);
  const acct = { apiKey: args.apiKey || saved.apiKey, username: args.user || saved.username, password: args.password || saved.password };
  if (!acct.apiKey) { const m = 'An OpenSubtitles API key is needed (Settings → Subtitles, or --api-key).'; say({ error: m }, m); return 1; }
  const client = new Client(acct);
  try { await client.login(); } catch (e) { say({ error: e.message }, e.message); return 1; }
  const jobs = args.only.length ? p.jobs.filter((j) => args.only.includes(path.resolve(j.path))) : p.jobs;
  const results = [];
  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i];
    say({ progress: i, total: jobs.length, title: j.title });
    if (!args.json) process.stdout.write(`[${i + 1}/${jobs.length}] ${j.title} … `);
    let r;
    try { r = await getOne(client, j); }
    catch (e) {
      r = { ok: false, error: e.message };
      // the day's downloads are used up: stop here (the rest can wait for the next run)
      if (e.status === 406 || /limit|quota|remaining/i.test(e.message)) { results.push({ title: j.title, path: j.path, ...r }); if (!args.json) console.log(e.message); break; }
      if (/No internet/.test(e.message)) { say({ error: e.message }, `\n${e.message}`); return 1; }
    }
    results.push({ title: j.title, path: j.path, ...r });
    if (!args.json) console.log(r.ok ? `saved (${r.timing})` : `skipped: ${r.error}`);
    if (r.ok && r.remaining === 0 && i + 1 < jobs.length) { results.push({ title: '', ok: false, error: `Today's OpenSubtitles downloads are used up${r.reset ? ` (more from ${r.reset})` : ''}.` }); break; }
  }
  const made = results.filter((r) => r.ok).length;
  const stop = results.find((r) => !r.title && r.error);
  say({ done: true, made, total: jobs.length, failed: results.filter((r) => !r.ok && r.title), stopped: stop ? stop.error : null, remaining: client.remaining },
    `Got ${made} of ${jobs.length}.${stop ? ' ' + stop.error : ''}`);
  return 0;
}

module.exports = { plan, movieHash, pick };
if (require.main === module) main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(e.message); process.exit(1); });
