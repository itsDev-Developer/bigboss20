#!/usr/bin/env node
/**
 * Static file server + same-origin reverse proxy + a small local backend
 * for site-only features the real API has no concept of (ads, notices,
 * maintenance mode) and a short-lived response cache.
 *
 * Why this exists: the Ottfree backend (aiohttp) doesn't send CORS headers,
 * so calling it directly from a browser on a different origin fails outright.
 * This process serves the frontend AND transparently proxies every
 * "/api-proxy/*" request to the real backend server-side (no browser
 * involved in that hop, so CORS doesn't apply). The browser only ever talks
 * to this one origin.
 *
 * Used for:
 *  - Render "Web Service" deploys (reads PORT from the environment)
 *  - Local hosting, including inside Termux on Android
 *  - Any other plain Node host (a VPS, Fly.io, Railway, etc.)
 */
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { URL } = require("url");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const SETTINGS_PATH = path.join(DATA_DIR, "site-settings.json");

// Minimal .env support (no dependency) so `npm start` alone picks up
// OTTFREE_API_URL / OTTFREE_PORT without requiring `npm run build` first.
// Real environment variables (e.g. set in Render's dashboard) always win.
(function loadDotEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
})();

const PORT = process.env.PORT || process.env.OTTFREE_PORT || 8080;
const HOST = process.env.HOST || "0.0.0.0";

// The real backend. Defaults to the API this project ships pointed at;
// override with OTTFREE_API_URL (Render dashboard, or a local .env — see
// .env.example) without touching any code.
const API_TARGET = normalizeTarget(process.env.OTTFREE_API_URL || "https://varying-orsa-komi106-7ef913ad.koyeb.app");
const API_PREFIX = "/api-proxy"; // internal mount point the browser calls, distinct from the backend's own "/api/thumb" route

// How long to keep a cached JSON GET response before re-asking the backend.
// Cuts down on repeat calls to a free-tier backend that may cold-start.
const CACHE_TTL_MS = Number(process.env.OTTFREE_CACHE_TTL_MS) || 20000;
const MAX_CACHE_ENTRY_BYTES = 2 * 1024 * 1024; // never cache huge bodies

function normalizeTarget(u) {
  const withProto = /^https?:\/\//i.test(u) ? u : `https://${u}`;
  return withProto.replace(/\/+$/, "");
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const resolved = path.normalize(path.join(root, decoded));
  if (!resolved.startsWith(root)) return null; // block path traversal
  return resolved;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { "Content-Type": "application/json; charset=utf-8" });
}

function serveFileOrFallback(res, status, filePath, fallbackText) {
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, status, fallbackText, { "Content-Type": "text/plain; charset=utf-8" });
    send(res, status, data, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
  });
}

function serve404(res) {
  serveFileOrFallback(res, 404, path.join(ROOT, "404.html"), "404 — not found");
}

function serve500(res, detail) {
  console.error("[ottfree] server error:", detail);
  serveFileOrFallback(res, 500, path.join(ROOT, "500.html"), "500 — internal server error");
}

// ---------------------------------------------------------------------
// Site settings (ads / notice / maintenance) — a tiny JSON-file "database"
// for the handful of admin-configurable things the real backend has no
// concept of. Reads are public (the frontend needs them pre-login to show
// a notice or enforce maintenance mode); writes require a verified admin
// session, checked against the real backend on every request.
// ---------------------------------------------------------------------

const DEFAULT_SETTINGS = {
  ads: { enabled: false, network: "custom", snippet: "" },
  notice: { enabled: false, level: "info", message: "" },
  maintenance: { enabled: false, message: "We're doing a bit of maintenance — back shortly." },
};

function readSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      ads: { ...DEFAULT_SETTINGS.ads, ...(parsed.ads || {}) },
      notice: { ...DEFAULT_SETTINGS.notice, ...(parsed.notice || {}) },
      maintenance: { ...DEFAULT_SETTINGS.maintenance, ...(parsed.maintenance || {}) },
    };
  } catch (e) {
    return { ...DEFAULT_SETTINGS };
  }
}

function writeSettings(settings) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

// ---------------------------------------------------------------------
// A tiny promise-based client for calling the real backend from *this*
// process (not proxying a browser request) — used to verify admin sessions.
// ---------------------------------------------------------------------

