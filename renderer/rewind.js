// Rewind: a VCR look for the Screenroom box (Settings → Look → Theme). A blue screen, blocky white letters,
// grey bars along the top and bottom, the highlighted line shown in reverse, a tape counter, BEGIN ▼ END.
// Text first: the title menu is a list of names, not posters.
//
// Everything is drawn on a 1280×720 "screen" that's scaled to fit the TV, so it looks the same on any set.
// The film side only: Parlor (music) keeps its own look.
(function () {
  'use strict';
  window.createRewind = function (ctx) {
    const { h } = ctx;
    const S = () => ctx.state();
    const C = () => (S() && S().config) || {};

    let cat = 'all';          // which list the title menu shows (ALL, RESUME, MOVIES, TV, 4K, a holiday)
    let curKey = null;        // the highlighted title
    let searchOpen = false;
    let lastLetter = 'A';     // the highlighted key on the search screen
    let detailPick = null;    // the film menu's choices: { key, audio, epKey }

    // ---- the 1280×720 screen, scaled to the window ---------------------------------------------------------
    const fit = () => document.documentElement.style.setProperty('--rwk', String(Math.min(innerWidth / 1280, innerHeight / 720)));
    fit();
    addEventListener('resize', fit);
    const stage = (cls, ...kids) => h('div', { class: 'rw-stage ' + (cls || '') }, ...kids);

    // ---- little helpers ----------------------------------------------------------------------------------------
    const up = (s) => String(s == null ? '' : s).toUpperCase();
    const hms = (s) => {
      s = Math.max(0, Math.floor(s || 0));
      return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    };
    function clockText() {
      const d = new Date();
      const mm = String(d.getMinutes()).padStart(2, '0');
      if (String(C().rwClock) === '24') return `${String(d.getHours()).padStart(2, '0')}:${mm}`;
      return `${d.getHours() % 12 || 12}:${mm}${d.getHours() < 12 ? 'AM' : 'PM'}`;
    }
    setInterval(() => document.querySelectorAll('.rw-clock').forEach((el) => { el.textContent = clockText(); }), 10000);
    const clock = () => h('span', { class: 'rw-clock' }, clockText());
    const okBox = () => h('span', { class: 'rw-okbox' }, 'OK');
    const banner = (label, right) => h('div', { class: 'rw-ban rw-top' },
      h('span', { class: 'rw-ban-l' }, label), h('span', { class: 'rw-ban-r' }, ...(right || [])));
    const foot = (a, b) => h('div', { class: 'rw-ban rw-foot' }, h('span', {}, ...a), h('span', {}, ...b));
    const sortName = (n) => up(n).replace(/^(THE|A|AN)\s+/, '');
    const epShort = (ep) => `S${ep.tv.season} E${ep.tv.label || ep.tv.episode}`;

    function tagsOf(items) {
      const t = [];
      if (items.some((i) => ctx.resOf(i) === '4K')) t.push('4K');
      if (items.some((i) => i.video && (i.video.dv || i.video.hdr))) t.push('HDR');
      if (items.some((i) => (i.audio || []).some((a) => /atmos/i.test(a.label || '')))) t.push('ATMOS');
      else if (items.some((i) => (i.audio || []).some((a) => a.family === 'dts'))) t.push('DTS');
      return t.join(' · ');
    }

    // where a film (or a series' next episode) is up to, as the info panel shows it
    function infoFor(e) {
      if (e.kind === 'movie') {
        const it = e.item, p = ctx.prog(it.id), dur = it.duration || (p && p.dur) || 0;
        let status = 'NEW', pos = 0;
        if (p && p.done) { status = 'WATCHED'; pos = dur; } else if (p && p.pos > 5) { status = 'RESUME AT'; pos = p.pos; }
        return { a: e.year ? String(e.year) : '', b: dur ? hms(dur) : '', status, counter: hms(pos), frac: dur ? Math.min(1, pos / dur) : 0, tags: tagsOf(e.versions || [it]) };
      }
      const n = ctx.nextUp(e), ep = n.ep, p = ctx.prog(ep.id), dur = ep.duration || (p && p.dur) || 0;
      let status = 'NEW', pos = 0;
      if (n.mode === 'resume') { status = 'RESUME ' + epShort(ep); pos = p ? p.pos : 0; } else if (n.mode === 'next') status = 'NEXT ' + epShort(ep);
      else if (n.mode === 'finished') { status = 'WATCHED'; pos = dur; }
      const yrs = e.year ? (e.yearEnd && e.yearEnd !== e.year ? `${e.year}-${e.yearEnd}` : String(e.year)) : '';
      return { a: yrs, b: `${e.seasons.size} SEASON${e.seasons.size === 1 ? '' : 'S'} · ${e.eps.length} EP`, status, counter: hms(pos), frac: dur ? Math.min(1, pos / dur) : 0, tags: tagsOf(e.items) };
    }
    function posBar(frac) {
      const pct = (Math.max(0, Math.min(1, frac || 0)) * 100).toFixed(2) + '%';
      return h('div', { class: 'rw-pos', 'aria-hidden': 'true' },
        h('div', { class: 'rw-pos-mark', style: `left:clamp(0px, calc(${pct} - 13px), calc(100% - 26px))` }, '▼'),
        h('div', { class: 'rw-pos-bar' }, h('i', {}), h('i', {}), h('i', {}), h('i', {}), h('i', {}), h('div', { class: 'rw-pos-fill', style: `width:${pct}` })),
        h('div', { class: 'rw-pos-lab' }, h('span', {}, 'BEGIN'), h('span', {}, 'END')));
    }
    const infoBox = (i) => h('div', { class: 'rw-info' },
      h('div', {}, i.a), h('div', {}, i.b),
      h('div', { class: 'rw-status' }, i.status), h('div', { class: 'rw-counter' }, i.counter),
      posBar(i.frac),
      i.tags ? h('div', { class: 'rw-tags' }, i.tags) : null);

    // ---- the title menu ---------------------------------------------------------------------------------------
    function lists() {
      const all = ctx.catalogOf();
      const out = [['all', 'ALL', all.slice().sort((a, b) => sortName(a.name).localeCompare(sortName(b.name)))]];
      const cont = ctx.continueList(all).map((c) => c.entry);
      if (cont.length) out.push(['resume', 'RESUME', cont]);
      const later = ctx.laterList(all);
      if (later.length) out.push(['later', 'LATER', later]);
      // the holidays coming up (Christmas films from November, …)
      for (const [name, list] of ctx.holidayRows(all)) {
        const seen = new Set();
        const l = list.map((x) => x.entry || x).filter((e) => !seen.has(e.key) && seen.add(e.key));
        out.push(['hol:' + name, up(name.replace(/\s+(Movies|Films).*$/i, '')), l]);
      }
      const movies = out[0][2].filter((e) => e.kind === 'movie'), shows = out[0][2].filter((e) => e.kind === 'series');
      if (movies.length && shows.length) { out.push(['movies', 'MOVIES', movies]); out.push(['tv', 'TV', shows]); }
      const uhd = ctx.catalogOf((i) => ctx.resOf(i) === '4K');
      if (uhd.length && uhd.length < all.length) out.push(['4k', '4K', uhd.sort((a, b) => sortName(a.name).localeCompare(sortName(b.name)))]);
      return out;
    }

    function topKeys() {
      const keys = [h('button', { class: 'rw-key', 'data-rw': 'search', onclick: () => openSearch() }, 'SEARCH')];
      if (ctx.hasMusic()) keys.push(h('button', { class: 'rw-key', 'data-rw': 'music', onclick: () => ctx.toggleMode() }, 'MUSIC'));
      keys.push(h('button', { class: 'rw-key', 'data-rw': 'setup', onclick: () => ctx.openSettings() }, 'SETUP'));
      const p = S().profile;
      if (p && (S().profiles || []).length > 1) keys.push(h('button', { class: 'rw-key', 'data-rw': 'who', title: 'Switch profile', onclick: () => ctx.switchProfile() }, up(p.name).slice(0, 10)));
      return keys;
    }

    function drawMenu() {
      const all = lists();
      const cur = all.find((x) => x[0] === cat) || all[0];
      cat = cur[0];
      const entries = cur[2];
      if (!entries.some((e) => e.key === curKey)) curKey = entries.length ? entries[0].key : null;
      const info = h('div', { class: 'rw-side' });
      const rows = entries.map((e) => h('button', { class: 'rw-row', 'data-key': e.key, onclick: () => ctx.openEntry(e.key) },
        h('span', { class: 'rw-mark', 'aria-hidden': 'true' }, '▶'), h('span', { class: 'rw-t' }, up(e.name))));
      const show = (key) => {
        const e = entries.find((x) => x.key === key);
        if (!e) return;
        curKey = key;
        for (const r of rows) r.classList.toggle('cur', r.dataset.key === key);
        info.replaceChildren(infoBox(infoFor(e)));
      };
      const list = h('div', { class: 'rw-list' }, rows.length ? rows : h('div', { class: 'rw-none' }, 'NO TITLES'));
      list.addEventListener('focusin', (ev) => { const r = ev.target.closest('.rw-row'); if (r) show(r.dataset.key); });
      const moreUp = h('div', { class: 'rw-more up', 'aria-hidden': 'true' }, '▲ MORE');
      const moreDn = h('div', { class: 'rw-more dn', 'aria-hidden': 'true' }, '▼ MORE');
      const more = () => {
        moreUp.classList.toggle('on', list.scrollTop > 4);
        moreDn.classList.toggle('on', list.scrollTop + list.clientHeight < list.scrollHeight - 4);
      };
      list.addEventListener('scroll', more, { passive: true });
      const tabs = all.length > 1 ? h('div', { class: 'rw-cats' }, all.map(([id, label]) => h('button', {
        class: 'rw-cat' + (id === cat ? ' on' : ''), 'data-cat': id,
        onclick: () => { cat = id; curKey = null; ctx.render(); const f = document.querySelector(`.rw-cat[data-cat="${CSS.escape(id)}"]`); f && ctx.focus(f); },
      }, label))) : null;
      ctx.main().replaceChildren(stage('rw-menu',
        banner('TITLE MENU', [...topKeys(), clock()]),
        tabs, list, moreUp, moreDn, info,
        foot(['SELECT WITH (▲▼) AND ', okBox()], ['PRESS (MENU) FOR SETUP'])));
      show(curKey);
      const c = list.querySelector('.rw-row.cur');
      if (c) c.scrollIntoView({ block: 'center' });
      requestAnimationFrame(more);
    }

    // ---- title search: letters picked with the arrows (or typed on the phone remote) ---------------------------
    const KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('');
    function openSearch() {
      searchOpen = true;
      ctx.render();
      const k = document.querySelector('.rw-k[data-k="A"]');
      if (k) ctx.focus(k);
    }
    function found(q) {
      const all = ctx.catalogOf().sort((a, b) => sortName(a.name).localeCompare(sortName(b.name)));
      const Q = up(q).trim();
      if (!Q) return all;
      const name = (e) => ' ' + up(e.name).replace(/[’']/g, '');
      const starts = all.filter((e) => name(e).includes(' ' + Q.replace(/[’']/g, '')));
      if (starts.length || Q.length < 3) return starts;
      return all.filter((e) => ctx.matches(e)); // (longer words: genres, descriptions, holidays too)
    }
    function drawSearch() {
      const q = ctx.query();
      const field = h('span', { class: 'rw-field' }, up(q), h('span', { class: 'rw-cursor', 'aria-hidden': 'true' }));
      const res = h('div', { class: 'rw-results' });
      const drawResults = () => {
        const list = found(ctx.query());
        const Q = ctx.query().trim();
        res.replaceChildren(
          h('div', { class: 'rw-count' }, !Q ? `ALL ${list.length} TITLES` : list.length ? `${list.length} FOUND` : 'NO TITLES FOUND'),
          h('div', { class: 'rw-reslist' }, list.slice(0, 40).map((e) => h('button', { class: 'rw-res', 'data-key': e.key, onclick: () => ctx.openEntry(e.key) }, up(e.name)))));
      };
      const type = (fn, k) => {
        lastLetter = k;
        ctx.setQuery(fn(ctx.query()).slice(0, 30));
        field.firstChild.textContent = up(ctx.query());
        drawResults();
      };
      const keys = [
        ...KEYS.map((c) => h('button', { class: 'rw-k', 'data-k': c, onclick: () => type((s) => s + c, c) }, c)),
        h('button', { class: 'rw-k wide4', 'data-k': 'SP', onclick: () => type((s) => s + ' ', 'SP') }, 'SPACE'),
        h('button', { class: 'rw-k wide3', 'data-k': 'DEL', onclick: () => type((s) => s.slice(0, -1), 'DEL') }, 'DEL'),
        h('button', { class: 'rw-k wide3', 'data-k': 'CLR', onclick: () => type(() => '', 'CLR') }, 'CLEAR'),
      ];
      drawResults();
      ctx.main().replaceChildren(stage('rw-search',
        banner('TITLE SEARCH', [clock()]),
        h('div', { class: 'rw-entry' }, h('span', {}, 'TITLE:'), field),
        h('div', { class: 'rw-keys' }, keys),
        res,
        foot(['PICK LETTERS WITH (▲▼◀▶) AND ', okBox(), ', OR TYPE ON YOUR PHONE'], ['PRESS (BACK) FOR THE TITLE MENU'])));
    }

    // ---- a film's menu (and a series' episodes) --------------------------------------------------------------
    const pickRow = (label, items) => h('div', { class: 'rw-pickrow' }, h('span', { class: 'rw-picklab' }, label), h('div', { class: 'rw-picks' }, items));
    const trackName = (a) => {
      const bits = [up(a.lang || '').slice(0, 3) || `TRACK ${a.n}`];
      if (/atmos/i.test(a.label || '')) bits.push('ATMOS'); else if (a.layout) bits.push(up(a.layout).replace(/\s+/g, ''));
      return bits.join(' ');
    };
    const copyName = (v) => { const q = window.MediaCore ? MediaCore.qualityOf(v) : ''; const vid = v.video || {}; return q === '4K' ? '4K' : q === 'HD' ? `HD ${up(vid.res || '')}`.trim() : `SD ${vid.height ? vid.height + 'P' : ''}`.trim(); };

    // + Watch later / take it off again
    const laterOpt = (e) => h('button', { class: 'rw-opt', 'data-rwopt': 'later', onclick: async () => {
      await ctx.toggleLater(e); ctx.renderModal(); ctx.render();
      const b = document.querySelector('.rw-opt[data-rwopt="later"]'); b && ctx.focus(b);
    } }, h('span', { class: 'rw-mark' }, '▶'), ctx.inLater(e) ? 'TAKE OFF WATCH LATER' : 'WATCH LATER');

    function movieMenu(e, open) {
      const vs = e.versions || [e.item];
      const item = (open.version && vs.find((v) => v.id === open.version)) || e.item;
      const p = ctx.prog(item.id);
      const resumable = p && !p.done && p.pos > 5;
      if (!detailPick || detailPick.key !== item.id) {
        const def = item.audio.find((a) => a.default) || item.audio[0];
        detailPick = { key: item.id, audio: def ? def.n : null };
      }
      const dp = detailPick;
      const opts = [];
      if (resumable) opts.push(h('button', { class: 'rw-opt rw-first', onclick: () => ctx.start(item.id, dp.audio) }, h('span', { class: 'rw-mark' }, '▶'), 'RESUME'));
      opts.push(h('button', { class: 'rw-opt' + (resumable ? '' : ' rw-first'), onclick: () => ctx.start(item.id, dp.audio, true) }, h('span', { class: 'rw-mark' }, '▶'), resumable ? 'PLAY FROM BEGIN' : 'PLAY'));
      opts.push(h('button', { class: 'rw-opt', onclick: () => ctx.setWatched(vs.map((v) => v.id), !(p && p.done)) }, h('span', { class: 'rw-mark' }, '▶'), p && p.done ? 'MARK UNWATCHED' : 'MARK WATCHED'));
      if (!(p && p.done)) opts.push(laterOpt(e));
      const picks = [];
      if (item.audio.length > 1) picks.push(pickRow('AUDIO', item.audio.slice(0, 5).map((a) => h('button', {
        class: 'rw-pick' + (a.n === dp.audio ? ' on' : ''), title: a.label,
        onclick: (ev) => { dp.audio = a.n; ev.currentTarget.parentNode.querySelectorAll('.rw-pick').forEach((b) => b.classList.toggle('on', b === ev.currentTarget)); },
      }, trackName(a)))));
      if (vs.length > 1) picks.push(pickRow('COPY', vs.map((v) => h('button', {
        class: 'rw-pick' + (v.id === item.id ? ' on' : ''), 'data-ver': v.id,
        onclick: () => { open.version = v.id; ctx.renderModal(); const b = document.querySelector(`.rw-pick[data-ver="${CSS.escape(v.id)}"]`); b && ctx.focus(b); },
      }, copyName(v)))));
      const dur = item.duration || (p && p.dur) || 0;
      const pos = p ? (p.done ? dur : p.pos) : 0;
      const info = { a: dur ? 'LENGTH ' + hms(dur) : '', b: '', status: p && p.done ? 'WATCHED' : resumable ? 'RESUME AT' : 'NEW', counter: hms(pos), frac: dur ? pos / dur : 0, tags: tagsOf([item]) };
      return stage('rw-film',
        banner(up(e.name), [e.year ? h('span', {}, String(e.year)) : null, clock()]),
        h('div', { class: 'rw-opts' }, opts),
        h('div', { class: 'rw-pickset' }, picks),
        h('div', { class: 'rw-side' }, infoBox(info), h('p', { class: 'rw-desc' }, item.description || '')),
        foot(['SELECT WITH (▲▼) AND ', okBox()], ['PRESS (BACK) FOR THE TITLE MENU']));
    }

    function seriesMenu(e, open) {
      const seasons = [...e.seasons.keys()].sort((a, b) => a - b);
      if (!seasons.includes(open.season)) open.season = seasons[0];
      const eps = e.seasons.get(open.season);
      const n = ctx.nextUp(e);
      const side = h('div', { class: 'rw-side' });
      const showEp = (ep) => {
        const p = ctx.prog(ep.id), dur = ep.duration || (p && p.dur) || 0;
        const pos = p ? (p.done ? dur : p.pos) : 0;
        side.replaceChildren(
          h('div', { class: 'rw-epname' }, epShort(ep) + '  ' + up(ep.tv.name || '')),
          infoBox({ a: dur ? 'LENGTH ' + hms(dur) : '', b: '', status: p && p.done ? 'WATCHED' : p && p.pos > 5 ? 'RESUME AT' : 'NEW', counter: hms(pos), frac: dur ? pos / dur : 0, tags: tagsOf([ep]) }),
          h('p', { class: 'rw-desc short' }, ep.description || e.description || ''));
      };
      const main = n.mode === 'resume' ? `RESUME ${epShort(n.ep)}` : n.mode === 'next' ? `PLAY ${epShort(n.ep)}` : `PLAY ${epShort(n.ep)}`;
      const opts = [h('button', { class: 'rw-opt rw-first', onclick: () => ctx.playEntry(e) }, h('span', { class: 'rw-mark' }, '▶'), main)];
      if (n.mode === 'resume') opts.push(h('button', { class: 'rw-opt', onclick: () => ctx.start(n.ep.id, null, true) }, h('span', { class: 'rw-mark' }, '▶'), `${epShort(n.ep)} FROM BEGIN`));
      opts.push(laterOpt(e));
      const seasonRow = seasons.length > 1 ? pickRow('SEASON', seasons.map((s) => h('button', {
        class: 'rw-pick' + (s === open.season ? ' on' : ''), 'data-season': s,
        onclick: () => { open.season = s; open.focusEp = null; ctx.renderModal(); const b = document.querySelector(`.rw-pick[data-season="${s}"]`); b && ctx.focus(b); },
      }, s === 0 ? 'SP' : String(s)))) : null;
      const epRows = eps.map((ep) => {
        const done = ctx.isDone(ep.id);
        const b = h('button', { class: 'rw-ep', 'data-ep': ep.id, onclick: () => ctx.start(ep.id, null, false) },
          h('span', { class: 'rw-mark' }, '▶'),
          h('span', { class: 'rw-epn' }, 'E' + String(ep.tv.label || ep.tv.episode).padStart(2, '0')),
          h('span', { class: 'rw-t' }, up(ep.tv.name || '')),
          h('span', { class: 'rw-done' }, done ? '✓' : ''));
        b.addEventListener('focus', () => showEp(ep));
        return b;
      });
      const box = h('div', { class: 'rw-eps' }, epRows);
      const focusEp = open.focusEp && eps.find((x) => x.id === open.focusEp);
      showEp(focusEp || (eps.includes(n.ep) ? n.ep : eps[0]));
      const yrs = e.year ? (e.yearEnd && e.yearEnd !== e.year ? `${e.year}-${e.yearEnd}` : String(e.year)) : '';
      if (focusEp) setTimeout(() => { const el = document.querySelector(`.rw-ep[data-ep="${CSS.escape(focusEp.id)}"]`); if (el) { el.scrollIntoView({ block: 'center' }); ctx.focus(el); } }, 30);
      return stage('rw-film rw-series',
        banner(up(e.name), [yrs ? h('span', {}, yrs) : null, clock()]),
        h('div', { class: 'rw-left' }, h('div', { class: 'rw-opts' }, opts), seasonRow ? h('div', { class: 'rw-pickset' }, seasonRow) : null, box),
        side,
        foot(['SELECT WITH (▲▼) AND ', okBox()], ['PRESS (BACK) FOR THE TITLE MENU']));
    }

    // ---- start-up: the clock blinking 12:00, LOADING ----------------------------------------------------------
    let bootShown = false;
    function boot() {
      if (bootShown) return;
      bootShown = true;
      const segs = Array.from({ length: 30 }, (_, i) => h('i', { style: `animation-delay:${(i * 0.06).toFixed(2)}s` }));
      const el = h('div', { id: 'rw-boot' }, stage('rw-bootstage',
        h('div', { class: 'rw-blink rw-boot-clock' }, '12:00'),
        h('div', { class: 'rw-boot-name' }, 'SCREENROOM'),
        h('div', { class: 'rw-boot-sub' }, 'HOME VIDEO SYSTEM'),
        h('div', { class: 'rw-boot-load' }, h('span', {}, 'LOADING'), h('div', { class: 'rw-segs' }, segs))));
      document.body.append(el);
      const done = () => { removeEventListener('keydown', done, true); el.classList.add('out'); setTimeout(() => el.remove(), 250); };
      addEventListener('keydown', done, true);
      setTimeout(done, 2600);
    }

    // ---- snow (December, always, or never) and scanlines -----------------------------------------------------
    function decorate() {
      const on = ctx.active();
      const scan = C().rwScan !== false;
      document.body.classList.toggle('rw-scan', on && scan);
      const mode = C().rwSnow || 'dec';
      const snow = on && (mode === 'on' || (mode === 'dec' && new Date().getMonth() === 11));
      let el = document.getElementById('rw-snow');
      if (snow && !el) {
        el = h('div', { id: 'rw-snow', 'aria-hidden': 'true' }, Array.from({ length: 56 }, (_, i) => {
          const d = 10 + ((i * 7) % 12);
          return h('i', { style: `left:${((i * 113) % 1000) / 10}%;animation-duration:${d}s;animation-delay:${-((i * 11) % 22)}s;animation-timing-function:steps(${d * 6})` });
        }));
        document.body.append(el);
      } else if (!snow && el) el.remove();
    }

    // ---- menu sounds: a short beep on each move, a higher one on OK -------------------------------------------
    let actx = null;
    function blip(kind) {
      if (!ctx.active() || C().rwSounds === false) return;
      try {
        actx = actx || new (window.AudioContext || window.webkitAudioContext)();
        const o = actx.createOscillator(), g = actx.createGain();
        o.type = 'square';
        o.frequency.value = kind === 'ok' ? 1320 : 880;
        const t = actx.currentTime;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.05, t + 0.005);
        g.gain.exponentialRampToValueAtTime(0.0001, t + (kind === 'ok' ? 0.09 : 0.04));
        o.connect(g).connect(actx.destination);
        o.start(t); o.stop(t + 0.1);
      } catch { /* no sound device: never mind */ }
    }

    // ---- the screensaver's logo: a disc and the name, bouncing -------------------------------------------------
    function saverLogo() {
      const el = h('div', { class: 'saver-logo rw-saver' });
      el.innerHTML = '<svg viewBox="0 0 150 34" width="150" height="34" aria-hidden="true"><ellipse cx="75" cy="17" rx="72" ry="14" fill="none" stroke="currentColor" stroke-width="3"/><ellipse cx="75" cy="17" rx="12" ry="4" fill="currentColor"/></svg><span>SCREENROOM</span>';
      return el;
    }

    return {
      render() {
        decorate();
        if (ctx.query() || searchOpen) { searchOpen = true; drawSearch(); } else drawMenu();
        if (performance.now() < 20000) boot();
      },
      detail(e, open) { return e.kind === 'series' ? seriesMenu(e, open) : movieMenu(e, open); },
      // Back on the search screen: to the title menu, on the highlighted title
      back() {
        if (!searchOpen) return false;
        searchOpen = false;
        ctx.setQuery('');
        ctx.render();
        const b = document.querySelector('.rw-key[data-rw="search"]');
        if (b) ctx.focus(b);
        return true;
      },
      reset() { searchOpen = false; },
      // the remote between the list, the tabs above it and the keys along the top: always onto the chosen tab and
      // the highlighted title (not just whichever is nearest)
      nav(el, dir) {
        if (!el || !el.closest) return null;
        const q = (sel) => document.querySelector(sel);
        if (dir === 'up' && el.matches('.rw-row') && !el.previousElementSibling) return q('.rw-cat.on') || q('.rw-key');
        if (dir === 'down' && el.matches('.rw-cat')) return q('.rw-row.cur') || q('.rw-row');
        if (dir === 'down' && el.matches('.rw-key') && el.closest('.rw-menu')) return q('.rw-cat.on') || q('.rw-row.cur');
        if (dir === 'up' && el.matches('.rw-cat')) return q('.rw-key[data-rw="search"]');
        return null;
      },
      searching: () => searchOpen,
      decorate, blip, saverLogo,
    };
  };
})();
