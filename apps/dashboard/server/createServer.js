import http from "node:http";
import https from "node:https";
import { createReadStream, existsSync, statSync } from "node:fs";
import { join, normalize, extname, sep } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";

// Standalone Node server that replaces `serve -s dist` in production. Two problems it solves,
// both stemming from the dashboard previously being a pure static SPA with no server of its own:
//
// 1. The bot's API_TOKEN used to be baked into the built JS bundle via VITE_API_TOKEN (Vite
//    inlines any VITE_-prefixed env var at build time) — anyone who loaded the dashboard URL
//    could extract it from the bundle and call any bot route directly, including unbounded
//    backtest sweeps. This server holds the real token server-side and injects it when proxying
//    `/api/*` to the bot; the browser never sees it.
// 2. The bot's WebSocket server had no auth at all. This server gates `/ws` behind the same
//    session cookie as everything else, and authenticates itself to the bot's WS server with
//    the token when it connects upstream (see apps/bot/src/ws.ts's verifyClient).
//
// Auth model: a single shared password (this is a personal, single-user dashboard, not
// multi-tenant SaaS) exchanged at POST /login for an httpOnly session cookie. Sessions are
// in-memory — losing them on a redeploy just means logging in again, which is an acceptable
// trade for not needing a session store for one user.