function upstreamJsonRequest(pathWithQuery, cookieHeader) {
  return new Promise((resolve) => {
    const targetUrl = new URL(pathWithQuery, API_TARGET + "/");
    const mod = targetUrl.protocol === "https:" ? https : http;
    const reqOpts = {
      method: "GET",
      headers: cookieHeader ? { cookie: cookieHeader } : {},
      timeout: 8000,
    };
    const upReq = mod.request(targetUrl, reqOpts, (upRes) => {
      let body = "";
      upRes.on("data", (c) => (body += c));
      upRes.on("end", () => {
        try {
          resolve({ status: upRes.statusCode, data: JSON.parse(body) });
        } catch (e) {
          resolve({ status: upRes.statusCode, data: null });
        }
      });
    });
    upReq.on("timeout", () => upReq.destroy());
    upReq.on("error", () => resolve({ status: 0, data: null }));
    upReq.end();
  });
}

/** Fails closed: any doubt (no cookie, upstream down, not admin) -> false. */
async function verifyAdmin(req) {
  const cookie = req.headers.cookie;
  if (!cookie) return false;
  try {
    const loginState = await upstreamJsonRequest("/login", cookie);
    if (!loginState.data || !loginState.data.authenticated) return false;
    // Same technique admin.js uses client-side: an admin-only route replies
    // normally, a non-admin session gets the backend's "Who the hell you
    // are" 200-with-msg lockout.
    const probe = await upstreamJsonRequest("/searchDbFol?query=", cookie);
    if (probe.data && probe.data.msg === "Who the hell you are") return false;
    return true;
  } catch (e) {
    return false;
  }
}

