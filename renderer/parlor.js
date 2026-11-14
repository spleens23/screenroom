// Parlor: the music room. Same layout and controls as the film side (remote, touch, mouse), with a
// 2000s-iTunes look (off-white and soft gray, brushed-metal bar, light-blue highlights, an LCD now-playing panel).
// Created by app.js, which hands over its helpers (createParlor(ctx)).
window.createParlor = function createParlor(ctx) {
  'use strict';
  const { h, $, api } = ctx;
  let P = null;            // state from the main process (albums, tracks, playlists, player...)
  let view = 'home';       // home | albums | artists | songs | playlists | artist:<name> | playlist:<id>
  let loading = null;
  const main = $('#main');

  // ---- helpers -----------------------------------------------------------------------------------------
  // (a Windows path, C:\Users\…, becomes file:///C:/Users/…)
  const fileUrl = (p) => {
    if (!p) return '';
    const win = /^[A-Za-z]:[\\/]/.test(p);
    const q = win ? '/' + p.replace(/\\/g, '/') : p;
    return (window.S_FILE_BASE || (window.S_IOS ? 'srfile://f' : 'file://')) + encodeURI(q).replace(/#/g, '%23').replace(/\?/g, '%3F');
  };
  const mmss = (s) => { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const longDur = (s) => { const m = Math.round((s || 0) / 60); return m >= 60 ? `${Math.floor(m / 60)} hr ${m % 60} min` : `${m} min`; };
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const album = (key) => P.albums.find((a) => a.key === key);
  const track = (id) => P.tracks[id];
  const albumTracks = (a) => a.tracks.map(track).filter(Boolean);
  const shuffle = (arr) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const svg = (markup, cls) => { const s = document.createElement('span'); s.className = cls || 'ico'; s.innerHTML = markup; return s; };
  const ICON = {
    play: '<svg viewBox="0 0 24 24"><path d="M7 4l13 8-13 8z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>',
    next: '<svg viewBox="0 0 24 24"><path d="M4 5l9 7-9 7zM13 5l9 7-9 7z"/></svg>',
    prev: '<svg viewBox="0 0 24 24"><path d="M20 5l-9 7 9 7zM11 5l-9 7 9 7z"/></svg>',
    rew: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path fill="none" d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path fill="none" d="M4.5 3.5v4.2h4.2"/><text x="12.4" y="15.2" text-anchor="middle" font-size="7.5" font-weight="800" font-family="sans-serif" fill="currentColor" stroke="none">10</text></svg>',
    fwd: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path fill="none" d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path fill="none" d="M19.5 3.5v4.2h-4.2"/><text x="11.6" y="15.2" text-anchor="middle" font-size="7.5" font-weight="800" font-family="sans-serif" fill="currentColor" stroke="none">10</text></svg>',
    shuffle: '<svg viewBox="0 0 24 24"><path d="M3 7h4l10 10h4M17 13l4 4-4 4M3 17h4l3-3M14 10l3-3h4M17 3l4 4-4 4" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
    repeat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 0 1 4-4h12"/><path d="M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 0 1-4 4H4"/></svg>',
    repeat1: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 0 1 4-4h12"/><path d="M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 0 1-4 4H4"/><text x="12" y="15.3" text-anchor="middle" font-size="8" font-weight="800" font-family="sans-serif" fill="currentColor" stroke="none">1</text></svg>',
    queue: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h11M4 12h11M4 18h7"/><path d="M17 15v6l4-3z" fill="currentColor" stroke="none"/></svg>',
    // a pin (an album pinned to the top of Home)
    pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6l-1 6 4 4H6l4-4z"/><path d="M12 13v8"/></svg>',
    // a speaker (where the music plays: this device or a Sonos room)
    speaker: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2.5" width="14" height="19" rx="3"/><circle cx="12" cy="14" r="3.5"/><circle cx="12" cy="7" r="1" fill="currentColor" stroke="none"/></svg>',
  };

  // A colour of its own for an album without a picture (the same album always gets the same one).
  const hue = (str) => { let x = 0; for (const c of String(str || '')) x = (x * 31 + c.charCodeAt(0)) >>> 0; return x % 360; };
  /** A sleeve for an album with no cover picture: its own colour, the title and artist set like a record label. */
  function generatedSleeve(a, small) {
    const hh = hue((a && (a.key || a.title)) || '');
    return h('div', { class: 'cover-gen' + (small ? ' small' : ''), style: `--h:${hh}` },
      h('div', { class: 'cg-rings' }),
      small ? null : h('div', { class: 'cg-text' },
        h('div', { class: 'cg-title' }, (a && a.title) || ''),
        h('div', { class: 'cg-artist' }, (a && a.artist) || '')));
  }
  /** The record itself: grooves, a shine, and the album's cover (or colour) as its centre label. */
  const VINYL_KINDS = ['black', 'color', 'color', 'marble', 'clear', 'color', 'black', 'split'];
  function vinyl(a, extra) {
    const seed = hue(((a && (a.key || a.title)) || '') + '#record');
    const kind = VINYL_KINDS[seed % VINYL_KINDS.length];
    const label = a && a.art ? h('img', { src: fileUrl(a.art), alt: '', draggable: 'false' }) : h('div', { class: 'vl-gen', style: `--h:${hue((a && (a.key || a.title)) || '')}` });
    return h('div', { class: `vinyl v-${kind} ${extra || ''}`, style: `--vh:${(seed * 7) % 360}` },
      h('div', { class: 'vinyl-shine' }), h('div', { class: 'vinyl-label' }, label, h('i', { class: 'vinyl-hole' })));
  }
  function cover(a, size) {
    const box = h('div', { class: `cover ${size || ''}` });
    if (a && a.art) box.append(h('img', { src: fileUrl(a.art), alt: '', loading: 'lazy', draggable: 'false' }));
    else box.append(generatedSleeve(a, /tiny/.test(size || '')));
    // the album's moving cover (cover.mp4 in its folder) plays over the still one on the album page and in
    // Now Playing, silently and on a loop; if it can't play, the still cover stays
    if (a && a.motion && /big|huge/.test(size || '')) box.append(motion(a));
    box.append(h('div', { class: 'gloss' }));
    return box;
  }
  function motion(a) {
    const v = h('video', { class: 'motion', src: fileUrl(a.motion), loop: '', playsinline: '', 'webkit-playsinline': '', preload: 'auto', disablepictureinpicture: '', 'aria-hidden': 'true' });
    v.muted = true; v.defaultMuted = true; v.autoplay = true;
    v.addEventListener('playing', () => v.classList.add('on'));
    v.addEventListener('error', () => v.remove());
    // Ask to play straight away too: this runs inside the tap that opened the album, and a tap lets a video
    // start even when the phone holds back autoplay (Low Power Mode). Then again once it's in the page.
    try { const p0 = v.play(); if (p0 && p0.catch) p0.catch(() => {}); } catch {}
    v.addEventListener('canplay', () => { if (v.paused) { const p1 = v.play(); if (p1 && p1.catch) p1.catch(() => {}); } }, { once: true });
    requestAnimationFrame(() => { const p = v.play && v.play(); if (p && p.catch) p.catch(() => {}); });
    return v;
  }
  /** Album card artwork: just the cover (Parlor dropped the record-sleeve look). */
  function sleeve(a) {
    return cover(a);
  }

  async function load() {
    if (!loading) loading = api.parlorState().then((s) => { P = s; loading = null; drawMeButton(); refreshFriends(); return s; });
    return loading;
  }
  async function refresh() { P = await api.parlorState(); render(); }

  // ---- views -------------------------------------------------------------------------------------------
  function albumCard(a) {
    return h('button', { class: 'card pcard', 'data-key': a.key, title: `${a.title} — ${a.artist}`, onclick: () => openAlbum(a.key) },
      sleeve(a), h('div', { class: 'pcard-t' }, a.title), h('div', { class: 'pcard-s' }, a.artist));
  }
  /** A pinned album on Home in the Parlor app: small, like an app on a phone's home screen. */
  function pinTile(a) {
    return h('button', { class: 'ptile', 'data-key': a.key, title: `${a.title} — ${a.artist}`, onclick: () => openAlbum(a.key) },
      cover(a, 'tiny'), h('span', { class: 'ptile-t' }, a.title));
  }
  function playlistCard(pl) {
    const arts = [...new Set(pl.tracks.map((id) => (track(id) || {}).albumKey))].map(album).filter((a) => a && a.art).slice(0, 4);
    const mosaic = h('div', { class: 'cover mosaic' + (arts.length >= 4 ? ' four' : '') },
      ...(arts.length >= 4 ? arts : arts.slice(0, 1)).map((a) => h('img', { src: fileUrl(a.art), alt: '' })),
      arts.length ? null : h('div', { class: 'cover-blank list' }, h('span', {}, '≡')));
    return h('button', { class: 'card pcard', 'data-key': 'pl:' + pl.id, title: pl.name, onclick: () => go('playlist:' + pl.id) },
      mosaic, h('div', { class: 'pcard-t' }, pl.name), h('div', { class: 'pcard-s' }, plural(pl.tracks.length, 'song')));
  }
  // the library's songs, one per place in each album (an album there in stereo and in spatial audio: the version it plays)
  const libIds = () => P.albums.flatMap((a) => a.tracks);
  // Spatial Audio: Dolby Atmos and other surround songs, whichever version their album plays
  const isSpatial = (t) => !!t && (!!t.atmos || (t.channels || 0) > 2);
  const spatialIds = () => P.albums.flatMap((a) => (a.spatial || a.tracks).filter((id) => isSpatial(track(id))));
  const row = (title, cards) => (cards.length ? h('section', { class: 'row' }, h('h2', {}, title), h('div', { class: 'strip' }, cards)) : null);
  const grid = (cards) => h('div', { class: 'grid pgrid' }, cards);
  const page = (title, ...kids) => main.replaceChildren(h('div', { class: 'ppage' }, title ? h('h1', { class: 'page-title' }, title) : null, ...kids));

  function renderEmpty() {
    page(null, h('div', { class: 'pempty' },
      svg(cdIcon(), 'big-cd'),
      h('h1', {}, 'Welcome to the Parlor'),
      P.canManage
        ? (ctx.isIOS && ctx.isIOS()
          ? [h('p', {}, `Your music library is empty. Put albums in Screenroom’s Music folder (Files app › On My ${ctx.device ? ctx.device() : 'iPad'} › ${ctx.appName || 'Screenroom'}, Finder on a Mac, or AirDrop), or import them.`),
              h('button', { class: 'btn primary', onclick: async () => { const r = await api.parlorAddDir(null); if (r.ok) { P = r.state; render(); } else ctx.flash(r.error); } }, 'Import music…')]
          : [h('p', {}, 'Your music library is empty. Add the folder your music is in: albums found there are yours, and you can share any album with other profiles.'),
              h('button', { class: 'btn primary', onclick: () => ctx.openSettings('parlor') }, 'Add music')])
        : h('p', {}, 'No music yet. Ask a grown-up to share some albums with you.')));
  }

  function renderHome() {
    const pinned = (P.pinned || []).map(album).filter(Boolean);
    const recent = P.recent.map(album).filter(Boolean);
    const added = P.albums.slice().sort((a, b) => b.added - a.added).slice(0, 20);
    page(null,
      h('div', { class: 'phead' }, h('h1', {}, 'Parlor'), h('div', { class: 'pstats' },
        `${plural(P.albums.length, 'album')} · ${plural(libIds().length, 'song')}`)),
      h('div', { class: 'rows' },
        // favourites, pinned from their album pages
        pinned.length ? (ctx.standalone
          ? h('section', { class: 'row prow-pins' }, h('h2', {}, 'Pinned'), h('div', { class: 'ptiles' }, pinned.map(pinTile)))
          : row('Pinned', pinned.map(albumCard))) : null,
        ctx.albumRecs ? row('Recommended for You', (() => {
          const seen = new Set();
          return ctx.albumRecs().map((x) => ({ ...x, a: album(x.rec.key) })).filter((x) => x.a && !seen.has(x.a.key) && seen.add(x.a.key)).map((x) => {
            const c = albumCard(x.a);
            c.append(h('div', { class: 'card-from' }, ctx.avatar(x.from), `from ${x.from.name}`));
            return c;
          });
        })()) : null,
        ctx.standalone ? row('Made for Today', dailyMixes().map(mixCard)) : null,
        row('Recently Played', recent.map(albumCard)),
        row('Recently Added', added.map(albumCard)),
        row('Playlists', P.playlists.map(playlistCard)),
        h('section', { class: 'row' }, h('h2', {}, 'All Albums'), grid(P.albums.map(albumCard)))));
  }

  function artists() {
    const m = new Map();
    for (const a of P.albums) { if (!m.has(a.artist)) m.set(a.artist, []); m.get(a.artist).push(a); }
    return [...m.entries()].sort((x, y) => x[0].localeCompare(y[0]));
  }
  function renderArtists() {
    page('Artists', grid(artists().map(([name, list]) =>
      h('button', { class: 'card pcard artist', 'data-key': 'ar:' + name, title: name, onclick: () => go('artist:' + name) },
        cover(list.find((a) => a.art) || list[0], 'round'), h('div', { class: 'pcard-t' }, name), h('div', { class: 'pcard-s' }, plural(list.length, 'album'))))));
  }
  function renderArtist(name) {
    const list = P.albums.filter((a) => a.artist === name).sort((a, b) => (a.year || 0) - (b.year || 0));
    const ids = list.flatMap((a) => a.tracks);
    page(name, h('div', { class: 'btns pbtns' },
      h('button', { class: 'btn primary', onclick: () => playIds(ids, 0, { kind: 'artist', name }) }, svg(ICON.play), 'Play'),
      h('button', { class: 'btn secondary', onclick: () => playIds(shuffle(ids), 0, { kind: 'artist', name }) }, svg(ICON.shuffle), 'Shuffle')),
    grid(list.map(albumCard)));
  }

  // The classic striped song list (Name · Time · Artist · Album · Genre).
  function songTable(ids, { context, removable, numbered } = {}) {
    const cur = P.player && P.player.track && P.player.track.id;
    return h('table', { class: 'songs' },
      h('thead', {}, h('tr', {}, numbered ? h('th', { class: 'n' }, '#') : null, h('th', {}, 'Name'), h('th', { class: 't' }, 'Time'),
        h('th', { class: 'ar' }, 'Artist'), h('th', { class: 'al' }, 'Album'), h('th', { class: 'g' }, 'Genre'), h('th', { class: 'x' }, ''))),
      h('tbody', {}, ids.map((id, i) => {
        const t = track(id);
        if (!t) return null;
        return h('tr', { class: 'srow' + (id === cur ? ' now' : ''), tabindex: '0', 'data-id': id,
          onclick: (e) => { if (e.target.closest('.rowbtn')) return; playIds(ids, i, context); } },
          numbered ? h('td', { class: 'n' }, i + 1) : null,
          h('td', { class: 'nm' }, h('span', { class: 'nm-t' }, t.title, t.explicit ? h('span', { class: 'e' }, 'E') : null), h('small', { class: 'nm-s' }, `${t.artist} — ${t.album}`)), h('td', { class: 't' }, mmss(t.duration)),
          h('td', { class: 'ar' }, t.artist), h('td', { class: 'al' }, t.album), h('td', { class: 'g' }, t.genre || ''),
          h('td', { class: 'x' }, removable
            ? h('button', { class: 'rowbtn', title: 'Remove from playlist', onclick: () => removable(i) }, '✕')
            : h('button', { class: 'rowbtn', title: 'Add to a playlist', onclick: () => pickPlaylist([id]) }, '+')));
      })));
  }
  function renderSongs() {
    const ids = libIds().map(track).filter(Boolean).sort((a, b) => a.artist.localeCompare(b.artist) || a.album.localeCompare(b.album) || (a.disc - b.disc) || (a.track - b.track)).map((t) => t.id);
    const ctxs = { kind: 'songs', name: 'Songs' };
    page('Songs',
      ids.length ? h('div', { class: 'btns pbtns' },
        h('button', { class: 'btn primary', onclick: () => playIds(ids, 0, ctxs) }, svg(ICON.play), 'Play'),
        h('button', { class: 'btn secondary', onclick: () => playIds(shuffle(ids), 0, ctxs) }, svg(ICON.shuffle), 'Shuffle')) : null,
      songTable(ids, { context: ctxs }));
  }
  // Spatial Audio: just the Dolby Atmos (and other surround) songs, and the albums they're on
  function renderSpatial() {
    const ids = spatialIds().map(track).filter(Boolean)
      .sort((a, b) => a.artist.localeCompare(b.artist) || a.album.localeCompare(b.album) || (a.disc - b.disc) || (a.track - b.track)).map((t) => t.id);
    const keys = new Set(ids.map((id) => track(id).albumKey));
    const albums = P.albums.filter((a) => keys.has(a.key));
    const atmos = ids.filter((id) => track(id).atmos).length;
    const dur = ids.reduce((s, id) => s + (track(id).duration || 0), 0);
    const ctxs = { kind: 'spatial', name: 'Spatial Audio' };
    if (!ids.length) return page('Spatial Audio', h('p', { class: 'pnote' }, 'No Dolby Atmos or surround songs yet. Albums in spatial audio show up here when they’re added.'));
    page('Spatial Audio',
      h('div', { class: 'pstats' }, `${plural(ids.length, 'song')}${atmos && atmos < ids.length ? ` (${atmos} in Dolby Atmos)` : atmos ? ' in Dolby Atmos' : ''} · ${longDur(dur)}`),
      h('div', { class: 'btns pbtns' },
        h('button', { class: 'btn primary', onclick: () => playIds(ids, 0, ctxs) }, svg(ICON.play), 'Play'),
        h('button', { class: 'btn secondary', onclick: () => playIds(shuffle(ids), 0, ctxs) }, svg(ICON.shuffle), 'Shuffle')),
      h('div', { class: 'rows' }, row('Albums', albums.map(albumCard)),
        h('section', { class: 'row' }, h('h2', {}, 'Songs'), songTable(ids, { context: ctxs })), ));
  }
  // ---- made for today: a few mixes from the library, new each day (the same all day) ----------------------
  // From what's been played lately, the genres there's most of, albums not played in a while, and spatial audio.
  const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
  function seeded(str) {
    let x = 2166136261 >>> 0;
    for (const c of str) x = Math.imul(x ^ c.charCodeAt(0), 16777619) >>> 0;
    return () => { x = (x + 0x6D2B79F5) >>> 0; let t = x; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const seededShuffle = (arr, rnd) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  /** n songs from these albums' songs, no more than `per` from one album, in a mixed-up order. */
  function pickFrom(albums, n, rnd, per = 2) {
    const out = [];
    const pools = seededShuffle(albums, rnd).map((a) => seededShuffle(a.tracks.filter((id) => track(id)), rnd).slice(0, per));
    for (let round = 0; round < per && out.length < n; round++) for (const p of pools) { if (p[round] && out.length < n) out.push(p[round]); }
    return seededShuffle(out, rnd);
  }
  let mixCache = null;
  function dailyMixes() {
    const day = todayKey();
    const sig = `${day}|${P.profile}|${P.albums.length}|${(P.recent || []).join(',')}`;
    if (mixCache && mixCache.sig === sig) return mixCache.mixes;
    const mixes = [];
    const R = (id) => seeded(`${day}|${P.profile}|${id}`);
    const recent = (P.recent || []).map(album).filter(Boolean);
    const inLists = new Set(P.playlists.flatMap((pl) => pl.tracks.map((id) => (track(id) || {}).albumKey)));
    const loved = [...new Set([...recent, ...P.albums.filter((a) => inLists.has(a.key)), ...(P.pinned || []).map(album).filter(Boolean)])];
    if (P.albums.length >= 3) {
      // what's been on lately, with some of the rest for company
      const rnd = R('today');
      const base = loved.length ? loved : P.albums;
      const fav = pickFrom(base, 16, rnd, Math.min(5, Math.max(2, Math.ceil(16 / base.length))));
      const rest = pickFrom(P.albums.filter((a) => !loved.includes(a)), 9, rnd, 1);
      const ids = seededShuffle([...new Set([...fav, ...rest])], rnd);
      if (ids.length >= 5) mixes.push({ id: 'today', name: 'Today’s Mix', blurb: 'What you’ve had on lately, and some of the rest', ids });
    }
    // a mix for each of the genres there's most of
    const byGenre = new Map();
    for (const a of P.albums) { const g = (a.genre || '').trim(); if (g) { if (!byGenre.has(g)) byGenre.set(g, []); byGenre.get(g).push(a); } }
    const genres = [...byGenre.entries()].filter(([, l]) => l.length >= 2).sort((a, b) => b[1].length - a[1].length).slice(0, 3);
    for (const [g, list] of genres) {
      const ids = pickFrom(list, 20, R('g:' + g), 3);
      if (ids.length >= 5) mixes.push({ id: 'g:' + g, name: `${g} Mix`, blurb: `${g} from across your library`, ids });
    }
    // albums not played lately (or ever)
    const played = new Set((P.recent || []));
    const quiet = P.albums.filter((a) => !played.has(a.key));
    if (quiet.length >= 3 && quiet.length < P.albums.length) {
      const ids = pickFrom(quiet, 20, R('rediscover'), 2);
      if (ids.length >= 5) mixes.push({ id: 'rediscover', name: 'Rediscover', blurb: 'From albums you haven’t played in a while', ids });
    }
    // spatial audio
    const sp = spatialIds();
    if (sp.length >= 5) {
      const byAlbum = new Map();
      for (const id of sp) { const k = track(id).albumKey; if (!byAlbum.has(k)) byAlbum.set(k, []); byAlbum.get(k).push(id); }
      const ids = pickFrom([...byAlbum.entries()].map(([key, t]) => ({ key, tracks: t })), 20, R('spatial'), 3);
      mixes.push({ id: 'spatial', name: 'Spatial Mix', blurb: 'Dolby Atmos and surround', ids });
    }
    mixCache = { sig, mixes };
    return mixes;
  }
  function mixCard(m) {
    const arts = [...new Set(m.ids.map((id) => (track(id) || {}).albumKey))].map(album).filter((a) => a && a.art).slice(0, 4);
    const mosaic = h('div', { class: 'cover mosaic mixcover' + (arts.length >= 4 ? ' four' : '') },
      ...(arts.length >= 4 ? arts : arts.slice(0, 1)).map((a) => h('img', { src: fileUrl(a.art), alt: '' })),
      arts.length ? null : h('div', { class: 'cover-blank list' }, h('span', {}, '♫')),
      h('span', { class: 'mix-name' }, m.name));
    return h('button', { class: 'card pcard', 'data-key': 'mix:' + m.id, title: m.name, onclick: () => go('mix:' + m.id) },
      mosaic, h('div', { class: 'pcard-s' }, `${plural(m.ids.length, 'song')} · ${m.blurb}`));
  }
  function renderMix(id) {
    const m = dailyMixes().find((x) => x.id === id);
    if (!m) return go('home');
    const dur = m.ids.reduce((s, t) => s + ((track(t) || {}).duration || 0), 0);
    const ctxm = { kind: 'mix', id: m.id, name: m.name };
    page(m.name,
      h('div', { class: 'pstats' }, `${m.blurb} · ${plural(m.ids.length, 'song')} · ${longDur(dur)} · a new one tomorrow`),
      h('div', { class: 'btns pbtns' },
        h('button', { class: 'btn primary', onclick: () => playIds(m.ids, 0, ctxm) }, svg(ICON.play), 'Play'),
        h('button', { class: 'btn secondary', onclick: () => playIds(shuffle(m.ids), 0, ctxm) }, svg(ICON.shuffle), 'Shuffle'),
        h('button', { class: 'btn secondary', onclick: () => nameDialog('Keep as a Playlist', `${m.name} (${new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' })})`, 'Keep', async (name) => {
          const r = await api.playlistCreate(name, m.ids);
          if (!r.ok) { ctx.flash(r.error); return; }
          P = r.state; closeOverlay(); ctx.flash(`Kept as ${name}`);
        }) }, 'Keep as Playlist')),
      songTable(m.ids, { context: ctxm, numbered: true }));
  }
  // ---- friends (the Parlor app on phones, iPad, Mac and Windows; not the TV box) ---------------------------
  // A friend profile lives on Parlor's friends service (friends/worker.js): a name, a picture, a friend code and
  // the song or album you choose to show. Friends are added by code, and see each other's picture and pick.
  const FR = { me: null, friends: [], incoming: [], outgoing: [], error: '', loading: false, at: 0 };
  const FRIEND_COLORS = ['#2f80ed', '#3cc4c4', '#27ae60', '#f2c94c', '#9b51e0', '#f2994a', '#eb5757', '#b5523a'];
  const friendsOn = () => !!(ctx.standalone && window.FRIENDS_URL);
  const acct = () => { const all = (ctx.config && ctx.config().friends) || {}; return all[P ? P.profile : ''] || null; };
  async function saveAcct(a) {
    const all = { ...((ctx.config && ctx.config().friends) || {}) };
    if (a) all[P.profile] = a; else delete all[P.profile];
    await ctx.setConfig({ friends: all });
  }
  async function fr(method, path, body) {
    const a = acct();
    let r;
    try {
      r = await fetch(window.FRIENDS_URL.replace(/\/$/, '') + path, { method, headers: { 'Content-Type': 'application/json', ...(a ? { Authorization: 'Bearer ' + a.token } : {}) },
        body: body ? JSON.stringify(body) : undefined });
    } catch { return { ok: false, error: 'Couldn’t reach the friends service. Are you online?' }; }
    let j = null; try { j = await r.json(); } catch {}
    if (r.status === 401 && a) { await saveAcct(null); Object.assign(FR, { me: null, friends: [], incoming: [], outgoing: [] }); }
    return j || { ok: false, error: `The friends service didn’t answer properly (${r.status}).` };
  }
  function took(j) {
    if (!j || !j.ok) { FR.error = (j && j.error) || 'Something went wrong.'; return false; }
    if (j.me) Object.assign(FR, { me: j.me, friends: j.friends || [], incoming: j.incoming || [], outgoing: j.outgoing || [], error: '', at: Date.now() });
    drawMeButton();
    return true;
  }
  async function refreshFriends() {
    // (another profile on this computer: its own friend profile)
    if (P && FR.pid !== P.profile) { Object.assign(FR, { pid: P.profile, me: null, friends: [], incoming: [], outgoing: [], error: '', at: 0 }); drawMeButton(); }
    if (!friendsOn() || !acct() || FR.loading) return;
    FR.loading = true;
    try { took(await fr('GET', '/v1/me')); } finally { FR.loading = false; }
    if (view === 'profile') render();
  }
  const youAvatar = (p, big) => ctx.avatar({ name: (p && p.name) || '?', color: (p && p.color) || '#2f80ed', avatar: (p && p.avatar) || '', photo: (p && p.photo) || '' }, big);
  /** A picture of your own: the phone's or computer's picture chooser, then a small square copy (a data: URL), or '' */
  function choosePhoto() {
    return new Promise((resolve) => {
      const inp = h('input', { type: 'file', accept: 'image/*', style: 'position:fixed;left:-9999px;opacity:0' });
      let done = false;
      const finish = (v) => { if (done) return; done = true; inp.remove(); resolve(v); };
      inp.addEventListener('change', async () => {
        const f = inp.files && inp.files[0];
        if (!f) return finish('');
        try {
          // (read as a data: URL: the page's rules allow pictures from those, not from blob: addresses)
          const url = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(f); });
          const img = new Image(); img.src = url; await img.decode();
          const c = document.createElement('canvas'); c.width = c.height = 256;
          const s = Math.min(img.naturalWidth, img.naturalHeight);
          c.getContext('2d').drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, 256, 256);
          let q = 0.82, out = c.toDataURL('image/jpeg', q);
          while (out.length > 85000 && q > 0.4) { q -= 0.12; out = c.toDataURL('image/jpeg', q); }
          finish(out);
        } catch { ctx.flash('That picture couldn’t be opened. Try another one.'); finish(''); }
      });
      inp.addEventListener('cancel', () => finish(''));
      document.body.append(inp);
      inp.click();
    });
  }
  /** The pictures to pick from: your initial (when there's a name), your photo, the characters, and "+ Photo" */
  function picChoices(d, name, redraw) {
    const pic = (on, title, onclick, face) => h('button', { class: 'pic' + (on ? ' on' : ''), title, 'aria-label': title, 'aria-pressed': on ? 'true' : 'false', onclick }, face);
    return [
      name ? pic(!d.avatar, 'Initial', () => { d.avatar = ''; redraw(); }, ctx.avatar({ name, color: d.color })) : null,
      d.photo ? pic(d.avatar === 'photo', 'Your photo', () => { d.avatar = 'photo'; redraw(); }, ctx.avatar({ name: '', color: d.color, avatar: 'photo', photo: d.photo })) : null,
      ...(window.Avatars ? window.Avatars.list : []).map((c) => pic(d.avatar === 'char:' + c.id, c.name, () => { d.avatar = 'char:' + c.id; redraw(); },
        ctx.avatar({ name: c.name, color: d.color, avatar: 'char:' + c.id }))),
      h('button', { class: 'pic pic-add', title: d.photo ? 'Choose a different photo' : 'Use a photo of your own', 'aria-label': d.photo ? 'Choose a different photo' : 'Use a photo of your own',
        onclick: async () => { const ph = await choosePhoto(); if (ph) { d.photo = ph; d.avatar = 'photo'; redraw(); } } },
        h('span', { class: 'avatar pic-add-face' }, h('span', { class: 'pic-add-ico', 'aria-hidden': 'true' }, '+'), h('small', {}, 'Photo')))];
  }

  // the round button in the top bar: your picture (a dot when someone wants to be friends)
  let meBtn = null;
  function drawMeButton() {
    if (!friendsOn()) { if (meBtn) meBtn.hidden = true; return; }
    if (!meBtn) {
      meBtn = h('button', { id: 'me-btn', title: 'Profile and friends', 'aria-label': 'Profile and friends', onclick: () => go('profile') });
      const sb = $('#settings-btn'); sb && sb.parentElement.insertBefore(meBtn, sb);
    }
    meBtn.hidden = false;
    meBtn.replaceChildren(FR.me ? youAvatar(FR.me) : svg('<svg viewBox="0 0 24 24"><circle cx="12" cy="8.5" r="3.6" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M5 20c.8-3.6 3.6-5.6 7-5.6s6.2 2 7 5.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>', 'ico me-ico'),
      FR.incoming.length ? h('span', { class: 'me-dot', 'aria-label': `${FR.incoming.length} friend request${FR.incoming.length > 1 ? 's' : ''}` }) : null);
  }

  /** A small copy of a cover for the friends service (a data: URL), or '' */
  async function artThumb(a) {
    if (!a || !a.art) return '';
    if (api.artThumb) { try { return (await api.artThumb(a.art)) || ''; } catch { return ''; } }
    try {
      const img = new Image(); img.crossOrigin = 'anonymous'; img.src = fileUrl(a.art);
      await img.decode();
      const c = document.createElement('canvas'); c.width = c.height = 160;
      const s = Math.min(img.naturalWidth, img.naturalHeight);
      c.getContext('2d').drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, 160, 160);
      return c.toDataURL('image/jpeg', 0.8);
    } catch { return ''; }
  }
  const showcaseArt = (s, cls) => (s && s.art ? h('img', { class: cls || 'sc-art', src: s.art, alt: '' })
    : h('div', { class: (cls || 'sc-art') + ' sc-gen', style: `--h:${hue((s && s.title) || '')}` }, h('span', {}, s && s.kind === 'song' ? '♪' : '◉')));
  function showcaseLine(s, empty) {
    if (!s) return h('div', { class: 'sc sc-none' }, empty || 'Nothing chosen yet');
    return h('div', { class: 'sc' }, showcaseArt(s), h('div', { class: 'sc-txt' },
      h('div', { class: 'sc-k' }, s.kind === 'song' ? 'Song' : 'Album'), h('div', { class: 'sc-t' }, s.title),
      h('div', { class: 'sc-s' }, [s.artist, s.kind === 'song' ? s.album : s.year].filter(Boolean).join(' · '))));
  }

  // Your picture (tap it): the picture and colour, and the song or album your friends see
  function editMe() {
    const d = { avatar: FR.me.avatar || '', color: FR.me.color || '#2f80ed', photo: FR.me.photo || '' };
    const pics = h('div', { class: 'pics fr-pics' }), sw = h('div', { class: 'swatches' });
    const drawPics = () => pics.replaceChildren(...picChoices(d, FR.me.name, drawPics));
    const drawSw = () => sw.replaceChildren(...FRIEND_COLORS.map((c) => h('button', { class: 'swatch' + (c === d.color ? ' on' : ''), style: `background:${c}`, title: c, onclick: () => { d.color = c; drawSw(); drawPics(); } })));
    drawPics(); drawSw();
    // what to show: search the library
    const q = h('input', { type: 'search', class: 'pname-input fr-q', placeholder: 'Search your albums and songs', autocomplete: 'off' });
    const list = h('div', { class: 'pick-list fr-pick' });
    let chosen = FR.me.showcase || null;
    const cur = h('div', {});
    const drawCur = () => cur.replaceChildren(showcaseLine(chosen, 'Nothing: your friends just see your name and picture'));
    const choose = async (o) => { chosen = o; drawCur(); };
    const drawList = () => {
      const s = q.value.trim().toLowerCase();
      const albums = P.albums.filter((a) => !s || `${a.title} ${a.artist}`.toLowerCase().includes(s)).slice(0, s ? 30 : 12);
      const songs = s ? libIds().map(track).filter((t) => t && `${t.title} ${t.artist}`.toLowerCase().includes(s)).slice(0, 30) : [];
      list.replaceChildren(
        h('button', { class: 'btn secondary', onclick: () => choose(null) }, 'Show nothing'),
        ...albums.map((a) => h('button', { class: 'btn secondary fr-opt', onclick: async () => choose({ kind: 'album', title: a.title, artist: a.artist, year: a.year || null, art: await artThumb(a), key: a.key }) },
          cover(a, 'tiny'), h('span', {}, h('b', {}, a.title), h('small', {}, ` Album · ${a.artist}`)))),
        ...songs.map((t) => h('button', { class: 'btn secondary fr-opt', onclick: async () => choose({ kind: 'song', title: t.title, artist: t.artist, album: t.album, art: await artThumb(album(t.albumKey)) }) },
          cover(album(t.albumKey), 'tiny'), h('span', {}, h('b', {}, t.title), h('small', {}, ` Song · ${t.artist}`)))));
    };
    q.addEventListener('input', drawList);
    drawList(); drawCur();
    overlay('fr-edit',
      h('h2', {}, 'Your picture'), pics, sw,
      h('h2', { class: 'fr-h2' }, 'Showing to friends'), cur, q, list,
      h('div', { class: 'btns' },
        h('button', { class: 'btn primary', onclick: async () => {
          const sc = chosen ? { kind: chosen.kind, title: chosen.title, artist: chosen.artist, album: chosen.album || '', year: chosen.year || null, art: chosen.art || '' } : null;
          const ok = took(await fr('PUT', '/v1/me', { avatar: d.avatar, color: d.color, showcase: sc, ...(d.avatar === 'photo' ? { photo: d.photo } : {}) }));
          if (!ok) { ctx.flash(FR.error); return; }
          closeOverlay(); render();
        } }, 'Save'),
        h('button', { class: 'btn secondary', onclick: closeOverlay }, 'Cancel')));
  }

  // A friend (tap them): what they're showing, and remove / block / report
  function friendSheet(f) {
    overlay('fr-friend',
      h('div', { class: 'fr-who' }, youAvatar(f, true), h('h2', {}, f.name)),
      showcaseLine(f.showcase, `${f.name} isn’t showing anything right now`),
      h('div', { class: 'btns fr-acts' },
        h('button', { class: 'btn secondary', onclick: async () => {
          if (!(await ctx.confirm(`Remove ${f.name}?`, 'You’ll stop seeing each other. You can add each other again with your codes.', 'Remove', 'Cancel', true))) return;
          took(await fr('DELETE', `/v1/friends/${f.id}`)); closeOverlay(); render();
        } }, 'Remove Friend'),
        h('button', { class: 'btn secondary danger', onclick: async () => {
          if (!(await ctx.confirm(`Block ${f.name}?`, 'They’re removed and can’t send you requests, even with your code.', 'Block', 'Cancel', true))) return;
          took(await fr('POST', `/v1/friends/${f.id}/block`)); closeOverlay(); render();
        } }, 'Block'),
        h('button', { class: 'btn secondary danger', onclick: () => reportSheet(f) }, 'Report…'),
        h('button', { class: 'btn secondary', onclick: closeOverlay }, 'Close')));
  }
  function reportSheet(f) {
    const why = h('textarea', { class: 'pname-input fr-why', rows: '3', maxlength: '500', placeholder: 'What’s wrong (their name, picture or what they’re showing)?' });
    const block = h('input', { type: 'checkbox', checked: true });
    overlay('fr-report', h('h2', {}, `Report ${f.name}`), why,
      h('label', { class: 'row-set' }, h('span', {}, 'Block them too'), block),
      h('div', { class: 'btns' },
        h('button', { class: 'btn primary', onclick: async () => {
          const r = await fr('POST', `/v1/friends/${f.id}/report`, { reason: why.value });
          if (!r.ok) { ctx.flash(r.error); return; }
          if (block.checked) took(await fr('POST', `/v1/friends/${f.id}/block`));
          closeOverlay(); ctx.flash('Thanks. The report was sent.'); render();
        } }, 'Send Report'),
        h('button', { class: 'btn secondary', onclick: closeOverlay }, 'Cancel')));
  }

  async function shareCode() {
    const code = FR.me.code, text = `Add me on Parlor: my friend code is ${code}`;
    try { if (navigator.share) { await navigator.share({ text }); return; } } catch (e) { if (e && e.name === 'AbortError') return; }
    try { await navigator.clipboard.writeText(code); ctx.flash(`Copied ${code}`); return; } catch {}
    ctx.flash(`Your code: ${code}`);
  }

  function renderProfile() {
    if (!friendsOn()) return page('Profile', h('p', { class: 'pnote' }, 'Friends aren’t switched on in this version of Parlor yet.'));
    if (!acct()) {
      // set up a friend profile
      const d = { avatar: '', photo: '', color: FRIEND_COLORS[hue(String(Date.now())) % FRIEND_COLORS.length] };
      const name = h('input', { type: 'text', class: 'pname-input fr-name', maxlength: '40', placeholder: 'Your name (what friends see)', autocomplete: 'off' });
      const pics = h('div', { class: 'pics fr-pics' });
      const drawPics = () => pics.replaceChildren(...picChoices(d, '', drawPics));
      drawPics();
      const go1 = h('button', { class: 'btn primary', onclick: async () => {
        if (!name.value.trim()) { name.focus(); ctx.flash('Give your profile a name.'); return; }
        go1.disabled = true;
        const r = await fr('POST', '/v1/register', { name: name.value.trim(), avatar: d.avatar, color: d.color, ...(d.avatar === 'photo' ? { photo: d.photo } : {}) });
        go1.disabled = false;
        if (!r.ok) { ctx.flash(r.error); return; }
        await saveAcct({ id: r.id, token: r.token });
        await refreshFriends(); render();
      } }, 'Make My Profile');
      return page('Profile', h('div', { class: 'fr-setup' },
        h('p', { class: 'pnote' }, 'Make a friend profile to swap codes with friends and show them a song or album you love.'),
        h('h3', {}, 'Pick a picture'), pics, name, h('div', { class: 'btns pbtns' }, go1),
        h('p', { class: 'pnote small' }, 'Friends you accept see your name, picture and the song or album you choose. Nothing else from your library leaves this device.')));
    }
    if (!FR.me) {
      refreshFriends();
      return page('Profile', h('p', { class: 'pnote' }, FR.error || 'Loading your friends…'));
    }
    const me = FR.me;
    const add = h('input', { type: 'text', class: 'pname-input fr-add', maxlength: '12', placeholder: 'Their code, like 7KQ2-M9XD', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false' });
    const doAdd = async () => {
      if (!add.value.trim()) { add.focus(); return; }
      const ok = took(await fr('POST', '/v1/friends', { code: add.value }));
      if (!ok) { ctx.flash(FR.error); return; }
      ctx.flash('Request sent'); render();
    };
    add.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); doAdd(); } });
    const person = (p, ...extra) => h('div', { class: 'fr-row' }, youAvatar(p), h('span', { class: 'fr-n' }, p.name), h('span', { class: 'fr-x' }, ...extra));
    page(null,
      h('div', { class: 'fr-head' },
        h('button', { class: 'fr-me-pic', title: 'Change your picture and what you’re showing', onclick: editMe }, youAvatar(me, true), h('span', { class: 'fr-edit-badge' }, 'Edit')),
        h('div', { class: 'fr-me-txt' },
          h('h1', { class: 'fr-me-name' }, me.name),
          h('div', { class: 'fr-code' }, 'Friend code ', h('b', {}, me.code)),
          h('div', { class: 'btns fr-code-btns' },
            h('button', { class: 'btn secondary', onclick: shareCode }, navigator.share ? 'Share Code' : 'Copy Code'),
            h('button', { class: 'btn secondary', onclick: () => nameDialog('Your Name', me.name, 'Save', async (nm) => { if (took(await fr('PUT', '/v1/me', { name: nm }))) { closeOverlay(); render(); } else ctx.flash(FR.error); }) }, 'Rename'),
            h('button', { class: 'btn secondary', onclick: async () => {
              if (!(await ctx.confirm('Get a new friend code?', 'Your old code stops working. Friends you have stay friends.', 'New Code', 'Cancel'))) return;
              took(await fr('POST', '/v1/me/code')); render();
            } }, 'New Code')))),
      h('section', { class: 'row fr-sec' }, h('h2', {}, 'Showing to friends'),
        h('button', { class: 'fr-show', onclick: editMe }, showcaseLine(me.showcase, 'Nothing yet. Tap to pick a song or album.'))),
      h('section', { class: 'row fr-sec' }, h('h2', {}, 'Add a friend'), h('div', { class: 'fr-addrow' }, add, h('button', { class: 'btn primary', onclick: doAdd }, 'Add'))),
      FR.incoming.length ? h('section', { class: 'row fr-sec' }, h('h2', {}, 'Requests'),
        ...FR.incoming.map((p) => person(p,
          h('button', { class: 'btn primary', onclick: async () => { took(await fr('POST', `/v1/friends/${p.id}/accept`)); render(); } }, 'Accept'),
          h('button', { class: 'btn secondary', onclick: async () => { took(await fr('POST', `/v1/friends/${p.id}/decline`)); render(); } }, 'Decline'),
          h('button', { class: 'btn secondary danger', title: 'Block', onclick: async () => { took(await fr('POST', `/v1/friends/${p.id}/block`)); render(); } }, 'Block')))) : null,
      FR.outgoing.length ? h('section', { class: 'row fr-sec' }, h('h2', {}, 'Waiting for'),
        ...FR.outgoing.map((p) => person(p, h('button', { class: 'btn secondary', onclick: async () => { took(await fr('DELETE', `/v1/friends/${p.id}`)); render(); } }, 'Cancel')))) : null,
      h('section', { class: 'row fr-sec' }, h('h2', {}, FR.friends.length ? `Friends (${FR.friends.length})` : 'Friends'),
        FR.friends.length ? h('div', { class: 'fr-grid' }, FR.friends.map((f) => h('button', { class: 'fr-card', 'data-key': 'fr:' + f.id, title: f.name, onclick: () => friendSheet(f) },
          h('div', { class: 'fr-card-top' }, youAvatar(f), h('span', { class: 'fr-n' }, f.name)),
          showcaseLine(f.showcase, 'Not showing anything'))))
          : h('p', { class: 'pnote' }, 'No friends yet. Share your code, or add a friend’s.')),
      h('div', { class: 'fr-foot' }, h('button', { class: 'link danger', onclick: async () => {
        if (!(await ctx.confirm('Delete your friend profile?', 'Your name, picture, code and friends are deleted from the friends service. Your music stays.', 'Delete', 'Cancel', true))) return;
        const r = await fr('DELETE', '/v1/me');
        if (!r.ok) { ctx.flash(r.error); return; }
        await saveAcct(null); Object.assign(FR, { me: null, friends: [], incoming: [], outgoing: [] }); drawMeButton(); render();
      } }, 'Delete My Friend Profile')));
  }
  // (fresh while the profile page is open, and now and then otherwise so a new request shows its dot)
  setInterval(() => { if (document.hidden) return; if (view === 'profile' || Date.now() - FR.at > 5 * 60000) refreshFriends(); }, 30000);

  function renderPlaylists() {
    page('Playlists', grid([
      h('button', { class: 'card pcard newpl', 'data-key': 'pl:new', onclick: () => newPlaylist([]) },
        h('div', { class: 'cover cover-blank list' }, h('span', {}, '+')), h('div', { class: 'pcard-t' }, 'New Playlist'), h('div', { class: 'pcard-s' }, ' ')),
      ...P.playlists.map(playlistCard)]));
  }
  function renderPlaylist(id) {
    const pl = P.playlists.find((x) => x.id === id);
    if (!pl) return go('playlists');
    const dur = pl.tracks.reduce((s, t) => s + ((track(t) || {}).duration || 0), 0);
    const ctxp = { kind: 'playlist', id: pl.id, name: pl.name };
    page(pl.name,
      h('div', { class: 'pstats' }, `${plural(pl.tracks.length, 'song')} · ${longDur(dur)}`),
      h('div', { class: 'btns pbtns' },
        pl.tracks.length ? h('button', { class: 'btn primary', onclick: () => playIds(pl.tracks, 0, ctxp) }, svg(ICON.play), 'Play') : null,
        pl.tracks.length ? h('button', { class: 'btn secondary', onclick: () => playIds(shuffle(pl.tracks), 0, ctxp) }, svg(ICON.shuffle), 'Shuffle') : null,
        h('button', { class: 'btn secondary', onclick: () => renamePlaylist(pl) }, 'Rename'),
        h('button', { class: 'btn secondary danger', onclick: async () => {
          if (!(await ctx.confirm(`Delete the playlist “${pl.name}”?`, 'The songs stay in your library.', 'Delete', 'Cancel', true))) return;
          const r = await api.playlistDelete(pl.id); P = r.state; go('playlists');
        } }, 'Delete')),
      pl.tracks.length ? songTable(pl.tracks, { context: ctxp, numbered: true, removable: async (i) => {
        const r = await api.playlistUpdate(pl.id, { removeAt: i }); P = r.state; render();
      } }) : h('p', { class: 'pnote' }, 'Empty for now. Add songs with + on any album or song.'));
  }

  function renderSearch(q) {
    const s = q.toLowerCase();
    const albums = P.albums.filter((a) => `${a.title} ${a.artist} ${a.genre || ''}`.toLowerCase().includes(s));
    const songs = libIds().map(track).filter(Boolean).filter((t) => `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(s)).map((t) => t.id);
    const arts = artists().filter(([n]) => n.toLowerCase().includes(s));
    page(`Results for “${q}”`,
      arts.length ? h('section', { class: 'row' }, h('h2', {}, 'Artists'), h('div', { class: 'strip' }, arts.map(([name, list]) =>
        h('button', { class: 'card pcard artist', 'data-key': 'ar:' + name, onclick: () => go('artist:' + name) }, cover(list[0], 'round'), h('div', { class: 'pcard-t' }, name))))) : null,
      albums.length ? h('section', { class: 'row' }, h('h2', {}, 'Albums'), h('div', { class: 'strip' }, albums.map(albumCard))) : null,
      songs.length ? h('section', { class: 'row' }, h('h2', {}, 'Songs'), songTable(songs.slice(0, 200), { context: { kind: 'search', name: q } })) : null,
      !albums.length && !songs.length && !arts.length ? h('p', { class: 'pnote' }, 'Nothing found.') : null);
  }

  function render() {
    if (!P) { main.replaceChildren(h('div', { class: 'pempty' }, h('p', {}, 'Opening the Parlor…'))); load().then(render); return; }
    document.querySelectorAll('#pnav a').forEach((x) => x.classList.toggle('active', x.dataset.pview === view.split(':')[0] || (view.startsWith('artist:') && x.dataset.pview === 'artists') || (view.startsWith('playlist:') && x.dataset.pview === 'playlists') || (view.startsWith('mix:') && x.dataset.pview === 'home')));
    // (the Spatial Audio tab only once there's something in spatial audio)
    const sp = document.querySelector('#pnav a[data-pview="spatial"]');
    if (sp) sp.hidden = !spatialIds().length;
    const q = ctx.query();
    if (!P.albums.length) return renderEmpty();
    if (q) return renderSearch(q);
    if (view === 'albums') return page('Albums', grid(P.albums.map(albumCard)));
    if (view === 'artists') return renderArtists();
    if (view.startsWith('artist:')) return renderArtist(view.slice(7));
    if (view === 'songs') return renderSongs();
    if (view === 'spatial') return renderSpatial();
    if (view === 'playlists') return renderPlaylists();
    if (view.startsWith('playlist:')) return renderPlaylist(view.slice(9));
    if (view.startsWith('mix:')) return renderMix(view.slice(4));
    if (view === 'profile') return renderProfile();
    renderHome();
  }
  const history = [];
  function go(v) { if (v !== view) history.push(view); view = v; ctx.clearQuery(); render(); window.scrollTo(0, 0); const f = main.querySelector('.btn, .card, .srow'); f && ctx.focusEl(f); }

  // Add songs to the queue (next, or at the end) and say so; they show under "Playing Next" in the Queue.
  async function queueUp(ids, next, name) {
    await api.musicCmd('enqueue', { trackIds: ids, next });
    ctx.flash(next ? `${name} will play next` : `${name} added to the end of the queue`);
  }

  // ---- album page (in the shared modal) --------------------------------------------------------------
  let openKey = null;
  function openAlbum(key) {
    openKey = key; drawAlbum(); ctx.showModal();
    const b = $('#modal .btn.primary'); b && b.focus({ preventScroll: true });
  }

  function drawAlbum(focusSel) {
    const a = album(openKey);
    if (!a) return ctx.closeModal();
    const ids = a.tracks;
    const multiDisc = new Set(albumTracks(a).map((t) => t.disc)).size > 1;
    const ctxa = { kind: 'album', id: a.key, name: a.title };
    const fmt = albumTracks(a)[0] || {};
    const body = h('div', { class: 'palbum' },
      h('div', { class: 'palbum-head' },
        cover(a, 'big reflect'),
        h('div', { class: 'palbum-info' },
          h('h1', {}, a.title),
          h('button', { class: 'linkish partist', onclick: () => { ctx.closeModal(); go('artist:' + a.artist); } }, a.artist),
          h('div', { class: 'pmeta' }, [a.genre, a.year, plural(ids.length, 'song'), longDur(a.duration), a.lossless ? 'Lossless' : fmt.codec,
            ids.some((id) => (P.tracks[id] || {}).atmos) ? 'Dolby Atmos' : ids.some((id) => (P.tracks[id] || {}).channels > 2) ? 'Surround' : ''].filter(Boolean).join(' · ')),
          versionPicker(a),
          h('div', { class: 'btns' },
            h('button', { class: 'btn primary', onclick: () => playIds(ids, 0, ctxa) }, svg(ICON.play), 'Play'),
            h('button', { class: 'btn secondary', onclick: () => playIds(shuffle(ids), 0, ctxa) }, svg(ICON.shuffle), 'Shuffle'),
            h('button', { class: 'btn secondary', onclick: () => pickPlaylist(ids) }, '+ Playlist'),
            api.parlorPin ? h('button', { class: 'btn secondary pin-btn' + (isPinned(a) ? ' on' : ''), 'aria-pressed': String(isPinned(a)), onclick: () => togglePin(a) },
              svg(ICON.pin), isPinned(a) ? 'Pinned' : 'Pin') : null,
            P.player && P.player.playing ? h('button', { class: 'btn secondary', onclick: () => queueUp(ids, true, a.title) }, svg(ICON.queue), 'Play Next') : null,
            P.player && P.player.playing ? h('button', { class: 'btn secondary', onclick: () => queueUp(ids, false, a.title) }, 'Play Last') : null,
            P.canManage && api.parlorCoverSearch ? h('button', { class: 'btn secondary', onclick: () => findCover(a) }, a.art ? 'Change Cover' : 'Find Cover') : null,
            P.canManage && api.parlorMotionSet ? h('button', { class: 'btn secondary', onclick: () => motionCover(a) }, a.motion ? 'Moving Cover' : 'Add Moving Cover') : null,
            ctx.recommend && ctx.canRecommend() && !window.S_IOS ? h('button', { class: 'btn secondary rec-btn', onclick: () => recommendAlbum(a) }, '→ Recommend') : null),
          albumRecBanner(a),
          P.canManage && !window.S_IOS ? sharePanel(a) : null)),
      h('table', { class: 'songs tracks' + (P.player && P.player.playing ? ' two-btns' : '') }, h('tbody', {},
        // (the table's columns take their widths from its first row: with discs, that would be the "Disc 1" row,
        // one cell across, which splits them evenly and pushes the titles right; an invisible row of normal cells goes first)
        multiDisc ? h('tr', { class: 'sizer', 'aria-hidden': 'true' }, h('td', { class: 'n' }), h('td', {}), h('td', { class: 't' }), h('td', { class: 'x' })) : null,
        albumTracks(a).map((t, i) => {
        const cur = P.player && P.player.track && P.player.track.id === t.id;
        return [
          multiDisc && (i === 0 || albumTracks(a)[i - 1].disc !== t.disc) ? h('tr', { class: 'disc' }, h('td', { colspan: '4' }, `Disc ${t.disc}`)) : null,
          h('tr', { class: 'srow' + (cur ? ' now' : ''), tabindex: '0', 'data-id': t.id, style: `--i:${Math.min(i, 16)}`, onclick: (e) => { if (e.target.closest('.rowbtn')) return; playIds(ids, i, ctxa); } },
            h('td', { class: 'n' }, cur ? svg(ICON.play, 'ico tiny') : (t.track || i + 1)),
            h('td', {}, t.title, t.explicit ? h('span', { class: 'e' }, 'E') : null, t.atmos ? h('span', { class: 'e sur', title: 'Dolby Atmos: Spatial Audio on AirPods' }, 'Atmos') : t.channels > 2 ? h('span', { class: 'e sur', title: 'Surround: Spatial Audio on AirPods' }, chLabel(t.channels)) : null,
              t.playable === false ? h('span', { class: 'e sur', title: "This phone can't play this file" }, "Can't play") : null, a.various && t.artist !== a.artist ? h('span', { class: 'by' }, ` — ${t.artist}`) : null),
            h('td', { class: 't' }, mmss(t.duration)),
            h('td', { class: 'x' },
              P.player && P.player.playing ? h('button', { class: 'rowbtn qadd', title: 'Play next', 'aria-label': `Play ${t.title} next`, onclick: () => queueUp([t.id], true, t.title) }, svg(ICON.queue, 'ico tiny')) : null,
              h('button', { class: 'rowbtn', title: 'Add to a playlist', onclick: () => pickPlaylist([t.id]) }, '+')))];
        }).flat())));
    $('#modal-body').replaceChildren(body);
    $('#modal .modal-card').classList.add('pmodal');
    if (focusSel) { const f = $('#modal-body').querySelector(focusSel); f && f.focus(); }
  }

  // Pin an album to the top of Home (or take it off), for the profile that's listening.
  const isPinned = (a) => (P.pinned || []).includes(a.key);
  async function togglePin(a) {
    const on = !isPinned(a);
    const r = await api.parlorPin(a.key, on);
    if (!r.ok) { ctx.flash(r.error || "Couldn't pin that album."); return; }
    P = r.state;
    drawAlbum('.pin-btn');
    ctx.flash(on ? `${a.title} is pinned to the top of Home` : `${a.title} is no longer pinned`);
    if (view === 'home') render();
  }

  // An album there in stereo and in spatial audio shows once, with the version to play picked here (kept for the album).
  function versionPicker(a) {
    if (!a.version || !api.parlorSetVersion) return null;
    const sel = h('select', { class: 'pversion-sel', 'aria-label': 'Version', onchange: async () => {
      const r = await api.parlorSetVersion(a.key, sel.value);
      if (!r.ok) { ctx.flash(r.error || "Couldn't change the version."); return; }
      P = r.state;
      drawAlbum('.pversion-sel');
      ctx.flash(sel.value === 'stereo' ? `${a.title}: Stereo` : `${a.title}: Spatial Audio`);
    } },
      h('option', { value: 'spatial' }, 'Spatial Audio'),
      h('option', { value: 'stereo' }, 'Stereo'));
    sel.value = a.version;
    return h('label', { class: 'pversion' }, h('span', {}, 'Version'), sel);
  }

  // Recommend an album: grown-ups also share it with whoever they send it to; kids can send it to people who can already hear it.
  function recommendAlbum(a) {
    ctx.setSheetClosed(() => { const b = $('#modal .rec-btn'); b && b.focus(); });
    ctx.recommend({ kind: 'album', key: a.key, name: a.title,
      allowed: (p) => P.canManage || a.audience.includes(p.id),
      beforeSend: async (to) => {
        for (const pid of to) {
          if (a.audience.includes(pid)) continue;
          const r = await api.parlorShare(a.key, pid, true);
          if (r.ok) P = r.state;
        }
        return true;
      },
      onSent: () => { drawAlbum('.rec-btn'); } });
  }
  function albumRecBanner(a) {
    if (!ctx.albumRecs) return null;
    const mine = ctx.albumRecs().filter((x) => x.rec.key === a.key);
    if (!mine.length) return null;
    return h('div', { class: 'rec-banner' }, ctx.avatar(mine[0].from), h('span', {}, `${mine.map((x) => x.from.name).join(' and ')} recommended this for you`),
      h('button', { class: 'btn secondary small', onclick: async () => { await ctx.dismissRecs(mine.map((x) => x.rec.id)); drawAlbum('.btn.primary'); } }, 'Dismiss'));
  }

  // Share this album with other profiles (one press each; press again to unshare).
  function sharePanel(a) {
    const others = P.profiles.filter((p) => p.id !== P.profile);
    if (!others.length) return h('p', { class: 'pnote small' }, 'Add more profiles in Settings → Profiles to share albums with them.');
    return h('div', { class: 'pshare' }, h('div', { class: 'pshare-t' }, 'Shared with'),
      h('div', { class: 'pshare-list' }, others.map((p) => {
        const on = a.audience.includes(p.id);
        return h('button', { class: 'chip pchip' + (on ? ' on' : ''), 'data-pid': p.id, title: on ? `Stop sharing with ${p.name}` : `Share with ${p.name}`,
          onclick: async () => {
            const r = await api.parlorShare(a.key, p.id, !on);
            if (!r.ok) { ctx.flash(r.error); return; }
            P = r.state; ctx.flash(on ? `${a.title} is no longer shared with ${p.name}` : `${p.name} can now hear ${a.title}`);
            drawAlbum(`.pchip[data-pid="${p.id}"]`);
          } },
          h('span', { class: 'dot', style: `background:${p.color}` }), p.name, p.kids ? ' (kids)' : '', on ? ' ✓' : '');
      })));
  }

  // ---- playlists: pick / create ----------------------------------------------------------------------
  function overlay(cls, ...kids) {
    closeOverlay();
    const el = h('div', { class: `poverlay ${cls}`, id: 'poverlay', onmousedown: (e) => { if (e.target === el) closeOverlay(); } }, h('div', { class: 'poverlay-card' }, ...kids));
    document.body.append(el);
    const f = el.querySelector('button, input'); f && f.focus();
    return el;
  }
  function closeOverlay() { const o = $('#poverlay'); if (o) { const back = o.back; o.remove(); if (back && back.isConnected) back.focus({ preventScroll: true }); return true; } return false; }

  // Right-click (or the keyboard's menu key, or Shift+F10) on a song, an album, a mix or a playlist: what you can do with it.
  function contextMenu(target, x, y) {
    const srow = target.closest && target.closest('tr.srow');
    const card = target.closest && target.closest('.pcard[data-key], .ptile[data-key]');
    let items = [];
    if (srow) {
      const id = srow.dataset.id, t = track(id);
      if (!t) return false;
      const nm = `“${t.title}”`;
      items = [['Play', () => srow.click()], ['Play Next', () => queueUp([id], true, nm)], ['Add to Queue', () => queueUp([id], false, nm)],
        ['Add to a Playlist…', () => pickPlaylist([id])], album(t.albumKey) ? ['Go to Album', () => openAlbum(t.albumKey)] : null, ['Go to Artist', () => go('artist:' + t.artist)]];
    } else if (card) {
      const key = card.dataset.key;
      const a = album(key);
      const mix = key.startsWith('mix:') && dailyMixes().find((m) => 'mix:' + m.id === key);
      const pl = key.startsWith('pl:') && P.playlists.find((p) => 'pl:' + p.id === key);
      const list = (name, ids, c, open) => [['Open', open], ['Play', () => playIds(ids, 0, c)], ['Shuffle', () => playIds(shuffle(ids), 0, c)],
        ['Play Next', () => queueUp(ids, true, name)], ['Add to Queue', () => queueUp(ids, false, name)]];
      if (a) items = [...list(`“${a.title}”`, a.tracks, { kind: 'album', id: a.key, name: a.title }, () => openAlbum(a.key)),
        ['Add to a Playlist…', () => pickPlaylist(a.tracks)], [isPinned(a) ? 'Unpin from Home' : 'Pin to Home', () => togglePin(a)], ['Go to Artist', () => go('artist:' + a.artist)]];
      else if (mix) items = [...list(mix.name, mix.ids, { kind: 'mix', id: mix.id, name: mix.name }, () => go(key))];
      else if (pl && pl.tracks.length) items = [...list(`“${pl.name}”`, pl.tracks, { kind: 'playlist', id: pl.id, name: pl.name }, () => go('playlist:' + pl.id))];
    }
    items = items.filter(Boolean);
    if (!items.length) return false;
    closeOverlay();
    const card2 = h('div', { class: 'pmenu-card', role: 'menu' }, items.map(([l, fn]) => h('button', { class: 'pmenu-item', role: 'menuitem', onclick: () => { closeOverlay(); fn(); } }, l)));
    const el = h('div', { class: 'poverlay pmenu', id: 'poverlay', onmousedown: (e) => { if (e.target === el) closeOverlay(); }, oncontextmenu: (e) => { e.preventDefault(); if (e.target === el) closeOverlay(); } }, card2);
    el.back = srow || card;
    document.body.append(el);
    const r = card2.getBoundingClientRect();
    card2.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`;
    card2.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8))}px`;
    const f = card2.querySelector('button'); f && f.focus({ preventScroll: true });
    return true;
  }
  document.addEventListener('contextmenu', (e) => {
    if (!ctx.isOpen || !ctx.isOpen()) return;
    if (e.target.closest && e.target.closest('input, textarea')) return;
    if (contextMenu(e.target, e.clientX, e.clientY)) e.preventDefault();
  });

  function pickPlaylist(trackIds) {
    overlay('pick', h('h2', {}, `Add ${plural(trackIds.length, 'song')} to…`),
      h('div', { class: 'pick-list' },
        h('button', { class: 'btn secondary', onclick: () => newPlaylist(trackIds) }, '+ New Playlist…'),
        ...P.playlists.map((pl) => h('button', { class: 'btn secondary', onclick: async () => {
          const r = await api.playlistUpdate(pl.id, { add: trackIds }); P = r.state; closeOverlay(); ctx.flash(`Added to ${pl.name}`);
          if (view === 'playlist:' + pl.id) render();
        } }, pl.name, h('small', {}, `  ${plural(pl.tracks.length, 'song')}`)))),
      h('div', { class: 'btns' }, h('button', { class: 'btn secondary', onclick: closeOverlay }, 'Cancel')));
  }
  function nameDialog(title, value, okLabel, onOk) {
    const input = h('input', { type: 'text', class: 'pname-input', maxlength: '60', autocapitalize: 'words', value: value || '', placeholder: window.S_IOS ? 'Type a name here' : 'Playlist name (or type it on your phone)' });
    const ok = async () => { const v = input.value.trim(); if (!v) { input.focus(); return; } await onOk(v); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && input.value.trim() && !ctx.wantsKeyboard()) { e.preventDefault(); e.stopPropagation(); ok(); } });
    overlay('name', h('h2', {}, title), input,
      h('div', { class: 'btns' }, h('button', { class: 'btn primary', onclick: ok }, okLabel), h('button', { class: 'btn secondary', onclick: closeOverlay }, 'Cancel')));
    input.focus();
  }
  function newPlaylist(trackIds) {
    nameDialog('New Playlist', '', 'Create', async (name) => {
      const r = await api.playlistCreate(name, trackIds);
      if (!r.ok) { ctx.flash(r.error); return; }
      P = r.state; closeOverlay(); ctx.flash(trackIds.length ? `Added to ${name}` : `Made ${name}`);
      if (!trackIds.length) go('playlist:' + r.playlist.id); else if (view === 'playlists' || view === 'home') render();
    });
  }
  function renamePlaylist(pl) {
    nameDialog('Rename Playlist', pl.name, 'Save', async (name) => { const r = await api.playlistUpdate(pl.id, { name }); P = r.state; closeOverlay(); render(); });
  }

  // ---- album covers ------------------------------------------------------------------------------------
  /** Add, change or take away the album's moving cover (a short video, like Apple Music's). */
  function motionCover(a) {
    const go = async (how) => {
      closeOverlay();
      const r = await api.parlorMotionSet(a.key, how);
      if (!r.ok) { ctx.flash(r.error); return; }
      if (r.cancelled) return;
      P = r.state;
      ctx.flash(how === 'remove' ? 'Moving cover taken away'
        : r.plays ? 'Moving cover added' : `That video can't play here${r.detail ? ' (' + r.detail + ')' : ''}`);
      drawAlbum(); render(); drawBar(true);
      if (fullOpen) drawFull(true);
    };
    overlay('covers', h('h2', {}, `Moving cover for ${a.title}`),
      h('p', { class: 'pnote small' }, 'Pick a short looping video. It plays silently in place of the cover on the album page and in Now Playing.'),
      h('div', { class: 'btns motion-btns' },
        window.S_IOS ? h('button', { class: 'btn primary', onclick: () => go('photos') }, 'From Photos') : null,
        h('button', { class: window.S_IOS ? 'btn secondary' : 'btn primary', onclick: () => go('files') }, window.S_IOS ? 'From Files' : 'Choose a Video…'),
        a.motion ? h('button', { class: 'btn secondary', onclick: () => go('remove') }, 'Take Away') : null,
        h('button', { class: 'btn secondary', onclick: closeOverlay }, 'Cancel')));
  }
  async function findCover(a) {
    overlay('covers', h('h2', {}, `Cover for ${a.title}`), h('p', { class: 'pnote small' }, 'Looking…'));
    const r = await api.parlorCoverSearch(a.key);
    if (!$('#poverlay')) return;
    if (!r.ok) { closeOverlay(); ctx.flash(r.error); return; }
    const pick = async (choice, label) => {
      const res = await api.parlorCoverSet(a.key, choice);
      if (!res.ok) { ctx.flash(res.error); return; }
      P = res.state; closeOverlay(); ctx.flash(label || 'Cover updated'); drawAlbum(); render(); drawBar(true);
    };
    const tiles = [
      ...r.results.slice(0, 8).map((x) => h('button', { class: 'cover-pick', title: `${x.album} — ${x.artist} ${x.year}`, onclick: () => pick({ url: x.url }, 'Cover saved') },
        h('img', { src: x.thumb, alt: '' }), h('span', {}, x.album), h('small', {}, `${x.artist}${x.year ? ' · ' + x.year : ''}`))),
      ...r.local.slice(0, 6).map((f) => h('button', { class: 'cover-pick', title: f, onclick: () => pick({ path: f }) },
        h('img', { src: fileUrl(f), alt: '' }), h('span', {}, f.split(/[\\/]/).pop()), h('small', {}, 'in the album folder'))),
    ];
    overlay('covers', h('h2', {}, `Cover for ${a.title}`),
      r.error ? h('p', { class: 'pnote small' }, r.error) : null,
      tiles.length ? h('div', { class: 'cover-picks' }, tiles) : h('p', { class: 'pnote small' }, 'No covers found for this album.'),
      h('div', { class: 'btns' },
        h('button', { class: 'btn secondary', onclick: async () => {
          if (ctx.isLinux && ctx.isLinux()) {
            closeOverlay();
            const f = await ctx.pickPath({ title: `Cover for ${a.title}`, mode: 'image' });
            if (f) pick({ path: f });
            return;
          }
          pick(null);
        } }, 'Choose a picture…'),
        h('button', { class: 'btn secondary', onclick: closeOverlay }, 'Cancel')));
  }

  // ---- playing -----------------------------------------------------------------------------------------
  let lastPlay = { key: '', at: 0 };
  // the phone's clock and battery: white over Now Playing (dark), dark over the light pages
  const statusBar = () => { if (api.setStatusBar) api.setStatusBar(fullOpen || (ctx.isDark && ctx.isDark()) ? 'light' : 'dark'); };
  let openOnPlay = null; // the song whose Now Playing opens as soon as it starts (touch screens)
  async function playIds(ids, start, context) {
    // a double-click on a song is one request, not two
    const key = `${ids[start]}|${ids.length}`;
    if (key === lastPlay.key && Date.now() - lastPlay.at < 700) return;
    lastPlay = { key, at: Date.now() };
    if (matchMedia('(pointer: coarse)').matches) openOnPlay = ids[start];
    const r = await api.musicPlay({ trackIds: ids, start, context });
    if (!r.ok) { openOnPlay = null; ctx.flash(r.error || 'Could not play that'); }
  }

  // Now Playing bar (bottom of the screen, both sides of the app) and the full Now Playing view.
  function noteIcon() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 17.5V5.2l11-2.2v12.4"/><path d="M9 9.2l11-2.2"/><ellipse cx="6.3" cy="17.6" rx="2.7" ry="2.2"/><ellipse cx="17.3" cy="15.5" rx="2.7" ry="2.2"/></svg>'; }
  function cdIcon() { return '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10.2" fill="url(#cdg)" stroke="#8a97a8" stroke-width=".8"/><defs><linearGradient id="cdg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f4f7fb"/><stop offset=".45" stop-color="#b9d3ee"/><stop offset=".55" stop-color="#f1d6ef"/><stop offset="1" stop-color="#dfe8f1"/></linearGradient></defs><circle cx="12" cy="12" r="3.4" fill="#d6dde6" stroke="#8a97a8" stroke-width=".6"/><circle cx="12" cy="12" r="1.3" fill="#3b4652"/></svg>'; }

  // The bar and the full view are built once and then only updated (rebuilding them several times a second
  // made buttons miss clicks).
  const pct = (s) => (s.dur ? Math.min(100, (s.pos / s.dur) * 100) : 0);
  // Skip back / forward 10 seconds in the song (buttons, the remote's rewind / fast-forward keys, the progress bar)
  // (quick presses add up: the song's position only reaches us a moment later)
  let skipTo = null;
  const skip = (d) => {
    const s = P && P.player;
    if (!s || !s.track) return;
    const from = skipTo && Date.now() - skipTo.at < 1500 && skipTo.id === s.track.id ? skipTo.pos : (s.pos || 0);
    const pos = Math.max(0, Math.min((s.dur || 0) - 1, from + d));
    skipTo = { pos, at: Date.now(), id: s.track.id };
    seekHold = { to: pos, at: performance.now(), until: Date.now() + 2500 };
    if (clock) { clock.pos = pos; clock.at = seekHold.at; paintTime(); }
    api.musicCmd('seek', pos);
  };
  const bar = h('div', { id: 'npbar', hidden: true, 'data-navrow': '1' });
  const B = {
    art: h('button', { class: 'npb-art', 'data-b': 'art', title: 'Now Playing', onclick: () => openFull() }),
    prev: h('button', { class: 'npb', 'data-b': 'prev', title: 'Previous', onclick: () => api.musicCmd('prev') }, svg(ICON.prev)),
    play: h('button', { class: 'npb big', 'data-b': 'play', title: 'Play / Pause', onclick: () => api.musicCmd('toggle') }),
    next: h('button', { class: 'npb', 'data-b': 'next', title: 'Next', onclick: () => api.musicCmd('next') }, svg(ICON.next)),
    rew: h('button', { class: 'npb', 'data-b': 'rew', title: 'Back 10 seconds', onclick: () => skip(-10) }, svg(ICON.rew, 'ico skip')),
    fwd: h('button', { class: 'npb', 'data-b': 'fwd', title: 'Forward 10 seconds', onclick: () => skip(10) }, svg(ICON.fwd, 'ico skip')),
    title: h('div', { class: 'lcd-t' }), sub: h('div', { class: 'lcd-s' }),
    pos: h('span', {}), fill: h('div', {}), left: h('span', {}),
  };
  B.lcd = h('button', { class: 'lcd', 'data-b': 'lcd', title: 'Now Playing', onclick: () => openFull() },
    B.title, B.sub, h('div', { class: 'lcd-p' }, B.pos, h('div', { class: 'lcd-bar' }, B.fill), B.left));
  // (no 10-second skips on an iPhone or iPad)
  bar.append(B.art, h('div', { class: 'npb-ctrl' }, B.prev, window.S_IOS ? null : B.rew, B.play, window.S_IOS ? null : B.fwd, B.next), B.lcd);
  document.body.append(bar);
  // A "Now Playing" button in the top bar, on both sides of the app: always one press of Back away
  // (Back jumps to the top bar), so the music is easy to reach with a remote from anywhere.
  const chipTitle = h('span', { class: 'npc-t' });
  const chip = h('button', { id: 'np-chip', hidden: true, title: 'Now Playing', onclick: () => openFull() },
    h('span', { class: 'npc-disc' }), chipTitle);
  // (no longer put in the top bar: it squeezed the titles beside it; the bar along the bottom does the job)
  // On a phone the sections become a tab bar along the bottom. It has to live outside the top bar (the bar's
  // blur would trap it inside), and the page starts just below the top bar however tall that has grown.
  const navEl = $('#nav'), pnavEl = $('#pnav'), pnavNext = pnavEl && pnavEl.nextElementSibling;
  const phoneMQ = matchMedia('(max-width: 600px)');
  const placeTabs = () => {
    if (!pnavEl || !navEl) return;
    if (phoneMQ.matches) { if (pnavEl.parentElement !== document.body) document.body.append(pnavEl); }
    else if (pnavEl.parentElement !== navEl) navEl.insertBefore(pnavEl, pnavNext);
  };
  placeTabs();
  if (phoneMQ.addEventListener) phoneMQ.addEventListener('change', placeTabs);
  const setNavH = () => { if (navEl) document.documentElement.style.setProperty('--navh', navEl.offsetHeight + 'px'); };
  if (window.ResizeObserver && navEl) new ResizeObserver(setNavH).observe(navEl, { box: 'border-box' });
  addEventListener('resize', setNavH); addEventListener('orientationchange', () => setTimeout(setNavH, 300));
  setTimeout(setNavH, 500); setTimeout(setNavH, 1500);
  let fullOpen = false;
  statusBar();
  let lastTrack = null, lastPaused = null;

  function drawBar(force) {
    const s = P && P.player;
    const t = s && s.track;
    bar.hidden = !t;
    chip.hidden = true;
    document.body.classList.toggle('has-npbar', !!t);
    document.body.classList.toggle('music-paused', !!(s && s.paused));
    if (!t) { lastTrack = null; if (fullOpen) closeFull(); return; }
    if (force || !lastTrack || lastTrack !== t.id) {
      const a = album(t.albumKey) || { art: t.art, title: t.album, artist: t.artist, key: t.albumKey };
      const blook = [a.key, a.art].join('|');
      if (force === 'look' || B.art.dataset.look !== blook || !B.art.firstChild) { B.art.dataset.look = blook; B.art.replaceChildren(cover(a, 'tiny')); }
      B.title.textContent = t.title; B.sub.textContent = `${t.artist} — ${t.album}`;
      chipTitle.textContent = t.title;
    }
    if (force || lastPaused !== s.paused) B.play.replaceChildren(svg(s.paused ? ICON.play : ICON.pause));
    B.pos.textContent = mmss(s.pos); B.left.textContent = '-' + mmss((s.dur || 0) - s.pos);
    B.fill.style.width = pct(s) + '%';
    if (fullOpen) drawFull(force || lastTrack !== t.id);
    lastTrack = t.id; lastPaused = s.paused;
  }

  // ---- the full Now Playing screen ---------------------------------------------------------------------
  // The cover (or the album's moving cover) over a soft wash of its own colours, the song, a slim progress
  // bar and the controls, like Apple Music. On a phone it's one column; on a TV or computer the cover sits
  // beside the controls. After a while without a key press the controls fade away and the cover fills the
  // screen (any key brings them back) — "big cover" mode.
  const full = h('div', { id: 'npfull', hidden: true });
  // (no volume buttons on a phone or iPad: it has its own)
  if (window.S_IOS) document.body.classList.add('ios-app');
  const F = {
    bg: h('div', { class: 'npf-bg' }),
    stage: h('button', { class: 'npf-stage', 'data-b': 'stage', title: window.S_IOS ? '' : 'Big cover', onclick: () => { if (!window.S_IOS) setBig(!full.classList.contains('big')); } }),
    from: h('div', { class: 'npf-from' }), title: h('h1', {}),
    // (the artist and the album: either one opens the album the song is from)
    artist: h('h2', {}, h('button', { class: 'npf-link', 'data-b': 'to-album', title: 'Go to the album', onclick: () => goToAlbum() })),
    album: h('h3', {}, h('button', { class: 'npf-link', 'data-b': 'to-album2', title: 'Go to the album', onclick: () => goToAlbum() })),
    pos: h('span', {}), left: h('span', {}), fill: h('div', {}),
    vol: h('span', { class: 'npf-vol' }),
    caption: h('div', { class: 'npf-caption' }),
  };
  F.close = h('button', { class: 'np-close', 'data-b': 'close', 'aria-label': 'Close', title: 'Close (Back)', onclick: () => closeFull() }, '✕');
  F.bigBtn = h('button', { class: 'np-close np-big', 'data-b': 'big', title: 'Big cover', onclick: () => setBig(true) });
  F.bigBtn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/></svg>';
  F.barBtn = h('button', { class: 'npf-bar', 'data-b': 'bar', title: 'Left / right: skip 10 seconds',
    onkeydown: (e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); wakeFull(); skip(e.key === 'ArrowLeft' ? -10 : 10); } } }, F.fill);
  // Drag along the bar (or anywhere in the tall strip around it) to scrub: the times follow your finger and the
  // song jumps there when you let go.
  F.scrub = h('div', { class: 'npf-scrub' }, F.barBtn);
  let scrubbing = null;
  const scrubAt = (e) => {
    const s = P && P.player; if (!s || !s.dur) return null;
    const r = F.barBtn.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    F.fill.style.width = f * 100 + '%';
    F.pos.textContent = mmss(f * s.dur); F.left.textContent = '-' + mmss(s.dur - f * s.dur);
    return f * s.dur;
  };
  F.scrub.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    e.preventDefault(); e.stopPropagation();
    F.scrub.setPointerCapture(e.pointerId);
    scrubbing = { id: e.pointerId, to: scrubAt(e) };
    full.classList.add('scrubbing'); wakeFull();
  });
  F.scrub.addEventListener('pointermove', (e) => { if (scrubbing && e.pointerId === scrubbing.id) scrubbing.to = scrubAt(e); });
  const endScrub = (e, cancel) => {
    if (!scrubbing || e.pointerId !== scrubbing.id) return;
    const to = scrubbing.to; scrubbing = null; full.classList.remove('scrubbing');
    if (!cancel && to != null) {
      // show the new place at once and keep it there until the player reports it (no jump back)
      seekHold = { to, at: performance.now(), until: Date.now() + 2500 };
      if (clock) { clock.pos = to; clock.at = seekHold.at; }
      paintTime();
      api.musicCmd('seek', to);
    } else paintTime();
  };
  F.scrub.addEventListener('pointerup', (e) => endScrub(e, false));
  F.scrub.addEventListener('pointercancel', (e) => endScrub(e, true));
  // How good the file is (Lossless, Hi-Res Lossless, or a compressed format's bit rate); tap for the details.
  F.quality = h('button', { class: 'npf-q', 'data-b': 'quality', title: 'Audio quality', onclick: () => showQuality() });
  F.qsheet = h('div', { class: 'npf-qsheet', hidden: true, onclick: (e) => { if (e.target === F.qsheet) hideQuality(); } });
  F.grab = h('button', { class: 'npf-grab', 'aria-label': 'Close', title: 'Close', onclick: () => closeFull() });
  F.play = h('button', { class: 'npb big', 'data-b': 'play', title: 'Play / Pause', onclick: () => api.musicCmd('toggle') });
  F.ctrl = h('div', { class: 'npf-ctrl', 'data-navrow': '1' },
    h('button', { class: 'npb', 'data-b': 'prev', title: 'Previous', onclick: () => api.musicCmd('prev') }, svg(ICON.prev)),
    window.S_IOS ? null : h('button', { class: 'npb', 'data-b': 'rew', title: 'Back 10 seconds', onclick: () => skip(-10) }, svg(ICON.rew, 'ico skip')),
    F.play,
    window.S_IOS ? null : h('button', { class: 'npb', 'data-b': 'fwd', title: 'Forward 10 seconds', onclick: () => skip(10) }, svg(ICON.fwd, 'ico skip')),
    h('button', { class: 'npb', 'data-b': 'next', title: 'Next', onclick: () => api.musicCmd('next') }, svg(ICON.next)),
    h('button', { class: 'npb vol', 'data-b': 'vdown', title: 'Quieter', onclick: () => api.musicCmd('volume', P.player.volume - 10) }, '−'),
    F.vol,
    h('button', { class: 'npb vol', 'data-b': 'vup', title: 'Louder', onclick: () => api.musicCmd('volume', P.player.volume + 10) }, '+'));
  // Shuffle, Repeat and the Queue, in a row under the main buttons (as in Apple Music)
  F.shuf = h('button', { class: 'npt', 'data-b': 'shuffle', title: 'Shuffle', 'aria-pressed': 'false', onclick: () => api.musicCmd('shuffle') }, svg(ICON.shuffle));
  F.rep = h('button', { class: 'npt', 'data-b': 'repeat', title: 'Repeat', 'aria-pressed': 'false', onclick: () => api.musicCmd('repeat') }, svg(ICON.repeat));
  F.qbtn = h('button', { class: 'npt', 'data-b': 'queue', title: 'Queue', 'aria-pressed': 'false', onclick: () => toggleQueue() }, svg(ICON.queue));
  // Where the music plays: this device, or a Sonos room on the Wi-Fi (Parlor on an iPhone or iPad)
  F.out = api.sonosRooms ? h('button', { class: 'npt', 'data-b': 'output', title: 'Play on a speaker', 'aria-pressed': 'false', onclick: () => showOutputs() }, svg(ICON.speaker)) : null;
  F.where = h('div', { class: 'npf-where', hidden: true });
  // On a speaker: its volume, as a slider (the phone's own volume buttons work the phone, not the speaker)
  let volSent = 0, volTimer = null, volDragging = false;
  const sendVol = (v) => { clearTimeout(volTimer); const now = Date.now(); const go = () => { volSent = Date.now(); api.musicCmd('volume', v); };
    if (now - volSent > 150) go(); else volTimer = setTimeout(go, 150 - (now - volSent)); };
  F.volIn = h('input', { type: 'range', min: '0', max: '100', step: '1', class: 'npf-volin', 'aria-label': 'Speaker volume', 'data-b': 'volume',
    oninput: (e) => { volDragging = true; F.volIn.style.setProperty('--v', e.target.value + '%'); sendVol(Number(e.target.value)); },
    onchange: (e) => { sendVol(Number(e.target.value)); setTimeout(() => { volDragging = false; }, 1500); },
    onkeydown: (e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') e.stopPropagation(); } });
  const volIco = (w) => { const sp = h('span', { class: 'npf-volico', 'aria-hidden': 'true' }); sp.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/>${w ? '<path d="M16.5 8.5a5 5 0 0 1 0 7M19.5 5.5a9 9 0 0 1 0 13"/>' : ''}</svg>`; return sp; };
  F.volRow = h('div', { class: 'npf-volrow', hidden: true }, volIco(false), F.volIn, volIco(true));
  F.tools = h('div', { class: 'npf-tools', 'data-navrow': '1' }, F.shuf, F.qbtn, F.out, F.rep);
  F.queue = h('div', { class: 'npf-queue', hidden: true });
  F.body = h('div', { class: 'npf' }, F.stage, F.queue,
      h('div', { class: 'npf-side' }, F.from, F.title, F.artist, F.album,
        h('div', { class: 'npf-prog' }, F.scrub, F.pos, F.quality, F.left), F.ctrl, F.volRow, F.tools, F.where));
  // (the big-cover button is for a TV or computer; on an iPhone or iPad it's just the close button)
  F.melt = h('div', { class: 'npf-melt', 'aria-hidden': 'true' });
  full.append(F.bg, F.melt, F.grab, h('div', { class: 'npf-top', 'data-navrow': '1' }, window.S_IOS ? null : F.bigBtn, F.close), F.body, F.caption, F.qsheet);
  document.body.append(full);

  let idle = null;
  const BIG_AFTER = 25000;
  function setBig(on) {
    full.classList.toggle('big', !!on);
    if (on) { F.stage.focus({ preventScroll: true }); } else wakeFull();
  }
  function wakeFull() {
    clearTimeout(idle);
    if (fullOpen && !window.S_IOS) idle = setTimeout(() => { if (fullOpen && !full.contains(document.querySelector('.poverlay'))) setBig(true); }, BIG_AFTER);
  }
  // In big-cover mode the first key / click only brings the controls back.
  full.addEventListener('keydown', (e) => {
    if (full.classList.contains('big') && !['MediaPlayPause', 'MediaTrackNext', 'MediaTrackPrevious', 'MediaRewind', 'MediaFastForward'].includes(e.key)) {
      e.preventDefault(); e.stopPropagation(); setBig(false); const b = F.play; b.focus({ preventScroll: true }); return;
    }
    wakeFull();
    // Up from the buttons goes to the progress bar (where left / right skip 10 seconds), down from it back to Play.
    const a = document.activeElement;
    if (e.key === 'ArrowUp' && a && a.closest('.npf-ctrl')) { e.preventDefault(); e.stopPropagation(); F.barBtn.focus({ preventScroll: true }); return; }
    if (e.key === 'ArrowDown' && a === F.barBtn) { e.preventDefault(); e.stopPropagation(); F.play.focus({ preventScroll: true }); }
  }, true);
  full.addEventListener('mousemove', () => { if (!full.classList.contains('big')) wakeFull(); });

  // ---- the queue: what plays next ------------------------------------------------------------------------
  // "Playing Next" is what you added (Play Next / Add to Queue); then the rest of the album or playlist.
  let queueOpen = false, queueSig = '';
  function toggleQueue(on = !queueOpen) {
    queueOpen = !!on;
    full.classList.toggle('queue-open', queueOpen);
    F.queue.hidden = !queueOpen;
    F.qbtn.setAttribute('aria-pressed', String(queueOpen));
    F.qbtn.classList.toggle('on', queueOpen);
    queueSig = ''; drawQueue();
    if (queueOpen) F.queue.scrollTop = 0;
    return true;
  }
  function drawQueue() {
    const s = P && P.player; if (!s) return;
    const sig = [s.index, s.shuffle, s.repeat, ...s.queue.map((q) => q.id + (q.queued ? '+' : ''))].join('|');
    // the Queue button gets a dot while there's something you added waiting
    const added = s.queue.slice(s.index + 1).filter((q) => q.queued && !q.missing);
    F.qbtn.classList.toggle('dot', added.length > 0);
    if (!queueOpen || sig === queueSig) return;
    queueSig = sig;
    const keep = document.activeElement && F.queue.contains(document.activeElement) ? document.activeElement.dataset.b : null;
    const row = (q, i) => {
      const a = album(q.albumKey) || { art: q.art, title: q.album, key: q.albumKey };
      return h('button', { class: 'qi' + (q.queued ? ' queued' : ''), 'data-b': 'q' + i, title: `Play ${q.title}`, onclick: () => api.musicCmd('jump', i) },
        cover(a, 'tiny'), h('span', { class: 'qi-t' }, h('b', {}, q.title), h('small', {}, q.artist)), h('span', { class: 'qi-d' }, mmss(q.duration)));
    };
    const after = s.queue.map((q, i) => ({ q, i })).slice(s.index + 1).filter((x) => !x.q.missing);
    const mine = after.filter((x) => x.q.queued), rest = after.filter((x) => !x.q.queued);
    const from = s.context && s.context.name ? `Continue playing from ${s.context.name}` : 'Up Next';
    const mode = [s.shuffle ? 'Shuffled' : '', s.repeat === 'all' ? 'Repeating' : s.repeat === 'one' ? 'Repeating this song' : ''].filter(Boolean).join(' · ');
    const clear = after.length ? h('button', { class: 'btn secondary qclear', 'data-b': 'qclear', onclick: async () => {
      const r = await api.musicCmd('clear'); if (r && r.player && P) { P.player = r.player; drawFull(false); } ctx.flash('Queue cleared');
    } }, 'Clear Queue') : null;
    F.queue.replaceChildren(
      clear ? h('div', { class: 'qtop' }, clear) : null,
      mine.length ? h('div', { class: 'qsec' }, h('div', { class: 'qh' }, h('h4', {}, 'Playing Next'), h('small', {}, plural(mine.length, 'song') + ' you added')), ...mine.map((x) => row(x.q, x.i))) : null,
      h('div', { class: 'qsec' }, h('div', { class: 'qh' }, h('h4', {}, from), mode ? h('small', {}, mode) : null),
        ...(rest.length ? rest.slice(0, 200).map((x) => row(x.q, x.i)) : [h('p', { class: 'qempty' }, s.repeat === 'all' ? 'The queue starts again after this song.' : 'Nothing else is queued after this song.')])));
    if (keep) { const k = F.queue.querySelector(`[data-b="${keep}"]`); (k || F.qbtn).focus({ preventScroll: true }); }
  }

  // ---- audio quality -----------------------------------------------------------------------------------
  const khz = (r) => (r % 1000 ? (r / 1000).toFixed(1) : String(r / 1000)) + ' kHz';
  function quality(t) {
    t = { ...t, ...((P && P.tracks && P.tracks[t.id]) || {}) }; // the library has the file's details
    const hi = t.lossless && (t.sampleRate > 48000 || t.bitDepth > 24);
    const spec = t.lossless
      ? [t.bitDepth ? `${t.bitDepth}-bit` : '', t.sampleRate ? khz(t.sampleRate) : ''].filter(Boolean).join(' / ')
      : (t.bitrate ? `${t.bitrate} kbps` : '');
    // a surround mix (5.1, 7.1): AirPods and Beats play it as Spatial Audio, everything else gets it in stereo
    const route = (P && P.player && P.player.route) || null;
    const spatial = !!(route && route.spatial);
    if (route && route.sonos && route.downmix && (t.atmos || t.channels > 2)) {
      const what = t.atmos ? 'Dolby Atmos' : `${chLabel(t.channels)} surround`;
      return {
        t, kind: 'stereo downmix',
        name: 'Stereo', spec: route.twin ? 'Stereo version' : 'Downmixed',
        about: route.twin
          ? `This song is ${what}, which ${route.model ? 'a Sonos ' + route.model : 'this speaker'} doesn't play, so ${route.name} is playing the album's stereo version of it instead.`
          : `This song is ${what}, which ${route.model ? 'a Sonos ' + route.model : 'this speaker'} doesn't play, so this device mixed it down to stereo for ${route.name} (the first time takes a few seconds; the stereo copy is kept for next time). On an Arc, Arc Ultra, Beam (Gen 2) or Era 300 it plays in Dolby Atmos.`,
      };
    }
    if (route && route.sonos && t.atmos) {
      return {
        t, kind: 'surround atmos',
        name: 'Dolby Atmos', spec: route.atmos ? 'Sonos' : '',
        about: route.atmos
          ? `Dolby Atmos, sent to ${route.name} exactly as it is on this device: the speaker plays it in Dolby Atmos itself (the Sonos app shows Dolby Atmos while it does).`
          : `Dolby Atmos, sent to ${route.name} as it is.`,
      };
    }
    if (t.atmos) {
      return {
        t, kind: 'surround atmos' + (spatial ? ' spatial' : ''),
        name: 'Dolby Atmos', spec: spatial ? 'Spatial Audio' : '', // (the format's in the sheet; the chip stays short)
        about: spatial
          ? `Dolby Atmos, playing as Spatial Audio on ${route.name || 'your headphones'}: sounds are placed all around you, above too, and with head tracking they stay put when you turn your head.`
          : 'Dolby Atmos. It plays as Spatial Audio on AirPods (3rd generation or later, Pro or Max) and Beats that support it; the speaker and wired headphones get a stereo version.',
      };
    }
    if (t.channels > 2) {
      const lay = chLabel(t.channels);
      return {
        t, kind: 'surround' + (spatial ? ' spatial' : ''),
        name: spatial ? 'Spatial Audio' : `${lay} Surround`,
        spec: [spatial ? lay : '', t.lossless ? 'Lossless' : (t.codec || '')].filter(Boolean).join(' · '),
        about: spatial
          ? `A ${lay} surround mix, playing as Spatial Audio on ${route.name || 'your headphones'}: each channel is placed around you, and with head tracking the sound stays put when you turn your head.`
          : `A ${lay} surround mix. It plays as Spatial Audio on AirPods (3rd generation or later, Pro or Max) and Beats that support it; ${route && route.name ? route.name + ' gets' : 'the speaker and wired headphones get'} it mixed down to stereo.`,
      };
    }
    return {
      t,
      kind: hi ? 'hires' : t.lossless ? 'lossless' : 'lossy',
      name: hi ? 'Hi-Res Lossless' : t.lossless ? 'Lossless' : (t.codec || 'Compressed'),
      spec,
      about: hi ? 'More detail than a CD: the full studio recording, nothing thrown away. Wired headphones or a good DAC let you hear all of it.'
        : t.lossless ? 'Every bit of the original recording, exactly as it left the studio (CD quality or better). Nothing is thrown away.'
          : 'A compressed file: smaller, with some detail removed to save space. Fine for most listening.',
    };
  }
  /** 6 channels → "5.1", 8 → "7.1" … */
  function chLabel(n) { return ({ 1: 'Mono', 2: 'Stereo', 3: '2.1', 4: '4.0', 5: '5.0', 6: '5.1', 7: '6.1', 8: '7.1', 10: '7.1.2', 12: '7.1.4' })[n] || `${n}-channel`; }
  const waveIcon = () => { const i = h('span', { class: 'npf-q-ico', 'aria-hidden': 'true' }); i.innerHTML = '<svg viewBox="0 0 20 14" width="16" height="12"><path d="M1 7h2M5 3v8M9 1v12M13 4v6M17 6v2" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>'; return i; };
  function drawQuality(t) {
    const q = quality(t);
    F.quality.className = 'npf-q ' + q.kind;
    F.quality.replaceChildren(waveIcon(), h('b', {}, q.name), q.spec ? h('small', {}, q.spec) : '');
    F.quality.hidden = !q.name;
  }
  function showQuality() {
    const t = P && P.player && P.player.track; if (!t) return;
    const q = quality(t);
    const row = (k, v) => (v ? h('div', { class: 'qrow' }, h('span', {}, k), h('b', {}, v)) : null);
    F.qsheet.replaceChildren(h('div', { class: 'npf-qcard ' + q.kind },
      h('div', { class: 'qhead' }, waveIcon(), h('h2', {}, q.name)),
      h('p', {}, q.about),
      row('Format', q.t.codec),
      row('Channels', q.t.channels ? `${chLabel(q.t.channels)}${q.t.channels > 2 ? ' surround' : ''}` : ''),
      P.player && P.player.route && P.player.route.downmix ? row('Sent as', P.player.route.twin ? 'The album’s stereo version' : 'Stereo, mixed down on this device') : null,
      P.player && P.player.route && P.player.route.sonos ? row('Playing on', P.player.route.name) : null,
      row('Spatial Audio', P.player && P.player.route && !P.player.route.sonos ? (P.player.route.spatial ? `On (${P.player.route.name || 'headphones'})`
        : q.t.channels > 2 ? 'Off: needs AirPods or Beats that support it' : '') : ''),
      row('Bit depth', q.t.bitDepth ? `${q.t.bitDepth}-bit` : ''),
      row('Sample rate', q.t.sampleRate ? khz(q.t.sampleRate) : ''),
      row('Bit rate', q.t.bitrate ? `${q.t.bitrate.toLocaleString()} kbps` : ''),
      h('button', { class: 'btn secondary', 'data-b': 'qdone', onclick: () => hideQuality() }, 'Done')));
    F.qsheet.hidden = false; F.qsheet.back = F.quality;
    const d = F.qsheet.querySelector('button'); d && d.focus({ preventScroll: true });
  }
  function hideQuality() { if (F.qsheet.hidden) return false; F.qsheet.hidden = true; (F.qsheet.back || F.quality).focus({ preventScroll: true }); return true; }

  // ---- where it plays: this device or a Sonos room -------------------------------------------------------------
  // The song carries on from where it was; on a Sonos speaker it's the file itself that plays (a Dolby Atmos song
  // stays Dolby Atmos on the speakers that play it).
  const deviceName = /iPad/.test(navigator.userAgent) ? 'This iPad' : /iPhone/.test(navigator.userAgent) ? 'This iPhone' : window.S_ANDROID ? 'This phone' : 'This device';
  let outRooms = null;
  async function showOutputs() {
    const using = (P && P.player && P.player.output && P.player.output.id) || '';
    const card = h('div', { class: 'npf-qcard npf-outs' });
    const draw = (rooms, looking, error) => {
      const row = (id, name, sub, badge) => h('button', { class: 'outrow' + (id === using ? ' on' : ''), 'data-b': 'out-' + (id || 'here'), onclick: () => pick(id, name) },
        h('span', { class: 'out-n' }, h('b', {}, name), sub ? h('small', {}, sub) : null),
        badge ? h('span', { class: 'out-badge' }, badge) : null,
        h('span', { class: 'out-tick' }, id === using ? '✓' : ''));
      card.replaceChildren(
        h('div', { class: 'qhead' }, svg(ICON.speaker), h('h2', {}, 'Play On')),
        row('', deviceName, using ? '' : 'Playing here'),
        ...(rooms || []).map((r) => row(r.id, r.name, r.model ? `Sonos ${r.model}` : 'Sonos', r.atmos ? 'Dolby Atmos' : '')),
        looking ? h('p', { class: 'out-note' }, 'Looking for Sonos speakers on your Wi-Fi…') : null,
        !looking && rooms && !rooms.length ? h('p', { class: 'out-note' }, error || `No Sonos speakers found. ${deviceName} needs to be on the same Wi-Fi as them, and Parlor needs to be allowed on the local network (Settings › Privacy & Security › Local Network).`) : null,
        h('button', { class: 'btn secondary', 'data-b': 'qdone', onclick: () => hideQuality() }, 'Done'));
    };
    const pick = async (id, name) => {
      hideQuality();
      if (id === using) return;
      const r = await api.sonosUse(id);
      if (!r.ok) { ctx.flash(r.error || 'That speaker didn\'t answer.'); return; }
      if (r.player && P) { P.player = r.player; drawFull(false); }
      ctx.flash(id ? `Playing on ${name}` : `Playing on ${deviceName.replace('This', 'this')}`);
    };
    draw(outRooms, true);
    F.qsheet.replaceChildren(card); F.qsheet.hidden = false; F.qsheet.back = F.out;
    const first = card.querySelector('.outrow'); first && first.focus({ preventScroll: true });
    const r = await api.sonosRooms();
    if (F.qsheet.hidden || !card.isConnected) return;
    outRooms = r.ok ? r.rooms : [];
    draw(outRooms, false, r.ok ? '' : r.error);
  }

  // ---- swipe down to close (phones and tablets) ------------------------------------------------------------
  // Pull the screen down from anywhere (once Up Next is scrolled to the top): it follows your finger and closes
  // past a third of the way, or on a quick flick.
  let pull = null;
  full.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || scrubbing || !F.qsheet.hidden || e.target.closest('.npf-scrub, .npf-qsheet')) { pull = null; return; }
    if (queueOpen && F.queue.contains(e.target) && F.queue.scrollTop > 0) { pull = null; return; } // scrolling the queue
    const t = e.touches[0];
    pull = { y: t.clientY, x: t.clientX, t: Date.now(), dy: 0, on: false };
  }, { passive: true });
  full.addEventListener('touchmove', (e) => {
    // nothing here scrolls except the queue (so the page behind doesn't scroll, and no scroll bar appears)
    if (e.cancelable && !e.target.closest('.npf-queue, .npf-qcard')) e.preventDefault();
    if (!pull) return;
    const t = e.touches[0];
    const dy = t.clientY - pull.y, dx = t.clientX - pull.x;
    if (!pull.on) {
      if (Math.abs(dx) > Math.abs(dy) || dy < 8) { if (dy < -8 || Math.abs(dx) > 12) pull = null; return; }
      if (F.body.scrollTop > 0 || (queueOpen && F.queue.contains(e.target) && F.queue.scrollTop > 0)) { pull = null; return; }
      pull.on = true; full.classList.add('pulling');
    }
    e.preventDefault();
    pull.dy = Math.max(0, dy);
    full.style.transform = `translateY(${pull.dy}px)`;
  }, { passive: false });
  full.addEventListener('touchend', () => {
    if (!pull || !pull.on) { pull = null; return; }
    const v = pull.dy / Math.max(1, Date.now() - pull.t);
    const close = pull.dy > window.innerHeight * 0.3 || (v > 0.6 && pull.dy > 60);
    full.classList.remove('pulling'); pull = null;
    if (close) closeFull();
    else full.style.transform = '';
  });
  full.addEventListener('touchcancel', () => { if (pull && pull.on) { full.classList.remove('pulling'); full.style.transform = ''; } pull = null; });

  let fullFrom = null;
  let leaving = null;
  function openFull() {
    clearTimeout(leaving); full.classList.remove('leaving'); full.style.transform = '';
    fullFrom = document.activeElement;
    fullOpen = true; full.hidden = false; full.classList.remove('big');
    document.documentElement.classList.add('np-open');
    statusBar();
    if (matchMedia('(pointer: coarse)').matches) { // slide up from the bottom
      full.style.transition = 'none'; full.style.transform = 'translateY(100%)'; void full.offsetHeight;
      full.style.transition = ''; full.style.transform = '';
    }
    drawFull(true); F.play.focus({ preventScroll: true }); wakeFull();
  }
  /** The album the playing song is from (the artist or album name on the Now Playing screen) */
  function goToAlbum() {
    const t = P && P.player && P.player.track;
    if (!t || !album(t.albumKey)) return;
    closeFull();
    if (ctx.closeModal) ctx.closeModal();
    setTimeout(() => openAlbum(t.albumKey), matchMedia('(pointer: coarse)').matches ? 180 : 0);
  }
  function closeFull() {
    fullOpen = false; clearTimeout(idle); F.qsheet.hidden = true;
    document.documentElement.classList.remove('np-open');
    statusBar();
    // on a touch screen it slides away downwards, like Apple Music
    if (matchMedia('(pointer: coarse)').matches) {
      full.classList.add('leaving');
      full.style.transform = '';
      clearTimeout(leaving);
      leaving = setTimeout(() => { full.hidden = true; full.classList.remove('leaving', 'big'); }, 300);
    } else { full.hidden = true; full.classList.remove('big'); }
    const back = fullFrom && document.body.contains(fullFrom) ? fullFrom : (!chip.hidden ? chip : null);
    if (back) back.focus({ preventScroll: true });
    return true;
  }
  function drawFull(rebuild) {
    const s = P && P.player;
    const t = s && s.track;
    if (!t) return closeFull();
    const a = album(t.albumKey) || { art: t.art, title: t.album, artist: t.artist, key: t.albumKey };
    // (the next song from the same album keeps the same cover and moving cover: nothing is redrawn or restarted)
    const look = [a.key, a.art, a.motion].join('|');
    const sameLook = rebuild && look === lastLook && F.stage.firstChild;
    if (rebuild) lastLook = look;
    if (rebuild && !sameLook) {
      F.bg.style.backgroundImage = a.art ? `url("${fileUrl(a.art)}")` : '';
      F.bg.style.setProperty('--h', hue(a.key || a.title));
      F.bg.classList.toggle('gen', !a.art);
      F.stage.replaceChildren(cover(a, 'huge'));
      // a moving cover also fills the top of the screen behind everything, fading into the controls
      if (F.mbg) { F.mbg.remove(); F.mbg = null; }
      full.classList.toggle('has-motion', !!a.motion);
      if (a.motion) { F.mbg = motion(a); F.mbg.classList.add('npf-motion'); F.bg.after(F.mbg); } // (under the soft edge, F.melt)
    }
    if (rebuild) {
      F.from.textContent = s.context && s.context.name
        ? `Playing from ${s.context.kind === 'album' ? 'the album' : s.context.kind === 'playlist' ? 'the playlist' : s.context.kind === 'artist' ? 'the artist' : ''} ${s.context.name}`.replace(/\s+/g, ' ') : '';
      F.title.textContent = t.title; F.artist.firstChild.textContent = t.artist; F.album.firstChild.textContent = t.album;
      F.caption.replaceChildren(h('b', {}, t.title), h('span', {}, `${t.artist} — ${t.album}`));
    }
    const qlook = [t.id, s.route && s.route.spatial, s.route && s.route.name].join('|');
    if (rebuild || qlook !== lastQLook) { lastQLook = qlook; drawQuality(t); }
    drawQueue();
    if (F.play.dataset.p !== String(!!s.paused)) { F.play.dataset.p = String(!!s.paused); F.play.replaceChildren(svg(s.paused ? ICON.play : ICON.pause)); }
    F.shuf.classList.toggle('on', !!s.shuffle); F.shuf.setAttribute('aria-pressed', String(!!s.shuffle));
    const out = s.output && s.output.name;
    if (F.out) { F.out.classList.toggle('on', !!out); F.out.setAttribute('aria-pressed', String(!!out)); F.out.title = out ? `Playing on ${out}` : 'Play on a speaker'; }
    F.where.hidden = !out; if (out && F.where.textContent !== `Playing on ${out}`) F.where.textContent = `Playing on ${out}`;
    F.volRow.hidden = !out; full.classList.toggle('on-speaker', !!out);
    if (out && !volDragging && document.activeElement !== F.volIn) { F.volIn.value = String(s.volume); F.volIn.style.setProperty('--v', s.volume + '%'); }
    const r = s.repeat || 'off';
    F.rep.classList.toggle('on', r !== 'off'); F.rep.setAttribute('aria-pressed', String(r !== 'off'));
    F.rep.title = r === 'one' ? 'Repeating this song' : r === 'all' ? 'Repeating the queue' : 'Repeat';
    if (F.rep.dataset.mode !== r) { F.rep.dataset.mode = r; F.rep.replaceChildren(svg(r === 'one' ? ICON.repeat1 : ICON.repeat)); }
    full.classList.toggle('paused', !!s.paused);
    F.vol.textContent = `${s.volume}%`;
    // where the song is, as of this update; the bar moves on smoothly from here (see tick)
    if (seekHold && (Math.abs(s.pos - seekHold.to) < 1.5 || Date.now() > seekHold.until)) seekHold = null;
    clock = { pos: seekHold ? seekHold.to : s.pos, at: performance.now(), dur: s.dur || 0, paused: !!s.paused, id: t.id };
    if (seekHold) clock.at = seekHold.at;
    paintTime();
    if (!ticking) { ticking = true; requestAnimationFrame(tick); }
  }
  let clock = null, seekHold = null, ticking = false, lastLook = '', lastQLook = '';
  function paintTime() {
    if (scrubbing || !clock) return; // the finger is in charge of the times while scrubbing
    const pos = Math.min(clock.dur || Infinity, clock.pos + (clock.paused ? 0 : (performance.now() - clock.at) / 1000));
    F.pos.textContent = mmss(pos); F.left.textContent = '-' + mmss(Math.max(0, (clock.dur || 0) - pos));
    F.fill.style.width = (clock.dur ? Math.min(100, (pos / clock.dur) * 100) : 0) + '%';
  }
  function tick() {
    if (!fullOpen || full.hidden) { ticking = false; return; }
    paintTime();
    requestAnimationFrame(tick);
  }

  api.onMusicState((s) => {
    if (!P) return;
    const changed = !P.player || !s.track || !P.player.track || P.player.track.id !== (s.track && s.track.id);
    P.player = s;
    drawBar();
    if (openOnPlay && s.track && s.track.id === openOnPlay) { openOnPlay = null; if (!fullOpen) openFull(); }
    // highlight the playing song in lists
    if (changed) document.querySelectorAll('.srow').forEach((r) => r.classList.toggle('now', !!s.track && r.dataset.id === s.track.id));
    // a new song started: "Recently Played" has moved on (shown next time the page is drawn)
    if (changed && s.track) api.parlorState().then((x) => { if (P) P.recent = x.recent; }).catch(() => {});
  });
  api.onParlorUpdated(async () => { P = await api.parlorState(); drawBar(true); if (ctx.isOpen()) render(); });
  load().then(drawBar).catch(() => {});

  // ---- what app.js calls -----------------------------------------------------------------------------
  return {
    render,
    go,
    statusBar,
    reload: async () => { P = await api.parlorState(); drawBar(true); },
    /** Back button: close the top thing; false when there's nothing left (then app.js leaves the Parlor). */
    back() {
      if (closeOverlay()) return true;
      if (fullOpen && hideQuality()) return true;
      if (fullOpen && queueOpen) return toggleQueue(false);
      if (fullOpen) { if (full.classList.contains('big')) { setBig(false); F.play.focus({ preventScroll: true }); return true; } return closeFull(); }
      if (view !== 'home') { view = history.pop() || 'home'; if (view.startsWith('playlist:') && !P.playlists.some((p) => 'playlist:' + p.id === view)) view = 'home'; render(); return true; }
      return false;
    },
    /** The menu for the highlighted song or album (the keyboard's menu key) */
    menuFor(el) { const r = el.getBoundingClientRect(); return contextMenu(el, r.left + Math.min(40, r.width / 2), r.top + Math.min(r.height, 40)); },
    /** Which part of the screen the remote moves in (overlays first). */
    scope() {
      if ($('#poverlay')) return $('#poverlay');
      if (fullOpen && !F.qsheet.hidden) return F.qsheet;
      if (fullOpen) return full;
      return null;
    },
    onModalClosed() {
      const k = openKey; openKey = null;
      const c = $('#modal .modal-card'); c && c.classList.remove('pmodal');
      const el = k && main.querySelector(`.card[data-key="${CSS.escape(k)}"]`); if (el) el.focus({ preventScroll: true });
    },
    cdIcon,
    noteIcon,
    state: () => P,
    settingsBlock,
  };

  // Settings → Parlor: this profile's music folders.
  function settingsBlock() {
    const box = h('div', { class: 'am-card' }, h('p', { class: 'am-hint' }, 'Checking…'));
    const draw = async () => {
      P = await api.parlorState();
      box.replaceChildren();
      if (!P.canManage) { box.append(h('p', { class: 'am-hint' }, 'Your music is shared with you by a grown-up.')); return; }
      box.append(h('p', { class: 'am-hint' }, window.S_IOS ? 'Your music folders.' : 'Your music folders. Albums found here are yours; share any album with other profiles from its page. Each profile has its own folders.'));
      const pretty = (d) => (ctx.prettyPath ? ctx.prettyPath(d) : d);
      if (P.dirs.length) box.append(h('div', { class: 'dirs' }, P.dirs.map((d) => h('div', { class: 'dir' }, pretty(d),
        h('button', { onclick: async () => { const r = await api.parlorRemoveDir(d); P = r.state; draw(); } }, 'Remove')))));
      else box.append(h('p', {}, 'No music folders yet.'));
      if (P.suggestions.length) {
        box.append(h('p', { class: 'am-hint' }, `Found on ${ctx.here ? ctx.here() : 'this box'}:`), h('div', { class: 'btns' }, P.suggestions.map((d) =>
          h('button', { class: 'btn secondary', onclick: async (e) => { e.target.textContent = 'Adding…'; const r = await api.parlorAddDir(d); P = r.state; ctx.flash('Music added'); draw(); } }, '+ ' + pretty(d)))));
      }
      // iPhone / iPad: your own music folder in the Files app, read where it is
      if (api.parlorLinkFolder) {
        box.append(h('p', { class: 'am-hint' }, 'Keep your music in a folder of your own in the Files app (Artist › Album › songs)? Pick it here and Parlor reads it where it is: songs you add to it or take out of it show up in Parlor by themselves. Import music… makes a copy instead, which doesn’t follow later changes.'));
        box.append(h('div', { class: 'btns' }, h('button', { class: 'btn primary', onclick: async (e) => {
          const b = e.target; const was = b.textContent; b.textContent = 'Reading your folder…'; b.disabled = true;
          const r = await api.parlorLinkFolder();
          b.textContent = was; b.disabled = false;
          if (r.cancelled) return;
          if (!r.ok) { ctx.flash(r.error); return; }
          P = r.state; ctx.flash('Parlor now reads that folder'); draw(); render(); drawBar(true);
        } }, 'Use a music folder from Files…')));
        // the copies an earlier Import music… made, now only in the way
        const own = await api.parlorOwnCopies();
        if (own && own.count && own.linked) {
          const gb = (own.bytes / 1e9).toFixed(1);
          box.append(h('p', { class: 'am-hint' }, `Parlor still has its own copies of ${plural(own.count, 'song')} (${gb} GB) from an earlier Import music…. Songs you take out of your folder stay in Parlor until these copies are gone. Your folder in Files isn’t touched.`));
          let armed = false;
          box.append(h('div', { class: 'btns' }, h('button', { class: 'btn secondary', onclick: async (e) => {
            const b = e.target;
            if (!armed) { armed = true; b.textContent = `Tap again to delete ${(own.count === 1 ? '1 copy' : own.count + ' copies')}`; setTimeout(() => { if (armed) { armed = false; b.textContent = 'Delete Parlor’s copies…'; } }, 5000); return; }
            armed = false; b.textContent = 'Deleting…'; b.disabled = true;
            const r = await api.parlorDeleteOwnCopies();
            if (!r.ok) { ctx.flash(r.error); draw(); return; }
            P = r.state; ctx.flash(`Deleted ${(r.removed === 1 ? '1 copy' : r.removed + ' copies')}`); draw(); render(); drawBar(true);
          } }, 'Delete Parlor’s copies…')));
        }
      }
      box.append(h('div', { class: 'btns' },
        h('button', { class: 'btn secondary', onclick: async () => {
          let dir = null;
          if (ctx.isLinux && ctx.isLinux()) { dir = await ctx.pickPath({ title: 'Add a music folder', mode: 'folder' }); if (!dir) return; }
          const r = await api.parlorAddDir(dir); if (r.ok) { P = r.state; draw(); } else ctx.flash(r.error);
        } }, ctx.isIOS && ctx.isIOS() ? 'Import music…' : 'Add music folder…'),
        P.dirs.length ? h('button', { class: 'btn secondary', onclick: async (e) => {
          e.target.textContent = 'Reading every song…'; e.target.disabled = true;
          const before = P.albums.length;
          P = await api.parlorRescan(); draw(); render(); drawBar(true);
          ctx.flash(`Rescanned: ${plural(P.albums.length, 'album')}${P.albums.length !== before ? ` (${P.albums.length > before ? '+' : ''}${P.albums.length - before})` : ''}`);
        } }, 'Rescan music') : null));
      // what the last scan found, so it's clear whether it saw a new file (and why a file was left out)
      if (api.parlorScanReport) {
        const sr = await api.parlorScanReport();
        if (sr && sr.at) {
          const ago = Math.max(0, Math.round((Date.now() - sr.at) / 60000));
          const why = { video: 'has a picture track (a video, not a song)', nosound: 'has no sound in it', unreadable: "couldn't be opened",
            timeout: 'took too long to open (it will be tried again next scan)',
            unplayable: "can't be played on this phone" };
          box.append(h('p', { class: 'am-hint' }, `Last scan ${ago < 1 ? 'just now' : ago < 60 ? ago + ' min ago' : 'over an hour ago'}: ${plural(sr.songs, 'song')} in ${plural(sr.files, 'file')}, ${sr.read} read afresh${sr.deep ? ' (full rescan)' : ''}.`));
          // every folder the scan found songs in (to compare with the Files app: a new album that isn't listed here isn't
          // in Parlor's folder)
          if (sr.folders && sr.folders.length) {
            const tidy = (d) => (d === '' ? '(Parlor’s folder itself)' : d.replace(/^\/.*?\/Documents\/?/, ''));
            box.append(h('details', { class: 'scan-folders' },
              h('summary', {}, `Folders Parlor looked in (${sr.folders.length}), ${plural(sr.everything || 0, 'file')} in all`),
              h('ul', { class: 'motion-report' }, sr.folders.map((f) => h('li', {}, h('b', {}, tidy(f.dir)), ` · ${plural(f.n, 'file')}`)))));
          }
          if (api.showInFiles) box.append(h('div', { class: 'btns' }, h('button', { class: 'btn secondary', onclick: () => api.showInFiles() }, 'Show Parlor’s folder in Files')));
          if (sr.skipped && sr.skipped.length) box.append(h('ul', { class: 'motion-report' }, sr.skipped.slice(0, 30).map((x) =>
            h('li', {}, h('b', {}, `${x.folder} / ${x.file}`), ` ${why[x.why] || x.why}`, x.why === 'unplayable' && /truehd/i.test(x.codec || '') ? h('span', { class: 'mr-d' }, ' · Dolby TrueHD: save it as Dolby Digital Plus (E-AC-3) Atmos instead') : x.codec ? h('span', { class: 'mr-d' }, ` · ${x.codec}`) : null))));
        }
      }
      if (api.parlorMotionReport) {
        const rep = await api.parlorMotionReport();
        const say = { plays: 'plays', fixed: 'plays (Parlor made a copy the phone can play)', unplayable: "can't be played on this phone",
          unreadable: "couldn't be read", nosongs: 'isn\'t in a folder with songs, so it isn\'t used', name: 'isn\'t used: call it cover.mp4 to make it the album\'s moving cover' };
        box.append(h('p', { class: 'am-hint' }, rep.length ? 'Moving covers found in the last scan:' : 'No moving covers found in the last scan. Put a video called cover.mp4 in an album\'s folder, next to its songs, then tap Rescan music.'));
        if (rep.length) box.append(h('ul', { class: 'motion-report' }, rep.map((r) =>
          h('li', {}, h('b', {}, `${r.album} / ${r.file}`), ` ${say[r.status] || r.status}`, r.detail ? h('span', { class: 'mr-d' }, ` · ${r.detail}`) : null))));
      }
      const noArt = P.albums.filter((a) => !a.art).length;
      if (noArt && api.parlorCoversAuto) {
        box.append(h('p', { class: 'am-hint' }, `${noArt} album${noArt === 1 ? ' has' : 's have'} no cover. Screenroom can look them up online (needs an internet connection) and save each as cover.jpg in the album's folder; or pick one on the album's page.`),
          h('div', { class: 'btns' }, h('button', { class: 'btn secondary', onclick: async (e) => {
            e.target.textContent = 'Looking up covers…';
            const r = await api.parlorCoversAuto();
            if (!r.ok) { ctx.flash(r.error); draw(); return; }
            P = r.state; ctx.flash(`Found ${r.found} of ${r.missing} covers${r.found < r.missing ? ' (the rest can be picked on each album\'s page)' : ''}`); draw(); render();
          } }, 'Find missing covers')));
      }
    };
    draw().catch(() => {});
    return box;
  }
};
