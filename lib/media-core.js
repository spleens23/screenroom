// Shared, dependency-free media logic used by both the desktop app (Node) and the Android app (WebView):
// codec labels, building a library item from probe data, TV-show naming and duplicate handling.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MediaCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Small path helpers that work the same everywhere ("/" or "\\" separators).
  function splitPath(p) { return String(p).replace(/[\\/]+$/, ''); }
  function basename(p, ext) {
    const s = splitPath(p);
    const b = s.slice(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1);
    return ext && b.toLowerCase().endsWith(ext.toLowerCase()) ? b.slice(0, b.length - ext.length) : b;
  }
  function dirname(p) {
    const s = splitPath(p);
    const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return i <= 0 ? (i === 0 ? '/' : '.') : s.slice(0, i);
  }
  function extname(p) {
    const b = basename(p);
    const i = b.lastIndexOf('.');
    return i > 0 ? b.slice(i) : '';
  }

// ---- codec labelling -------------------------------------------------------
function audioLabel(s) {
  const codec = (s.codec_name || '').toLowerCase();
  const profile = s.profile || '';
  const atmos = /atmos/i.test(profile);
  switch (codec) {
    case 'ac3': return 'Dolby Digital';
    case 'eac3': return atmos ? 'Dolby Digital Plus Atmos' : 'Dolby Digital Plus';
    case 'truehd': return atmos ? 'Dolby TrueHD Atmos' : 'Dolby TrueHD';
    case 'dts':
      if (/dts:x/i.test(profile)) return 'DTS:X';
      if (/ma/i.test(profile) && /hd/i.test(profile)) return 'DTS-HD MA';
      if (/hra|high res/i.test(profile)) return 'DTS-HD HRA';
      if (/es/i.test(profile)) return 'DTS-ES';
      return 'DTS';
    case 'aac': return 'AAC';
    case 'flac': return 'FLAC';
    case 'opus': return 'Opus';
    case 'mp3': return 'MP3';
    default: return codec.toUpperCase() || 'Audio';
  }
}

function familyOf(label) {
  if (/dolby/i.test(label)) return 'dolby';
  if (/dts/i.test(label)) return 'dts';
  return 'other';
}

function channelLabel(n) {
  return ({ 1: 'Mono', 2: 'Stereo', 3: '2.1', 6: '5.1', 7: '6.1', 8: '7.1' })[n] || (n ? `${n}ch` : '');
}

function parseFps(r) {
  if (!r) return null;
  const [a, b] = r.split('/').map(Number);
  return b ? Math.round((a / b) * 100) / 100 : null;
}

function resolutionBadge(w, h) {
  if (w >= 3200 || h >= 1800) return '4K';
  if (w >= 1800 || h >= 1000) return '1080p';
  if (w >= 1200 || h >= 700) return '720p';
  return h ? `${h}p` : '';
}

// ---- metadata --------------------------------------------------------------
function tag(tags, ...keys) {
  for (const k of keys) {
    for (const tk of Object.keys(tags)) {
      if (tk.toLowerCase() === k.toLowerCase() && String(tags[tk]).trim()) return String(tags[tk]).trim();
    }
  }
  return '';
}

