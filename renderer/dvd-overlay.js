'use strict';
// The DVD controls: a panel along the bottom of the screen, over the film, opened with Back on the remote.
// The remote's buttons come from Screenroom (window.dvd.onKey): left / right pick a button, OK presses it.
(() => {
  const $ = (id) => document.getElementById(id);
  const ICON = {
    play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
    menu: '<svg viewBox="0 0 24 24"><path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h10v2H4z"/></svg>',
    prev: '<svg viewBox="0 0 24 24"><path d="M6 5h2v14H6zm3.5 7L18 5v14z"/></svg>',
    next: '<svg viewBox="0 0 24 24"><path d="M16 5h2v14h-2zM6 5l8.5 7L6 19z"/></svg>',
    audio: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z"/></svg>',
    subs: '<svg viewBox="0 0 24 24"><path d="M3 5h18v14H3zm2 2v10h14V7zm2 6h4v2H7zm6 0h4v2h-4zm-6-3h10v2H7z"/></svg>',
    rew: '<svg viewBox="0 0 24 24"><path d="M11.5 6v12L3 12zm9 0v12L12 12z"/></svg>',
    fwd: '<svg viewBox="0 0 24 24"><path d="M12.5 6v12L21 12zm-9 0v12L12 12z"/></svg>',
    stop: '<svg viewBox="0 0 24 24"><path d="M6 6h12v12H6z"/></svg>',
    eject: '<svg viewBox="0 0 24 24"><path d="M5 17h14v2H5zm7-12 7 9H5z"/></svg>',
  };
  let state = null;
  // "English - Dolby Digital 5.1 (3/2.1)" → "English 5.1"
  const short = (t) => { t = String(t || '').trim(); if (!t || /^disable/i.test(t)) return ''; const ch = /(\d\.\d)/.exec(t); return t.split(/\s*[-(\[]/)[0] + (ch ? ` ${ch[1]}` : ''); };
  let focus = 0;
  const PLAY = 1; // (where the controls open: Play / Pause)
  const buttons = () => [
    { id: 'rew', icon: 'rew', label: '10 s' },
    { id: 'playpause', icon: state && state.live && state.live.paused ? 'play' : 'pause', label: state && state.live && state.live.paused ? 'Play' : 'Pause' },
    { id: 'ffwd', icon: 'fwd', label: '30 s' },
    { id: 'discmenu', icon: 'menu', label: 'Disc Menu', cls: 'ic2' },
    { id: 'prev', icon: 'prev', label: 'Chapter', cls: 'ic' },
    { id: 'next', icon: 'next', label: 'Chapter', cls: 'ic' },
    { id: 'audio', icon: 'audio', label: short(state && state.live && state.live.audio) || 'Audio' },
    { id: 'subtitle', icon: 'subs', label: short(state && state.live && state.live.subs) || 'Subtitles Off' },
    { id: 'stop', icon: 'stop', label: 'Stop', cls: 'ic' },
    { id: 'eject', icon: 'eject', label: 'Eject', cls: 'ic' },
  ];
  function draw() {
    const s = state || {};
    $('title').textContent = s.kind === 'bluray' ? 'Blu-ray' : 'DVD';
    const p = $('poster');
    if (s.poster) { p.classList.remove('none'); p.style.backgroundImage = `url("file://${encodeURI(s.poster)}")`; } else p.classList.add('none');
    const l = s.live || {};
    const where = [];
    if (l.title === 0) where.push('Disc menu');
    else {
      if (l.title) where.push(`Title ${l.title}`);
      if (l.chapter) where.push(`Chapter ${l.chapter}`);
    }
    $('where').textContent = s.peek && l.volume != null ? `Volume ${l.volume}%` : where.join(' · ');
    document.body.classList.toggle('peek', !!s.peek);
    $('at').textContent = l.at || '0:00';
    $('len').textContent = l.length ? l.len : '';
    $('fill').style.width = l.length ? `${Math.min(100, (l.time / l.length) * 100)}%` : '0';
    const list = buttons();
    focus = Math.max(0, Math.min(focus, list.length - 1));
    $('btns').replaceChildren(...list.map((b, i) => {
      const el = document.createElement('button');
      el.className = [b.cls || '', i === focus && !s.peek && !pointerOnly ? 'focus' : ''].join(' ').trim();
      el.title = b.id === 'prev' ? 'Previous chapter' : b.id === 'next' ? 'Next chapter' : b.label;
      el.innerHTML = ICON[b.icon] + `<span>${b.label}</span>`;
      el.onclick = () => { focus = i; press(); };
      return el;
    }), Object.assign(document.createElement('span'), { className: 'hint', innerHTML: '<b>Back</b> to return to the film' }));
    $('vol').style.width = `${Math.min(100, l.volume || 0)}%`;
  }
  function press() {
    const b = buttons()[focus];
    if (!b) return;
    window.dvd.cmd(b.id);
  }
  let pointerOnly = false; // (opened by the touchpad: no highlight until a key is pressed)
  window.dvd.onOpen((s) => { state = s; focus = PLAY; pointerOnly = !!s.pointer; draw(); });
  window.dvd.onState((s) => { state = s; draw(); });
  window.dvd.onKey((k) => {
    if (pointerOnly) { pointerOnly = false; if (k === 'left' || k === 'right') { draw(); return; } }
    const n = buttons().length;
    if (k === 'left') focus = (focus + n - 1) % n;
    else if (k === 'right') focus = (focus + 1) % n;
    else if (k === 'ok') { press(); return; }
    draw();
  });
  // the pointer resting on the controls keeps them up
  let held = 0;
  window.addEventListener('mousemove', () => { if (Date.now() - held > 500) { held = Date.now(); window.dvd.cmd('hold'); } });
  draw();
})();
