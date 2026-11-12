// Parlor's friends service (a Cloudflare Worker, with Workers KV for storage).
//
// Each person who sets up a friend profile in Parlor (a name; a picture: a character or a small photo of their own)
// gets an id, a secret token (kept by the app; only its hash is
// stored here) and a friend code like 7KQ2-M9XD. Giving someone your code lets them send you a friend request;
// once you accept, each of you sees the other's name, picture and the song or album they're showing.
// People can remove or block a friend, report one, get a new code, and delete their profile.
//
// Storage (KV namespace FRIENDS):
//   user:<id>   { id, th, code, name, avatar, photo, color, showcase, friends[], incoming[], outgoing[], blocked[], created, updated }
//   code:<CODE> <id>
//   report:<time>:<rand>  { by, about, reason, at, name, showcase }
//   rl:<ip>:<hour>  how many profiles were made from one address this hour (a little rate limit)

const CODE_CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // (no 0/O, 1/I)
const MAX_FRIENDS = 300, MAX_PENDING = 100, MAX_ART = 90_000, MAX_PHOTO = 90_000, MAX_NAME = 40;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors } });
const fail = (status, error) => json({ ok: false, error }, status);

const rand = (n) => { const b = new Uint8Array(n); crypto.getRandomValues(b); return b; };
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const sha = async (s) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
const newCode = () => { const b = rand(8); let s = ''; for (let i = 0; i < 8; i++) s += CODE_CHARS[b[i] % CODE_CHARS.length]; return s.slice(0, 4) + '-' + s.slice(4); };
const normCode = (c) => String(c || '').toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 8);
const fmtCode = (c) => (c.length === 8 ? c.slice(0, 4) + '-' + c.slice(4) : c);

