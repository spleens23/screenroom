// What a spoken request means: the words Whisper wrote down → one thing to do, matched against what's on the box
// (albums, artists, songs and playlists in Parlor; films and shows in Screenroom; the Sonos rooms).
// No outside service: just careful matching that copes with how speech gets written down ("AC/DC" said as
// "a c d c", "Part 2" as "part two", a missing "the" …).

// ---- the wake word, as Whisper writes it ---------------------------------------------------------------------
const WAKE_RE = /^(?:.*?\b)?(?:hey|hay|hi|okay|ok|a)?[\s,.!-]*(?:screen|scream|scene|green|cream)[\s-]*rooms?\b[\s,.!?:;-]*/i;
function afterWake(s) {
  let t = String(s || '').trim();
  const before = WAKE_RE.exec(t);
  if (before) {
    const after = t.slice(before[0].length);
    // (the wake word written at the end: the words before it are the request, e.g. its start was cut off)
    const pre = t.slice(0, before[0].length).replace(/(?:hey|hay|hi|okay|ok|a)?[\s,.!-]*(?:screen|scream|scene|green|cream)[\s-]*rooms?\b[\s,.!?:;-]*$/i, '');
    t = after.replace(/^[\s,.!?-]+/, '').trim() ? after : pre;
  }
  t = t.replace(/^[\s,.!?-]+/, '').trim();
  // only the first sentence (a TV talking straight after it gets written down too), and never past a second "Hey
  // Screenroom"
  const again = /\b(?:hey|hay|hi|okay|ok)[\s,.!-]*(?:screen|scream|scene|green|cream)[\s-]*rooms?\b/i.exec(t);
  if (again) t = t.slice(0, again.index);
  const end = /(?<!\b(?:mr|mrs|ms|dr|st|sgt|jr|sr|vs|vol|pt|no|feat|ft|lt|col|gen|capt|prof))[.!?]+["']?\s+(?=[A-Z0-9"'])/i.exec(t);
  if (end) t = t.slice(0, end.index);
  t = t.replace(/[\s,.!?-]+$/, '').trim();
  // Whisper's way of saying "nothing" when it heard only noise
  if (/^(\[.*\]|\(.*\)|you\.?|thank you\.?|thanks for watching!?|\.+|-+)$/i.test(t)) return '';
  return t;
}

// ---- words → comparable form ---------------------------------------------------------------------------------
const NUM = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100 };
const ABBR = { sgt: 'sergeant', mr: 'mister', mrs: 'missus', dr: 'doctor', st: 'saint', vs: 'versus', v: 'versus', pt: 'part', vol: 'volume', feat: 'featuring', ft: 'featuring', jr: 'junior', ok: 'okay', xmas: 'christmas' };
const ROMAN = { ii: 2, iii: 3, iv: 4, vi: 6, vii: 7, viii: 8, ix: 9 };
function norm(s) {
  let t = String(s || '').toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ').replace(/\+/g, ' plus ').replace(/@/g, ' at ')
    .replace(/(\w)'(\w)/g, '$1$2') // don't → dont
    .replace(/[^a-z0-9]+/g, ' ').trim();
  // "twenty one" → 21, "two" → 2, "part ii" → part 2
  const w = t.split(' ');
  const out = [];
  for (let i = 0; i < w.length; i++) {
    const x = w[i];
    if (x in NUM) {
      let v = NUM[x];
      if (v >= 20 && v < 100 && w[i + 1] in NUM && NUM[w[i + 1]] < 10) { v += NUM[w[i + 1]]; i++; }
      // years said as two numbers: "nineteen eighty nine" → 1989, "two thousand four" → 2004
      out.push(String(v));
    } else if (x === 'thousand' && out.length && /^\d$/.test(out[out.length - 1])) {
      let v = +out.pop() * 1000;
      if (w[i + 1] === 'and') i++;
      if (w[i + 1] in NUM) { let r = NUM[w[++i]]; if (r >= 20 && r < 100 && w[i + 1] in NUM && NUM[w[i + 1]] < 10) r += NUM[w[++i]]; v += r; }
      out.push(String(v));
    } else if (x in ROMAN && i > 0) out.push(String(ROMAN[x]));
    else out.push(x);
  }
  // "19 89" → 1989
  for (let i = 0; i + 1 < out.length; i++) {
    if (/^(1[0-9]|20)$/.test(out[i]) && /^\d\d$/.test(out[i + 1]) && +out[i + 1] >= 10) { out.splice(i, 2, out[i] + out[i + 1]); }
    else if (/^(1[0-9]|20)$/.test(out[i]) && out[i + 1] === 'oh' && /^\d$/.test(out[i + 2] || '')) { out.splice(i, 3, out[i] + '0' + out[i + 2]); }
  }
  // the same word written short or long
  for (let i = 0; i < out.length; i++) out[i] = ABBR[out[i]] || out[i];
  // spelled-out letters ("a c d c", "r e m") → one word
  const joined = [];
  for (let i = 0; i < out.length; i++) {
    if (out[i].length === 1 && /[a-z]/.test(out[i]) && out[i + 1] && out[i + 1].length === 1 && /[a-z]/.test(out[i + 1])) {
      let s2 = '';
      while (i < out.length && out[i].length === 1 && /[a-z]/.test(out[i])) s2 += out[i++];
      i--; joined.push(s2);
    } else joined.push(out[i]);
  }
  return joined.join(' ');
}
const STOP = new Set(['the', 'a', 'an', 'of', 'by', 'and', 'to', 'in', 'on', 'my', 'some', 'please']);
const squash = (s) => norm(s).split(' ').filter((w) => !STOP.has(w)).join('');

function lev(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length; if (!b.length) return a.length;
  let prev = new Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
/** How alike two names are, 0 … 1 (spaces, "the" and punctuation don't count; a few letters off still matches). */
function similar(said, name) {
  const bare = String(name || '').replace(/\s*[([][^)\]]*[)\]]\s*/g, ' ').replace(/\s+-\s+(remaster(ed)?|deluxe|live|mono|stereo|single)\b.*$/i, '').trim();
  if (bare && bare !== name) return Math.max(similar1(said, name), similar1(said, bare) - 0.01);
  return similar1(said, name);
}
function similar1(said, name) {
  const a = squash(said), b = squash(name);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ratio = 1 - lev(a, b) / Math.max(a.length, b.length);
  // said the start of a long name ("play Sgt Pepper" for "Sgt. Pepper's Lonely Hearts Club Band")
  const prefix = b.startsWith(a) && a.length >= 5 ? 0.86 + 0.1 * (a.length / b.length) : 0;
  // a name inside what was said, or what was said inside a name (with whole words)
  const na = ` ${norm(said)} `, nb = ` ${norm(name)} `;
  const inside = nb.length > 4 && na.includes(nb) ? 0.8 : (na.trim().length >= 4 && nb.includes(na) ? 0.7 + 0.2 * (na.length / nb.length) : 0);
  return Math.max(ratio, prefix, inside);
}

