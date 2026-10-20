// Tiny LAN web server so a phone or tablet can act as the remote:
// D-pad / transport controls, search, and "play this on the TV". Protected by a PIN.
const http = require('http');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  }
  return out;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * start({ port, pin: () => string, pageFile, handlers: { library, key, open, search, player }, log })
 * Returns { port, close() }.
 */
function start({ port, pin, pageFile, handlers, log = () => {} }) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      try { return send(200, fs.readFileSync(pageFile, 'utf8'), 'text/html; charset=utf-8'); }
      catch { return send(500, { error: 'remote page missing' }); }
    }
    if (!url.pathname.startsWith('/api/')) return send(404, { error: 'not found' });

    if (!safeEqual(req.headers['x-pin'] || '', pin())) {
      await new Promise((r) => setTimeout(r, 600)); // slow down guessing
      return send(401, { error: 'wrong pin' });
    }

    try {
      if (req.method === 'GET' && url.pathname === '/api/library') return send(200, handlers.library());
      if (req.method === 'GET' && url.pathname === '/api/ping') return send(200, { ok: true });
      if (req.method === 'GET' && url.pathname === '/api/info') return send(200, await handlers.info());
      if (req.method === 'POST' && url.pathname === '/api/rescan') { handlers.rescan(); return send(200, { ok: true }); }
      if (req.method === 'PUT' && url.pathname === '/api/upload') {
        const len = req.headers['content-length'] != null ? Number(req.headers['content-length']) : null;
        try {
          const r = await handlers.upload(url.searchParams.get('path') || '', req, len);
          return send(200, { ok: true, skipped: !!r.skipped });
        } catch (e) {
          req.resume();
          return send(e.status || 500, { error: String(e.message || e) });
        }
      }
      if (req.method !== 'POST') return send(405, { error: 'method not allowed' });

      let raw = '';
      for await (const chunk of req) { raw += chunk; if (raw.length > 10000) return send(413, { error: 'too large' }); }
      const body = raw ? JSON.parse(raw) : {};

      switch (url.pathname) {
        case '/api/key': handlers.key(String(body.key || '')); break;
        case '/api/player': handlers.player(String(body.cmd || '')); break;
        case '/api/open': handlers.open(String(body.key || '')); break;
        case '/api/search': handlers.search(String(body.q || '')); break;
        default: return send(404, { error: 'not found' });
      }
      return send(200, { ok: true });
    } catch (e) {
      return send(400, { error: String(e.message || e) });
    }
  });

  server.requestTimeout = 0;      // movies are big; don't cut an upload off
  server.headersTimeout = 60000;
  server.on('error', (e) => log(`phone remote could not start on port ${port}: ${e.message}`));
  server.listen(port, '0.0.0.0');
  return { port, close: () => { try { server.close(); } catch {} } };
}

module.exports = { start, lanAddresses };
