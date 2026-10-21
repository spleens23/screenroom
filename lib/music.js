// Parlor's music scanner: walks music folders, reads each song's tags with ffprobe (title, artist, album,
// track/disc number, year, genre, length, format), finds the album cover (embedded, or cover.jpg / folder.jpg
// in the album folder) and groups songs into albums. Results are cached in music.json, so later scans only
// read new or changed files. Folder names fill in a missing artist / album:  Music/<Artist>/<Album>/<song>.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const AUDIO_EXT = new Set(['.mp3', '.m4a', '.m4b', '.aac', '.flac', '.alac', '.ogg', '.oga', '.opus', '.wav', '.aif', '.aiff', '.wma', '.ape', '.wv', '.mka']);
const COVER_NAMES = ['cover', 'folder', 'front', 'album', 'albumart', 'albumartsmall'];
const ITEM_VERSION = 1;

function run(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

async function* walk(dir) {
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (AUDIO_EXT.has(path.extname(e.name).toLowerCase())) yield full;
  }
}

const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
function tag(tags, ...keys) {
  for (const k of keys) {
    for (const tk of Object.keys(tags)) if (tk.toLowerCase() === k) { const v = String(tags[tk]).trim(); if (v) return v; }
  }
  return '';
}
const num = (v) => { const n = parseInt(String(v || '').split('/')[0], 10); return Number.isFinite(n) ? n : 0; };
const total = (v) => { const n = parseInt(String(v || '').split('/')[1], 10); return Number.isFinite(n) ? n : 0; };

/** Album identity: the album's artist + title, ignoring case and punctuation. */
function albumKey(artist, album) {
  const n = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  return `${n(artist)}|${n(album)}`;
}

const LOSSLESS = new Set(['flac', 'alac', 'pcm_s16le', 'pcm_s24le', 'pcm_s16be', 'pcm_s24be', 'wavpack', 'ape']);
function codecLabel(c) {
  return ({ aac: 'AAC', mp3: 'MP3', flac: 'FLAC', alac: 'Apple Lossless', opus: 'Opus', vorbis: 'Ogg Vorbis', wmav2: 'WMA', ape: "Monkey's Audio", wavpack: 'WavPack' })[c]
    || (String(c || '').startsWith('pcm') ? 'WAV / AIFF' : String(c || '').toUpperCase());
}

/** One song from ffprobe output (+ folder names when tags are missing). */
function buildTrack(file, stat, probe) {
  const fmt = probe.format || {};
  const tags = { ...(fmt.tags || {}) };
  const streams = probe.streams || [];
  const a = streams.find((s) => s.codec_type === 'audio') || {};
  Object.assign(tags, a.tags || {}); // Ogg/FLAC/Opus keep tags on the stream
  const dir = path.dirname(file);
  const folderAlbum = path.basename(dir);
  const folderArtist = path.basename(path.dirname(dir));
  const artist = tag(tags, 'artist', 'album_artist', 'albumartist') || folderArtist || 'Unknown Artist';
  const albumArtist = tag(tags, 'album_artist', 'albumartist', 'album artist') || artist;
  const album = tag(tags, 'album') || folderAlbum || 'Unknown Album';
  const date = tag(tags, 'date', 'year', 'originaldate', 'creation_time');
  const y = date.match(/\d{4}/);
  const cover = streams.find((s) => s.disposition && s.disposition.attached_pic);
  return {
    id: sha(file),
    v: ITEM_VERSION,
    path: file,
    mtime: stat.mtimeMs,
    size: stat.size,
    title: tag(tags, 'title') || path.basename(file, path.extname(file)).replace(/^\d+[\s.-]+/, ''),
    artist,
    albumArtist,
    album,
    track: num(tag(tags, 'track', 'tracknumber')),
    trackTotal: total(tag(tags, 'track', 'tracknumber')) || num(tag(tags, 'tracktotal', 'totaltracks')),
    disc: num(tag(tags, 'disc', 'discnumber')) || 1,
    year: y ? Number(y[0]) : null,
    genre: tag(tags, 'genre'),
    compilation: tag(tags, 'compilation') === '1',
    explicit: /^(1|4)$/.test(tag(tags, 'itunesadvisory', 'rtng')),
    duration: Number(fmt.duration) || Number(a.duration) || 0,
    codec: codecLabel(a.codec_name),
    lossless: LOSSLESS.has(a.codec_name),
    bitrate: Math.round((Number(fmt.bit_rate) || Number(a.bit_rate) || 0) / 1000),
    sampleRate: Number(a.sample_rate) || 0,
    hasCover: !!cover,
    coverStream: cover ? cover.index : null,
  };
}

