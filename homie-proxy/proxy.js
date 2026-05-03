'use strict';

/**
 * Homie Dashboard Proxy
 * ─────────────────────────────────────────────────────────────────────────
 * Runs inside the HA addon container. Responsibilities:
 *
 *  1. Serves homie.html + a generated config.js (zero credentials)
 *  2. For each configured HA connection, opens a /proxy/<id> WebSocket
 *     endpoint that browsers connect to — no token required from the browser
 *  3. For each browser connection, opens a matching server-side WebSocket
 *     to HA using the stored token, injects the auth message, then pipes
 *     all subsequent messages transparently in both directions
 *  4. Rate-limits connection attempts to blunt brute-force attacks
 *  5. Logs every service call (domain.service + entity) for audit trail
 *
 * Token flow:
 *   options.json (HA encrypted) → HOMIE_CONNECTIONS env var → this file
 *   Token is used only in the server→HA WebSocket. Browser never sees it.
 * ─────────────────────────────────────────────────────────────────────────
 */

const express = require('express');
const http    = require('http');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const { WebSocket, WebSocketServer } = require('ws');

const DASHBOARDS_FILE = '/data/dashboards.json';

// ── Config ────────────────────────────────────────────────────────────────
const PORT            = parseInt(process.env.HOMIE_PORT || '3001', 10);
const LOG             = process.env.HOMIE_LOG || 'info';
const ADMIN_PASSWORD  = process.env.HOMIE_ADMIN_PASSWORD  || '';
const VIEWER_PASSWORD = process.env.HOMIE_VIEWER_PASSWORD || '';
const AUTH_ENABLED    = !!(ADMIN_PASSWORD || VIEWER_PASSWORD);

// Parse connections from env (set by run.sh from options.json)
let CONNECTIONS = [];
try {
  CONNECTIONS = JSON.parse(process.env.HOMIE_CONNECTIONS || '[]');
} catch (e) {
  log('error', `Failed to parse HOMIE_CONNECTIONS: ${e.message}`);
  process.exit(1);
}

if (!CONNECTIONS.length) {
  log('warn', 'No connections configured. Add at least one in the addon Configuration tab.');
}

// Build a lookup map: id → connection object (with token)
const CONN_MAP = {};
CONNECTIONS.forEach(c => {
  if (!c.id || !c.token || !c.ha_url) {
    log('warn', `Skipping invalid connection entry: ${JSON.stringify({ id: c.id, ha_url: c.ha_url })}`);
    return;
  }
  CONN_MAP[c.id] = c;
  log('info', `Registered connection [${c.id}] → ${c.ha_url}${c.wan_url ? ` / ${c.wan_url}` : ''}`);
});

// ── Rate limiting (per IP, per connection id) ─────────────────────────────
// Simple in-memory sliding window — 10 connection attempts per IP per minute
const rateLimitMap = new Map(); // key: `${ip}:${connId}` → [timestamps]
const RATE_LIMIT   = 10;
const RATE_WINDOW  = 60 * 1000; // 1 minute

function isRateLimited(ip, connId) {
  const key  = `${ip}:${connId}`;
  const now  = Date.now();
  const hits = (rateLimitMap.get(key) || []).filter(t => now - t < RATE_WINDOW);
  hits.push(now);
  rateLimitMap.set(key, hits);
  return hits.length > RATE_LIMIT;
}

// Clean up old rate limit entries every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW;
  for (const [key, hits] of rateLimitMap) {
    const fresh = hits.filter(t => t > cutoff);
    if (fresh.length === 0) rateLimitMap.delete(key);
    else rateLimitMap.set(key, fresh);
  }
}, 5 * 60 * 1000);

// ── Session store ─────────────────────────────────────────────────────────
const sessions   = new Map(); // token → { role, expires }
const SESSION_TTL = 12 * 60 * 60 * 1000; // 12 hours

function createSession(role) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { role, expires: Date.now() + SESSION_TTL });
  for (const [t, s] of sessions) if (Date.now() > s.expires) sessions.delete(t);
  return token;
}

function validateSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expires) { sessions.delete(token); return null; }
  return s.role;
}

function bearerToken(req) {
  const h = req.headers['authorization'] || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

// Middleware: protect HA data routes when auth is enabled
function requireAuth(req, res, next) {
  if (!AUTH_ENABLED) return next();
  const role = validateSession(bearerToken(req));
  if (!role) return res.status(401).json({ error: 'unauthorized' });
  req.userRole = role;
  next();
}

// ── Express HTTP server ───────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

// Serve static dashboard files from /app/www
// Disable caching for HTML so browsers always load the latest addon version
app.use(express.static(path.join(__dirname, 'www'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
  },
}));

function buildSafeConns(req) {
  const host     = req.headers['x-forwarded-host'] || req.headers.host || `homeassistant.local:${PORT}`;
  const proto    = req.headers['x-forwarded-proto'] === 'https' ? 'wss' : 'ws';
  const basePath = (req.headers['x-ingress-path'] || '').replace(/\/$/, '');
  // Only expose connections that are fully configured (in CONN_MAP) — those with
  // a valid id, token, and ha_url. Incomplete entries would cause WS to be
  // accepted by the browser but immediately rejected by the proxy (silent fail).
  return Object.values(CONN_MAP).map(c => ({
    id:       c.id,
    label:    c.label || c.id,
    proxyUrl: `${proto}://${host}${basePath}/proxy/${encodeURIComponent(c.id)}`,
  }));
}

// GET /api/connections — same data as client-config.js but as JSON (more reliable)
app.get('/api/connections', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(buildSafeConns(req));
});

/**
 * GET /client-config.js
 * Generates a credential-free config.js for the browser.
 * Only exposes: id, label, proxyUrl (ws:// pointing back to this proxy).
 * Token is NEVER included.
 */
app.get('/client-config.js', (req, res) => {
  const safeConns = buildSafeConns(req);

  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'no-store');  // never cache — contains ws URLs
  res.send(`
/* Auto-generated by Homie Proxy addon — no credentials included */
window.HOMIE_CONNECTIONS = ${JSON.stringify(safeConns, null, 2)};
`.trim());
});

// Health check endpoint (used by HA watchdog)
app.get('/health', (_req, res) => res.json({ status: 'ok', connections: Object.keys(CONN_MAP).length }));

// ── Auth routes ───────────────────────────────────────────────────────────
app.post('/auth/login', express.json({ limit: '1kb' }), (req, res) => {
  const { password } = req.body || {};
  if (!password) { res.status(400).json({ error: 'password_required' }); return; }
  if (ADMIN_PASSWORD && password === ADMIN_PASSWORD) {
    log('info', `[auth] Admin login from ${req.ip}`);
    res.json({ token: createSession('admin'), role: 'admin' });
  } else if (VIEWER_PASSWORD && password === VIEWER_PASSWORD) {
    log('info', `[auth] Viewer login from ${req.ip}`);
    res.json({ token: createSession('viewer'), role: 'viewer' });
  } else {
    log('warn', `[auth] Failed login attempt from ${req.ip}`);
    res.status(401).json({ error: 'invalid_password' });
  }
});

app.post('/auth/logout', (req, res) => {
  const token = bearerToken(req);
  if (token) sessions.delete(token);
  res.json({ ok: true });
});

app.get('/auth/check', (req, res) => {
  if (!AUTH_ENABLED) { res.json({ auth: false, role: 'admin' }); return; }
  const role = validateSession(bearerToken(req));
  if (!role) { res.status(401).json({ error: 'unauthorized' }); return; }
  res.json({ auth: true, role });
});

// Protect all HA data and dashboard routes when auth is configured
app.use(['/ha-test', '/ha-states', '/ha-mediabrowse', '/ha-media', '/ha-api', '/ha-callservice', '/dashboards'], requireAuth);

