// Profile pictures: a set of original characters, drawn as small SVGs in one flat, friendly style.
// Each sits on the profile's own colour (the rounded square behind it), so the same character in two
// colours still looks like two different people. window.Avatars = { list, svg(id) }.
(function () {
  'use strict';
  const INK = '#2b2b2b';
  const eyes = (x1, x2, y, r = 2.6) => `<circle cx="${x1}" cy="${y}" r="${r}" fill="${INK}"/><circle cx="${x2}" cy="${y}" r="${r}" fill="${INK}"/>` +
    `<circle cx="${x1 + 0.9}" cy="${y - 0.9}" r="${r * 0.35}" fill="#fff"/><circle cx="${x2 + 0.9}" cy="${y - 0.9}" r="${r * 0.35}" fill="#fff"/>`;
  const cheeks = (x1, x2, y) => `<circle cx="${x1}" cy="${y}" r="2.6" fill="#ff8fa3" opacity=".55"/><circle cx="${x2}" cy="${y}" r="2.6" fill="#ff8fa3" opacity=".55"/>`;
  const smile = (cx, y, w = 5) => `<path d="M${cx - w} ${y} Q${cx} ${y + w * 0.9} ${cx + w} ${y}" fill="none" stroke="${INK}" stroke-width="1.8" stroke-linecap="round"/>`;

  const CHARACTERS = [
    { id: 'fox', name: 'Fox', body: `
      <path d="M14 22 L20 6 L28 18 Z" fill="#e8742c"/><path d="M50 22 L44 6 L36 18 Z" fill="#e8742c"/>
      <path d="M17 19 L20 11 L24 17 Z" fill="#fff3e6"/><path d="M47 19 L44 11 L40 17 Z" fill="#fff3e6"/>
      <path d="M12 30 Q12 16 32 16 Q52 16 52 30 Q52 46 32 54 Q12 46 12 30 Z" fill="#f08a3a"/>
      <path d="M20 38 Q32 34 44 38 Q40 52 32 54 Q24 52 20 38 Z" fill="#fff3e6"/>
      ${eyes(25, 39, 31)}<ellipse cx="32" cy="42" rx="3" ry="2.2" fill="${INK}"/>` },
    { id: 'cat', name: 'Cat', body: `
      <path d="M13 26 L15 8 L27 17 Z" fill="#9aa3ad"/><path d="M51 26 L49 8 L37 17 Z" fill="#9aa3ad"/>
      <path d="M17 21 L18 13 L24 18 Z" fill="#f7b8c4"/><path d="M47 21 L46 13 L40 18 Z" fill="#f7b8c4"/>
      <ellipse cx="32" cy="35" rx="21" ry="19" fill="#aeb6bf"/>
      ${eyes(24, 40, 33, 2.8)}<path d="M30 39 L34 39 L32 41.5 Z" fill="#f28ba0"/>
      <path d="M32 41.5 Q29 45 26 43 M32 41.5 Q35 45 38 43" fill="none" stroke="${INK}" stroke-width="1.4" stroke-linecap="round"/>
      <path d="M10 36 H20 M10 40 H20 M44 36 H54 M44 40 H54" stroke="${INK}" stroke-width="1" opacity=".5"/>` },
    { id: 'dog', name: 'Dog', body: `
      <ellipse cx="14" cy="30" rx="7" ry="13" fill="#8a5a3b" transform="rotate(14 14 30)"/><ellipse cx="50" cy="30" rx="7" ry="13" fill="#8a5a3b" transform="rotate(-14 50 30)"/>
      <ellipse cx="32" cy="34" rx="18" ry="19" fill="#d9a066"/>
      <ellipse cx="32" cy="43" rx="10" ry="8" fill="#f3d6b1"/><circle cx="40" cy="27" r="5" fill="#b9814f" opacity=".7"/>
      ${eyes(25, 39, 31)}<ellipse cx="32" cy="40" rx="3.6" ry="2.6" fill="${INK}"/>${smile(32, 45, 3.5)}` },
    { id: 'bear', name: 'Bear', body: `
      <circle cx="16" cy="18" r="7" fill="#7a5235"/><circle cx="48" cy="18" r="7" fill="#7a5235"/>
      <circle cx="16" cy="18" r="3.5" fill="#c99a6e"/><circle cx="48" cy="18" r="3.5" fill="#c99a6e"/>
      <circle cx="32" cy="34" r="20" fill="#8d6040"/><ellipse cx="32" cy="42" rx="9" ry="7" fill="#d7b08a"/>
      ${eyes(25, 39, 31)}<ellipse cx="32" cy="39" rx="3.2" ry="2.3" fill="${INK}"/>${smile(32, 43, 3)}` },
    { id: 'panda', name: 'Panda', body: `
      <circle cx="16" cy="17" r="7" fill="${INK}"/><circle cx="48" cy="17" r="7" fill="${INK}"/>
      <circle cx="32" cy="34" r="20" fill="#f6f6f6"/>
      <ellipse cx="24" cy="32" rx="5.5" ry="7" fill="${INK}" transform="rotate(-25 24 32)"/><ellipse cx="40" cy="32" rx="5.5" ry="7" fill="${INK}" transform="rotate(25 40 32)"/>
      <circle cx="24.5" cy="31.5" r="2.2" fill="#fff"/><circle cx="39.5" cy="31.5" r="2.2" fill="#fff"/>
      <ellipse cx="32" cy="40" rx="3" ry="2.2" fill="${INK}"/>${smile(32, 44, 3)}${cheeks(20, 44, 41)}` },
    { id: 'owl', name: 'Owl', body: `
      <path d="M14 14 L22 22 L18 26 Z M50 14 L42 22 L46 26 Z" fill="#6d4c33"/>
      <ellipse cx="32" cy="36" rx="19" ry="19" fill="#8b6243"/><ellipse cx="32" cy="42" rx="12" ry="12" fill="#e2c49c"/>
      <circle cx="24" cy="30" r="7.5" fill="#fff"/><circle cx="40" cy="30" r="7.5" fill="#fff"/>
      ${eyes(24, 40, 30, 3.4)}<path d="M29 35 L35 35 L32 40 Z" fill="#f2a33a"/>
      <path d="M26 46 q2 2 4 0 M34 46 q2 2 4 0 M30 50 q2 2 4 0" fill="none" stroke="#b38a5f" stroke-width="1.2"/>` },
    { id: 'penguin', name: 'Penguin', body: `
      <ellipse cx="32" cy="35" rx="19" ry="20" fill="#27323f"/><path d="M19 36 Q19 22 32 22 Q45 22 45 36 Q45 50 32 52 Q19 50 19 36 Z" fill="#fafafa"/>
      ${eyes(26, 38, 31)}<path d="M28.5 36 L35.5 36 L32 41 Z" fill="#f5a623"/>${cheeks(22, 42, 38)}` },
    { id: 'frog', name: 'Frog', body: `
      <circle cx="21" cy="20" r="8" fill="#5fbf5a"/><circle cx="43" cy="20" r="8" fill="#5fbf5a"/>
      <ellipse cx="32" cy="38" rx="21" ry="16" fill="#6fcf68"/>
      <circle cx="21" cy="20" r="4.6" fill="#fff"/><circle cx="43" cy="20" r="4.6" fill="#fff"/>${eyes(21, 43, 20, 2.4)}
      <path d="M20 40 Q32 50 44 40" fill="none" stroke="${INK}" stroke-width="2" stroke-linecap="round"/>${cheeks(17, 47, 40)}` },
    { id: 'bunny', name: 'Bunny', body: `
      <ellipse cx="24" cy="14" rx="5" ry="13" fill="#f1f1f1"/><ellipse cx="40" cy="14" rx="5" ry="13" fill="#f1f1f1"/>
      <ellipse cx="24" cy="14" rx="2.4" ry="9" fill="#f7b8c4"/><ellipse cx="40" cy="14" rx="2.4" ry="9" fill="#f7b8c4"/>
      <circle cx="32" cy="38" r="17" fill="#f7f7f7"/>
      ${eyes(25.5, 38.5, 36)}<path d="M30 41 L34 41 L32 43.5 Z" fill="#f28ba0"/>${cheeks(21, 43, 42)}
      <path d="M32 43.5 v3" stroke="${INK}" stroke-width="1.3"/>` },
    { id: 'lion', name: 'Lion', body: `
      <circle cx="32" cy="33" r="23" fill="#c8761f"/>
      ${[0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330].map((a) => `<circle cx="${32 + 20 * Math.cos(a * Math.PI / 180)}" cy="${33 + 20 * Math.sin(a * Math.PI / 180)}" r="6" fill="#b5651a"/>`).join('')}
      <circle cx="32" cy="34" r="15" fill="#f1b24a"/><circle cx="21" cy="22" r="3.5" fill="#f1b24a"/><circle cx="43" cy="22" r="3.5" fill="#f1b24a"/>
      ${eyes(26.5, 37.5, 31, 2.3)}<path d="M29 37 L35 37 L32 40 Z" fill="#7a3f12"/>${smile(32, 42, 3)}` },
    { id: 'octopus', name: 'Octopus', body: `
      ${[14, 21, 28, 36, 43, 50].map((x, i) => `<path d="M${x} 40 q${i % 2 ? 3 : -3} 8 0 14" stroke="#d264a8" stroke-width="5" fill="none" stroke-linecap="round"/>`).join('')}
      <ellipse cx="32" cy="30" rx="19" ry="17" fill="#e07bbd"/>
      ${eyes(25, 39, 30, 3)}${smile(32, 37, 4)}<circle cx="23" cy="19" r="2" fill="#f4a8d8"/><circle cx="41" cy="17" r="1.5" fill="#f4a8d8"/>` },
    { id: 'robot', name: 'Robot', body: `
      <rect x="30.5" y="6" width="3" height="8" fill="#8892a0"/><circle cx="32" cy="6" r="3.2" fill="#ff5a5a"/>
      <rect x="9" y="27" width="5" height="12" rx="2" fill="#8892a0"/><rect x="50" y="27" width="5" height="12" rx="2" fill="#8892a0"/>
      <rect x="13" y="14" width="38" height="38" rx="9" fill="#c9d1db"/><rect x="18" y="21" width="28" height="16" rx="5" fill="#2b3644"/>
      <circle cx="26" cy="29" r="3.4" fill="#5ee0ff"/><circle cx="38" cy="29" r="3.4" fill="#5ee0ff"/>
      <rect x="23" y="42" width="18" height="4" rx="2" fill="#8892a0"/><path d="M26 42 v4 M30 42 v4 M34 42 v4 M38 42 v4" stroke="#c9d1db" stroke-width="1"/>` },
    { id: 'astronaut', name: 'Astronaut', body: `
      <circle cx="32" cy="33" r="21" fill="#f2f4f7"/><rect x="11" y="31" width="5" height="10" rx="2" fill="#c9cfd8"/><rect x="48" y="31" width="5" height="10" rx="2" fill="#c9cfd8"/>
      <rect x="17" y="22" width="30" height="22" rx="11" fill="#22344d"/>
      <path d="M21 28 Q25 24 31 25" stroke="#7fb4ff" stroke-width="2.4" fill="none" stroke-linecap="round" opacity=".8"/>
      ${eyes(26, 38, 34, 2.4)}${smile(32, 38, 3)}` },
    { id: 'alien', name: 'Alien', body: `
      <path d="M22 16 L18 6 M42 16 L46 6" stroke="#5fcf8a" stroke-width="2.4" stroke-linecap="round"/><circle cx="18" cy="6" r="3" fill="#5fcf8a"/><circle cx="46" cy="6" r="3" fill="#5fcf8a"/>
      <path d="M12 30 Q12 14 32 14 Q52 14 52 30 Q52 48 32 54 Q12 48 12 30 Z" fill="#6fdc98"/>
      <ellipse cx="23" cy="31" rx="6" ry="8" fill="${INK}" transform="rotate(-20 23 31)"/><ellipse cx="41" cy="31" rx="6" ry="8" fill="${INK}" transform="rotate(20 41 31)"/>
      <circle cx="24" cy="28" r="2" fill="#fff"/><circle cx="42" cy="28" r="2" fill="#fff"/>${smile(32, 43, 3.5)}` },
    { id: 'dino', name: 'Dinosaur', body: `
      ${[18, 26, 34, 42].map((x) => `<path d="M${x - 4} 18 L${x} 9 L${x + 4} 18 Z" fill="#f2b84b"/>`).join('')}
      <path d="M10 34 Q10 16 32 16 Q54 16 54 34 Q54 50 32 52 Q10 50 10 34 Z" fill="#5cb85c"/>
      <path d="M14 40 Q32 48 50 40 Q48 50 32 52 Q16 50 14 40 Z" fill="#8fd18f"/>
      ${eyes(24, 40, 30)}<circle cx="20" cy="37" r="1.3" fill="${INK}"/><circle cx="44" cy="37" r="1.3" fill="${INK}"/>
      <path d="M24 42 L27 45 L30 42 L33 45 L36 42 L39 45 L42 42" fill="none" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/>` },
    { id: 'ghost', name: 'Ghost', body: `
      <path d="M14 52 V30 Q14 12 32 12 Q50 12 50 30 V52 L44 47 L38 52 L32 47 L26 52 L20 47 Z" fill="#f7f8fb"/>
      ${eyes(25, 39, 30, 3)}<ellipse cx="32" cy="39" rx="3.5" ry="4" fill="${INK}"/>${cheeks(20, 44, 36)}` },
  ];

  function svg(id) {
    const c = CHARACTERS.find((x) => x.id === id);
    if (!c) return '';
    return `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${c.body}</svg>`;
  }
  window.Avatars = { list: CHARACTERS.map((c) => ({ id: c.id, name: c.name })), svg };
})();
