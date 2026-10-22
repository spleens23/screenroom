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
  const fileUrl = (p) => (p ? 'file://' + encodeURI(p).replace(/#/g, '%23').replace(/\?/g, '%3F') : '');
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
    shuffle: '<svg viewBox="0 0 24 24"><path d="M3 7h4l10 10h4M17 13l4 4-4 4M3 17h4l3-3M14 10l3-3h4M17 3l4 4-4 4" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
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
    box.append(h('div', { class: 'gloss' }));
    return box;
  }
  /** Album card artwork: the sleeve, with the record tucked behind it (it slides out when the card is chosen). */
  function sleeve(a) {
    return h('div', { class: 'sleeve' }, vinyl(a, 'peek'), cover(a));
  }

  async function load() {
    if (!loading) loading = api.parlorState().then((s) => { P = s; loading = null; return s; });
    return loading;
  }
  async function refresh() { P = await api.parlorState(); render(); }

  // ---- views -------------------------------------------------------------------------------------------
  function albumCard(a) {
    return h('button', { class: 'card pcard', 'data-key': a.key, title: `${a.title} — ${a.artist}`, onclick: () => openAlbum(a.key) },
      sleeve(a), h('div', { class: 'pcard-t' }, a.title), h('div', { class: 'pcard-s' }, a.artist));
  }
  function playlistCard(pl) {
    const arts = [...new Set(pl.tracks.map((id) => (track(id) || {}).albumKey))].map(album).filter((a) => a && a.art).slice(0, 4);
    const mosaic = h('div', { class: 'cover mosaic' + (arts.length >= 4 ? ' four' : '') },
      ...(arts.length >= 4 ? arts : arts.slice(0, 1)).map((a) => h('img', { src: fileUrl(a.art), alt: '' })),
      arts.length ? null : h('div', { class: 'cover-blank list' }, h('span', {}, '≡')));
    return h('button', { class: 'card pcard', 'data-key': 'pl:' + pl.id, title: pl.name, onclick: () => go('playlist:' + pl.id) },
      mosaic, h('div', { class: 'pcard-t' }, pl.name), h('div', { class: 'pcard-s' }, plural(pl.tracks.length, 'song')));
  }
  const row = (title, cards) => (cards.length ? h('section', { class: 'row' }, h('h2', {}, title), h('div', { class: 'strip' }, cards)) : null);
  const grid = (cards) => h('div', { class: 'grid pgrid' }, cards);
  const page = (title, ...kids) => main.replaceChildren(h('div', { class: 'ppage' }, title ? h('h1', { class: 'page-title' }, title) : null, ...kids));

  function renderEmpty() {
    page(null, h('div', { class: 'pempty' },
      svg(cdIcon(), 'big-cd'),
      h('h1', {}, 'Welcome to the Parlor'),
      P.canManage
        ? [h('p', {}, 'Your music library is empty. Add the folder your music is in: albums found there are yours, and you can share any album with other profiles.'),
            h('button', { class: 'btn primary', onclick: () => ctx.openSettings('parlor') }, 'Add music')]
        : h('p', {}, 'No music yet. Ask a grown-up to share some albums with you.')));
  }

  function renderHome() {
    const recent = P.recent.map(album).filter(Boolean);
    const added = P.albums.slice().sort((a, b) => b.added - a.added).slice(0, 20);
    page(null,
      h('div', { class: 'phead' }, h('h1', {}, 'Parlor'), h('div', { class: 'pstats' },
        `${plural(P.albums.length, 'album')} · ${plural(Object.keys(P.tracks).length, 'song')}`)),
      h('div', { class: 'rows' },
        ctx.albumRecs ? row('Recommended for You', (() => {
          const seen = new Set();
          return ctx.albumRecs().map((x) => ({ ...x, a: album(x.rec.key) })).filter((x) => x.a && !seen.has(x.a.key) && seen.add(x.a.key)).map((x) => {
            const c = albumCard(x.a);
            c.append(h('div', { class: 'card-from' }, ctx.avatar(x.from), `from ${x.from.name}`));
            return c;
          });
        })()) : null,
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
        h('th', {}, 'Artist'), h('th', {}, 'Album'), h('th', { class: 'g' }, 'Genre'), h('th', { class: 'x' }, ''))),
      h('tbody', {}, ids.map((id, i) => {
        const t = track(id);
        if (!t) return null;
        return h('tr', { class: 'srow' + (id === cur ? ' now' : ''), tabindex: '0', 'data-id': id,
          onclick: (e) => { if (e.target.closest('.rowbtn')) return; playIds(ids, i, context); } },
          numbered ? h('td', { class: 'n' }, i + 1) : null,
          h('td', {}, t.title, t.explicit ? h('span', { class: 'e' }, 'E') : null), h('td', { class: 't' }, mmss(t.duration)),
          h('td', {}, t.artist), h('td', {}, t.album), h('td', { class: 'g' }, t.genre || ''),
          h('td', { class: 'x' }, removable
            ? h('button', { class: 'rowbtn', title: 'Remove from playlist', onclick: () => removable(i) }, '✕')
            : h('button', { class: 'rowbtn', title: 'Add to a playlist', onclick: () => pickPlaylist([id]) }, '＋')));
      })));
  }
  function renderSongs() {
    const ids = Object.values(P.tracks).sort((a, b) => a.artist.localeCompare(b.artist) || a.album.localeCompare(b.album) || (a.disc - b.disc) || (a.track - b.track)).map((t) => t.id);
    const ctxs = { kind: 'songs', name: 'Songs' };
    page('Songs',
      ids.length ? h('div', { class: 'btns pbtns' },
        h('button', { class: 'btn primary', onclick: () => playIds(ids, 0, ctxs) }, svg(ICON.play), 'Play'),
        h('button', { class: 'btn secondary', onclick: () => playIds(shuffle(ids), 0, ctxs) }, svg(ICON.shuffle), 'Shuffle')) : null,
      songTable(ids, { context: ctxs }));
  }
  function renderPlaylists() {
    page('Playlists', grid([
      h('button', { class: 'card pcard newpl', 'data-key': 'pl:new', onclick: () => newPlaylist([]) },
        h('div', { class: 'cover cover-blank list' }, h('span', {}, '＋')), h('div', { class: 'pcard-t' }, 'New Playlist'), h('div', { class: 'pcard-s' }, ' ')),
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
          if (!confirm(`Delete the playlist "${pl.name}"? The songs stay in your library.`)) return;
          const r = await api.playlistDelete(pl.id); P = r.state; go('playlists');
        } }, 'Delete')),
      pl.tracks.length ? songTable(pl.tracks, { context: ctxp, numbered: true, removable: async (i) => {
        const r = await api.playlistUpdate(pl.id, { removeAt: i }); P = r.state; render();
      } }) : h('p', { class: 'pnote' }, 'Empty for now. Add songs with ＋ on any album or song.'));
  }

  function renderSearch(q) {
    const s = q.toLowerCase();
    const albums = P.albums.filter((a) => `${a.title} ${a.artist} ${a.genre || ''}`.toLowerCase().includes(s));
    const songs = Object.values(P.tracks).filter((t) => `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(s)).map((t) => t.id);
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
    document.querySelectorAll('#pnav a').forEach((x) => x.classList.toggle('active', x.dataset.pview === view.split(':')[0] || (view.startsWith('artist:') && x.dataset.pview === 'artists') || (view.startsWith('playlist:') && x.dataset.pview === 'playlists')));
    const q = ctx.query();
    if (!P.albums.length) return renderEmpty();
    if (q) return renderSearch(q);
    if (view === 'albums') return page('Albums', grid(P.albums.map(albumCard)));
    if (view === 'artists') return renderArtists();
    if (view.startsWith('artist:')) return renderArtist(view.slice(7));
    if (view === 'songs') return renderSongs();
    if (view === 'playlists') return renderPlaylists();
    if (view.startsWith('playlist:')) return renderPlaylist(view.slice(9));
    renderHome();
  }
  const history = [];
  function go(v) { if (v !== view) history.push(view); view = v; ctx.clearQuery(); render(); window.scrollTo(0, 0); const f = main.querySelector('.btn, .card, .srow'); f && ctx.focusEl(f); }

  // ---- album page (in the shared modal) --------------------------------------------------------------
  let openKey = null;
  function openAlbum(key) { openKey = key; drawAlbum(); ctx.showModal(); const b = $('#modal .btn.primary'); b && b.focus(); }
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
          h('div', { class: 'pmeta' }, [a.genre, a.year, plural(ids.length, 'song'), longDur(a.duration), a.lossless ? 'Lossless' : fmt.codec].filter(Boolean).join(' · ')),
          h('div', { class: 'btns' },
            h('button', { class: 'btn primary', onclick: () => playIds(ids, 0, ctxa) }, svg(ICON.play), 'Play'),
            h('button', { class: 'btn secondary', onclick: () => playIds(shuffle(ids), 0, ctxa) }, svg(ICON.shuffle), 'Shuffle'),
            h('button', { class: 'btn secondary', onclick: () => pickPlaylist(ids) }, '＋ Playlist'),
            P.player && P.player.playing ? h('button', { class: 'btn secondary', onclick: async () => { await api.musicCmd('enqueue', { trackIds: ids, next: true }); ctx.flash('Playing next'); } }, 'Play Next') : null,
            P.canManage && api.parlorCoverSearch ? h('button', { class: 'btn secondary', onclick: () => findCover(a) }, a.art ? 'Change Cover' : 'Find Cover') : null,
            ctx.recommend && ctx.canRecommend() ? h('button', { class: 'btn secondary rec-btn', onclick: () => recommendAlbum(a) }, '➜ Recommend') : null),
          albumRecBanner(a),
          P.canManage ? sharePanel(a) : null)),
      h('table', { class: 'songs tracks' }, h('tbody', {}, albumTracks(a).map((t, i) => {
        const cur = P.player && P.player.track && P.player.track.id === t.id;
        return [
          multiDisc && (i === 0 || albumTracks(a)[i - 1].disc !== t.disc) ? h('tr', { class: 'disc' }, h('td', { colspan: '5' }, `Disc ${t.disc}`)) : null,
          h('tr', { class: 'srow' + (cur ? ' now' : ''), tabindex: '0', 'data-id': t.id, onclick: (e) => { if (e.target.closest('.rowbtn')) return; playIds(ids, i, ctxa); } },
            h('td', { class: 'n' }, cur ? svg(ICON.play, 'ico tiny') : (t.track || i + 1)),
            h('td', {}, t.title, t.explicit ? h('span', { class: 'e' }, 'E') : null, a.various && t.artist !== a.artist ? h('span', { class: 'by' }, ` — ${t.artist}`) : null),
            h('td', { class: 't' }, mmss(t.duration)),
            h('td', { class: 'x' }, h('button', { class: 'rowbtn', title: 'Add to a playlist', onclick: () => pickPlaylist([t.id]) }, '＋')))];
      }).flat())));
    $('#modal-body').replaceChildren(body);
    $('#modal .modal-card').classList.add('pmodal');
    if (focusSel) { const f = $('#modal-body').querySelector(focusSel); f && f.focus(); }
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
  function closeOverlay() { const o = $('#poverlay'); if (o) { o.remove(); return true; } return false; }

  function pickPlaylist(trackIds) {
    overlay('pick', h('h2', {}, `Add ${plural(trackIds.length, 'song')} to…`),
      h('div', { class: 'pick-list' },
        h('button', { class: 'btn secondary', onclick: () => newPlaylist(trackIds) }, '＋ New Playlist…'),
        ...P.playlists.map((pl) => h('button', { class: 'btn secondary', onclick: async () => {
          const r = await api.playlistUpdate(pl.id, { add: trackIds }); P = r.state; closeOverlay(); ctx.flash(`Added to ${pl.name}`);
          if (view === 'playlist:' + pl.id) render();
        } }, pl.name, h('small', {}, `  ${plural(pl.tracks.length, 'song')}`)))),
      h('div', { class: 'btns' }, h('button', { class: 'btn secondary', onclick: closeOverlay }, 'Cancel')));
  }
  function nameDialog(title, value, okLabel, onOk) {
    const input = h('input', { type: 'text', class: 'pin-input', maxlength: '60', value: value || '', placeholder: 'Playlist name (or type it on your phone)' });
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
        !ctx.isTvBox() ? h('button', { class: 'btn secondary', onclick: () => pick(null) }, 'Choose a picture…') : null,
        h('button', { class: 'btn secondary', onclick: closeOverlay }, 'Cancel')));
  }

  // ---- playing -----------------------------------------------------------------------------------------
  let lastPlay = { key: '', at: 0 };
  async function playIds(ids, start, context) {
    // a double-click on a song is one request, not two
    const key = `${ids[start]}|${ids.length}`;
    if (key === lastPlay.key && Date.now() - lastPlay.at < 700) return;
    lastPlay = { key, at: Date.now() };
    const r = await api.musicPlay({ trackIds: ids, start, context });
    if (!r.ok) ctx.flash(r.error || 'Could not play that');
  }

  // Now Playing bar (bottom of the screen, both sides of the app) and the full Now Playing view.
  function noteIcon() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 17.5V5.2l11-2.2v12.4"/><path d="M9 9.2l11-2.2"/><ellipse cx="6.3" cy="17.6" rx="2.7" ry="2.2"/><ellipse cx="17.3" cy="15.5" rx="2.7" ry="2.2"/></svg>'; }
  function cdIcon() { return '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10.2" fill="url(#cdg)" stroke="#8a97a8" stroke-width=".8"/><defs><linearGradient id="cdg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f4f7fb"/><stop offset=".45" stop-color="#b9d3ee"/><stop offset=".55" stop-color="#f1d6ef"/><stop offset="1" stop-color="#dfe8f1"/></linearGradient></defs><circle cx="12" cy="12" r="3.4" fill="#d6dde6" stroke="#8a97a8" stroke-width=".6"/><circle cx="12" cy="12" r="1.3" fill="#3b4652"/></svg>'; }

  // The bar and the full view are built once and then only updated (rebuilding them several times a second
  // made buttons miss clicks).
  const pct = (s) => (s.dur ? Math.min(100, (s.pos / s.dur) * 100) : 0);
  const bar = h('div', { id: 'npbar', hidden: true, 'data-navrow': '1' });
  const B = {
    art: h('button', { class: 'npb-art', 'data-b': 'art', title: 'Now Playing', onclick: () => openFull() }),
    prev: h('button', { class: 'npb', 'data-b': 'prev', title: 'Previous', onclick: () => api.musicCmd('prev') }, svg(ICON.prev)),
    play: h('button', { class: 'npb big', 'data-b': 'play', title: 'Play / Pause', onclick: () => api.musicCmd('toggle') }),
    next: h('button', { class: 'npb', 'data-b': 'next', title: 'Next', onclick: () => api.musicCmd('next') }, svg(ICON.next)),
    title: h('div', { class: 'lcd-t' }), sub: h('div', { class: 'lcd-s' }),
    pos: h('span', {}), fill: h('div', {}), left: h('span', {}),
  };
  B.lcd = h('button', { class: 'lcd', 'data-b': 'lcd', title: 'Now Playing', onclick: () => openFull() },
    B.title, B.sub, h('div', { class: 'lcd-p' }, B.pos, h('div', { class: 'lcd-bar' }, B.fill), B.left));
  bar.append(B.art, h('div', { class: 'npb-ctrl' }, B.prev, B.play, B.next), B.lcd);
  document.body.append(bar);
  // A "Now Playing" button in the top bar, on both sides of the app: always one press of Back away
  // (Back jumps to the top bar), so the music is easy to reach with a remote from anywhere.
  const chipTitle = h('span', { class: 'npc-t' });
  const chip = h('button', { id: 'np-chip', hidden: true, title: 'Now Playing', onclick: () => openFull() },
    h('span', { class: 'npc-disc' }), chipTitle);
  const navRight = $('#nav .nav-right');
  if (navRight) navRight.prepend(chip);
  let fullOpen = false;
  let lastTrack = null, lastPaused = null;

  function drawBar(force) {
    const s = P && P.player;
    const t = s && s.track;
    bar.hidden = !t;
    chip.hidden = !t;
    document.body.classList.toggle('has-npbar', !!t);
    document.body.classList.toggle('music-paused', !!(s && s.paused));
    if (!t) { lastTrack = null; if (fullOpen) closeFull(); return; }
    if (force || !lastTrack || lastTrack !== t.id) {
      const a = album(t.albumKey) || { art: t.art, title: t.album, artist: t.artist, key: t.albumKey };
      B.art.replaceChildren(cover(a, 'tiny'));
      B.title.textContent = t.title; B.sub.textContent = `${t.artist} — ${t.album}`;
      chipTitle.textContent = t.title;
    }
    if (force || lastPaused !== s.paused) B.play.replaceChildren(svg(s.paused ? ICON.play : ICON.pause));
    B.pos.textContent = mmss(s.pos); B.left.textContent = '-' + mmss((s.dur || 0) - s.pos);
    B.fill.style.width = pct(s) + '%';
    if (fullOpen) drawFull(force || lastTrack !== t.id || lastPaused !== s.paused);
    lastTrack = t.id; lastPaused = s.paused;
  }

  // ---- the full Now Playing screen: the record on the turntable ----------------------------------------
  // Left: the sleeve (tilted, glossy) with the record slid out and spinning while it plays.
  // Right: song, artist, album, progress, big controls and Up Next. After a while without a key press the
  // controls fade away and the cover fills the screen (any key brings them back) — "big cover" mode.
  const full = h('div', { id: 'npfull', hidden: true });
  const F = {
    bg: h('div', { class: 'npf-bg' }),
    stage: h('button', { class: 'npf-stage', 'data-b': 'stage', title: 'Big cover', onclick: () => setBig(!full.classList.contains('big')) }),
    from: h('div', { class: 'npf-from' }), title: h('h1', {}), artist: h('h2', {}), album: h('h3', {}),
    pos: h('span', {}), left: h('span', {}), fill: h('div', {}),
    vol: h('span', { class: 'npf-vol' }), upnext: h('div', { class: 'upnext' }),
    caption: h('div', { class: 'npf-caption' }),
  };
  F.close = h('button', { class: 'np-close', 'data-b': 'close', 'aria-label': 'Close', title: 'Close (Back)', onclick: () => closeFull() }, '✕');
  F.bigBtn = h('button', { class: 'np-close np-big', 'data-b': 'big', title: 'Big cover', onclick: () => setBig(true) }, '⤢');
  F.barBtn = h('button', { class: 'npf-bar', 'data-b': 'bar', title: 'Left / right: skip 10 seconds',
    onclick: (e) => { const s = P.player; const r = e.currentTarget.getBoundingClientRect(); if (e.clientX && s) api.musicCmd('seek', ((e.clientX - r.left) / r.width) * (s.dur || 0)); },
    onkeydown: (e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); wakeFull(); api.musicCmd('seek', P.player.pos + (e.key === 'ArrowLeft' ? -10 : 10)); } } }, F.fill);
  F.play = h('button', { class: 'npb big', 'data-b': 'play', title: 'Play / Pause', onclick: () => api.musicCmd('toggle') });
  F.ctrl = h('div', { class: 'npf-ctrl', 'data-navrow': '1' },
    h('button', { class: 'npb', 'data-b': 'prev', title: 'Previous', onclick: () => api.musicCmd('prev') }, svg(ICON.prev)),
    F.play,
    h('button', { class: 'npb', 'data-b': 'next', title: 'Next', onclick: () => api.musicCmd('next') }, svg(ICON.next)),
    h('button', { class: 'npb vol', 'data-b': 'vdown', title: 'Quieter', onclick: () => api.musicCmd('volume', P.player.volume - 10) }, '−'),
    F.vol,
    h('button', { class: 'npb vol', 'data-b': 'vup', title: 'Louder', onclick: () => api.musicCmd('volume', P.player.volume + 10) }, '+'));
  full.append(F.bg, h('div', { class: 'npf-top', 'data-navrow': '1' }, F.bigBtn, F.close),
    h('div', { class: 'npf' }, F.stage,
      h('div', { class: 'npf-side' }, F.from, F.title, F.artist, F.album,
        h('div', { class: 'npf-prog' }, F.pos, F.barBtn, F.left), F.ctrl, F.upnext)),
    F.caption);
  document.body.append(full);

  let idle = null;
  const BIG_AFTER = 25000;
  function setBig(on) {
    full.classList.toggle('big', !!on);
    if (on) { F.stage.focus({ preventScroll: true }); } else wakeFull();
  }
  function wakeFull() {
    clearTimeout(idle);
    if (fullOpen) idle = setTimeout(() => { if (fullOpen && !full.contains(document.querySelector('.poverlay'))) setBig(true); }, BIG_AFTER);
  }
  // In big-cover mode the first key / click only brings the controls back.
  full.addEventListener('keydown', (e) => {
    if (full.classList.contains('big') && !['MediaPlayPause', 'MediaTrackNext', 'MediaTrackPrevious'].includes(e.key)) {
      e.preventDefault(); e.stopPropagation(); setBig(false); const b = F.play; b.focus({ preventScroll: true }); return;
    }
    wakeFull();
  }, true);
  full.addEventListener('mousemove', () => { if (!full.classList.contains('big')) wakeFull(); });

  let fullFrom = null;
  function openFull() {
    fullFrom = document.activeElement;
    fullOpen = true; full.hidden = false; full.classList.remove('big');
    drawFull(true); F.play.focus({ preventScroll: true }); wakeFull();
  }
  function closeFull() {
    fullOpen = false; full.hidden = true; full.classList.remove('big'); clearTimeout(idle);
    const back = fullFrom && document.body.contains(fullFrom) ? fullFrom : (!chip.hidden ? chip : null);
    if (back) back.focus({ preventScroll: true });
    return true;
  }
  function drawFull(rebuild) {
    const s = P && P.player;
    const t = s && s.track;
    if (!t) return closeFull();
    const a = album(t.albumKey) || { art: t.art, title: t.album, artist: t.artist, key: t.albumKey };
    if (rebuild) {
      F.bg.style.backgroundImage = a.art ? `url("${fileUrl(a.art)}")` : '';
      F.bg.style.setProperty('--h', hue(a.key || a.title));
      F.bg.classList.toggle('gen', !a.art);
      F.stage.replaceChildren(h('div', { class: 'turntable' }, vinyl(a, 'out'), cover(a, 'huge')));
      F.from.textContent = s.context && s.context.name
        ? `Playing from ${s.context.kind === 'album' ? 'the album' : s.context.kind === 'playlist' ? 'the playlist' : s.context.kind === 'artist' ? 'the artist' : ''} ${s.context.name}`.replace(/\s+/g, ' ') : '';
      F.title.textContent = t.title; F.artist.textContent = t.artist; F.album.textContent = t.album;
      F.caption.replaceChildren(h('b', {}, t.title), h('span', {}, `${t.artist} — ${t.album}`));
      F.play.replaceChildren(svg(s.paused ? ICON.play : ICON.pause));
      const nxt = s.queue.slice(s.index + 1, s.index + 6);
      const keep = document.activeElement && F.upnext.contains(document.activeElement) ? document.activeElement.dataset.b : null;
      F.upnext.hidden = !nxt.length;
      F.upnext.replaceChildren(h('div', { class: 'upnext-t' }, 'Up Next'),
        ...nxt.map((q, i) => h('button', { class: 'upnext-i', 'data-b': 'q' + i, onclick: () => api.musicCmd('jump', s.index + 1 + i) },
          h('span', {}, q.title), h('small', {}, q.artist))));
      if (keep) { const k = F.upnext.querySelector(`[data-b="${keep}"]`); (k || F.play).focus({ preventScroll: true }); }
    }
    full.classList.toggle('paused', !!s.paused);
    F.pos.textContent = mmss(s.pos); F.left.textContent = '-' + mmss((s.dur || 0) - s.pos);
    F.fill.style.width = pct(s) + '%';
    F.vol.textContent = `${s.volume}%`;
  }

  api.onMusicState((s) => {
    if (!P) return;
    const changed = !P.player || !s.track || !P.player.track || P.player.track.id !== (s.track && s.track.id);
    P.player = s;
    drawBar();
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
    reload: async () => { P = await api.parlorState(); drawBar(true); },
    /** Back button: close the top thing; false when there's nothing left (then app.js leaves the Parlor). */
    back() {
      if (closeOverlay()) return true;
      if (fullOpen) { if (full.classList.contains('big')) { setBig(false); F.play.focus({ preventScroll: true }); return true; } return closeFull(); }
      if (view !== 'home') { view = history.pop() || 'home'; if (view.startsWith('playlist:') && !P.playlists.some((p) => 'playlist:' + p.id === view)) view = 'home'; render(); return true; }
      return false;
    },
    /** Which part of the screen the remote moves in (overlays first). */
    scope() {
      if ($('#poverlay')) return $('#poverlay');
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
      box.append(h('p', { class: 'am-hint' }, 'Your music folders. Albums found here are yours; share any album with other profiles from its page. Each profile has its own folders.'));
      if (P.dirs.length) box.append(h('div', { class: 'dirs' }, P.dirs.map((d) => h('div', { class: 'dir' }, d,
        h('button', { onclick: async () => { const r = await api.parlorRemoveDir(d); P = r.state; draw(); } }, 'Remove')))));
      else box.append(h('p', {}, 'No music folders yet.'));
      if (P.suggestions.length) {
        box.append(h('p', { class: 'am-hint' }, 'Found on this box:'), h('div', { class: 'btns' }, P.suggestions.map((d) =>
          h('button', { class: 'btn secondary', onclick: async (e) => { e.target.textContent = 'Adding…'; const r = await api.parlorAddDir(d); P = r.state; ctx.flash('Music added'); draw(); } }, '＋ ' + d))));
      }
      box.append(h('div', { class: 'btns' },
        h('button', { class: 'btn secondary', onclick: async () => { const r = await api.parlorAddDir(); if (r.ok) { P = r.state; draw(); } else ctx.flash(r.error); } }, 'Add music folder…'),
        P.dirs.length ? h('button', { class: 'btn secondary', onclick: async (e) => { e.target.textContent = 'Scanning…'; P = await api.parlorRescan(); draw(); } }, 'Rescan music') : null));
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