// Diagnostic endpoint — tests whether the proxy can actually reach HA
app.get('/ha-test/:connId', (req, res) => {
  const connId = decodeURIComponent(req.params.connId);
  const conn   = CONN_MAP[connId];
  if (!conn) {
    return res.json({ ok: false, error: 'connection_not_found', connId, registered: Object.keys(CONN_MAP) });
  }
  resolveHaUrl(conn).then(haUrl => {
    if (!haUrl) return res.json({ ok: false, error: 'no_ha_url', connId, ha_url: conn.ha_url });
    const mod = haUrl.startsWith('https') ? require('https') : require('http');
    const probe = mod.request(
      `${haUrl}/api/`,
      { method: 'GET', headers: { Authorization: `Bearer ${conn.token}` }, timeout: 5000, rejectUnauthorized: false },
      haRes => {
        let body = '';
        haRes.on('data', d => { body += d; });
        haRes.on('end', () => {
          const ok = haRes.statusCode === 200;
          log('info', `[ha-test][${connId}] ${haUrl}/api/ → ${haRes.statusCode}`);
          res.json({ ok, connId, ha_url: haUrl, status: haRes.statusCode,
            error: ok ? null : haRes.statusCode === 401 ? 'invalid_token' : `http_${haRes.statusCode}` });
        });
        haRes.resume();
      }
    );
    probe.on('error', e => {
      log('warn', `[ha-test][${connId}] ${haUrl} → error: ${e.message}`);
      res.json({ ok: false, connId, ha_url: haUrl, error: e.message });
    });
    probe.on('timeout', () => { probe.destroy(); res.json({ ok: false, connId, ha_url: haUrl, error: 'timeout' }); });
    probe.end();
  }).catch(e => res.json({ ok: false, connId, error: e.message }));
});

// ── Server-side single-shot WS helper ────────────────────────────────────
// Opens a WS to HA, authenticates, sends one command, resolves with result.
// Used by /ha-states and /ha-mediabrowse so the browser never needs its own WS
// just to fetch data — it just calls a plain HTTP endpoint instead.
function haWsRequest(conn, msgType, msgPayload, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    resolveHaUrl(conn).then(haUrl => {
      const wsUrl = haUrl.replace(/^http/, 'ws') + '/api/websocket';
      let haWs;
      try { haWs = new WebSocket(wsUrl, { rejectUnauthorized: false }); }
      catch(e) { return reject(e); }

      let done = false;
      const finish = fn => { if (!done) { done = true; clearTimeout(timer); try { haWs.close(); } catch(_){} fn(); } };
      const timer = setTimeout(() => finish(() => reject(new Error('timeout'))), timeoutMs);

      haWs.on('message', raw => {
        let msg; try { msg = JSON.parse(raw); } catch { return; }
        if (msg.type === 'auth_required') {
          haWs.send(JSON.stringify({ type: 'auth', access_token: conn.token }));
        } else if (msg.type === 'auth_ok') {
          haWs.send(JSON.stringify({ id: 1, type: msgType, ...msgPayload }));
        } else if (msg.type === 'auth_invalid') {
          finish(() => reject(new Error('auth_invalid — check token in addon config')));
        } else if (msg.type === 'result' && msg.id === 1) {
          if (msg.success) finish(() => resolve(msg.result));
          else finish(() => reject(new Error(msg.error?.message || 'HA returned error')));
        }
      });
      haWs.on('error', e => finish(() => reject(e)));
      haWs.on('close',  () => finish(() => reject(new Error('connection closed before result'))));
    }).catch(reject);
  });
}

// GET /ha-states/:connId — returns HA entity states as JSON array
// Entity picker calls this directly; no browser-side WS needed.
app.get('/ha-states/:connId', (req, res) => {
  const conn = CONN_MAP[decodeURIComponent(req.params.connId)];
  if (!conn) { res.status(404).json({ error: 'connection_not_found', registered: Object.keys(CONN_MAP) }); return; }
  res.setHeader('Cache-Control', 'no-store');
  haWsRequest(conn, 'get_states', {})
    .then(result => res.json(Array.isArray(result) ? result : []))
    .catch(e => {
      log('warn', `[ha-states][${conn.id}] ${e.message}`);
      res.status(502).json({ error: e.message });
    });
});