function readBodyLimited(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function handleLocalApi(req, res, pathname) {
  if (pathname !== "/local-api/settings") return serve404(res);

  if (req.method === "GET") {
    return sendJson(res, 200, readSettings());
  }

  if (req.method === "POST") {
    // Lightweight CSRF guard: a plain cross-site <form> POST can't set
    // custom headers without triggering a CORS preflight, which would fail
    // here since we don't allow foreign origins. Our own admin UI sets this.
    if ((req.headers["x-requested-with"] || "").toLowerCase() !== "ottfreeadmin") {
      return sendJson(res, 403, { error: "Missing X-Requested-With header" });
    }
    let body;
    try {
      body = await readBodyLimited(req, 200 * 1024);
    } catch (e) {
      return sendJson(res, 413, { error: "Payload too large" });
    }
    let payload;
    try {
      payload = JSON.parse(body.toString("utf8") || "{}");
    } catch (e) {
      return sendJson(res, 400, { error: "Invalid JSON" });
    }
    const { section, data } = payload;
    if (!["ads", "notice", "maintenance"].includes(section) || typeof data !== "object" || !data) {
      return sendJson(res, 400, { error: "Expected { section: 'ads'|'notice'|'maintenance', data: {...} }" });
    }

    const isAdmin = await verifyAdmin(req);
    if (!isAdmin) return sendJson(res, 403, { error: "Admin session required" });

    const settings = readSettings();
    settings[section] = { ...settings[section], ...data };
    writeSettings(settings);
    cache.clear(); // settings changed — belt and suspenders, cheap to just flush
    return sendJson(res, 200, settings);
  }

  return sendJson(res, 405, { error: "Method not allowed" });
}

// ---------------------------------------------------------------------
// Reverse proxy: browser -> this server -> real backend, no CORS involved
// on either hop. Also transparently caches safe, idempotent JSON GETs.
// ---------------------------------------------------------------------

const cache = new Map(); // key -> { status, headers, body, expires }
const MUTATING_UPSTREAM_PATH = /^\/(create|delete|edit|edit_post|send|config|reload)\b/;

function rewriteSetCookie(values) {
  return values.map((v) =>
    v
      .replace(/;\s*Domain=[^;]+/i, "") // scope the cookie to whatever host is actually serving the browser
      .replace(/;\s*Secure/i, "") // allow it to stick even over plain http (e.g. local/Termux testing)
  );
}

function cacheKeyFor(req) {
  const hash = crypto.createHash("sha1");
  hash.update((req.headers.cookie || "") + "|" + req.method + "|" + req.url);
  return hash.digest("hex");
}

function proxyRequest(req, res) {
  const upstreamPath = req.url.slice(API_PREFIX.length) || "/";
  const targetUrl = new URL(upstreamPath, API_TARGET + "/");
  const cacheKey = req.method === "GET" ? cacheKeyFor(req) : null;

  if (cacheKey) {
    const hit = cache.get(cacheKey);
    if (hit && hit.expires > Date.now()) {
      res.writeHead(hit.status, hit.headers);
      return res.end(hit.body);
    }
  }

  const headers = { ...req.headers, host: targetUrl.host };
  delete headers["origin"]; // this is now a server-to-server hop, not a browser request

  const mod = targetUrl.protocol === "https:" ? https : http;
  const proxyReq = mod.request(
    targetUrl,
    { method: req.method, headers },
    (proxyRes) => {
      const outHeaders = { ...proxyRes.headers };
      if (outHeaders["set-cookie"]) {
        outHeaders["set-cookie"] = rewriteSetCookie(proxyRes.headers["set-cookie"]);
      }
      // The backend sends Content-Disposition: attachment on media routes,
      // which makes some browsers force-download instead of playing inline
      // in <video>. Since this is our own reverse proxy, fix that in flight.
      if (outHeaders["content-disposition"]) {
        outHeaders["content-disposition"] = outHeaders["content-disposition"].replace(/^attachment/i, "inline");
      }

      const isJson = /application\/json/i.test(proxyRes.headers["content-type"] || "");
      const cacheable = cacheKey && isJson && proxyRes.statusCode >= 200 && proxyRes.statusCode < 300 && !outHeaders["set-cookie"];

      if (cacheable) {
        const chunks = [];
        let total = 0;
        let overflow = false;
        proxyRes.on("data", (c) => {
          total += c.length;
          if (total > MAX_CACHE_ENTRY_BYTES) { overflow = true; return; }
          chunks.push(c);
        });
        proxyRes.on("end", () => {
          const bodyBuf = Buffer.concat(chunks);
          if (!overflow) cache.set(cacheKey, { status: proxyRes.statusCode, headers: outHeaders, body: bodyBuf, expires: Date.now() + CACHE_TTL_MS });
          res.writeHead(proxyRes.statusCode, outHeaders);
          res.end(overflow ? bodyBuf : bodyBuf);
        });
      } else {
        res.writeHead(proxyRes.statusCode, outHeaders);
        proxyRes.pipe(res);
      }

      if (MUTATING_UPSTREAM_PATH.test(targetUrl.pathname) && proxyRes.statusCode < 400) {
        proxyRes.on("end", () => cache.clear());
      }
    }
  );

  proxyReq.on("error", (err) => {
    sendJson(res, 502, { error: "Upstream request failed", detail: String((err && err.message) || err) });
  });

  req.pipe(proxyReq);
}

// ---------------------------------------------------------------------
// Static files (+ a maintenance-mode gate on page navigations)
// ---------------------------------------------------------------------

const ALWAYS_ALLOWED = new Set(["/", "/index.html"]);

function isPageRequest(pathname) {
  return pathname === "/" || pathname.endsWith(".html");
}

function serveStatic(req, res) {
  let filePath = safeJoin(ROOT, req.url === "/" ? "/index.html" : req.url);
  if (!filePath) return send(res, 400, "Bad request");

  fs.stat(filePath, (err, stats) => {
    if (err) return serve404(res);
    if (stats.isDirectory()) filePath = path.join(filePath, "index.html");

    fs.readFile(filePath, (err, data) => {
      if (err) return serve404(res);
      const ext = path.extname(filePath).toLowerCase();
      send(res, 200, data, {
        "Content-Type": MIME[ext] || "application/octet-stream",
        "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
      });
    });
  });
}

async function serveWithMaintenanceGate(req, res, pathname) {
  if (req.method !== "GET" || !isPageRequest(pathname) || ALWAYS_ALLOWED.has(pathname)) {
    return serveStatic(req, res);
  }

  const settings = readSettings();
  if (!settings.maintenance.enabled) return serveStatic(req, res);

  const isAdmin = await verifyAdmin(req);
  if (isAdmin) return serveStatic(req, res);

  fs.readFile(path.join(ROOT, "maintenance.html"), "utf8", (err, html) => {
    if (err) return send(res, 503, "Down for maintenance.", { "Content-Type": "text/plain" });
    const withMessage = html.replace("{{MESSAGE}}", escapeHtml(settings.maintenance.message || ""));
    send(res, 503, withMessage, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", "Retry-After": "120" });
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const server = http.createServer((req, res) => {
  const pathname = req.url.split("?")[0];
  Promise.resolve()
    .then(() => {
      if (pathname === "/local-api/settings") return handleLocalApi(req, res, pathname);
      if (req.url === API_PREFIX || req.url.startsWith(API_PREFIX + "/") || req.url.startsWith(API_PREFIX + "?")) {
        return proxyRequest(req, res);
      }
      return serveWithMaintenanceGate(req, res, pathname);
    })
    .catch((err) => serve500(res, err));
});

function localIPs() {
  const nets = os.networkInterfaces();
  const out = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) out.push(net.address);
    }
  }
  return out;
}

server.listen(PORT, HOST, () => {
  console.log(`\nOttfree frontend is running.`);
  console.log(`  Local:   http://localhost:${PORT}`);
  localIPs().forEach((ip) => console.log(`  Network: http://${ip}:${PORT}`));
  console.log(`  Proxying ${API_PREFIX}/* -> ${API_TARGET}`);
  console.log(`  Local settings store: ${SETTINGS_PATH}`);
  console.log(`\nPress Ctrl+C to stop.\n`);
});
