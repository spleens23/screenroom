(() => {
  const $ = (s) => document.querySelector(s);
  const main = $('#main');
  let S = { library: [], progress: {}, config: {}, mpvFound: true, ffprobeFound: true };
  let view = 'home';
  let query = '';

  if (navigator.platform.includes('Mac')) document.body.classList.add('mac');

  // ---- helpers -------------------------------------------------------------
  function h(tag, attrs = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const fileUrl = (p) => p ? 'file://' + encodeURI(p).replace(/#/g, '%23').replace(/\?/g, '%3F') : '';
  const bg = (p) => (p ? `background-image:url("${fileUrl(p)}")` : '');
  const fmtDur = (s) => { const m = Math.round(s / 60); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; };
  const fmtTime = (s) => { s = Math.floor(s); const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    return (hh ? hh + ':' + String(mm).padStart(2, '0') : mm) + ':' + String(ss).padStart(2, '0'); };
  const seasonLabel = (n) => (n === 0 ? 'Specials' : `Season ${n}`);
  const epLabel = (ep) => `S${ep.tv.season}:E${ep.tv.label || ep.tv.episode}`;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  // ---- catalog: movies stay single titles, episodes roll up into one series each --------
  function buildCatalog(items) {
    const movies = [];
    const bySeries = new Map();
    for (const it of items) {
      if (it.tv) {
        const key = it.tv.series.toLowerCase();
        if (!bySeries.has(key)) bySeries.set(key, []);
        bySeries.get(key).push(it);
      } else {
        movies.push({ kind: 'movie', key: it.id, name: it.title, item: it, items: [it], art: it.art, backdrop: it.backdrop || it.art,
          description: it.description, genres: it.genres, year: it.year, mtime: it.mtime });
      }
    }
    const series = [];
    for (const [key, eps] of bySeries) {
      eps.sort((a, b) => (a.tv.order - b.tv.order) || a.path.localeCompare(b.path));
      const seasons = new Map();
      for (const e of eps) { if (!seasons.has(e.tv.season)) seasons.set(e.tv.season, []); seasons.get(e.tv.season).push(e); }
      const first = eps[0];
      const years = eps.map((e) => e.year).filter(Boolean);
      series.push({
        kind: 'series', key, name: first.tv.series, eps, items: eps, seasons,
        art: (eps.find((e) => e.art) || {}).art, backdrop: (eps.find((e) => e.backdrop) || {}).backdrop || (eps.find((e) => e.art) || {}).art,
        description: (eps.find((e) => e.description) || {}).description || '',
        genres: [...new Set(eps.flatMap((e) => e.genres))],
        year: years.length ? Math.min(...years) : null, yearEnd: years.length ? Math.max(...years) : null,
        mtime: Math.max(...eps.map((e) => e.mtime)),
      });
    }
    return [...movies, ...series].sort((a, b) => a.name.localeCompare(b.name));
  }
  const catalogOf = (pred) => buildCatalog(pred ? S.library.filter(pred) : S.library);
  const fullEntry = (key) => buildCatalog(S.library).find((e) => e.key === key);

  const RES_RANK = { '4K': 4, '1080p': 3, '720p': 2 };
  const resOf = (it) => (it.video ? it.video.res : '');
  const isHD = (it) => resOf(it) === '1080p' || resOf(it) === '720p';
  const isSD = (it) => it.video && !['4K', '1080p', '720p'].includes(it.video.res);

  function badges(items) {
    const out = [];
    const best = items.map(resOf).sort((a, b) => (RES_RANK[b] || 0) - (RES_RANK[a] || 0))[0];
    if (RES_RANK[best]) out.push(h('span', { class: 'badge' }, best));
    if (items.some((i) => i.video && i.video.hdr)) out.push(h('span', { class: 'badge hdr' }, items.some((i) => i.video && i.video.dv) ? 'DV' : 'HDR'));
    const audio = items.flatMap((i) => i.audio);
    if (audio.some((a) => a.family === 'dolby')) out.push(h('span', { class: 'badge dolby' }, audio.some((a) => /Atmos/.test(a.label)) ? 'ATMOS' : 'DOLBY'));
    if (audio.some((a) => a.family === 'dts')) {
      const lab = audio.filter((a) => a.family === 'dts').sort((a, b) => b.channels - a.channels)[0].label;
      out.push(h('span', { class: 'badge dts' }, lab.replace('DTS-HD MA', 'DTS-HD')));
    }
    return out;
  }

  // ---- watch state -----------------------------------------------------------
  const prog = (id) => S.progress[id];
  const isDone = (id) => !!(S.progress[id] && S.progress[id].done);

  // What to watch next in a series: resume the latest episode, or move on to the one after a finished episode.
  function nextUp(series) {
    let last = null;
    for (const ep of series.eps) {
      const p = prog(ep.id);
      if (p && (!last || p.updated > last.p.updated)) last = { ep, p };
    }
    if (!last) return { ep: series.eps[0], mode: 'start', updated: 0 };
    if (!last.p.done) return { ep: last.ep, mode: 'resume', p: last.p, updated: last.p.updated };
    const nxt = series.eps[series.eps.indexOf(last.ep) + 1];
    return nxt ? { ep: nxt, mode: 'next', updated: last.p.updated } : { ep: series.eps[0], mode: 'finished', updated: last.p.updated };
  }

  // Continue Watching: unfinished movies and the next-up episode of any series you've started.
  function continueList(entries) {
    const out = [];
    for (const e of entries) {
      if (e.kind === 'movie') {
        const p = prog(e.item.id);
        if (p && !p.done && p.pos > 5) out.push({ entry: e, updated: p.updated, ep: null, p });
      } else {
        const n = nextUp(e);
        if (n.mode === 'resume' || n.mode === 'next') out.push({ entry: e, updated: n.updated, ep: n.ep, p: n.mode === 'resume' ? n.p : null });
      }
    }
    return out.sort((a, b) => b.updated - a.updated);
  }

  function playLabel(entry) {
    if (entry.kind === 'movie') { const p = prog(entry.item.id); return p && !p.done && p.pos > 5 ? '▶ Resume' : '▶ Play'; }
    const n = nextUp(entry);
    if (n.mode === 'resume') return `▶ Resume ${epLabel(n.ep)}`;
    if (n.mode === 'next') return `▶ Play ${epLabel(n.ep)}`;
    return multiSeason(entry) ? '▶ Play S1:E1' : '▶ Play';
  }
  const multiSeason = (s) => s.seasons.size > 1;

  function playEntry(entry) {
    if (entry.kind === 'movie') return start(entry.item.id);
    const n = nextUp(entry);
    return start(n.ep.id, null, n.mode === 'finished');
  }

  // ---- matching / rows -------------------------------------------------------
  function matches(it) {
    if (!query) return true;
    const q = query.toLowerCase();
    return [it.title, it.tv && it.tv.series, it.tv && it.tv.name, it.description, it.artist, it.genres.join(' ')].join(' ').toLowerCase().includes(q);
  }

  function rowsFor() {
    const all = catalogOf();
    const rows = [];
    const cont = continueList(all);
    if (cont.length) rows.push(['Continue Watching', cont]);
    rows.push(['Recently Added', [...all].sort((a, b) => b.mtime - a.mtime).slice(0, 20)]);
    const shows = all.filter((e) => e.kind === 'series');
    const movies = all.filter((e) => e.kind === 'movie');
    if (shows.length && movies.length) { rows.push(['TV Shows', shows]); rows.push(['Movies', movies]); }
    const uhd = catalogOf((i) => resOf(i) === '4K');
    if (uhd.length) rows.push(['4K Ultra HD', uhd]);
    const atmos = catalogOf((i) => i.audio.some((a) => /Atmos/.test(a.label)));
    if (atmos.length) rows.push(['Dolby Atmos', atmos]);
    const dts = catalogOf((i) => i.audio.some((a) => a.family === 'dts'));
    if (dts.length) rows.push(['DTS Sound', dts]);
    const byGenre = new Map();
    for (const e of all) for (const g of e.genres) { if (!byGenre.has(g)) byGenre.set(g, []); byGenre.get(g).push(e); }
    [...byGenre.entries()].sort((a, b) => b[1].length - a[1].length).forEach(([g, list]) => rows.push([g, list]));
    return rows;
  }

  // ---- rendering -------------------------------------------------------------
  function card(entry, cont) {
    let pct = 0, sub = '';
    if (entry.kind === 'series') {
      sub = cont && cont.ep ? epLabel(cont.ep) : plural(entry.seasons.size, 'Season');
      if (cont && cont.p && cont.p.dur) pct = Math.min(100, (cont.p.pos / cont.p.dur) * 100);
    } else {
      const p = prog(entry.item.id);
      if (p && !p.done && p.dur) pct = Math.min(100, (p.pos / p.dur) * 100);
    }
    return h('button', { class: 'card', style: bg(entry.art), 'data-key': entry.key, title: entry.name, onclick: () => openEntry(entry.key, cont && cont.ep && cont.ep.id) },
      h('div', { class: 'badges' }, badges(entry.items).slice(0, 2)),
      h('div', { class: 'ttl' }, entry.name, sub ? h('span', { class: 'sub' }, sub) : null),
      pct ? h('div', { class: 'bar', style: `width:${pct}%` }) : null);
  }

  function renderEmpty() {
    main.replaceChildren(h('div', { class: 'empty' },
      h('h2', {}, 'Add your media'),
      h('p', {}, 'Add your MP4 files and Screenroom reads titles, descriptions, genres and cover art straight from each file. TV shows are grouped from Series / Season / S#E# Name.mp4.'),
      !S.ffprobeFound ? h('div', { class: 'warn' }, 'ffprobe was not found. Install ffmpeg (brew install ffmpeg / apt install ffmpeg).') : null,
      addMediaPanel(),
      h('p', { class: 'am-hint' }, 'Already have the files on this computer or a mounted drive?'),
      h('button', { class: 'btn primary', onclick: async () => { setScanning(true); S = await api.addDir(); setScanning(false); render(); } }, 'Choose folders…')));
  }

  let heroKey = null;
  function pickHero(rows) {
    const all = catalogOf().filter((e) => e.backdrop);
    if (!all.length) return null;
    let e = all.find((x) => x.key === heroKey);
    if (!e) {
      const cont = rows.length && rows[0][0] === 'Continue Watching' ? rows[0][1].map((c) => c.entry).find((x) => x.backdrop) : null;
      e = cont || all[Math.floor(Math.random() * all.length)];
      heroKey = e.key;
    }
    return e;
  }

  function metaLine(e) {
    const bits = [];
    if (e.kind === 'series') {
      if (e.year) bits.push(e.yearEnd && e.yearEnd !== e.year ? `${e.year}–${e.yearEnd}` : e.year);
      bits.push(plural(e.seasons.size, 'Season'));
    } else {
      if (e.year) bits.push(e.year);
      if (e.item.duration) bits.push(fmtDur(e.item.duration));
    }
    return bits.map((b) => h('span', {}, b));
  }

  function renderHome() {
    const rows = rowsFor();
    const hero = pickHero(rows);
    const frag = [];
    if (hero) {
      frag.push(h('section', { class: 'hero', style: bg(hero.backdrop) },
        h('div', { class: 'hero-info' },
          h('h1', {}, hero.name),
          h('div', { class: 'meta' }, metaLine(hero), badges(hero.items)),
          h('p', {}, hero.description),
          h('div', { class: 'btns' },
            h('button', { class: 'btn primary', onclick: () => playEntry(fullEntry(hero.key)) }, playLabel(fullEntry(hero.key))),
            h('button', { class: 'btn secondary', onclick: () => openEntry(hero.key) }, 'ⓘ More Info')))));
    }
    frag.push(h('div', { class: 'rows' }, rows.map(([name, list]) =>
      h('section', { class: 'row' }, h('h2', {}, name),
        h('div', { class: 'strip' }, list.map((x) => (x.entry ? card(x.entry, x) : card(x))))))));
    main.replaceChildren(...frag);
  }

  function renderGrid(title, entries) {
    main.replaceChildren(h('h1', { class: 'page-title' }, title),
      entries.length ? h('div', { class: 'grid' }, entries.map((e) => card(e))) : h('div', { class: 'empty' }, h('p', {}, 'Nothing here.')));
  }

  const VIEWS = {
    tv: ['TV Shows', (i) => !!i.tv],
    movies: ['Movies', (i) => !i.tv],
    '4k': ['4K Ultra HD', (i) => resOf(i) === '4K'],
    hd: ['HD (720p / 1080p)', isHD],
    sd: ['SD (480p and below)', isSD],
  };

  function render() {
    document.body.classList.toggle('tv', !!S.tv);
    $('#nav').classList.toggle('solid', view !== 'home' || !!query);
    if (!S.library.length) return renderEmpty();
    if (query) return renderGrid(`Results for “${query}”`, catalogOf(matches));
    if (view === 'all') return renderGrid('Library', catalogOf());
    if (VIEWS[view]) return renderGrid(VIEWS[view][0], catalogOf(VIEWS[view][1]));
    renderHome();
  }

  // ---- detail modal ------------------------------------------------------------
  let open = null; // { key, season, focusEp }
  let selectedAudio = null;

  function openEntry(key, focusEp) {
    const e = fullEntry(key);
    if (!e) return;
    open = { key, season: null, focusEp: focusEp || null, returnKey: key };
    if (e.kind === 'series') {
      const n = nextUp(e);
      open.season = (focusEp ? S.library.find((i) => i.id === focusEp) : n.ep).tv.season;
    }
    renderModal();
    $('#modal').hidden = false;
    $('#modal').scrollTop = 0;
    const first = $('#modal .btn.primary'); first && first.focus();
  }
  const closeModal = () => {
    const back = open && open.returnKey;
    $('#modal').hidden = true; open = null;
    const el = back && document.querySelector(`.card[data-key="${CSS.escape(back)}"]`);
    if (el) el.focus({ preventScroll: false });
  };

  function renderModal() {
    if (!open) return;
    const e = fullEntry(open.key);
    if (!e) return closeModal();
    $('#modal-body').replaceChildren(...(e.kind === 'series' ? seriesDetail(e) : movieDetail(e)));
  }

  function heroBlock(e, extraBtns) {
    return h('div', { class: 'm-hero', style: bg(e.backdrop) },
      h('div', { class: 'm-actions' }, h('h1', {}, e.name),
        h('div', { class: 'btns' }, h('button', { class: 'btn primary', onclick: () => playEntry(e) }, playLabel(e)), extraBtns)));
  }

  function movieDetail(e) {
    const item = e.item;
    const p = prog(item.id);
    const resumable = p && !p.done && p.pos > 5;
    const def = item.audio.find((a) => a.default) || item.audio[0];
    selectedAudio = def ? def.n : null;
    const v = item.video || {};
    const trackEls = item.audio.map((a) => {
      const el = h('div', { class: 'track' + (a.n === selectedAudio ? ' sel' : ''), tabindex: '0',
        onclick: () => { selectedAudio = a.n; document.querySelectorAll('.track').forEach((t) => t.classList.remove('sel')); el.classList.add('sel'); },
        onkeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); el.click(); } } },
        h('span', { class: 'badge ' + a.family }, a.family === 'dolby' ? 'DOLBY' : a.family === 'dts' ? 'DTS' : 'AUDIO'),
        h('span', { class: 'lab' }, a.label),
        h('span', { class: 'sub' }, [a.layout, a.lang, a.title].filter(Boolean).join(' · ')));
      return el;
    });
    return [
      h('div', { class: 'm-hero', style: bg(e.backdrop) },
        h('div', { class: 'm-actions' }, h('h1', {}, e.name),
          h('div', { class: 'btns' },
            h('button', { class: 'btn primary', onclick: () => start(item.id, selectedAudio) }, resumable ? `▶ Resume ${fmtTime(p.pos)}` : '▶ Play'),
            resumable ? h('button', { class: 'btn secondary', onclick: () => start(item.id, selectedAudio, true) }, '↺ From start') : null,
            h('button', { class: 'btn secondary', title: p && p.done ? 'Mark as unwatched' : 'Mark as watched',
              onclick: async () => { S = await api.setWatched([item.id], !(p && p.done)); renderModal(); render(); } }, p && p.done ? '✓ Watched' : '＋ Mark watched')))),
      h('div', { class: 'm-body' },
        h('div', {},
          h('div', { class: 'meta' }, metaLine(e), badges([item])),
          h('p', {}, item.description || 'No description.'),
          item.audio.length ? h('div', { class: 'tracks' }, h('h3', {}, 'Audio'), trackEls) : null),
        h('div', { class: 'side' },
          item.genres.length ? h('div', {}, h('b', {}, 'Genres: '), item.genres.join(', ')) : null,
          item.artist ? h('div', {}, h('b', {}, 'Credits: '), item.artist) : null,
          h('div', {}, h('b', {}, 'Video: '), [v.codec, v.width && `${v.width}×${v.height}`, v.fps && `${v.fps}fps`, v.hdr].filter(Boolean).join(' · ')),
          h('div', {}, h('b', {}, 'Subtitles: '), item.subs.length ? item.subs.map((s) => s.lang || s.codec).join(', ') : 'none'),
          h('div', {}, h('b', {}, 'Size: '), (item.size / 1e9).toFixed(2) + ' GB'),
          h('div', {}, h('button', { class: 'link', onclick: () => api.reveal(item.path) }, 'Show in folder')))),
    ];
  }

  function seriesDetail(e) {
    const seasons = [...e.seasons.keys()].sort((a, b) => a - b);
    if (!seasons.includes(open.season)) open.season = seasons[0];
    const eps = e.seasons.get(open.season);

    const select = seasons.length > 1
      ? h('div', { class: 'chips' }, seasons.map((n) => h('button', {
        class: 'chip' + (n === open.season ? ' on' : ''),
        onclick: () => { open.season = n; open.focusEp = null; renderModal(); const c = document.querySelector('.chip.on'); c && c.focus(); },
      }, seasonLabel(n))))
      : null;

    const epRows = eps.map((ep) => {
      const p = prog(ep.id);
      const done = !!(p && p.done);
      const pct = p && !p.done && p.dur ? Math.min(100, (p.pos / p.dur) * 100) : 0;
      const row = h('div', { class: 'ep' + (open.focusEp === ep.id ? ' focus' : ''), tabindex: '0', 'data-ep': ep.id,
        onclick: () => start(ep.id, null, false),
        onkeydown: (ev) => { if (ev.key === 'Enter') start(ep.id); } },
        h('div', { class: 'ep-n' }, ep.tv.label || ep.tv.episode),
        h('div', { class: 'ep-thumb', style: bg(ep.backdrop || ep.art) },
          h('div', { class: 'ep-play' }, '▶'),
          pct ? h('div', { class: 'bar', style: `width:${pct}%` }) : null),
        h('div', { class: 'ep-info' },
          h('div', { class: 'ep-head' }, h('span', { class: 'ep-name' }, ep.tv.name),
            h('span', { class: 'ep-dur' }, ep.duration ? fmtDur(ep.duration) : ''),),
          h('div', { class: 'ep-desc' }, ep.description || ''),
          h('div', { class: 'ep-badges' }, badges([ep]))),
        h('button', { class: 'ep-watch' + (done ? ' on' : ''), title: done ? 'Mark as unwatched' : 'Mark as watched',
          onclick: async (ev) => { ev.stopPropagation(); S = await api.setWatched([ep.id], !done); renderModal(); render(); } }, '✓'));
      return row;
    });

    const n = nextUp(e);
    const resumeBtn = n.mode === 'resume'
      ? h('button', { class: 'btn secondary', onclick: () => start(n.ep.id, null, true) }, '↺ From start') : null;

    const node = [
      heroBlock(e, resumeBtn),
      h('div', { class: 'm-body' },
        h('div', {},
          h('div', { class: 'meta' }, metaLine(e), badges(e.items)),
          h('p', {}, e.description || ''),
          h('h3', { class: 'ep-title' }, 'Episodes'), select ? h('div', { class: 'ep-top' }, select) : null,
          h('div', { class: 'eps' }, epRows)),
        h('div', { class: 'side' },
          e.genres.length ? h('div', {}, h('b', {}, 'Genres: '), e.genres.join(', ')) : null,
          h('div', {}, h('b', {}, 'Seasons: '), e.seasons.size),
          h('div', {}, h('b', {}, 'Episodes: '), e.eps.length),
          h('div', {}, h('b', {}, 'Watched: '), `${e.eps.filter((x) => isDone(x.id)).length} of ${e.eps.length}`),
          h('div', {}, h('button', { class: 'link', onclick: () => api.reveal(e.eps[0].path) }, 'Show in folder')))),
    ];
    // scroll the focused episode into view after the modal paints
    if (open.focusEp) setTimeout(() => { const el = document.querySelector(`.ep[data-ep="${open.focusEp}"]`); el && el.scrollIntoView({ block: 'center' }); }, 30);
    return node;
  }

  async function start(id, audioTrack, fromStart) {
    const r = await api.play({ id, audioTrack, fromStart });
    if (!r.ok) alert(r.error);
  }


  // ---- adding media: Wi-Fi + USB -----------------------------------------------------------
  const fmtBytes = (n) => {
    if (n == null) return '';
    const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
    while (n >= 1024 && i < 4) { n /= 1024; i++; }
    return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
  };
  let copyState = null; // { label, index, total, bytesDone, bytesTotal, file }
  function drawCopy() {
    const el = document.getElementById('copy-status');
    if (!el) return;
    el.replaceChildren();
    if (!copyState) { el.hidden = true; return; }
    el.hidden = false;
    const pct = copyState.bytesTotal ? Math.min(100, Math.round((copyState.bytesDone / copyState.bytesTotal) * 100)) : 0;
    el.append(
      h('div', {}, `Copying “${copyState.label}”: file ${copyState.index} of ${copyState.total}  (${fmtBytes(copyState.bytesDone)} of ${fmtBytes(copyState.bytesTotal)})`),
      h('div', { class: 'progress' }, h('div', { class: 'progress-fill', style: `width:${pct}%` })),
      h('small', {}, copyState.file),
      h('button', { class: 'btn secondary', onclick: () => api.cancelCopy() }, 'Cancel'));
  }
  api.onCopyProgress((p) => { copyState = p; drawCopy(); });

  async function copyDrive(d) {
    copyState = { label: d.label, index: 0, total: 0, bytesDone: 0, bytesTotal: 0, file: 'Looking for videos…' };
    drawCopy();
    const r = await api.copyDrive(d.mount);
    copyState = null; drawCopy();
    if (r.error) flash(r.error);
    else flash(r.cancelled ? 'Copy cancelled' : `Copied ${r.copied} file${r.copied === 1 ? '' : 's'}${r.skipped ? ` (${r.skipped} were already there)` : ''}`);
    S = await api.state(); render();
    if (!$('#settings').hidden) renderSettings();
  }

  function drivesBlock() {
    const list = S.drives || [];
    if (!list.length) return h('p', { class: 'am-hint' }, 'Plug in a drive and its movies and shows appear in your library automatically. You can also copy them onto this box.');
    return h('div', { class: 'drives' }, list.map((d) => h('div', { class: 'drive' },
      h('div', { class: 'drive-name' }, d.label, h('small', {}, [d.fs, d.free != null ? `${fmtBytes(d.free)} free of ${fmtBytes(d.total)}` : ''].filter(Boolean).join(' · '))),
      h('div', { class: 'btns' },
        h('button', { class: 'btn secondary', onclick: () => copyDrive(d) }, 'Copy to library'),
        h('button', { class: 'btn secondary', onclick: async () => { const r = await api.ejectDrive(d.mount); if (!r.ok) flash(r.msg || 'Could not eject'); else flash(`${d.label} can be unplugged`); S = await api.state(); render(); if (!$('#settings').hidden) renderSettings(); } }, 'Eject')))));
  }

  function addMediaPanel() {
    const wifi = h('div', { class: 'am-card' }, h('h3', {}, 'Over Wi-Fi'), h('p', { class: 'am-hint' }, 'Loading…'));
    api.remoteInfo().then((r) => {
      wifi.replaceChildren(h('h3', {}, 'Over Wi-Fi'));
      if (!r.enabled || !r.urls.length) {
        wifi.append(h('p', { class: 'am-hint' }, r.enabled ? 'No network connection found.' : 'Turn on “Phone remote” in Settings to add files over Wi-Fi.'));
        return;
      }
      const qr = h('div', { class: 'qr' });
      if (r.qr) qr.innerHTML = r.qr; // an SVG we generated ourselves from the address
      wifi.append(...[
        h('div', { class: 'am-wifi' }, qr, h('div', { class: 'am-steps' },
          h('div', {}, 'Scan with a phone or laptop, or open:'),
          h('div', { class: 'url' }, r.urls[0]),
          h('div', { class: 'am-hint' }, 'Then tap “Add media” and pick files or a whole folder.'))),
        r.smb && r.smb.length ? h('div', { class: 'am-steps' },
          h('div', {}, 'Or drag files in from your computer:'),
          h('div', { class: 'url' }, r.smb[0]),
          h('div', { class: 'am-hint' }, 'Mac: Finder → Go → Connect to Server. Windows: File Explorer address bar, type \\\\' + r.smb[0].replace('smb://', ''))) : null,
        r.mediaDir ? h('div', { class: 'am-hint' }, 'Saved to ', h('b', {}, r.mediaDir)) : null].filter(Boolean));
    }).catch(() => {});
    return h('div', { class: 'addmedia' },
      wifi,
      h('div', { class: 'am-card' }, h('h3', {}, 'USB drive'), drivesBlock()),
      h('div', { id: 'copy-status', class: 'copy-status', hidden: true }));
  }

  api.onDrivesChanged(async (m) => {
    S = await api.state();
    if (m.added.length) flash(`Drive “${m.added[0]}” connected${m.added.length > 1 ? ` (+${m.added.length - 1})` : ''}. Adding it to your library…`);
    else if (m.removed.length) flash(`Drive “${m.removed[0]}” removed`);
    if (!$('#settings').hidden) renderSettings();
    else if (!S.library.length) renderKeepFocus();
  });

  // ---- Android: lock the box so only Screenroom (and Settings) can be used ------------------
  function kioskBlock() {
    const box = h('div', { class: 'am-card' }, h('p', { class: 'am-hint' }, 'Checking…'));
    api.kioskStatus().then((k) => {
      box.replaceChildren();
      if (!k.owner) {
        box.append(h('p', { class: 'am-hint' }, k.message || 'To lock this box, run the setup script from your computer with the lock option. See the setup guide.'));
        return;
      }
      const pin = h('input', { type: 'password', inputmode: 'numeric', maxlength: '8', class: 'pin-input',
        placeholder: k.locked ? 'Enter your PIN to unlock' : 'Choose a 4 to 8 digit PIN' });
      const act = async (fn) => { const r = await fn(pin.value.trim()); flash(r.message || (r.ok ? 'Done' : 'That did not work')); if (r.ok) renderSettings(); };
      box.append(
        h('p', {}, k.locked ? 'Locked. Only Screenroom and Settings can be opened, and Home always comes back here.' : 'Not locked. Other apps and the Google TV home screen can still be used.'),
        pin,
        h('div', { class: 'btns' },
          k.locked
            ? h('button', { class: 'btn secondary', onclick: () => act(api.kioskUnlock) }, 'Unlock')
            : h('button', { class: 'btn secondary', onclick: () => act(api.kioskLock) }, 'Lock to Screenroom'),
          k.locked ? null : h('button', { class: 'btn secondary', onclick: () => { if (confirm('Give control of the box back to Android? Screenroom can then be uninstalled, and locking needs the setup script again.')) act(api.kioskRelease); } }, 'Release control')));
    }).catch(() => {});
    return box;
  }

  // ---- settings ----------------------------------------------------------------
  function toggle(label, hint, key) {
    return h('label', { class: 'row-set' }, h('span', {}, label, h('small', {}, hint)),
      h('input', { type: 'checkbox', checked: !!S.config[key], onchange: async (e) => { S = await api.setConfig({ [key]: e.target.checked }); renderSettings(); } }));
  }
  function renderSettings() {
    const deviceSel = h('select', { class: 'dev-select', onchange: async (e) => { S = await api.setConfig({ audioDevice: e.target.value }); } },
      h('option', { value: '' }, 'Automatic'));
    api.audioDevices().then((list) => {
      for (const d of list) {
        if (d.id === 'auto') continue;
        deviceSel.append(h('option', { value: d.id, selected: d.id === S.config.audioDevice }, `${d.label}  [${d.id}]`));
      }
      deviceSel.value = S.config.audioDevice || '';
    }).catch(() => {});

    const remoteBox = h('div', { class: 'remote-box' });
    api.remoteInfo().then((r) => {
      if (!r.enabled) { remoteBox.append(h('small', {}, 'Phone remote is off.')); return; }
      remoteBox.append(
        h('div', {}, 'On your phone (same Wi-Fi), open:'),
        ...(r.urls.length ? r.urls.map((u) => h('div', { class: 'url' }, u)) : [h('div', { class: 'url' }, 'No network connection found')]),
        h('div', {}, 'PIN: ', h('b', { class: 'pin' }, r.pin)));
    }).catch(() => {});

    const canPower = S.platform === 'linux';
    const isAndroid = S.platform === 'android';
    $('#settings-body').replaceChildren(...[
      h('h2', {}, 'Settings'),
      !S.mpvFound ? h('div', { class: 'warn' }, 'mpv was not found, so playback will not work. Install it with “brew install mpv” (Mac) or “sudo apt install mpv” (Linux).') : null,
      !S.ffprobeFound ? h('div', { class: 'warn' }, 'ffprobe was not found. Install ffmpeg to scan your library.') : null,
      S.storageWarning ? h('div', { class: 'warn' }, S.storageWarning) : null,
      isAndroid ? null : toggle('TV mode', 'Big layout for a TV, fullscreen, controlled with a remote or game controller.', 'tvMode'),
      isAndroid ? null : toggle('Audio passthrough', 'Send Dolby / DTS bitstreams untouched to your receiver (HDMI/optical). Off = decode locally.', 'passthrough'),
      isAndroid ? null : toggle('Downmix to stereo', 'Only used when passthrough is off (speakers or headphones).', 'downmix'),
      isAndroid ? null : toggle('Start playback fullscreen', '', 'fullscreen'),
      isAndroid ? h('p', { class: 'am-hint' }, 'Sound: Dolby and DTS are sent to your receiver or soundbar automatically when it supports them. Change the output under System settings → Display & Sound.')
        : h('label', { class: 'row-set' }, h('span', {}, 'Audio output', h('small', {}, 'Pick your HDMI / optical device for surround or passthrough.')), deviceSel),
      toggle('Phone remote', 'Control Screenroom from a web page on your phone.', 'remote'),
      remoteBox,
      h('h3', {}, 'Add media'),
      addMediaPanel(),
      h('h3', {}, 'Library folders'),
      h('div', { class: 'dirs' }, (S.config.dirs || []).map((d) =>
        h('div', { class: 'dir' }, d, h('button', { onclick: async () => { setScanning(true); S = await api.removeDir(d); setScanning(false); renderSettings(); render(); } }, 'Remove')))),
      h('div', { class: 'btns' },
        h('button', { class: 'btn secondary', onclick: async () => { setScanning(true); S = await api.addDir(); setScanning(false); renderSettings(); render(); } }, 'Add folder…'),
        h('button', { class: 'btn secondary', onclick: async () => { setScanning(true); S = await api.scan(); setScanning(false); renderSettings(); render(); } }, 'Rescan')),
      S.duplicates ? h('div', { class: 'am-hint' }, `${S.duplicates} duplicate episode file${S.duplicates === 1 ? ' was' : 's were'} hidden (the same episode found twice; the best quality copy is kept).`) : null,
      isAndroid ? h('h3', {}, 'This box') : null,
      isAndroid ? h('div', { class: 'btns' },
        h('button', { class: 'btn secondary', onclick: () => api.openSystemSettings('main') }, 'System settings'),
        h('button', { class: 'btn secondary', onclick: () => api.openSystemSettings('storage') }, 'Storage & drives'),
        h('button', { class: 'btn secondary', onclick: () => api.openSystemSettings('network') }, 'Wi-Fi & network')) : null,
      isAndroid && api.kioskStatus ? h('h3', {}, 'Lock to Screenroom') : null,
      isAndroid && api.kioskStatus ? kioskBlock() : null,
      isAndroid ? null : h('h3', {}, 'Power'),
      isAndroid ? null : h('div', { class: 'btns' },
        h('button', { class: 'btn secondary', onclick: () => api.quit() }, 'Quit Screenroom'),
        canPower ? h('button', { class: 'btn secondary', onclick: () => { if (confirm('Restart this computer?')) api.power('reboot'); } }, 'Restart') : null,
        canPower ? h('button', { class: 'btn secondary', onclick: () => { if (confirm('Shut down this computer?')) api.power('poweroff'); } }, 'Shut down') : null),
    ].filter(Boolean));
  }

  function setScanning(on, text) {
    const el = $('#scan-status');
    el.hidden = !on;
    if (on) el.textContent = text || 'Scanning library…';
  }

  // ---- navigation: nav bar, remote (CEC / IR / Bluetooth), keyboard, game controller, phone ----------
  function setView(v) {
    view = v; query = ''; $('#search').value = '';
    document.querySelectorAll('#nav nav a').forEach((x) => x.classList.toggle('active', x.dataset.view === v));
    render(); window.scrollTo(0, 0);
  }
  document.querySelectorAll('#nav nav a').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); setView(a.dataset.view); }));
  $('#search').addEventListener('input', (e) => { query = e.target.value.trim(); render(); });
  const openSettings = () => { renderSettings(); $('#settings').hidden = false; const f = $('#settings input, #settings button'); f && f.focus(); };
  const closeSettings = () => { $('#settings').hidden = true; $('#settings-btn').focus(); };
  const toggleSettings = () => { if ($('#settings').hidden) openSettings(); else closeSettings(); };
  $('#settings-btn').addEventListener('click', openSettings);
  $('#settings-close').addEventListener('click', closeSettings);
  $('#modal-close').addEventListener('click', closeModal);
  for (const m of ['#modal', '#settings']) $(m).addEventListener('mousedown', (e) => {
    if (e.target === $(m)) { if (m === '#modal') closeModal(); else closeSettings(); }
  });
  window.addEventListener('scroll', () => $('#nav').classList.toggle('solid', window.scrollY > 40 || view !== 'home' || !!query));

  const FOCUSABLE = 'a[data-view], button:not([disabled]), .card, .ep, .track, input, select';
  const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  function scopeEls() {
    let els;
    if (!$('#modal').hidden) els = $('#modal').querySelectorAll(FOCUSABLE);
    else if (!$('#settings').hidden) els = $('#settings').querySelectorAll(FOCUSABLE);
    else els = document.querySelectorAll(`#nav ${FOCUSABLE.split(', ').join(', #nav ')}, #main ${FOCUSABLE.split(', ').join(', #main ')}`);
    return [...new Set(els)].filter(shown);
  }
  function focusEl(el) {
    el.focus({ preventScroll: true });
    if (!el.closest('#nav')) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
  }
  function defaultFocus(els) {
    return els.find((e) => e.matches('.btn.primary')) || els.find((e) => e.matches('.card')) || els[0];
  }

  // Spatial navigation: jump to the nearest focusable thing in the direction pressed.
  function move(dir) {
    document.body.classList.add('navmode');
    const els = scopeEls();
    if (!els.length) return;
    const cur = els.includes(document.activeElement) ? document.activeElement : null;
    if (!cur) { const d = defaultFocus(els); d && focusEl(d); return; }
    const a = cur.getBoundingClientRect();
    const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
    let best = null, bestScore = Infinity;
    for (const el of els) {
      if (el === cur) continue;
      const r = el.getBoundingClientRect();
      const dx = r.left + r.width / 2 - ax, dy = r.top + r.height / 2 - ay;
      const gapX = Math.max(0, r.left - a.right, a.left - r.right); // 0 when the two overlap horizontally
      const gapY = Math.max(0, r.top - a.bottom, a.top - r.bottom);
      let primary, lateral;
      if (dir === 'right') { if (dx <= 2) continue; primary = gapX + dx * 0.2; lateral = gapY + Math.abs(dy) * 0.3; }
      else if (dir === 'left') { if (dx >= -2) continue; primary = gapX - dx * 0.2; lateral = gapY + Math.abs(dy) * 0.3; }
      else if (dir === 'down') { if (dy <= 2) continue; primary = gapY + dy * 0.2; lateral = gapX + Math.abs(dx) * 0.3; }
      else { if (dy >= -2) continue; primary = gapY - dy * 0.2; lateral = gapX + Math.abs(dx) * 0.3; }
      const score = primary + lateral * 3;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    if (best) focusEl(best);
  }
  function activate() {
    const el = document.activeElement;
    if (el && el !== document.body && scopeEls().includes(el)) el.click();
    else move('down');
  }
  // Returns true if it did something (so a TV remote's Back can leave the app when there's nothing left to close).
  function goBack() {
    if (!$('#modal').hidden) { closeModal(); return true; }
    if (!$('#settings').hidden) { closeSettings(); return true; }
    if (document.activeElement === $('#search')) $('#search').blur();
    if (query) { query = ''; $('#search').value = ''; render(); return true; }
    if (view !== 'home') { setView('home'); return true; }
    return false;
  }

  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t.tagName === 'INPUT' && t.type === 'search') {
      if (e.key === 'Escape') { t.blur(); e.preventDefault(); }
      else if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); t.blur(); const c = document.querySelector('#main .card, #main .btn'); c && focusEl(c); }
      return;
    }
    const dir = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }[e.key];
    if (dir) {
      // let a focused dropdown use up/down itself; left/right still navigate
      if (t.tagName === 'SELECT' && (dir === 'up' || dir === 'down')) return;
      e.preventDefault(); move(dir); return;
    }
    if (e.key === 'Escape' || e.key === 'Backspace' || e.key === 'BrowserBack' || e.key === 'GoBack') { e.preventDefault(); goBack(); return; }
    if (e.key === 'Home' || e.key === 'BrowserHome' || e.key === 'HomePage') { e.preventDefault(); closeModal(); if (!$('#settings').hidden) closeSettings(); setView('home'); return; }
    if (e.key === '/') { e.preventDefault(); $('#search').focus(); return; }
    if (e.key === 'Enter' && t.tagName === 'INPUT' && t.type === 'checkbox') { e.preventDefault(); t.click(); return; }
    if (e.key === 'Enter' && t === document.body) { e.preventDefault(); activate(); return; }
    if (e.key === 'ContextMenu' || e.key === 'F1' || e.key === 'Tab' && e.altKey) { e.preventDefault(); toggleSettings(); }
  });

  // Game controller (standard mapping): D-pad / left stick move, A selects, B goes back, Start opens settings.
  const held = {};
  function pollPad(now) {
    const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
    for (const gp of pads) {
      const on = {
        up: (gp.buttons[12] && gp.buttons[12].pressed) || gp.axes[1] < -0.6,
        down: (gp.buttons[13] && gp.buttons[13].pressed) || gp.axes[1] > 0.6,
        left: (gp.buttons[14] && gp.buttons[14].pressed) || gp.axes[0] < -0.6,
        right: (gp.buttons[15] && gp.buttons[15].pressed) || gp.axes[0] > 0.6,
      };
      for (const d of Object.keys(on)) {
        if (!on[d]) { delete held[d]; continue; }
        if (held[d] === undefined) { held[d] = now + 380; move(d); }
        else if (now >= held[d]) { held[d] = now + 110; move(d); }
      }
      const press = (i, fn) => {
        const down = !!(gp.buttons[i] && gp.buttons[i].pressed);
        if (down && !held['b' + i]) fn();
        if (down) held['b' + i] = 1; else delete held['b' + i];
      };
      press(0, activate); press(1, goBack); press(9, toggleSettings);
    }
    requestAnimationFrame(pollPad);
  }
  requestAnimationFrame(pollPad);

  // Phone remote
  api.onRemote((m) => {
    if (m.type === 'key') {
      if (['up', 'down', 'left', 'right'].includes(m.key)) move(m.key);
      else if (m.key === 'ok') activate();
      else if (m.key === 'back') { if (!goBack() && m.exitIfRoot && api.exitApp) api.exitApp(); }
      else if (m.key === 'home') { closeModal(); if (!$('#settings').hidden) closeSettings(); setView('home'); }
      else if (m.key === 'settings') toggleSettings();
    } else if (m.type === 'open') {
      if (!$('#settings').hidden) closeSettings();
      openEntry(m.key);
    } else if (m.type === 'search') {
      if (!$('#modal').hidden) closeModal();
      query = (m.q || '').trim(); $('#search').value = m.q || '';
      render();
    }
  });

  // Focus rings show while navigating with remote/keyboard/gamepad, and hide again when the mouse is used.
  window.addEventListener('mousedown', () => document.body.classList.remove('navmode'));
  window.addEventListener('pointermove', (e) => { if (e.movementX || e.movementY) document.body.classList.remove('navmode'); });

  // Hide the mouse pointer after a few seconds in TV mode.
  let idleTimer = null;
  function wake() {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    if (S.tv) idleTimer = setTimeout(() => document.body.classList.add('idle'), 3000);
  }
  window.addEventListener('mousemove', wake);

  let flashTimer = null;
  function flash(text) {
    const el = $('#scan-status');
    el.hidden = false; el.textContent = text;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { el.hidden = true; }, 9000);
  }
  api.onPlaybackError(flash);
  api.onScanProgress((p) => { if (p.total) setScanning(true, `Scanning ${p.done}/${p.total}…`); });

  // Re-draw without losing your place (used when something changes in the background).
  function renderKeepFocus() {
    const a = document.activeElement;
    const key = a && a.dataset && a.dataset.key;
    const y = window.scrollY;
    render();
    window.scrollTo(0, y);
    if (key) { const el = document.querySelector(`.card[data-key="${CSS.escape(key)}"]`); if (el) el.focus({ preventScroll: true }); }
  }

  // New files found by a background rescan
  api.onLibraryUpdated((s) => {
    const sig = (st) => st.library.length + ':' + Math.max(0, ...st.library.map((i) => i.mtime));
    const changed = sig(s) !== sig(S);
    S = s;
    setScanning(false);
    if (changed && $('#modal').hidden && $('#settings').hidden) renderKeepFocus();
  });

  api.onPlaybackEnded((s) => {
    S = s;
    const keep = open ? { ...open, focusEp: null } : null;
    renderKeepFocus();
    if (keep && !$('#modal').hidden) { open = keep; renderModal(); }
  });

  (async () => { S = await api.state(); render(); wake(); })();
})();