// GET /ha-mediabrowse/:connId?id=<media_content_id>
// Media browser calls this directly; no browser-side WS needed.
app.get('/ha-mediabrowse/:connId', (req, res) => {
  const conn = CONN_MAP[decodeURIComponent(req.params.connId)];
  if (!conn) { res.status(404).json({ error: 'connection_not_found' }); return; }
  const mediaContentId = req.query.id || 'media-source://media_source/local';
  res.setHeader('Cache-Control', 'no-store');
  haWsRequest(conn, 'media_source/browse_media', { media_content_id: mediaContentId })
    .then(result => res.json(result))
    .catch(e => {
      log('warn', `[ha-mediabrowse][${conn.id}] ${e.message}`);
      res.status(502).json({ error: e.message });
    });
});

// Shared HA HTTP proxy helper — adds auth token, pipes response
function proxyHaHttp(req, res, conn, haPath, cacheControl) {
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  resolveHaUrl(conn).then(haUrl => {
    const fullUrl = haUrl + haPath + qs;
    const mod = haUrl.startsWith('https') ? require('https') : require('http');
    const haReq = mod.get(fullUrl, {
      headers: { Authorization: `Bearer ${conn.token}` },
      rejectUnauthorized: false,
    }, haRes => {
      res.status(haRes.statusCode);
      const ct = haRes.headers['content-type'];
      if (ct) res.setHeader('Content-Type', ct);
      if (cacheControl) res.setHeader('Cache-Control', cacheControl);
      haRes.pipe(res);
    });
    haReq.on('error', () => res.status(502).end());
  }).catch(() => res.status(502).end());
}

// GET /ha-media/:connId/* — proxy HA media files (browser never sees token)
// req.params[0] is the wildcard capture — already decoded, no path-replace needed
app.get('/ha-media/:connId/*', (req, res) => {
  const conn = CONN_MAP[decodeURIComponent(req.params.connId)];
  if (!conn) { res.status(404).end(); return; }
  const haPath = '/' + req.params[0];
  proxyHaHttp(req, res, conn, haPath, 'max-age=60');
});

// GET /ha-api/:connId/* — proxy HA REST API calls (used by entity picker, etc.)
app.get('/ha-api/:connId/*', (req, res) => {
  const connId = decodeURIComponent(req.params.connId);
  const conn   = CONN_MAP[connId];
  if (!conn) {
    log('warn', `[ha-api] Unknown connId: "${connId}" — registered: [${Object.keys(CONN_MAP).join(', ')}]`);
    res.status(404).json({ error: 'connection_not_found', connId, registered: Object.keys(CONN_MAP) });
    return;
  }
  const haPath = '/' + req.params[0];
  log('info', `[ha-api][${connId}] → ${haPath}`);
  proxyHaHttp(req, res, conn, haPath, 'no-store');
});

// POST /ha-callservice/:connId/:domain/:service
// Calls an HA service via a server-side WebSocket (same haWsRequest path used by
// the entity picker — this is the only approach proven to work in all environments).
app.post('/ha-callservice/:connId/:domain/:service', express.json({ limit: '100kb' }), (req, res) => {
  const conn = CONN_MAP[decodeURIComponent(req.params.connId)];
  if (!conn) { res.status(404).json({ error: 'connection_not_found' }); return; }
  const domain  = decodeURIComponent(req.params.domain);
  const service = decodeURIComponent(req.params.service);
  const serviceData = req.body || {};
  log('info', `[ha-callservice][${conn.id}][AUDIT] ${domain}.${service} entity=${serviceData.entity_id || '—'}`);
  haWsRequest(conn, 'call_service', { domain, service, service_data: serviceData }, 10000)
    .then(() => res.json({ ok: true }))
    .catch(e => {
      log('warn', `[ha-callservice][${conn.id}] ${domain}.${service} → ${e.message}`);
      res.status(502).json({ error: e.message });
    });
});

