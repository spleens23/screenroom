(() => {
  const $ = (s) => document.querySelector(s);
  const main = $('#main');
  let S = { library: [], progress: {}, config: {}, mpvFound: true, ffprobeFound: true };
  let view = 'home';
  let query = '';
  let mode = 'movies'; // 'movies' | 'parlor' (music)
  let parlorUI = null;

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
      if (!it.tv) continue;
      const key = it.tv.series.toLowerCase();
      if (!bySeries.has(key)) bySeries.set(key, []);
      bySeries.get(key).push(it);
    }
    // The same movie in several qualities (DVD / Blu-ray / 4K) is one title with a Quality choice.
    for (const g of MediaCore.groupMovies(items)) {
      const vs = g.versions;
      const watching = vs.map((v) => ({ v, p: S.progress[v.id] })).filter((x) => x.p).sort((a, b) => b.p.updated - a.p.updated)[0];
      const it = watching ? watching.v : vs[0]; // the copy you were watching, else the best one
      const withArt = vs.find((v) => v.art) || {};
      movies.push({ kind: 'movie', key: vs[0].id, name: g.title, item: it, versions: vs, items: vs,
        art: withArt.art || null, backdrop: (vs.find((v) => v.backdrop) || withArt).backdrop || withArt.art || null,
        description: (vs.find((v) => v.description) || it).description, genres: [...new Set(vs.flatMap((v) => v.genres))],
        year: g.year || it.year, mtime: Math.max(...vs.map((v) => v.mtime || 0)) });
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
  // Filtered lists (4K / HD / SD, search...): a movie shows up if any of its copies matches, under its one
  // plain title; a series shows just its matching episodes.
  const catalogOf = (pred) => {
    if (!pred) return buildCatalog(S.library);
    const movies = buildCatalog(S.library.filter((i) => !i.tv)).filter((e) => e.versions.some(pred));
    const series = buildCatalog(S.library.filter((i) => i.tv && pred(i)));
    return [...movies, ...series].sort((a, b) => a.name.localeCompare(b.name));
  };
  // (a key can be any copy of a movie: lists filtered to e.g. SD only show that copy)
  const fullEntry = (key) => buildCatalog(S.library).find((e) => e.key === key || (e.versions && e.versions.some((v) => v.id === key)));

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
    // the age rating read from the file(s), e.g. "TV-Y7" (what kids profiles go by)
    const rated = (e.items || []).map((i) => i.rating).filter(Boolean).sort((a, b) => b.level - a.level)[0];
    const out = bits.map((b) => h('span', {}, b));
    if (rated) out.push(h('span', { class: 'rating' }, rated.label));
    return out;
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
            h('button', { class: 'btn secondary', onclick: () => openEntry(hero.key) }, h('span', { class: 'i-info' }, 'i'), 'More Info')))));
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
    drawProfileButton();
    if (S.pickProfile && api.selectProfile) { main.replaceChildren(); renderPicker(); return; }
    hidePicker();
    if (mode === 'parlor' && parlorUI) { $('#nav').classList.add('solid'); parlorUI.render(); return; }
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
    open = { key, season: null, focusEp: focusEp || null, returnKey: key, version: null };
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
    if (parlorUI) parlorUI.onModalClosed();
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

  const qualityLabel = (v) => {
    const vid = v.video || {};
    const q = MediaCore.qualityOf(v);
    const best = v.audio.slice().sort((a, b) => (b.channels || 0) - (a.channels || 0))[0];
    return [q === '4K' ? '4K Ultra HD' : q === 'HD' ? `HD ${vid.res || ''}`.trim() : `SD ${vid.height ? vid.height + 'p' : ''}`.trim(),
      vid.dv ? 'Dolby Vision' : vid.hdr, best && best.label, `${(v.size / 1e9).toFixed(1)} GB`].filter(Boolean).join(' · ');
  };

  // A long description shows its first few lines and a "More" button (works with the remote: OK toggles it).
  function descBlock(text) {
    const p = h('p', { class: 'm-desc' }, text);
    if (text.length < 280) return p;
    p.classList.add('clamped');
    const more = h('button', { class: 'desc-more', onclick: () => {
      const short = p.classList.toggle('clamped');
      more.textContent = short ? 'More' : 'Less';
    } }, 'More');
    return h('div', {}, p, more);
  }

  function movieDetail(e) {
    const vs = e.versions || [e.item];
    const item = (open.version && vs.find((v) => v.id === open.version)) || e.item;
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
              onclick: async () => { S = await api.setWatched(vs.map((v) => v.id), !(p && p.done)); renderModal(); render(); } }, p && p.done ? '✓ Watched' : '+ Mark watched')),
          vs.length > 1 ? h('label', { class: 'quality' }, h('span', {}, 'Quality'),
            h('select', { class: 'dev-select', onchange: (ev) => { open.version = ev.target.value; renderModal(); const s = $('#modal .quality select'); s && s.focus(); } },
              vs.map((v) => h('option', { value: v.id, selected: v.id === item.id }, qualityLabel(v))))) : null)),
      h('div', { class: 'm-body' },
        h('div', {},
          h('div', { class: 'meta' }, metaLine(e), badges([item])),
          descBlock(item.description || 'No description.'),
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
          descBlock(e.description || ''),
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


  // ---- Linux appliance: Wi-Fi and Bluetooth --------------------------------------------------------
  function wifiBlock() {
    const box = h('div', { class: 'am-card' }, h('p', { class: 'am-hint' }, 'Checking…'));
    const draw = async (networks) => {
      const st = await api.wifiStatus();
      box.replaceChildren();
      if (!st.available) { box.append(h('p', { class: 'am-hint' }, st.message)); return; }
      box.append(h('p', {}, st.wired ? 'Connected by network cable.' : st.wifiConnected ? `Connected to Wi-Fi: ${st.wifiNetwork}` : 'Not connected.'));
      if (!st.hasWifi) { box.append(h('p', { class: 'am-hint' }, 'This computer has no Wi-Fi adapter.')); return; }
      box.append(h('div', { class: 'btns' }, h('button', { class: 'btn secondary', onclick: async (e) => {
        e.target.textContent = 'Searching…';
        const r = await api.wifiScan();
        if (!r.ok) { flash(r.error); draw(); return; }
        draw(r.networks);
      } }, networks ? 'Search again' : 'Find Wi-Fi networks')));
      if (!networks) return;
      const list = h('div', { class: 'drives' });
      for (const n of networks.slice(0, 12)) {
        const row = h('div', { class: 'drive' },
          h('div', { class: 'drive-name' }, n.ssid, h('small', {}, `${n.current ? 'Connected · ' : ''}${n.secure ? 'Password' : 'Open'} · signal ${n.signal}%`)));
        const go = async (pw) => {
          flash(`Connecting to ${n.ssid}…`);
          const r = await api.wifiConnect(n.ssid, pw);
          flash(r.ok ? r.message : r.error);
          if (r.ok) draw();
        };
        if (n.secure) {
          const pw = h('input', { type: 'password', class: 'pin-input', placeholder: 'Wi-Fi password (or type it on your phone)' });
          row.append(h('div', { class: 'wifi-join' }, pw, h('button', { class: 'btn secondary', onclick: () => go(pw.value) }, 'Join')));
        } else row.append(h('button', { class: 'btn secondary', onclick: () => go('') }, 'Join'));
        list.append(row);
      }
      box.append(list);
    };
    draw().catch(() => {});
    return box;
  }

  function bluetoothBlock() {
    const box = h('div', { class: 'am-card' }, h('p', { class: 'am-hint' }, 'Checking…'));
    const soundOn = (mac) => (S.config.audioDevice || '').toUpperCase() === `BT:${mac}`;
    const useForSound = async (d) => { S = await api.setConfig({ audioDevice: `bt:${d.mac}` }); flash(`Sound will play on ${d.name}`); renderSettings(); };
    const draw = async (found) => {
      const st = await api.btStatus();
      box.replaceChildren();
      if (!st.available) { box.append(h('p', { class: 'am-hint' }, st.message)); return; }
      if (!st.hasAdapter) { box.append(h('p', { class: 'am-hint' }, 'No Bluetooth adapter found. A USB Bluetooth dongle works too.')); return; }
      box.append(h('p', { class: 'am-hint' }, 'Remotes, game controllers, speakers and headphones. USB and 2.4 GHz dongle remotes work without pairing.'));
      if (st.paired.length) {
        box.append(h('div', { class: 'drives' }, st.paired.map((d) => h('div', { class: 'drive' },
          h('div', { class: 'drive-name' }, d.name,
            h('small', {}, [d.audio ? 'Speaker / headphones' : 'Paired', d.connected ? 'connected' : (d.audio ? 'not connected' : ''), soundOn(d.mac) ? 'sound plays here' : '']
              .filter(Boolean).join(' · '))),
          d.audio && !d.connected ? h('button', { class: 'btn secondary', onclick: async (e) => {
            e.target.textContent = 'Connecting…';
            const r = await api.btConnect(d.mac); flash(r.ok ? `${d.name} connected` : r.error); draw();
          } }, 'Connect') : null,
          d.audio && !soundOn(d.mac) ? h('button', { class: 'btn secondary', onclick: () => useForSound(d) }, 'Play sound here') : null,
          d.audio && soundOn(d.mac) ? h('button', { class: 'btn secondary', onclick: async () => {
            S = await api.setConfig({ audioDevice: '' }); flash('Sound is back on Automatic (the TV)'); renderSettings();
          } }, 'Use the TV instead') : null,
          h('button', { class: 'btn secondary', onclick: async () => {
            const r = await api.btRemove(d.mac);
            if (r.ok) { S = await api.state(); flash(`Removed ${d.name}`); renderSettings(); } else flash(r.error);
          } }, 'Forget')))));
      }
      box.append(h('div', { class: 'btns' }, h('button', { class: 'btn secondary', onclick: async (e) => {
        e.target.textContent = 'Searching… (put the device in pairing mode)';
        const r = await api.btScan();
        draw(r.devices || []);
      } }, 'Pair a device')));
      if (!found) return;
      if (!found.length) { box.append(h('p', { class: 'am-hint' }, 'Nothing found. Put it in pairing mode (often: hold the pairing or Bluetooth button until a light flashes) and search again.')); return; }
      box.append(h('div', { class: 'drives' }, found.map((d) => h('div', { class: 'drive' },
        h('div', { class: 'drive-name' }, d.name),
        h('button', { class: 'btn secondary', onclick: async (e) => {
          e.target.textContent = 'Pairing…';
          const r = await api.btPair(d.mac);
          if (!r.ok) { flash(r.error); draw(); return; }
          // A speaker you just paired is a speaker you want to hear: send sound to it straight away.
          if (r.audio) { await useForSound(d); return; }
          flash(`${d.name} is ready`); draw();
        } }, 'Pair')))));
    };
    draw().catch(() => {});
    return box;
  }


  // Android: the last few films that stopped with an error, with what the TV was decoding (to report or look into).
  function problemsBlock() {
    const when = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    return h('div', { class: 'am-card' },
      h('p', { class: 'am-hint' }, 'Films that stopped playing, newest first, with what the TV was decoding.'),
      ...S.playbackProblems.slice(0, 5).map((p) => h('div', { class: 'problem' },
        h('div', {}, h('b', {}, p.title), ` · ${when(p.at)} · ${p.code}`),
        h('small', {}, p.details || ''))),
      h('div', { class: 'btns' }, h('button', { class: 'btn secondary', onclick: async () => { S = await api.clearProblems(); renderSettings(); } }, 'Clear')));
  }

  function systemBlock() {
    const box = h('div', { class: 'am-card' }, h('p', { class: 'am-hint' }, 'Checking…'));
    let polling = null;
    const draw = async () => {
      const a = await api.applianceInfo();
      box.replaceChildren();
      const u = a.update;
      const busy = u && ['checking', 'downloading', 'installing'].includes(u.state) && (Date.now() - Date.parse(u.at)) < 15 * 60 * 1000;
      box.append(
        h('p', {}, `Screenroom ${a.version}`),
        u && u.message ? h('p', { class: 'am-hint' }, u.message) : null,
        h('div', { class: 'btns' }, h('button', { class: 'btn secondary', disabled: busy, onclick: async () => {
          const r = await api.applianceUpdate();
          if (!r.ok) flash(r.error || 'Could not start the update');
          clearInterval(polling); polling = setInterval(() => { if ($('#settings').hidden) clearInterval(polling); else draw(); }, 3000);
          setTimeout(draw, 800);
        } }, busy ? 'Updating…' : 'Check for updates')));
      if (a.maintenance) {
        const secret = h('span', {}, '••••••••');
        box.append(h('p', { class: 'am-hint' }, 'Maintenance login for repairs from a computer on your network: ',
          h('b', {}, `ssh ${a.maintenance.user}@${a.host}`), ' · password ', secret, ' ',
          h('button', { class: 'linkish', onclick: (e) => { secret.textContent = a.maintenance.password; e.target.remove(); } }, 'Show')));
      }
    };
    draw().catch(() => {});
    return box;
  }


  // ---- profiles: "Who's watching?", PIN pad, profile editor --------------------------------------
  const LEVELS = [
    [1, 'Little kids', 'G, TV-Y, TV-G'],
    [2, 'Older kids', 'up to PG, TV-Y7, TV-PG'],
    [3, 'Teens', 'up to PG-13, TV-14'],
  ];
  const LANGS = [['', 'Default'], ['eng', 'English'], ['spa', 'Spanish'], ['fre', 'French'], ['ger', 'German'], ['ita', 'Italian'],
    ['por', 'Portuguese'], ['jpn', 'Japanese'], ['kor', 'Korean'], ['chi', 'Chinese']];
  const COLORS = ['#e50914', '#2f80ed', '#27ae60', '#f2c94c', '#9b51e0', '#f2994a', '#56ccf2', '#eb5757'];

  function avatar(p, big) {
    return h('span', { class: 'avatar' + (big ? ' big' : ''), style: `background:${p.color || '#555'}` },
      (p.name || '?').trim().charAt(0).toUpperCase());
  }

  // A number pad that works with arrows + OK, digits on a keyboard, or the phone remote's "Type on TV".
  let pinState = null;
  function askPin(title, subtitle) {
    return new Promise((resolve) => {
      const layer = $('#pinpad') || document.body.appendChild(h('div', { id: 'pinpad', class: 'pinpad', hidden: true }));
      let value = '';
      const dots = h('div', { class: 'pin-dots' });
      const msg = h('div', { class: 'pin-msg' }, subtitle || '');
      const drawDots = () => dots.replaceChildren(...[0, 1, 2, 3].map((i) => h('span', { class: i < value.length ? 'on' : '' })));
      const done = (v) => { layer.hidden = true; pinState = null; resolve(v); };
      const add = (d) => { if (value.length < 4) { value += d; drawDots(); } if (value.length === 4) setTimeout(() => done(value), 120); };
      const del = () => { value = value.slice(0, -1); drawDots(); };
      const key = (label, fn, cls) => h('button', { class: 'pin-key' + (cls ? ' ' + cls : ''), onclick: fn }, label);
      layer.replaceChildren(h('div', { class: 'pin-card' },
        h('h2', {}, title || 'Enter PIN'), msg, dots,
        h('div', { class: 'pin-grid' },
          ...'123456789'.split('').map((d) => key(d, () => add(d))),
          key('Cancel', () => done(null), 'small'), key('0', () => add('0')), key('⌫', del, 'small'))));
      drawDots();
      layer.hidden = false;
      pinState = { add, del, cancel: () => done(null), typed: (t) => { const d = String(t || '').replace(/\D/g, '').slice(0, 4); value = ''; for (const c of d) add(c); drawDots(); } };
      const first = layer.querySelector('.pin-key');
      if (first) first.focus();
    });
  }

  async function chooseProfile(p) {
    let pin = '';
    if (p.hasPin) {
      pin = await askPin(`${p.name}'s PIN`, 'Enter the 4-digit PIN');
      if (pin === null) return;
    }
    const r = await api.selectProfile(p.id, pin);
    if (!r.ok) { flash(r.error || 'Could not switch'); if (p.hasPin) return chooseProfile(p); return; }
    S = r.state;
    query = ''; $('#search').value = ''; view = 'home';
    if (parlorUI) parlorUI.reload();
    document.querySelectorAll('#nav nav a').forEach((x) => x.classList.toggle('active', x.dataset.view === 'home'));
    drawProfileButton();
    render();
    window.scrollTo(0, 0);
  }

  function renderPicker() {
    const layer = $('#who') || document.body.appendChild(h('div', { id: 'who', class: 'who' }));
    layer.hidden = false;
    layer.replaceChildren(h('div', { class: 'who-inner' },
      h('div', { class: 'brand who-brand' }, 'SCREENROOM'),
      h('h1', {}, "Who's watching?"),
      h('div', { class: 'who-list' }, (S.profiles || []).map((p) =>
        h('button', { class: 'who-tile', 'data-profile': p.id, onclick: () => chooseProfile(p) },
          avatar(p, true),
          h('span', { class: 'who-name' }, p.name),
          h('span', { class: 'who-tags' }, p.kids ? h('span', { class: 'tag-kids' }, 'Kids') : null, p.hasPin ? h('span', { class: 'tag-lock' }, 'PIN') : null))))));
    const last = layer.querySelector(`.who-tile[data-profile="${CSS.escape((S.profile && S.profile.id) || '')}"]`) || layer.querySelector('.who-tile');
    if (last) last.focus();
  }
  function hidePicker() { const l = $('#who'); if (l) l.hidden = true; }

  function drawProfileButton() {
    let b = $('#profile-btn');
    if (!b) {
      b = h('button', { id: 'profile-btn', title: 'Switch profile', onclick: async () => { if (!$('#settings').hidden) closeSettings(); S = await api.showProfilePicker(); render(); } });
      $('#settings-btn').before(b);
    }
    const p = S.profile;
    b.hidden = !p || (S.profiles || []).length < 2;
    b.replaceChildren(p ? avatar(p) : '');
  }

  // Settings > Profiles
  function profilesBlock() {
    const me = S.profile || {};
    const box = h('div', { class: 'am-card' });
    if (me.kids) {
      box.append(h('p', { class: 'am-hint' }, `You're in ${me.name}'s kids profile.`),
        h('div', { class: 'btns' }, h('button', { class: 'btn secondary', onclick: async () => { closeSettings(); S = await api.showProfilePicker(); render(); } }, 'Switch profile')));
      return box;
    }
    box.append(h('div', { class: 'drives' }, (S.profiles || []).map((p) => h('div', { class: 'drive' },
      h('div', { class: 'prof-row' }, avatar(p), h('div', { class: 'drive-name' }, p.name + (p.id === me.id ? ' (you)' : ''),
        h('small', {}, [p.kids ? `Kids · ${LEVELS.find((l) => l[0] === p.maxLevel)[1]}` : 'Grown-up', p.hasPin ? 'PIN' : ''].filter(Boolean).join(' · ')))),
      h('button', { class: 'btn secondary', onclick: () => editProfile(p) }, 'Edit')))));
    box.append(h('div', { class: 'btns' },
      (S.profiles || []).length < 8 ? h('button', { class: 'btn secondary', onclick: () => editProfile(null) }, 'Add profile') : null,
      (S.profiles || []).length > 1 ? h('button', { class: 'btn secondary', onclick: async () => { closeSettings(); S = await api.showProfilePicker(); render(); } }, 'Switch profile') : null));
    return box;
  }

  async function editProfile(p) {
    // Editing someone else's PIN-protected profile needs their PIN.
    let authPin = '';
    if (p && p.hasPin && (!S.profile || p.id !== S.profile.id)) {
      authPin = await askPin(`${p.name}'s PIN`, 'Enter it to change this profile');
      if (authPin === null) return;
    }
    const d = p ? { ...p } : { name: '', color: COLORS[(S.profiles || []).length % COLORS.length], kids: false, maxLevel: 1, allowUnrated: false, preferredLang: '', subLang: '' };
    const body = $('#settings-body');
    const name = h('input', { type: 'text', class: 'pin-input prof-name', maxlength: '24', placeholder: 'Name (or type it on your phone)', value: d.name });
    const preview = h('div', {});
    const drawPreview = () => preview.replaceChildren(avatar({ name: name.value || '?', color: d.color }, true));
    name.addEventListener('input', drawPreview);
    const swatches = h('div', { class: 'swatches' });
    const drawSw = () => swatches.replaceChildren(...COLORS.map((c) => h('button', { class: 'swatch' + (c === d.color ? ' on' : ''), style: `background:${c}`, title: c, onclick: () => { d.color = c; drawSw(); drawPreview(); } })));
    drawSw(); drawPreview();
    const kids = h('input', { type: 'checkbox', checked: !!d.kids });
    const level = h('select', { class: 'dev-select' }, LEVELS.map(([v, l, x]) => h('option', { value: String(v), selected: v === (d.maxLevel || 1) }, `${l} (${x})`)));
    const unrated = h('input', { type: 'checkbox', checked: !!d.allowUnrated });
    const kidsOpts = h('div', { class: 'kids-opts' },
      h('label', { class: 'row-set' }, h('span', {}, 'Age', h('small', {}, 'Uses the rating saved in each file.')), level),
      h('label', { class: 'row-set' }, h('span', {}, 'Show titles without a rating', h('small', {}, 'Off: anything without a rating is hidden.')), unrated));
    const showKids = () => { kidsOpts.hidden = !kids.checked; };
    kids.addEventListener('change', showKids); showKids();
    const audio = h('select', { class: 'dev-select' }, LANGS.map(([v, l]) => h('option', { value: v, selected: v === (d.preferredLang || '') }, l)));
    const subs = h('select', { class: 'dev-select' }, [['', 'Off'], ...LANGS.slice(1)].map(([v, l]) => h('option', { value: v, selected: v === (d.subLang || '') }, l)));

    const save = async () => {
      const r = await api.saveProfile({ id: p ? p.id : undefined, name: name.value, color: d.color, kids: kids.checked,
        maxLevel: Number(level.value), allowUnrated: unrated.checked, preferredLang: audio.value, subLang: subs.value }, authPin);
      if (!r.ok) { flash(r.error); return; }
      S = r.state; drawProfileButton(); render(); renderSettings();
      flash(p ? 'Saved' : `Added ${r.profile.name}`);
    };
    const pinBtns = p ? [
      h('button', { class: 'btn secondary', onclick: async () => {
        const a = await askPin(p.hasPin ? 'New PIN' : 'Choose a PIN', '4 digits'); if (a === null) return;
        const b = await askPin('Enter it again', 'To make sure'); if (b === null) return;
        if (a !== b) { flash("The PINs didn't match"); return; }
        const r = await api.setProfilePin(p.id, a, authPin); flash(r.ok ? 'PIN saved' : r.error);
        if (r.ok) { S = r.state; authPin = a; p.hasPin = true; }
      } }, p.hasPin ? 'Change PIN' : 'Add a PIN'),
      p.hasPin ? h('button', { class: 'btn secondary', onclick: async () => { const r = await api.setProfilePin(p.id, null, authPin); flash(r.ok ? 'PIN removed' : r.error); if (r.ok) { S = r.state; p.hasPin = false; } } }, 'Remove PIN') : null,
    ] : [];
    body.replaceChildren(...[
      h('h2', {}, p ? `Edit ${p.name}` : 'Add a profile'),
      h('div', { class: 'prof-edit-head' }, preview, h('div', { class: 'prof-edit-fields' }, name, swatches)),
      h('label', { class: 'row-set' }, h('span', {}, 'Kids profile', h('small', {}, 'Only shows titles rated for their age.')), kids),
      kidsOpts,
      h('label', { class: 'row-set' }, h('span', {}, 'Audio language', h('small', {}, 'Picked first when a movie has several.')), audio),
      h('label', { class: 'row-set' }, h('span', {}, 'Subtitles', h('small', {}, 'Turned on automatically in this language.')), subs),
      p ? h('h3', {}, 'PIN') : null,
      p ? h('p', { class: 'am-hint' }, p.hasPin ? 'This profile needs a PIN to open.' : 'Anyone can open this profile.') : null,
      p ? h('div', { class: 'btns' }, ...pinBtns.filter(Boolean)) : null,
      h('div', { class: 'btns prof-actions' },
        h('button', { class: 'btn primary', onclick: save }, 'Save'),
        h('button', { class: 'btn secondary', onclick: () => renderSettings() }, 'Cancel'),
        p && (S.profiles || []).length > 1 ? h('button', { class: 'btn secondary danger', onclick: async () => {
          if (!confirm(`Delete ${p.name}? Their watch history goes too.`)) return;
          const r = await api.deleteProfile(p.id, authPin);
          if (!r.ok) { flash(r.error); return; }
          S = r.state; drawProfileButton(); render(); if (!S.pickProfile) renderSettings();
        } }, 'Delete profile') : null),
    ].filter(Boolean));
    body.scrollTop = 0;
    name.focus();
  }

  // ---- settings ----------------------------------------------------------------
  function toggle(label, hint, key) {
    return h('label', { class: 'row-set' }, h('span', {}, label, h('small', {}, hint)),
      h('input', { type: 'checkbox', checked: !!S.config[key], onchange: async (e) => { S = await api.setConfig({ [key]: e.target.checked }); renderSettings(); } }));
  }
  function renderSettings() {
    if (S.profile && S.profile.kids) {
      $('#settings-body').replaceChildren(h('h2', {}, 'Settings'), h('h3', {}, 'Profiles'), profilesBlock());
      return;
    }
    const deviceSel = h('select', { class: 'dev-select', onchange: async (e) => { S = await api.setConfig({ audioDevice: e.target.value }); } },
      h('option', { value: '' }, 'Automatic'));
    api.audioDevices().then((list) => {
      for (const d of list) {
        if (d.id === 'auto') continue;
        if (d.nice && d.id === '') { deviceSel.firstChild.textContent = d.label; continue; } // TV box: friendly names
        deviceSel.append(h('option', { value: d.id, selected: d.id === S.config.audioDevice }, d.nice ? d.label : `${d.label}  [${d.id}]`));
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
      api.saveProfile && S.profile ? h('h3', {}, 'Profiles') : null,
      api.saveProfile && S.profile ? profilesBlock() : null,
      !S.mpvFound ? h('div', { class: 'warn' }, 'mpv was not found, so playback will not work. Install it with “brew install mpv” (Mac) or “sudo apt install mpv” (Linux).') : null,
      !S.ffprobeFound ? h('div', { class: 'warn' }, 'ffprobe was not found. Install ffmpeg to scan your library.') : null,
      S.storageWarning ? h('div', { class: 'warn' }, S.storageWarning) : null,
      isAndroid ? null : toggle('TV mode', 'Big layout for a TV, fullscreen, controlled with a remote or game controller.', 'tvMode'),
      isAndroid ? null : toggle('Audio passthrough', 'Send Dolby / DTS bitstreams untouched to your receiver (HDMI/optical). Off = decode locally.', 'passthrough'),
      isAndroid ? null : toggle('Downmix to stereo', 'Only used when passthrough is off (speakers or headphones).', 'downmix'),
      isAndroid || S.tv ? null : toggle('Full screen', 'Screenroom and the player use the whole screen. (Also F11, or the green button on a Mac window.)', 'appFullscreen'),
      isAndroid || S.config.appFullscreen ? null : toggle('Start playback fullscreen', '', 'fullscreen'),
      isAndroid ? h('p', { class: 'am-hint' }, 'Sound: Dolby and DTS are sent to your receiver or soundbar automatically when it supports them. Change the output under System settings → Display & Sound.')
        : h('label', { class: 'row-set' }, h('span', {}, 'Audio output', h('small', {}, S.platform === 'linux' && api.btStatus
          ? 'The TV, the headphone jack, or a Bluetooth speaker (pair it under Bluetooth below).'
          : 'Pick your HDMI / optical device for surround or passthrough.')), deviceSel),
      toggle('Phone remote', 'Control Screenroom from a web page on your phone.', 'remote'),
      remoteBox,
      parlorUI ? h('h3', { id: 'set-parlor' }, 'Parlor (music)') : null,
      parlorUI ? parlorUI.settingsBlock() : null,
      h('h3', {}, 'Add media'),
      addMediaPanel(),
      h('h3', {}, 'Library folders'),
      h('div', { class: 'dirs' }, (S.config.dirs || []).map((d) =>
        h('div', { class: 'dir' }, d, h('button', { onclick: async () => { setScanning(true); S = await api.removeDir(d); setScanning(false); renderSettings(); render(); } }, 'Remove')))),
      h('div', { class: 'btns' },
        h('button', { class: 'btn secondary', onclick: async () => { setScanning(true); S = await api.addDir(); setScanning(false); renderSettings(); render(); } }, 'Add folder…'),
        h('button', { class: 'btn secondary', onclick: async () => { setScanning(true); S = await api.scan(); setScanning(false); renderSettings(); render(); } }, 'Rescan')),
      S.duplicates ? h('div', { class: 'am-hint' }, `${S.duplicates} duplicate episode file${S.duplicates === 1 ? ' was' : 's were'} hidden (the same episode found twice; the best quality copy is kept).`) : null,
      S.platform === 'linux' && api.wifiStatus ? h('h3', {}, 'Wi-Fi') : null,
      S.platform === 'linux' && api.wifiStatus ? wifiBlock() : null,
      S.platform === 'linux' && api.btStatus ? h('h3', {}, 'Bluetooth') : null,
      S.platform === 'linux' && api.btStatus ? bluetoothBlock() : null,
      isAndroid ? h('h3', {}, 'This box') : null,
      isAndroid ? h('div', { class: 'btns' },
        h('button', { class: 'btn secondary', onclick: () => api.openSystemSettings('main') }, 'System settings'),
        h('button', { class: 'btn secondary', onclick: () => api.openSystemSettings('storage') }, 'Storage & drives'),
        h('button', { class: 'btn secondary', onclick: () => api.openSystemSettings('network') }, 'Wi-Fi & network')) : null,
      isAndroid && (S.playbackProblems || []).length ? h('h3', {}, 'Playback problems') : null,
      isAndroid && (S.playbackProblems || []).length ? problemsBlock() : null,
      isAndroid && api.kioskStatus ? h('h3', {}, 'Lock to Screenroom') : null,
      isAndroid && api.kioskStatus ? kioskBlock() : null,
      S.platform === 'linux' && api.applianceInfo ? h('h3', {}, 'System') : null,
      S.platform === 'linux' && api.applianceInfo ? systemBlock() : null,
      isAndroid ? null : h('h3', {}, 'Power'),
      S.appliance ? h('p', { class: 'am-hint' }, 'The power button on the box: press it to sleep, hold it 5 seconds to turn off. Press it again (or a key on a USB remote) to wake up.') : null,
      isAndroid ? null : h('div', { class: 'btns' },
        // The TV box always runs Screenroom (quitting used to leave a login screen), so offer a restart instead.
        S.appliance ? h('button', { class: 'btn secondary', onclick: () => api.power('suspend') }, 'Sleep') : null,
        S.appliance
          ? h('button', { class: 'btn secondary', onclick: () => api.quit() }, 'Restart Screenroom')
          : h('button', { class: 'btn secondary', onclick: () => api.quit() }, 'Quit Screenroom'),
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

  const FOCUSABLE = 'a[data-view], a[data-pview], button:not([disabled]), .card, .ep, .track, .srow, input, select';
  const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  function scopeEls() {
    let els;
    if (osk) els = osk.el.querySelectorAll('.osk-key');
    else if ($('#pinpad') && !$('#pinpad').hidden) els = $('#pinpad').querySelectorAll(FOCUSABLE);
    else if ($('#who') && !$('#who').hidden) els = $('#who').querySelectorAll(FOCUSABLE);
    else if (parlorUI && parlorUI.scope()) els = parlorUI.scope().querySelectorAll(FOCUSABLE);
    else if (!$('#modal').hidden) els = $('#modal').querySelectorAll(FOCUSABLE);
    else if (!$('#settings').hidden) els = $('#settings').querySelectorAll(FOCUSABLE);
    else els = document.querySelectorAll(`#nav ${FOCUSABLE.split(', ').join(', #nav ')}, #main ${FOCUSABLE.split(', ').join(', #main ')}, #npbar button`);
    return [...new Set(els)].filter(shown);
  }
  function focusEl(el) {
    navFocus = true; // moving onto a text box with the remote doesn't pop up the keyboard (OK does)
    el.focus({ preventScroll: true });
    navFocus = false;
    // (things in fixed bars / overlays are always on screen: scrolling them "into view" would shift the whole page)
    if (!el.closest('#nav, #npbar, #npfull, .poverlay')) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
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
    // Left/right inside a control strip (the music bar, player buttons) stays in that strip.
    const grp = cur.closest('[data-navrow]');
    let pool = els;
    if (grp && (dir === 'left' || dir === 'right')) { const inG = els.filter((e) => grp.contains(e)); if (inG.length > 1) pool = inG; }
    for (const el of pool) {
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
  // TV remote on a dropdown (Quality, Audio output...): OK moves to the next choice.
  function cycleSelect(sel) {
    if (!sel.options.length) return;
    sel.selectedIndex = (sel.selectedIndex + 1) % sel.options.length;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function activate() {
    const el = document.activeElement;
    if (el && el.tagName === 'SELECT') { cycleSelect(el); return; }
    if (isTextInput(el) && oskAllowed()) { openOsk(el); return; }
    if (el && el !== document.body && scopeEls().includes(el)) el.click();
    else move('down');
  }
  // Returns true if it did something (so a TV remote's Back can leave the app when there's nothing left to close).
  function goBack() {
    if (osk) { closeOsk(); return true; }
    if (pinState) { pinState.cancel(); return true; }
    if ($('#who') && !$('#who').hidden) return true;
    if (parlorUI && parlorUI.scope()) { parlorUI.back(); return true; }
    if (!$('#modal').hidden) { closeModal(); return true; }
    if (!$('#settings').hidden) { closeSettings(); return true; }
    if (document.activeElement === $('#search')) $('#search').blur();
    if (query) { query = ''; $('#search').value = ''; render(); return true; }
    if (mode === 'parlor') { if (!parlorUI.back()) toggleMode(); return true; }
    if (view !== 'home') { setView('home'); return true; }
    return false;
  }

  // ---- on-screen keyboard ----------------------------------------------------------------------------
  // TV box: pressing OK on a text box (search, Wi-Fi password, profile name...) opens a keyboard you work with
  // the remote. While a real keyboard is being used, text boxes just take its typing and Enter moves on.
  // Android has its own keyboard, so this is only for the Linux box.
  let osk = null;           // { input, el, shift, sym }
  // A real keyboard counts as "in use" for 5 minutes after it last typed a letter (then the remote's OK
  // opens the on-screen keyboard again, e.g. after the keyboard is unplugged).
  let kbTypedAt = 0;
  const kbInUse = () => Date.now() - kbTypedAt < 5 * 60 * 1000;
  let navFocus = false;
  const isTextInput = (el) => !!el && el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'range', 'color', 'file'].includes(el.type);
  const oskAllowed = () => !!(S && S.tv) && S.platform !== 'android';
  const OSK_ROWS = {
    abc: ['1234567890', 'qwertyuiop', "asdfghjkl'", 'zxcvbnm,.-'],
    sym: ['1234567890', '!@#$%&*()_', '+=/\\?:;"<>', '[]{}~`^|€£'],
  };

  function oskInsert(text) {
    const inp = osk.input;
    const max = inp.maxLength > 0 ? inp.maxLength : Infinity;
    if (text === null) inp.value = inp.value.slice(0, -1);
    else if (text === '') inp.value = '';
    else inp.value = (inp.value + text).slice(0, max);
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    drawOskField();
  }
  function drawOskField() {
    if (!osk) return;
    const v = osk.input.value;
    const shownText = osk.input.type === 'password' ? '•'.repeat(Math.max(0, v.length - 1)) + v.slice(-1) : v;
    osk.field.replaceChildren(
      v ? h('span', {}, shownText) : h('span', { class: 'osk-ph' }, osk.input.placeholder || 'Type here'),
      h('span', { class: 'osk-caret' }));
  }
  function drawOskKeys(keep) {
    const rows = osk.sym ? OSK_ROWS.sym : OSK_ROWS.abc;
    const focused = keep && document.activeElement && document.activeElement.dataset && document.activeElement.dataset.k;
    const key = (k, label, cls, fn) => h('button', { class: `osk-key ${cls || ''}`, 'data-k': k, tabindex: '-1', onclick: fn }, label);
    const letter = (ch) => {
      const c = osk.shift ? ch.toUpperCase() : ch;
      return key(ch, c, '', () => { oskInsert(c); if (osk.shift === 1) { osk.shift = 0; drawOskKeys(true); } });
    };
    osk.keys.replaceChildren(
      ...rows.map((r) => h('div', { class: 'osk-row' }, [...r].map(letter))),
      h('div', { class: 'osk-row' },
        key('shift', osk.shift === 2 ? '⇪' : '⇧', `wide ${osk.shift ? 'on' : ''}`, () => { osk.shift = osk.shift ? 0 : 1; drawOskKeys(true); }),
        key('sym', osk.sym ? 'abc' : '?123', 'wide', () => { osk.sym = !osk.sym; drawOskKeys(true); }),
        key('space', 'Space', 'space', () => oskInsert(' ')),
        key('del', '⌫', 'wide', () => oskInsert(null)),
        key('clear', 'Clear', 'wide', () => oskInsert('')),
        key('done', 'Done', 'wide done', () => closeOsk(true))));
    const again = focused && osk.keys.querySelector(`[data-k="${CSS.escape(focused)}"]`);
    if (again) again.focus({ preventScroll: true });
  }
  function openOsk(input) {
    if (osk) closeOsk();
    hideOskHint();
    const el = h('div', { id: 'osk', class: 'osk' });
    osk = { input, el, shift: 0, sym: false, field: h('div', { class: 'osk-field' }), keys: h('div', { class: 'osk-keys' }) };
    el.append(osk.field, osk.keys);
    document.body.append(el);
    document.body.classList.add('osk-open');
    drawOskField(); drawOskKeys();
    input.scrollIntoView({ block: 'center' });
    const first = el.querySelector('[data-k="q"]') || el.querySelector('.osk-key');
    first && first.focus({ preventScroll: true });
  }
  // done = true: the "Done" key, which also moves on (search: to the results; Wi-Fi password: to Join).
  function closeOsk(done) {
    if (!osk) return;
    const { input, el } = osk;
    osk = null;
    el.remove();
    document.body.classList.remove('osk-open');
    navFocus = true; input.focus({ preventScroll: true }); navFocus = false;
    if (done) afterTyping(input);
  }
  function afterTyping(input) {
    if (input.id === 'search') { input.blur(); const c = document.querySelector('#main .card, #main .btn'); c && focusEl(c); return; }
    const next = input.parentElement && input.parentElement.querySelector('button');
    if (next) { focusEl(next); return; }
    move('down');
  }
  // "Press OK to type" next to a text box reached with the remote.
  let oskHint = null;
  function showOskHint(input) {
    hideOskHint();
    const r = input.getBoundingClientRect();
    oskHint = h('div', { class: 'osk-hint' }, 'Press OK to type');
    oskHint.style.left = `${Math.max(8, r.left)}px`;
    oskHint.style.top = `${r.bottom + 6}px`;
    document.body.append(oskHint);
  }
  function hideOskHint() { if (oskHint) { oskHint.remove(); oskHint = null; } }
  document.addEventListener('focusin', (e) => {
    const t = e.target;
    if (!isTextInput(t) || !oskAllowed() || osk) { hideOskHint(); return; }
    if (navFocus) { if (!kbInUse() && document.body.classList.contains('navmode')) showOskHint(t); return; }
    hideOskHint();
  });
  document.addEventListener('focusout', () => hideOskHint());
  // Clicking a text box with a mouse / air mouse opens the keyboard too (unless a real keyboard is being used).
  document.addEventListener('click', (e) => {
    if (isTextInput(e.target) && oskAllowed() && !kbInUse() && !osk) openOsk(e.target);
  });
  const printable = (e) => e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey;

  document.addEventListener('keydown', (e) => {
    const t = e.target;
    // On-screen keyboard open: real-keyboard typing goes straight into the text box (and closes it).
    if (osk) {
      if (printable(e)) { e.preventDefault(); kbTypedAt = Date.now(); oskInsert(e.key); closeOsk(); return; }
      if (e.key === 'Backspace') { e.preventDefault(); if (!e.repeat && !osk.input.value) closeOsk(); else oskInsert(null); return; }
      if (e.key === 'Escape' || e.key === 'BrowserBack' || e.key === 'GoBack') { e.preventDefault(); closeOsk(); return; }
    }
    if (isTextInput(t) && printable(e)) kbTypedAt = Date.now();
    if (pinState && /^[0-9]$/.test(e.key)) { e.preventDefault(); pinState.add(e.key); return; }
    if (pinState && e.key === 'Backspace') { e.preventDefault(); pinState.del(); return; }
    if (t.tagName === 'INPUT' && t.type === 'search') {
      if (e.key === 'Escape') { t.blur(); e.preventDefault(); }
      else if (e.key === 'Enter' && oskAllowed() && !kbInUse()) { e.preventDefault(); openOsk(t); }
      else if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); t.blur(); const c = document.querySelector('#main .card, #main .btn'); c && focusEl(c); }
      return;
    }
    if (isTextInput(t) && !pinState) {
      // Backspace deletes; it only means "back" in an empty box, and only for remote users (holding it down
      // on a keyboard never throws away the screen you were typing in).
      if (e.key === 'Backspace') {
        if (t.value || kbInUse() || e.repeat) return;
        e.preventDefault(); goBack(); return;
      }
      // Left/right move the cursor inside the text; at either end they move on to the next thing.
      if ((e.key === 'ArrowLeft' && (t.selectionStart > 0 || t.selectionEnd > 0)) ||
          (e.key === 'ArrowRight' && t.selectionEnd < t.value.length)) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        if (oskAllowed() && !kbInUse()) openOsk(t); else afterTyping(t);
        return;
      }
    }
    const dir = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }[e.key];
    if (dir) {
      // with a mouse/keyboard a focused dropdown uses up/down itself; on a TV the arrows always move on
      // (OK steps through the choices instead)
      if (t.tagName === 'SELECT' && (dir === 'up' || dir === 'down') && !S.tv) return;
      e.preventDefault(); move(dir); return;
    }
    if (e.key === 'Escape' || e.key === 'Backspace' || e.key === 'BrowserBack' || e.key === 'GoBack') { e.preventDefault(); goBack(); return; }
    if (e.key === 'Home' || e.key === 'BrowserHome' || e.key === 'HomePage') { e.preventDefault(); closeModal(); if (!$('#settings').hidden) closeSettings(); setView('home'); return; }
    if (e.key === '/') { e.preventDefault(); $('#search').focus(); return; }
    if (api.musicCmd && (e.key === 'MediaPlayPause' || e.key === 'MediaTrackNext' || e.key === 'MediaTrackPrevious')) {
      e.preventDefault(); api.musicCmd(e.key === 'MediaPlayPause' ? 'toggle' : e.key === 'MediaTrackNext' ? 'next' : 'prev'); return;
    }
    if (e.key === 'F11' && !S.tv && S.platform !== 'android') { e.preventDefault(); api.setConfig({ appFullscreen: !S.config.appFullscreen }).then((s) => { S = s; if (!$('#settings').hidden) renderSettings(); }); return; }
    if (e.key === 'Enter' && t.tagName === 'INPUT' && t.type === 'checkbox') { e.preventDefault(); t.click(); return; }
    if (e.key === 'Enter' && t.tagName === 'SELECT' && S.tv) { e.preventDefault(); cycleSelect(t); return; }
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
      if (mode === 'parlor') toggleMode();
      openEntry(m.key);
    } else if (m.type === 'text' && osk) {
      osk.input.value = ''; oskInsert(m.text || '');
    } else if (m.type === 'text' && pinState) {
      pinState.typed(m.text);
    } else if (m.type === 'text') {
      // Typed on the phone: goes into whatever text box is focused on the TV (search, Wi-Fi password, PIN).
      const el = document.activeElement;
      if (el && el.tagName === 'INPUT' && !['checkbox', 'radio', 'button'].includes(el.type)) {
        el.value = m.text || '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        query = (m.text || '').trim(); $('#search').value = m.text || '';
        if (!$('#modal').hidden) closeModal();
        render();
      }
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
  // full screen switched from the window itself (green button / menu): keep Settings in step
  if (api.onConfigChanged) api.onConfigChanged((s) => { S = s; if (!$('#settings').hidden) renderSettings(); });
  api.onScanProgress((p) => { if (p.total) setScanning(true, p.music ? `Scanning music ${p.done}/${p.total}…` : `Scanning ${p.done}/${p.total}…`); });
  if (api.onParlorUpdated) api.onParlorUpdated(() => setScanning(false));

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

  // ---- Parlor (music) ------------------------------------------------------------------------------
  function toggleMode() {
    mode = mode === 'parlor' ? 'movies' : 'parlor';
    document.body.classList.toggle('parlor', mode === 'parlor');
    $('#nav .brand').textContent = mode === 'parlor' ? 'PARLOR' : 'SCREENROOM';
    $('#search').placeholder = mode === 'parlor' ? 'Search music…' : 'Search titles, genres…';
    const b = $('#parlor-btn');
    b.title = mode === 'parlor' ? 'Back to films' : 'Parlor (music)';
    b.innerHTML = mode === 'parlor' ? FILM_ICON : parlorUI.cdIcon();
    query = ''; $('#search').value = '';
    if (!$('#modal').hidden) closeModal();
    render(); window.scrollTo(0, 0);
    if (document.body.classList.contains('navmode')) { const f = main.querySelector('.btn, .card'); f && focusEl(f); }
  }
  const FILM_ICON = '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4" stroke="currentColor" stroke-width="1.6"/></svg>';
  if (window.createParlor && api.parlorState) {
    parlorUI = window.createParlor({
      h, $, api, flash, focusEl,
      query: () => query,
      clearQuery: () => { query = ''; $('#search').value = ''; },
      isOpen: () => mode === 'parlor',
      showModal: () => { $('#modal').hidden = false; $('#modal').scrollTop = 0; },
      closeModal,
      openSettings: () => { openSettings(); const s = $('#set-parlor'); s && s.scrollIntoView({ block: 'start' }); const b = $('#set-parlor') && $('#set-parlor').nextElementSibling; const f = b && b.querySelector('button'); f && f.focus({ preventScroll: true }); },
      wantsKeyboard: () => oskAllowed() && !kbInUse(),
    });
    const b = $('#parlor-btn');
    b.hidden = false;
    b.innerHTML = parlorUI.cdIcon();
    b.addEventListener('click', toggleMode);
    document.querySelectorAll('#pnav a').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); parlorUI.go(a.dataset.pview); }));
  }

  (async () => { S = await api.state(); render(); wake(); })();
})();