function buildItemFromProbe(file, stat, probe, id) {
  const fmt = probe.format || {};
  const tags = fmt.tags || {};
  const streams = probe.streams || [];
  const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const audio = streams.filter((s) => s.codec_type === 'audio').map((s, i) => {
    const label = audioLabel(s);
    return {
      n: i + 1, // mpv --aid is 1-based among audio tracks
      codec: s.codec_name,
      label,
      family: familyOf(label),
      channels: s.channels || 0,
      layout: channelLabel(s.channels),
      lang: (s.tags && s.tags.language) || '',
      title: (s.tags && s.tags.title) || '',
      bitrate: s.bit_rate ? Math.round(s.bit_rate / 1000) : null,
      default: !!(s.disposition && s.disposition.default),
    };
  });
  const subs = streams.filter((s) => s.codec_type === 'subtitle').map((s, i) => ({
    n: i + 1, codec: s.codec_name, lang: (s.tags && s.tags.language) || '', title: (s.tags && s.tags.title) || '',
  }));
  const hdr = v && v.color_transfer === 'smpte2084' ? 'HDR10' : v && v.color_transfer === 'arib-std-b67' ? 'HLG' : '';
  const dv = streams.some((s) => (s.side_data_list || []).some((d) => /dovi/i.test(d.side_data_type || '')));
  const genre = tag(tags, 'genre');
  const date = tag(tags, 'date', 'creation_time', 'year');
  const yearMatch = date.match(/\d{4}/);
  const base = basename(file, extname(file));

  return {
    id,
    path: file,
    mtime: stat.mtimeMs,
    size: stat.size,
    title: tag(tags, 'title') || base,
    year: yearMatch ? Number(yearMatch[0]) : null,
    description: tag(tags, 'description', 'synopsis', 'comment', 'lyrics'),
    genres: genre ? genre.split(/[;,/]/).map((g) => g.trim()).filter(Boolean) : [],
    show: tag(tags, 'show'),
    season: Number(tag(tags, 'season_number')) || null,
    episode: Number(tag(tags, 'episode_sort', 'episode_id')) || null,
    artist: tag(tags, 'artist', 'album_artist'),
    rating: parseRating(tags),
    duration: Number(fmt.duration) || 0,
    video: v ? {
      codec: v.codec_name === 'hevc' ? 'H.265' : v.codec_name === 'h264' ? 'H.264' : (v.codec_name || '').toUpperCase(),
      width: v.width, height: v.height,
      res: resolutionBadge(v.width, v.height),
      fps: parseFps(v.avg_frame_rate || v.r_frame_rate),
      hdr, dv,
    } : null,
    audio,
    subs,
    art: null,
    backdrop: null,
  };
}

// ---- TV detection ----------------------------------------------------------
// Expected layout: <Series name>/<Season #>/S#E# Episode name.mp4
// Computed from the path every time (not cached), so layout fixes apply without a rescan.
const SEASON_DIR = /^(?:season|series|s)\s*\.?\s*(\d{1,3})$/i;

// "S1E1a", "S01E01b" -> a segment letter. "S01E01-E02" / "S01E01E02" -> a two-part file (episodes 1-2).
const SXEY = /S(\d{1,3})\s*E(\d{1,4})(?:[-_]E?(\d{1,4})(?!\d)|E(\d{1,4})(?!\d))?(?:([a-z])(?=[\s._:\/\-]|$))?/i;

// On a Mac a "/" in a file name is stored as ":" (so "Help Wanted/Reef Blower" is "Help Wanted:Reef Blower" on disk).
// Show those the way the person typed them.
function prettyName(n) {
  return String(n || '').normalize('NFC').replace(/\s*[:\uA789\u2215]\s*/g, ' / ').replace(/\s+/g, ' ').trim();
}

function parseTv(item) {
  const file = item.path;
  const base = basename(file, extname(file)).normalize('NFC');
  const dir = dirname(file);
  const dirName = basename(dir);
  const sd = dirName.match(SEASON_DIR) || (/^specials?$/i.test(dirName) ? [null, '0'] : null);
  const se = base.match(SXEY);
  let episode = null, episodeEnd = null, part = '';
  let name = '';
  let season = null;

  if (se) {
    season = Number(se[1]);
    episode = Number(se[2]);
    const end = Number(se[3] || se[4] || 0);
    if (end > episode && end - episode < 10) episodeEnd = end;
    part = (se[5] || '').toLowerCase();
    name = base.slice(se.index + se[0].length).replace(/^[\s._:-]+/, '').trim();
  } else if (sd) {
    const m = base.match(/^(?:e|ep|episode)?\s*(\d{1,4})\s*([a-z](?![a-z]))?\s*[-._:)\s]*(.*)$/i);
    if (m) { episode = Number(m[1]); part = (m[2] || '').toLowerCase(); name = m[3].trim(); }
  }
  if (episode == null) return null;
  if (sd) season = season != null ? season : Number(sd[1]);
  if (season == null) season = item.season || 1;

  let series = sd ? basename(dirname(dir)) : (se ? dirName : '');
  if (!series || series === '/') series = item.show || '';
  if (!series) return null;
  series = series.normalize('NFC');
  const partIdx = part ? part.charCodeAt(0) - 96 : 0;
  return {
    series, season, episode, episodeEnd, part,
    label: `${episode}${episodeEnd ? '\u2013' + episodeEnd : ''}${part}`,
    // one number to sort by: season, then episode, then segment
    order: season * 1e7 + episode * 100 + Math.min(partIdx, 99),
    name: prettyName(name) || (item.show && item.title) || `Episode ${episode}`,
  };
}