async function folderCover(dir) {
  let names;
  try { names = await fs.promises.readdir(dir); } catch { return null; }
  const imgs = names.filter((n) => /\.(jpe?g|png|webp|gif|bmp)$/i.test(n) && !n.startsWith('.'));
  const base = (n) => n.replace(/\.[^.]+$/, '').toLowerCase();
  for (const want of COVER_NAMES) {
    const hit = imgs.find((n) => base(n) === want);
    if (hit) return path.join(dir, hit);
  }
  // Windows Media Player ("AlbumArt_{…}_Large.jpg"), scans named "Front", "cover (1)", "<album> - front"...
  const score = (n) => { const b = base(n); let s = 0;
    if (/front|cover|folder/.test(b)) s += 4; if (/albumart.*large/.test(b)) s += 3; if (/albumart/.test(b)) s += 1;
    if (/back|cd|disc|inlay|inside|booklet|tray|label|spine|small/.test(b)) s -= 3; return s; };
  const ranked = imgs.map((n) => [n, score(n)]).sort((a, b) => b[1] - a[1]);
  if (ranked.length && (ranked[0][1] > 0 || ranked.length === 1)) return path.join(dir, ranked[0][0]);
  return null;
}

/**
 * Scan music folders. Returns { tracks, albums } where albums = [{ key, title, artist, year, genre, art,
 * added, tracks: [track ids in disc/track order], duration, lossless, dirs }].
 */
async function scanMusic({ dirs, dataDir, ffprobe = 'ffprobe', ffmpeg = 'ffmpeg', onProgress = () => {}, concurrency = 6 }) {
  const artDir = path.join(dataDir, 'music-art');
  await fs.promises.mkdir(artDir, { recursive: true });
  const dbFile = path.join(dataDir, 'music.json');
  let cache = {};
  try { cache = JSON.parse(await fs.promises.readFile(dbFile, 'utf8')).tracks || {}; } catch {}

  const files = [];
  const seen = new Set();
  for (const d of dirs) {
    for await (const f of walk(d)) {
      const k = path.resolve(f).normalize('NFC');
      if (!seen.has(k)) { seen.add(k); files.push(f); }
    }
  }

  const tracks = {};
  let done = 0, idx = 0;
  async function worker() {
    while (idx < files.length) {
      const file = files[idx++];
      try {
        const stat = await fs.promises.stat(file);
        const hit = cache[file];
        if (hit && hit.v === ITEM_VERSION && hit.mtime === stat.mtimeMs && hit.size === stat.size) tracks[file] = hit;
        else tracks[file] = buildTrack(file, stat, JSON.parse(await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file])));
      } catch { /* unreadable file: skipped */ }
      onProgress({ done: ++done, total: files.length, music: true });
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  // ---- albums
  const byKey = new Map();
  for (const t of Object.values(tracks)) {
    const k = albumKey(t.compilation ? 'Various Artists' : t.albumArtist, t.album);
    t.albumKey = k;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(t);
  }
  const albums = [];
  for (const [key, list] of byKey) {
    list.sort((a, b) => (a.disc - b.disc) || ((a.track || 999) - (b.track || 999)) || a.path.localeCompare(b.path));
    const first = list[0];
    const artists = new Set(list.map((t) => t.artist));
    const art = await albumArt(key, list, artDir, ffmpeg);
    const years = list.map((t) => t.year).filter(Boolean);
    albums.push({
      key,
      title: first.album,
      artist: first.compilation ? 'Various Artists' : first.albumArtist,
      various: first.compilation || artists.size > 2,
      year: years.length ? Math.min(...years) : null,
      genre: first.genre,
      art,
      added: Math.max(...list.map((t) => t.mtime)),
      tracks: list.map((t) => t.id),
      duration: list.reduce((s, t) => s + (t.duration || 0), 0),
      lossless: list.every((t) => t.lossless),
      dirs: [...new Set(list.map((t) => path.dirname(t.path)))],
    });
  }
  albums.sort((a, b) => a.artist.localeCompare(b.artist) || (a.year || 0) - (b.year || 0) || a.title.localeCompare(b.title));
  await fs.promises.writeFile(dbFile, JSON.stringify({ tracks }));
  const byId = {};
  for (const t of Object.values(tracks)) byId[t.id] = t;
  return { tracks: byId, albums };
}

/** The album's cover: a picture in the album folder, else the first embedded cover (saved once, 600 px). */
async function albumArt(key, list, artDir, ffmpeg) {
  const dest = path.join(artDir, `${sha(key)}.jpg`);
  const fromFolder = await folderCover(path.dirname(list[0].path));
  if (fromFolder) return fromFolder;
  if (fs.existsSync(dest)) return dest;
  const withCover = list.find((t) => t.hasCover);
  if (!withCover) return null;
  try {
    await run(ffmpeg, ['-y', '-v', 'error', '-i', withCover.path, '-map', `0:${withCover.coverStream}`, '-frames:v', '1',
      '-vf', "scale='min(600,iw)':-2", dest]);
    return dest;
  } catch { return null; }
}

module.exports = { scanMusic, albumKey, buildTrack, AUDIO_EXT, folderCover };