const SESSION_COOKIE = "dash_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function loginPageHtml(error) {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>crypto-bot dashboard</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: system-ui, sans-serif; background: #0b0f14; color: #e6edf3; display: flex;
         align-items: center; justify-content: center; height: 100vh; margin: 0; }
  form { background: #161b22; padding: 2rem; border-radius: 8px; width: 280px; }
  h1 { font-size: 1.1rem; margin: 0 0 1rem; }
  input { width: 100%; box-sizing: border-box; padding: 0.5rem; margin-bottom: 0.75rem;
          background: #0d1117; border: 1px solid #30363d; border-radius: 4px; color: inherit; }
  button { width: 100%; padding: 0.5rem; background: #238636; border: none; border-radius: 4px;
           color: white; cursor: pointer; }
  .error { color: #f85149; font-size: 0.85rem; margin-bottom: 0.75rem; }
</style>
</head>
<body>
  <form method="POST" action="/login">
    <h1>crypto-bot dashboard</h1>
    ${error ? '<div class="error">Wrong password.</div>' : ""}
    <input type="password" name="password" placeholder="Password" autofocus>
    <button type="submit">Sign in</button>
  </form>
</body>
</html>`;
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function serializeCookie(name, value, { maxAge, secure } = {}) {
  const parts = [`${name}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (secure) parts.push("Secure");
  if (maxAge != null) parts.push(`Max-Age=${maxAge}`);
  return parts.join("; ");
}

/** Constant-time password check that still works when the candidate's length differs from the
 * real password's (timingSafeEqual throws on a length mismatch, which would itself leak length
 * via a thrown-vs-not-thrown timing difference if not handled). */
function passwordMatches(candidate, expected) {
  const candidateBuf = Buffer.from(candidate ?? "");
  const expectedBuf = Buffer.from(expected);
  if (candidateBuf.length !== expectedBuf.length) {
    timingSafeEqual(expectedBuf, expectedBuf); // burn roughly the same time as a real compare
    return false;
  }
  return timingSafeEqual(candidateBuf, expectedBuf);
}

function isHttpsRequest(req) {
  return req.headers["x-forwarded-proto"] === "https"; // Railway's edge sets this; absent in local dev
}

/**
 * @param {object} config
 * @param {string} config.distDir - built dashboard static assets (Vite's `dist/`)
 * @param {string} config.botUrl - the bot's base URL, e.g. https://bot.up.railway.app
 * @param {string} config.apiToken - the bot's API_TOKEN, injected server-side into proxied requests
 * @param {string} config.password - the dashboard's single login password
 */
export function createDashboardServer({ distDir, botUrl, apiToken, password }) {
  if (!distDir || !botUrl || !apiToken || !password) {
    throw new Error("createDashboardServer requires distDir, botUrl, apiToken, and password");
  }
  const botOrigin = new URL(botUrl);
  const requestFn = botOrigin.protocol === "https:" ? https.request : http.request;

  /** token -> expiresAtMs. In-memory by design — see module doc comment. */
  const sessions = new Map();

  function isAuthed(req) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token) return false;
    const expiresAt = sessions.get(token);
    if (!expiresAt || Date.now() > expiresAt) {
      sessions.delete(token);
      return false;
    }
    return true;
  }

  function issueSession() {
    const token = randomBytes(32).toString("hex");
    sessions.set(token, Date.now() + SESSION_TTL_MS);
    return token;
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  async function handleLogin(req, res) {
    const contentType = req.headers["content-type"] ?? "";
    const raw = await readBody(req);
    let submitted = "";
    if (contentType.includes("application/json")) {
      try {
        submitted = JSON.parse(raw).password ?? "";
      } catch {
        submitted = "";
      }
    } else {
      submitted = new URLSearchParams(raw).get("password") ?? "";
    }

    if (!passwordMatches(submitted, password)) {
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
      res.end(loginPageHtml(true));
      return;
    }

    const token = issueSession();
    res.writeHead(302, {
      Location: "/",
      "Set-Cookie": serializeCookie(SESSION_COOKIE, token, {
        maxAge: Math.floor(SESSION_TTL_MS / 1000),
        secure: isHttpsRequest(req),
      }),
    });
    res.end();
  }

  function handleLogout(req, res) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) sessions.delete(token);
    res.writeHead(302, {
      Location: "/login",
      "Set-Cookie": serializeCookie(SESSION_COOKIE, "", { maxAge: 0, secure: isHttpsRequest(req) }),
    });
    res.end();
  }

  function proxyApi(req, res) {
    const target = new URL(req.url, botOrigin);
    const proxyReq = requestFn(
      target,
      {
        method: req.method,
        headers: { ...req.headers, host: target.host, authorization: `Bearer ${apiToken}` },
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );
    proxyReq.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Bad gateway" }));
    });
    req.pipe(proxyReq);
  }

  function serveStatic(req, res, pathname) {
    // Prevent path traversal: resolve under distDir and verify the result is still inside it.
    const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
    let filePath = join(distDir, safePath);
    if (!filePath.startsWith(distDir + sep) && filePath !== distDir) filePath = distDir;

    let stat = existsSync(filePath) ? statSync(filePath) : null;
    if (!stat || stat.isDirectory()) {
      // SPA fallback — any unmatched GET (a client-side route) serves index.html.
      filePath = join(distDir, "index.html");
      stat = existsSync(filePath) ? statSync(filePath) : null;
    }
    if (!stat) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const isIndex = filePath === join(distDir, "index.html");
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[extname(filePath)] ?? "application/octet-stream",
      "Content-Length": stat.size,
      // Vite fingerprints built assets by content hash, so they're safe to cache forever;
      // index.html references the current hashes and must always be revalidated.
      "Cache-Control": isIndex ? "no-cache" : "public, max-age=31536000, immutable",
    });
    createReadStream(filePath).pipe(res);
  }

  async function handleRequest(req, res) {
    const url = new URL(req.url, "http://internal");
    const pathname = url.pathname;

    // Unauthenticated by design, like the bot's own /health — Railway's healthcheck hits GET /
    // by default, and that now 302s to /login when logged out, which some healthcheck clients
    // treat as a failure. A dedicated always-200 path avoids depending on that behavior at all.
    if (pathname === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }

    if (pathname === "/login" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(loginPageHtml(false));
      return;
    }
    if (pathname === "/login" && req.method === "POST") return handleLogin(req, res);
    if (pathname === "/logout" && req.method === "POST") return handleLogout(req, res);

    if (!isAuthed(req)) {
      if (pathname.startsWith("/api/")) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
      res.writeHead(302, { Location: "/login" });
      res.end();
      return;
    }

    if (pathname.startsWith("/api/")) return proxyApi(req, res);
    return serveStatic(req, res, pathname);
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end("Internal error");
    });
  });

  server.on("upgrade", (clientReq, clientSocket, head) => {
    if (!isAuthed(clientReq)) {
      clientSocket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      clientSocket.destroy();
      return;
    }

    const proxyReq = requestFn({
      hostname: botOrigin.hostname,
      port: botOrigin.port || (botOrigin.protocol === "https:" ? 443 : 80),
      protocol: botOrigin.protocol,
      path: "/",
      method: "GET",
      headers: {
        ...clientReq.headers,
        host: botOrigin.host,
        authorization: `Bearer ${apiToken}`,
        connection: "Upgrade",
        upgrade: "websocket",
      },
    });

    clientSocket.on("error", () => proxyReq.destroy());

    proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
      const statusLine = `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}`;
      const headerLines = Object.entries(proxyRes.headers).map(([k, v]) => `${k}: ${v}`);
      clientSocket.write([statusLine, ...headerLines, "", ""].join("\r\n"));
      if (proxyHead && proxyHead.length) proxySocket.unshift(proxyHead);
      if (head && head.length) clientSocket.unshift(head);
      proxySocket.pipe(clientSocket);
      clientSocket.pipe(proxySocket);
    });

    proxyReq.on("error", () => {
      if (!clientSocket.destroyed) clientSocket.destroy();
    });
    proxyReq.end();
  });

  return server;
}
