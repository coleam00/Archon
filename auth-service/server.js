'use strict';

const http = require('node:http');
const { createHmac, timingSafeEqual } = require('node:crypto');
const bcrypt = require('bcryptjs');

// ── Configuration ─────────────────────────────────────────────────────────────
// AUTH_PORT is set by docker-compose from AUTH_SERVICE_PORT in .env (default: 9000)
const PORT = parseInt(process.env.AUTH_PORT ?? '9000', 10);
const USERNAME = process.env.AUTH_USERNAME ?? '';
const PASSWORD_HASH = process.env.AUTH_PASSWORD_HASH ?? '';
const COOKIE_SECRET = process.env.COOKIE_SECRET ?? '';
const COOKIE_NAME = 'archon_auth';
const COOKIE_MAX_AGE = parseInt(process.env.COOKIE_MAX_AGE ?? '86400', 10);

if (!USERNAME || !PASSWORD_HASH || !COOKIE_SECRET) {
  console.error(
    '[auth-service] Missing required env vars: AUTH_USERNAME, AUTH_PASSWORD_HASH, COOKIE_SECRET'
  );
  process.exit(1);
}

try {
  bcrypt.getRounds(PASSWORD_HASH);
} catch {
  console.error(
    '[auth-service] AUTH_PASSWORD_HASH is not a valid bcrypt hash. ' +
      'Generate one with: docker compose --profile auth run --rm auth-service ' +
      "node -e \"require('bcryptjs').hash('YOUR_PASSWORD', 12).then(h => console.log(h))\""
  );
  process.exit(1);
}

// ── Cookie helpers ─────────────────────────────────────────────────────────────
function signCookie(value) {
  const sig = createHmac('sha256', COOKIE_SECRET).update(value).digest('base64url');
  return `${value}.${sig}`;
}

function verifyCookie(signed) {
  const dot = signed.lastIndexOf('.');
  if (dot === -1) return null;
  const value = signed.slice(0, dot);
  const expected = createHmac('sha256', COOKIE_SECRET).update(value).digest('base64url');
  const sigBuf = Buffer.from(signed.slice(dot + 1), 'base64url');
  const expBuf = Buffer.from(expected, 'base64url');
  if (sigBuf.length !== expBuf.length) return null;
  if (!timingSafeEqual(sigBuf, expBuf)) return null; // constant-time
  return value;
}

function parseCookies(header) {
  if (!header) return {};
  return Object.fromEntries(
    header.split(';').map(c => {
      const eq = c.indexOf('=');
      return eq === -1 ? [c.trim(), ''] : [c.slice(0, eq).trim(), c.slice(eq + 1).trim()];
    })
  );
}

function isSafeRedirect(rd) {
  // Only allow relative paths — block open redirects (https://, //host, backslash tricks)
  return rd === '/' || (/^\/[^/\\]/.test(rd) && !rd.includes('://'));
}

// ── HTML helpers ──────────────────────────────────────────────────────────────
function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Login HTML page ───────────────────────────────────────────────────────────
function loginPage(rdEncoded, error) {
  const errorHtml = error ? `<div class="error">${escapeHtml(error)}</div>` : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Sign In · Archon</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { min-height: 100vh; display: flex; align-items: center; justify-content: center;
           background: #0f172a; font-family: system-ui, sans-serif; color: #e2e8f0; }
    .card { width: 100%; max-width: 360px; padding: 2rem; border-radius: 12px;
            background: #1e293b; box-shadow: 0 4px 24px rgba(0,0,0,.3); }
    h1 { font-size: 1.25rem; font-weight: 600; text-align: center; margin-bottom: 1.5rem; }
    label { display: block; font-size: .875rem; margin-bottom: .25rem; color: #94a3b8; }
    input[type=text], input[type=password] { width: 100%; padding: .625rem .75rem;
      border-radius: 6px; background: #0f172a; border: 1px solid #334155;
      color: #e2e8f0; font-size: 1rem; margin-bottom: 1rem; }
    input:focus { outline: 2px solid #3b82f6; border-color: #3b82f6; }
    button { width: 100%; padding: .75rem; border-radius: 6px; background: #3b82f6;
             color: #fff; font-size: 1rem; font-weight: 500; border: none; cursor: pointer; }
    button:hover { background: #2563eb; }
    .error { background: #450a0a; border: 1px solid #7f1d1d; color: #fca5a5;
             padding: .75rem; border-radius: 6px; margin-bottom: 1rem; font-size: .875rem; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Sign In</h1>
    ${errorHtml}
    <form method="POST" action="/login">
      <input type="hidden" name="rd" value="${rdEncoded}">
      <label for="u">Username</label>
      <input id="u" name="username" type="text" autocomplete="username" required>
      <label for="p">Password</label>
      <input id="p" name="password" type="password" autocomplete="current-password" required>
      <button type="submit">Sign In</button>
    </form>
  </div>
</body>
</html>`;
}

// ── Body reader ───────────────────────────────────────────────────────────────
const MAX_BODY = 4096; // 4 KB — sufficient for login form; rejects oversized payloads

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', c => {
      total += c.length;
      if (total > MAX_BODY) {
        req.destroy();
        return reject(new Error('Request body too large'));
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

// ── Request handler ───────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');

    // GET /verify — Caddy forward_auth calls this for every protected request
    if (req.method === 'GET' && url.pathname === '/verify') {
      const cookies = parseCookies(req.headers['cookie']);
      const session = verifyCookie(cookies[COOKIE_NAME] ?? '');
      if (session === 'authenticated') {
        res.writeHead(200, { 'X-Auth-User': USERNAME });
        return res.end();
      }
      const originalUri = req.headers['x-forwarded-uri'] ?? '/';
      const safeRd = isSafeRedirect(originalUri) ? originalUri : '/';
      res.writeHead(302, { Location: `/login?rd=${encodeURIComponent(safeRd)}` });
      return res.end();
    }

    // GET /login — serve the styled login form
    if (req.method === 'GET' && url.pathname === '/login') {
      const rd = url.searchParams.get('rd') ?? '/';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(loginPage(encodeURIComponent(rd), null));
    }

    // POST /login — validate credentials, issue session cookie
    if (req.method === 'POST' && url.pathname === '/login') {
      const body = await readBody(req);
      const params = new URLSearchParams(body);
      const username = params.get('username') ?? '';
      const password = params.get('password') ?? '';
      const rd = decodeURIComponent(params.get('rd') ?? '/');
      const safeRd = isSafeRedirect(rd) ? rd : '/';

      const usernameOk = username === USERNAME;
      const passwordOk = await bcrypt.compare(password, PASSWORD_HASH);

      if (!usernameOk || !passwordOk) {
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(loginPage(encodeURIComponent(safeRd), 'Invalid username or password.'));
      }

      const cookieValue = signCookie('authenticated');
      res.writeHead(302, {
        Location: safeRd,
        'Set-Cookie': `${COOKIE_NAME}=${cookieValue}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}`,
      });
      return res.end();
    }

    // GET /logout — clear the session cookie
    if (url.pathname === '/logout') {
      res.writeHead(302, {
        Location: '/login',
        'Set-Cookie': `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
      });
      return res.end();
    }

    res.writeHead(404);
    res.end();
  } catch (err) {
    console.error('[auth-service] Unhandled error on %s %s:', req.method, req.url, err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Internal server error. Check auth-service logs.');
    }
  }
});

server.on('error', err => {
  console.error('[auth-service] Server failed to start:', err);
  process.exit(1);
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`[auth-service] Listening on :${PORT}`);
  });
}

module.exports = { signCookie, verifyCookie, isSafeRedirect, parseCookies };