// ---- what kind of thing was asked for -----------------------------------------------------------------------------
const CONTROLS = [
  [/^(pause|pause (it|this|the music|the movie|the film|the show|music)|hold on|wait)$/, { do: 'pause' }],
  [/^(stop|stop (it|this|the music|music|playing|the movie|the film|the show)|turn (it|the music) off|enough)$/, { do: 'stop' }],
  [/^(play|resume|continue|keep (playing|going)|unpause|play (it|music) again|carry on)$/, { do: 'resume' }],
  [/^(next|skip|skip (it|this|ahead|(this|the|that) (song|track|one)|song|track)|next (song|track|one|episode)|play the next (song|track|one|episode))$/, { do: 'next' }],
  [/^(previous|back|go back|last (song|track)|previous (song|track)|play the (previous|last) (song|track)|play that again|start (it|this|the song) over|restart( (it|this|the song))?)$/, { do: 'prev' }],
  [/^((turn|crank) (it|the (music|volume|sound)) up|louder|volume up|(make it|a (bit|little)) louder|raise the volume|up the volume|turn up( the (music|volume))?)$/, { do: 'volume', by: 10 }],
  [/^((turn) (it|the (music|volume|sound)) down|quieter|softer|volume down|(make it|a (bit|little)) (quieter|softer)|lower the volume|turn down( the (music|volume))?)$/, { do: 'volume', by: -10 }],
  [/^(mute|mute (it|this|the (music|sound|tv)))$/, { do: 'mute', on: true }],
  [/^(unmute|unmute (it|this|the (music|sound|tv)))$/, { do: 'mute', on: false }],
  [/^(shuffle|shuffle (it|this|on|the songs)|turn on shuffle|mix it up)$/, { do: 'shuffle', on: true }],
  [/^(stop shuffling|shuffle off|turn off shuffle|unshuffle)$/, { do: 'shuffle', on: false }],
  [/^(what('?s| is) (this|playing|this song)|what song is (this|playing)|who('?s| is) (this|singing|playing))$/, { do: 'whats-on' }],
  [/^(skip (forward|ahead) ?(\d+ (seconds|minutes))?|fast forward)$/, { do: 'seek', by: 30 }],
  [/^(go back (\d+ )?(seconds|a bit)|rewind( a bit)?|back (\d+ )?seconds)$/, { do: 'seek', by: -15 }],
  [/^(cancel|never ?mind|nothing|no|forget it)$/, { do: 'cancel' }],
];