const clean = (s, max) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
const cleanColor = (c) => (/^#[0-9a-fA-F]{6}$/.test(c || '') ? c : '#2f80ed');
const cleanAvatar = (a) => (/^char:[a-z0-9-]{1,30}$/.test(a || '') || a === 'photo' ? a : '');
// a picture of their own: a small square JPEG (the app shrinks it to 256 × 256 first)
const cleanPhoto = (p) => (typeof p === 'string' && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(p) && p.length <= MAX_PHOTO ? p : '');
function cleanShowcase(s) {
  if (!s || typeof s !== 'object') return null;
  const kind = s.kind === 'song' ? 'song' : 'album';
  const art = typeof s.art === 'string' && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(s.art) && s.art.length <= MAX_ART ? s.art : '';
  const out = { kind, title: clean(s.title, 120), artist: clean(s.artist, 120), album: clean(s.album, 120), year: Number.isInteger(s.year) ? s.year : null, art, at: Date.now() };
  return out.title ? out : null;
}

async function getUser(env, id) { if (!id) return null; const v = await env.FRIENDS.get('user:' + id); return v ? JSON.parse(v) : null; }
const putUser = (env, u) => { u.updated = Date.now(); return env.FRIENDS.put('user:' + u.id, JSON.stringify(u)); };
/** What a friend (or someone with a request) sees of a person */
const pub = (u) => ({ id: u.id, name: u.name, avatar: u.avatar, photo: u.avatar === 'photo' ? u.photo || '' : '', color: u.color, showcase: u.showcase || null, updated: u.updated });
const without = (list, id) => (list || []).filter((x) => x !== id);

async function auth(req, env) {
  const m = /^Bearer ([0-9a-f]{16})\.([0-9a-f]{64})$/.exec(req.headers.get('Authorization') || '');
  if (!m) return null;
  const u = await getUser(env, m[1]);
  return u && u.th === (await sha(m[2])) ? u : null;
}

async function me(env, u) {
  const load = async (ids) => (await Promise.all((ids || []).map((id) => getUser(env, id)))).filter(Boolean);
  const [friends, incoming, outgoing] = await Promise.all([load(u.friends), load(u.incoming), load(u.outgoing)]);
  return json({ ok: true, me: { ...pub(u), code: u.code }, friends: friends.map(pub), incoming: incoming.map(pub), outgoing: outgoing.map((x) => ({ id: x.id, name: x.name, avatar: x.avatar, photo: x.avatar === 'photo' ? x.photo || '' : '', color: x.color })) });
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '');
    let body = {};
    if (req.method === 'POST' || req.method === 'PUT') {
      const text = await req.text();
      if (text.length > 200_000) return fail(413, 'That’s too big.');
      try { body = text ? JSON.parse(text) : {}; } catch { return fail(400, 'Bad request.'); }
    }
    try {
      if (path === '' || path === '/v1') return json({ ok: true, service: 'parlor-friends', version: 1 });

      // a new friend profile
      if (path === '/v1/register' && req.method === 'POST') {
        const ip = req.headers.get('CF-Connecting-IP') || 'x';
        const rl = `rl:${ip}:${Math.floor(Date.now() / 3600000)}`;
        const n = Number(await env.FRIENDS.get(rl)) || 0;
        if (n >= 10) return fail(429, 'Too many new profiles from here. Try again in an hour.');
        await env.FRIENDS.put(rl, String(n + 1), { expirationTtl: 3700 });
        const name = clean(body.name, MAX_NAME);
        if (!name) return fail(400, 'Give your profile a name.');
        const id = hex(rand(8)), secret = hex(rand(32));
        let code = newCode();
        for (let i = 0; i < 5 && (await env.FRIENDS.get('code:' + normCode(code))); i++) code = newCode();
        const photo = cleanPhoto(body.photo), avatar = cleanAvatar(body.avatar);
        const u = { id, th: await sha(secret), code, name, avatar: avatar === 'photo' && !photo ? '' : avatar, photo, color: cleanColor(body.color), showcase: null,
          friends: [], incoming: [], outgoing: [], blocked: [], created: Date.now() };
        await env.FRIENDS.put('code:' + normCode(code), id);
        await putUser(env, u);
        return json({ ok: true, id, token: `${id}.${secret}`, code });
      }

      const u = await auth(req, env);
      if (!u) return fail(401, 'This friend profile isn’t recognised. Set it up again in Parlor.');

      if (path === '/v1/me' && req.method === 'GET') return me(env, u);
      if (path === '/v1/me' && req.method === 'PUT') {
        if ('name' in body) { const nm = clean(body.name, MAX_NAME); if (!nm) return fail(400, 'Your name can’t be empty.'); u.name = nm; }
        if ('photo' in body) u.photo = cleanPhoto(body.photo);
        if ('avatar' in body) u.avatar = cleanAvatar(body.avatar);
        if (u.avatar === 'photo' && !u.photo) u.avatar = '';
        if ('color' in body) u.color = cleanColor(body.color);
        if ('showcase' in body) u.showcase = cleanShowcase(body.showcase);
        await putUser(env, u);
        return me(env, u);
      }
      if (path === '/v1/me' && req.method === 'DELETE') {
        // gone from everyone's lists, and the code freed
        for (const id of new Set([...(u.friends || []), ...(u.incoming || []), ...(u.outgoing || [])])) {
          const o = await getUser(env, id);
          if (o) { o.friends = without(o.friends, u.id); o.incoming = without(o.incoming, u.id); o.outgoing = without(o.outgoing, u.id); await putUser(env, o); }
        }
        await env.FRIENDS.delete('code:' + normCode(u.code));
        await env.FRIENDS.delete('user:' + u.id);
        return json({ ok: true });
      }
      if (path === '/v1/me/code' && req.method === 'POST') {
        await env.FRIENDS.delete('code:' + normCode(u.code));
        u.code = newCode();
        await env.FRIENDS.put('code:' + normCode(u.code), u.id);
        await putUser(env, u);
        return me(env, u);
      }

      // add a friend by their code: a request (or, if they'd already asked, friends straight away)
      if (path === '/v1/friends' && req.method === 'POST') {
        const c = normCode(body.code);
        if (c.length !== 8) return fail(400, 'A friend code has 8 letters and numbers, like 7KQ2-M9XD.');
        const id = await env.FRIENDS.get('code:' + c);
        const o = id && (await getUser(env, id));
        if (!o) return fail(404, `No one has the code ${fmtCode(c)}. Check it with your friend.`);
        if (o.id === u.id) return fail(400, 'That’s your own code.');
        if ((u.friends || []).includes(o.id)) return fail(400, `You and ${o.name} are already friends.`);
        if ((u.friends || []).length >= MAX_FRIENDS) return fail(400, 'You have as many friends as Parlor can hold.');
        u.blocked = without(u.blocked, o.id);
        if ((o.blocked || []).includes(u.id)) { await putUser(env, u); return me(env, u); } // (looks sent; it goes nowhere)
        if ((u.incoming || []).includes(o.id)) {
          u.incoming = without(u.incoming, o.id); u.friends = [...without(u.friends, o.id), o.id];
          o.outgoing = without(o.outgoing, u.id); o.friends = [...without(o.friends, u.id), u.id];
        } else {
          if ((o.incoming || []).length >= MAX_PENDING) return fail(400, `${o.name} has too many requests waiting.`);
          u.outgoing = [...without(u.outgoing, o.id), o.id];
          o.incoming = [...without(o.incoming, u.id), u.id];
        }
        await putUser(env, o); await putUser(env, u);
        return me(env, u);
      }
      const fm = /^\/v1\/friends\/([0-9a-f]{16})(?:\/(accept|decline|block|report))?$/.exec(path);
      if (fm) {
        const [, id, action] = fm;
        const o = await getUser(env, id);
        if (action === 'accept' && req.method === 'POST') {
          if (!o || !(u.incoming || []).includes(id)) return fail(404, 'That request is no longer there.');
          u.incoming = without(u.incoming, id); u.friends = [...without(u.friends, id), id];
          o.outgoing = without(o.outgoing, u.id); o.friends = [...without(o.friends, u.id), u.id];
          await putUser(env, o); await putUser(env, u);
          return me(env, u);
        }
        if ((action === 'decline' && req.method === 'POST') || (!action && req.method === 'DELETE') || (action === 'block' && req.method === 'POST')) {
          // decline a request, take one back, remove a friend, or block: no link either way
          u.incoming = without(u.incoming, id); u.outgoing = without(u.outgoing, id); u.friends = without(u.friends, id);
          if (action === 'block') u.blocked = [...without(u.blocked, id), id].slice(-500);
          if (o) { o.incoming = without(o.incoming, u.id); o.outgoing = without(o.outgoing, u.id); o.friends = without(o.friends, u.id); await putUser(env, o); }
          await putUser(env, u);
          return me(env, u);
        }
        if (action === 'report' && req.method === 'POST') {
          await env.FRIENDS.put(`report:${Date.now()}:${hex(rand(4))}`, JSON.stringify({ by: u.id, about: id, reason: clean(body.reason, 500), at: Date.now(),
            name: o ? o.name : '', photo: o && o.avatar === 'photo' ? o.photo || '' : '', showcase: o && o.showcase ? { ...o.showcase, art: o.showcase.art ? '(picture)' : '' } : null }));
          return json({ ok: true });
        }
      }
      return fail(404, 'Not found.');
    } catch (e) {
      return fail(500, 'The friends service had a problem: ' + (e && e.message ? e.message : e));
    }
  },
};