// GET /dashboards — returns all saved dashboards (shared across browsers)
app.get('/dashboards', (_req, res) => {
  try {
    const data = fs.existsSync(DASHBOARDS_FILE)
      ? JSON.parse(fs.readFileSync(DASHBOARDS_FILE, 'utf8'))
      : [];
    res.json(Array.isArray(data) ? data : []);
  } catch(e) {
    log('warn', `Failed to read dashboards: ${e.message}`);
    res.json([]);
  }
});

// POST /dashboards — saves all dashboards (body: JSON array)
app.post('/dashboards', express.json({ limit: '2mb' }), (req, res) => {
  try {
    const data = Array.isArray(req.body) ? req.body : [];
    fs.writeFileSync(DASHBOARDS_FILE, JSON.stringify(data));
    res.json({ ok: true, count: data.length });
  } catch(e) {
    log('warn', `Failed to save dashboards: ${e.message}`);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Catch-all: serve homie.html for any unknown path (SPA behaviour)
app.get('*', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'www', 'homie.html'));
});

// ── WebSocket proxy server ────────────────────────────────────────────────
// No path option — ws exact-matches the full URL so /proxy/<id> would never
// match /proxy. Route manually in the handler instead.
const wss = new WebSocketServer({ server });

// Log every WS upgrade attempt so we can tell if the browser is reaching us
server.on('upgrade', (req) => {
  log('info', `WS upgrade request: ${req.url}`);
});

// Route: ws://host/proxy/<connId>
wss.on('connection', (browserWs, req) => {
  // Parse the connection ID from the URL path: /proxy/<id>
  const parts  = req.url.split('/').filter(Boolean); // ['proxy', '<id>']
  if (parts[0] !== 'proxy') { browserWs.close(4404, 'Not found'); return; }
  const connId = decodeURIComponent(parts[1] || '');
  const conn   = CONN_MAP[connId];

  // Derive client IP (respects X-Forwarded-For from HA ingress proxy)
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  if (!conn) {
    log('warn', `[${ip}] Unknown connection id: "${connId}" — closing`);
    browserWs.close(4004, 'Unknown connection');
    return;
  }

  if (isRateLimited(ip, connId)) {
    log('warn', `[${ip}] Rate limit exceeded for connection [${connId}] — dropping`);
    browserWs.close(4029, 'Too many requests');
    return;
  }

  log('info', `[${ip}] Browser connected → proxy [${connId}]`);

  // ── Resolve HA URL (LAN preferred, WAN fallback) ──────────────────────
  resolveHaUrl(conn).then(haUrl => {
    const wsUrl = haUrl.replace(/^http/, 'ws') + '/api/websocket';
    log('info', `[${connId}] Opening server-side WS → ${wsUrl}`);

    let haWs;
    try {
      haWs = new WebSocket(wsUrl, { rejectUnauthorized: false });
    } catch (e) {
      log('error', `[${connId}] Failed to open WS to HA: ${e.message}`);
      browserWs.close(1011, 'Proxy upstream error');
      return;
    }

    let authDone = false;

    // ── HA → browser (server-side receives, forwards to browser) ─────────
    haWs.on('message', (raw, isBinary) => {
      // Always work with a string — HA only sends JSON text frames
      const text = isBinary ? null : raw.toString();
      let msg;
      try { msg = JSON.parse(text ?? raw); } catch { return; }

      // Intercept auth_required: inject the token ourselves
      // The browser never sends a token — we do it here
      if (msg.type === 'auth_required' && !authDone) {
        log('debug', `[${connId}] HA requested auth — injecting token server-side`);
        haWs.send(JSON.stringify({ type: 'auth', access_token: conn.token }));
        return; // do NOT forward auth_required to browser
      }

      if (msg.type === 'auth_ok') {
        authDone = true;
        log('info', `[${connId}] HA auth OK — proxy is live`);
      }

      if (msg.type === 'auth_invalid') {
        log('error', `[${connId}] HA rejected token — check addon configuration`);
      }

      // Forward as text frame — prevents browser from receiving a Blob
      if (browserWs.readyState === WebSocket.OPEN) {
        browserWs.send(isBinary ? raw : text);
      }
    });

    haWs.on('close', (code, reason) => {
      log('info', `[${connId}] HA WS closed: ${code} ${reason}`);
      if (browserWs.readyState === WebSocket.OPEN) browserWs.close(code, reason);
    });

    haWs.on('error', e => {
      log('error', `[${connId}] HA WS error: ${e.message}`);
      if (browserWs.readyState === WebSocket.OPEN) browserWs.close(1011, 'Upstream error');
    });

    // ── Browser → HA (browser sends, proxy forwards to HA) ───────────────
    browserWs.on('message', raw => {
      // Audit log: record every service call
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'call_service') {
          log('info', `[${connId}][AUDIT] service_call: ${msg.domain}.${msg.service} entity=${msg.service_data?.entity_id || '—'}`);
        }
        // Block any attempt by the browser to send an auth message
        // (the token should only come from the server side)
        if (msg.type === 'auth') {
          log('warn', `[${ip}] Browser attempted to send auth token — blocked`);
          return;
        }
      } catch { /* non-JSON, pass through */ }

      if (haWs.readyState === WebSocket.OPEN) {
        haWs.send(raw);
      }
    });

    browserWs.on('close', (code, reason) => {
      log('info', `[${ip}] Browser disconnected from [${connId}]: ${code}`);
      if (haWs.readyState === WebSocket.OPEN) haWs.close();
    });

    browserWs.on('error', e => {
      log('warn', `[${ip}] Browser WS error: ${e.message}`);
      if (haWs.readyState === WebSocket.OPEN) haWs.close();
    });

  }).catch(e => {
    log('error', `[${connId}] URL resolution failed: ${e.message}`);
    browserWs.close(1011, 'Proxy upstream unavailable');
  });
});