// The same episode can show up twice (a copy in another folder, a 1080p and a 4K version).
// Keep the best one of each and remember what was hidden, so it can be reported.
function dedupeEpisodes(items) {
  const best = new Map();
  const dropped = [];
  const rank = (i) => ((i.height || 0) * 1e3) + Math.min(i.size || 0, 9e11) / 1e9;
  const out = [];
  for (const it of items) {
    if (!it.tv) { out.push(it); continue; }
    const key = [it.tv.series.toLowerCase(), it.tv.season, it.tv.episode, it.tv.part,
      it.tv.name.toLowerCase().replace(/[^a-z0-9]+/g, '')].join('|');
    const cur = best.get(key);
    if (!cur) { best.set(key, it); continue; }
    if (rank(it) > rank(cur)) { dropped.push(cur.path); best.set(key, it); } else dropped.push(it.path);
  }
  out.push(...best.values());
  out.dups = dropped;
  return out;
}

function applyTv(item) {
  item.tv = parseTv(item);
  return item;
}


  // ---- content ratings (from the iTunes "iTunEXTC" tag, e.g. "mpaa|PG-13|300|" or "us-tv|TV-Y7|200|") ----
  // Grouped into levels for kids profiles: 1 = little kids, 2 = older kids, 3 = teens, 4 = adults.
  const RATING_LEVELS = {
    'G': 1, 'TV-Y': 1, 'TV-G': 1, 'U': 1, 'E': 1, 'TV-Y7': 2, 'TV-Y7-FV': 2, 'PG': 2, 'TV-PG': 2,
    'PG-13': 3, 'TV-14': 3, '12': 3, '12A': 3, '13': 3, '14A': 3,
    'R': 4, 'NC-17': 4, 'TV-MA': 4, '15': 4, '16': 4, '18': 4, '18A': 4, 'R18': 4, 'X': 4,
  };
  function parseRating(tags) {
    const raw = tag(tags || {}, 'iTunEXTC', 'content_rating', 'contentrating', 'rating', 'certification', 'mpaa');
    if (!raw) return null;
    const parts = raw.split('|');
    const label = (parts.length >= 2 ? parts[1] : parts[0]).trim().toUpperCase().replace(/^RATED\s+/, '').replace(/\s+/g, '-');
    if (!label || /^(NR|NOT-RATED|UNRATED|NONE|0|1|2)$/.test(label)) return null;
    const level = RATING_LEVELS[label];
    return level ? { label, level } : null;
  }
  // May this profile see this item? (kids profiles: rated at or below their level; unrated only if allowed)
  function allowedFor(item, profile) {
    if (!profile || !profile.kids) return true;
    const r = item && item.rating;
    if (!r) return !!profile.allowUnrated;
    return r.level <= (Number(profile.maxLevel) || 1);
  }

  // ---- one movie kept in several qualities (DVD, Blu-ray, 4K) -------------------------------------------
  // Files are the same movie when their titles match once quality words, brackets and punctuation are
  // ignored ("Inception (2010) [4K]" = "Inception - Blu-ray"), and their years don't disagree.
  // Different cuts ("Extended Edition") stay separate.
  function qualityOf(item) {
    const v = (item && item.video) || {};
    const w = v.width || 0, hgt = v.height || 0;
    if (w >= 3200 || hgt >= 1800) return '4K';
    if (w >= 1200 || hgt >= 700) return 'HD';
    return 'SD';
  }
  const QUALITY_RANK = { '4K': 3, HD: 2, SD: 1 };
  const QUALITY_WORDS = /\b(4k|uhd|2160p|1080p|1080i|720p|576p|576i|480p|480i|hd|fhd|sd|dvd|dvdrip|dvd5|dvd9|blu ?ray|bluray|bdrip|brrip|bd|remux|hdr|hdr10|dolby vision|dv|sdr|x264|x265|h264|h265|hevc|avc|web ?dl|webrip|web)\b/g;
  function movieTitleKey(title, year) {
    let t = String(title || '').toLowerCase()
      .replace(/[\[({][^\])}]*[\])}]/g, ' ')          // (2010)  [Blu-ray]  {4K}
      .replace(/&/g, ' and ')
      .replace(/[._]+/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ');
    t = ` ${t} `.replace(QUALITY_WORDS, ' ').replace(/\s+/g, ' ').trim();
    if (year) t = t.replace(new RegExp(`^(.+?) ${year}$`), '$1'); // "Inception 2010" (but not "Blade Runner 2049")
    return t;
  }
  function cleanTitle(title) {
    const t = String(title || '')
      .replace(/\s*[\[({][^\])}]*[\])}]/g, ' ')
      .replace(new RegExp(QUALITY_WORDS.source.replace('blu ?ray', 'blu[ -]?ray').replace('web ?dl', 'web[ -]?dl'), 'gi'), ' ')
      .replace(/[\s._-]+$/g, '').replace(/^[\s._-]+/g, '').replace(/\s{2,}/g, ' ').trim();
    return t || String(title || '');
  }
  function yearOf(item) {
    if (item.year) return item.year;
    // "(2010)", "[2010]" or release-style "Inception.2010.2160p" (not "Blade Runner 2049": that's part of the name)
    const m = String(item.title || '').match(/[(\[](19\d\d|20\d\d)[)\]]|\.(19\d\d|20\d\d)(?:\.|$)/);
    return m ? Number(m[1] || m[2]) : null;
  }
  function versionRank(it) {
    const v = it.video || {};
    return (QUALITY_RANK[qualityOf(it)] || 0) * 1e6 + (v.height || 0) * 10 + (v.hdr ? 5 : 0) + Math.min(it.size || 0, 9e11) / 1e12;
  }
  /** Movies (items without .tv) grouped into [{ title, year, versions: [best first ...] }]. */
  function groupMovies(items) {
    const byTitle = new Map();
    for (const it of items) {
      if (it.tv) continue;
      const y = yearOf(it);
      const k = movieTitleKey(it.title, y) || String(it.id);
      if (!byTitle.has(k)) byTitle.set(k, []);
      const groups = byTitle.get(k);
      let g = groups.find((x) => !y || !x.year || x.year === y);
      if (!g) { g = { year: null, versions: [] }; groups.push(g); }
      g.versions.push(it);
      if (y && !g.year) g.year = y;
    }
    const out = [];
    for (const groups of byTitle.values()) {
      for (const g of groups) {
        g.versions.sort((a, b) => versionRank(b) - versionRank(a));
        // one plain title: "Inception" rather than "Inception 4K" or "Inception (2010) [Blu-ray]"
        g.title = g.versions.length > 1 ? cleanTitle(g.versions.map((v) => v.title).sort((a, b) => a.length - b.length)[0]) : g.versions[0].title;
        out.push(g);
      }
    }
    return out;
  }

  return { audioLabel, familyOf, channelLabel, parseFps, resolutionBadge, tag, buildItemFromProbe,
    prettyName, parseTv, applyTv, dedupeEpisodes, basename, dirname, extname, parseRating, allowedFor, RATING_LEVELS,
    qualityOf, movieTitleKey, groupMovies };
});