/**
 * @param {string} text what was said after "Hey Screenroom"
 * @param {object} lib  { albums:[{key,title,artist}], artists:[name], tracks:[{id,title,artist,albumKey}], playlists:[{id,name}],
 *                       films:[{id,title,year}], shows:[{key,name}], rooms:[{id,name}] }
 * @returns {object} { do: 'pause'|'play-music'|'play-film'|'play-show'|…, … , said }
 */
function understand(text, lib) {
  const said = String(text || '').trim();
  let t = norm(said).replace(/^(please|can you|could you|would you|will you|i want to|i wanna|i d like to|lets|let s)\s+/, '').replace(/\s+(please|thanks|thank you)$/, '').trim();
  // (Whisper sometimes runs "play" into the next word: "playdreams")
  t = t.replace(/^play(?!list|er|ing|ed|s |ful|ground|boy|house|time)(?=[a-z]{3})/, 'play ');
  if (!t) return { do: 'nothing', said };
  // volume to a number: "volume 30", "set the volume to 30", "turn it to 20"
  let m = /^(?:set |turn |put )?(?:the )?(?:volume|it|sound)(?: up| down)? (?:to |at )?(\d{1,3})(?: percent)?$/.exec(t);
  if (m) return { do: 'volume', to: Math.min(100, +m[1]), said };
  const plainRoom = (x) => x.replace(/\s+(?:in|on|to) (?:the )?([a-z0-9 ]+)$/, '');
  for (const [re, act] of CONTROLS) if (re.test(t) || re.test(plainRoom(t))) {
    const r = { ...act, said };
    const room = roomFrom(t, lib.rooms || []);
    if (room) r.room = room.room;
    return r;
  }

  // move the music: "play this in the kitchen", "move the music to the den", "play it on the TV"
  m = /^(?:play|move|send|put|switch)(?: (?:this|it|the music|music|that|what s playing))?(?: over)? (?:in|on|to|into) (?:the )?(.+)$/.exec(t);
  if (m && /^(?:play|move|send|put|switch) (?:this|it|the music|music|that|what s playing)/.test(t)) {
    const room = matchRoom(m[1], lib.rooms || []);
    if (room) return { do: 'move', room, said };
    if (/^(tv|television|box|here|screenroom)$/.test(m[1])) return { do: 'move', room: null, said };
  }

  m = /^(?:play|put on|start|listen to|i want to hear|watch|i want to watch|show|turn on|shuffle|play some|queue|queue up|add)\s+(.+)$/.exec(t);
  if (!m) {
    // a bare name ("Night Drive") counts as play
    m = [t, t];
  }
  const verb = t.slice(0, t.length - m[1].length).trim();
  let what = m[1].trim();
  const shuffle = /^shuffle/.test(verb) || /\b(on shuffle|shuffled|in random order)$/.test(what);
  what = what.replace(/\s+(on shuffle|shuffled|in random order)$/, '');
  const queue = /^(queue|add)/.test(verb);
  what = what.replace(/\s+(to|on) (the )?queue$/, '').replace(/\s+next$/, () => '');

  // where: "… in the living room", "… on the kitchen", "… on the TV"
  let room;
  const rf = roomFrom(what, lib.rooms || []);
  if (rf) { room = rf.room; what = rf.rest; }
  else {
    const tv = /\s+(?:on|in) (?:the )?(tv|television|telly|box|screen|here)$/.exec(what);
    if (tv) { room = null; what = what.slice(0, tv.index); }
  }

  // which kind
  let kind = '';
  const KINDS = [
    ['film', /^(?:the )?(?:movie|film)\s+|\s+(?:the )?(?:movie|film)$/],
    ['episode', /^(?:the )?(?:next|latest|new|newest) episode of\s+|^(?:the )?(?:next|latest) (?:episode|one) of\s+|^(?:an |the )?episode of\s+/],
    ['show', /^(?:the )?(?:tv )?(?:show|series)\s+|\s+(?:the )?(?:tv )?(?:show|series)$/],
    ['playlist', /^(?:the |my )?playlist\s+(?:called\s+)?|\s+playlist$/],
    ['artist', /^(?:songs|music|something|stuff|anything|tracks|hits) (?:by|from)\s+|^(?:the )?(?:artist|band|singer)\s+|^some\s+(?=\w)/],
    ['album', /^(?:the )?(?:album|record|lp|ep)\s+(?:called\s+)?|\s+(?:the )?album$/],
    ['song', /^(?:the )?(?:song|track|tune|single)\s+(?:called\s+)?|\s+(?:the )?(?:song|track)$/],
  ];
  for (const [k, re] of KINDS) if (re.test(what)) { kind = k; what = what.replace(re, ' ').trim(); break; }
  if (verb === 'watch' || verb === 'i want to watch') kind = kind || 'watch';
  if (verb === 'listen to' || verb === 'i want to hear' || verb === 'play some') kind = kind || 'listen';
  // "X by Y": a song or album by that artist
  let by = '';
  const bm = /^(.+?) (?:by|from) (.+)$/.exec(what);
  if (bm && !['artist', 'film', 'show', 'episode', 'playlist'].includes(kind)) { by = bm[2]; }
  if (!kind && /^(music|something|anything|songs|some music|my music|random music|tunes)$/.test(what)) return { do: 'play-music', any: true, shuffle: true, room, queue, said };
  if (!kind && /^(my )?(favou?rites|liked songs|loved songs)$/.test(what)) return { do: 'play-music', favourites: true, shuffle, room, queue, said };
  if (/^(today s mix|todays mix|the daily mix|daily mix|my mix|mix)$/.test(what)) return { do: 'play-music', mix: true, room, queue, said };
  if (!what) return { do: 'unknown', said };

  // ---- the best match of each kind ----
  const cands = [];
  const add = (type, score, item, extra) => { if (score > 0) cands.push({ type, score, item, ...extra }); };
  const music = !['film', 'show', 'episode', 'watch'].includes(kind);
  const video = !['album', 'song', 'artist', 'playlist', 'listen'].includes(kind);
  if (music) {
    for (const a of lib.albums || []) {
      let s = similar(what, a.title);
      if (by) s = Math.max(s, (similar(bm[1], a.title) * 0.75 + similar(by, a.artist) * 0.25) + 0.02);
      s = Math.max(s, similar(what, `${a.title} ${a.artist}`) - 0.03);
      add('album', s + (kind === 'album' ? 0.08 : 0), a);
    }
    for (const n of lib.artists || []) add('artist', similar(what, n) + (kind === 'artist' ? 0.1 : 0) + 0.01, { name: n });
    for (const tr of lib.tracks || []) {
      let s = similar(what, tr.title);
      if (by) s = Math.max(s, similar(bm[1], tr.title) * 0.75 + similar(by, tr.artist) * 0.25 + 0.02);
      add('song', s + (kind === 'song' ? 0.08 : 0) - 0.02, tr);
    }
    for (const p of lib.playlists || []) add('playlist', similar(what, p.name) + (kind === 'playlist' ? 0.1 : 0), p);
  }
  if (video) {
    for (const f of lib.films || []) {
      const base = what.replace(/\s+(?:from )?(1[89]\d\d|20\d\d)$/, '');
      add('film', Math.max(similar(what, f.title), similar(base, f.title), f.year ? similar(what, `${f.title} ${f.year}`) : 0) + (kind === 'film' || kind === 'watch' ? 0.08 : 0), f);
    }
    for (const s of lib.shows || []) add('show', similar(what, s.name) + (kind === 'show' || kind === 'episode' || kind === 'watch' ? 0.08 : 0), s);
  }
  cands.sort((a, b) => b.score - a.score);
  const best = cands[0];
  if (!best || best.score < 0.72) return { do: 'not-found', what, kind, said, near: cands.slice(0, 3).filter((c) => c.score > 0.5).map((c) => label(c)) };
  const out = { said, score: +best.score.toFixed(2), room, shuffle, queue };
  if (best.type === 'film') return { ...out, do: 'play-film', film: best.item };
  if (best.type === 'show') return { ...out, do: 'play-show', show: best.item, fresh: kind === 'episode' && /first episode|from the (start|beginning)/.test(t) };
  return { ...out, do: 'play-music', [best.type]: best.item };
}

function label(c) {
  if (c.type === 'album') return `${c.item.title} (${c.item.artist})`;
  if (c.type === 'song') return `${c.item.title} (${c.item.artist})`;
  if (c.type === 'artist') return c.item.name;
  return c.item.title || c.item.name;
}

/** A Sonos room named at the end of a request ("… in the living room"): { room, rest } */
function roomFrom(t, rooms) {
  if (!rooms.length) return null;
  const m = /^(.*?)\s+(?:in|on|to|into|through|from) (?:the )?([a-z0-9 ]{2,40})(?: speakers?| speaker| sonos)?$/.exec(t);
  if (m) {
    const r = matchRoom(m[2], rooms);
    if (r) return { room: r, rest: m[1] };
  }
  // the whole thing is a room ("play in the kitchen" was cut short)
  return null;
}
function matchRoom(name, rooms) {
  let best = null, bs = 0;
  const n = name.replace(/\s+(speakers?|sonos|room speaker)$/, '');
  for (const r of rooms) { const s = Math.max(similar(n, r.name), similar(n, r.name.replace(/\s*room$/i, ''))); if (s > bs) { bs = s; best = r; } }
  return bs >= 0.78 ? best : null;
}

module.exports = { understand, afterWake, norm, similar, matchRoom };