// ── HA URL resolver (LAN first, WAN fallback, 1.5 s timeout) ─────────────
function resolveHaUrl(conn) {
  const lan = conn.ha_url  || '';
  const wan = conn.wan_url || '';

  if (!lan) return Promise.resolve(wan);
  if (!wan || wan === lan) return Promise.resolve(lan);

  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(wan), 1500);

    const https = lan.startsWith('https') ? require('https') : require('http');
    const req = https.request(
      `${lan}/api/`,
      { method: 'HEAD', headers: { Authorization: `Bearer ${conn.token}` }, timeout: 1400, rejectUnauthorized: false },
      res => {
        clearTimeout(timer);
        resolve(res.statusCode < 400 ? lan : wan);
        res.resume();
      }
    );
    req.on('error',   () => { clearTimeout(timer); resolve(wan); });
    req.on('timeout', () => { clearTimeout(timer); resolve(wan); req.destroy(); });
    req.end();
  });
}

// ── Logging ───────────────────────────────────────────────────────────────
function log(level, msg) {
  const levels = { debug: 0, info: 1, warn: 2, error: 3 };
  if ((levels[level] ?? 1) < (levels[LOG] ?? 1)) return;
  const prefix = { debug: '🔍', info: '✔', warn: '⚠', error: '✖' }[level] || '·';
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] ${prefix} ${msg}`);
}

// ── Start ─────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  log('info', `Homie proxy running on port ${PORT}`);
  log('info', `Dashboard: http://homeassistant.local:${PORT}/`);
  log('info', `Proxy endpoints: ${Object.keys(CONN_MAP).map(id => `/proxy/${id}`).join(', ') || 'none'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => { log('info', 'SIGTERM received — shutting down'); server.close(() => process.exit(0)); });
process.on('SIGINT',  () => { log('info', 'SIGINT received  — shutting down'); server.close(() => process.exit(0)); });
