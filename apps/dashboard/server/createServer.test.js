import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { createDashboardServer } from "./createServer.js";

const API_TOKEN = "the-real-bot-token";
const PASSWORD = "correct-horse-battery-staple";

// ── A fake bot: HTTP echoes back what auth header it received (never the token itself, since
// that's exactly the leak we're testing does NOT happen through the dashboard's responses), and
// a WS server gated the same way apps/bot/src/ws.ts's verifyClient is. ────────────────────────
let botServer;
let botPort;
let wss;
let lastWsAuthHeader;

beforeAll(async () => {
  botServer = http.createServer((req, res) => {
    if (req.url === "/api/echo-auth") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ receivedAuth: req.headers.authorization ?? null }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  wss = new WebSocketServer({
    server: botServer,
    verifyClient: (info, cb) => {
      lastWsAuthHeader = info.req.headers.authorization;
      if (info.req.headers.authorization === `Bearer ${API_TOKEN}`) cb(true);
      else cb(false, 401);
    },
  });
  wss.on("connection", (socket) => {
    socket.on("message", (msg) => socket.send(`echo:${msg.toString()}`));
  });
  await new Promise((resolve) => botServer.listen(0, resolve));
  botPort = botServer.address().port;
});

afterAll(async () => {
  wss.close();
  await new Promise((resolve) => botServer.close(resolve));
});

// ── The dashboard server under test, with a real temp dist/ dir. ───────────────────────────────
let distDir;
let dash;
let dashPort;
let baseUrl;

beforeEach(async () => {
  distDir = mkdtempSync(join(tmpdir(), "dash-dist-"));
  writeFileSync(join(distDir, "index.html"), "<!doctype html><title>dashboard</title>");
  writeFileSync(join(distDir, "app.js"), "console.log('app')");

  dash = createDashboardServer({
    distDir,
    botUrl: `http://127.0.0.1:${botPort}`,
    apiToken: API_TOKEN,
    password: PASSWORD,
  });
  await new Promise((resolve) => dash.listen(0, resolve));
  dashPort = dash.address().port;
  baseUrl = `http://127.0.0.1:${dashPort}`;
});

afterEach(async () => {
  await new Promise((resolve) => dash.close(resolve));
  rmSync(distDir, { recursive: true, force: true });
});

function parseSetCookie(res) {
  const raw = res.headers.get("set-cookie");
  if (!raw) return null;
  return raw.split(";")[0];
}

describe("health check", () => {
  it("GET /health returns 200 with no auth required (Railway's healthcheck target)", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
  });
});

describe("auth gating", () => {
  it("redirects an unauthenticated page request to /login", async () => {
    const res = await fetch(`${baseUrl}/`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("returns 401 JSON (not a redirect) for an unauthenticated /api/* request", async () => {
    const res = await fetch(`${baseUrl}/api/bots`, { redirect: "manual" });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("serves the login form on GET /login", async () => {
    const res = await fetch(`${baseUrl}/login`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<form");
  });

  it("rejects the wrong password with 401 and no session cookie", async () => {
    const res = await fetch(`${baseUrl}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "password=nope",
    });
    expect(res.status).toBe(401);
    expect(parseSetCookie(res)).toBeNull();
  });

  it("accepts the correct password, sets an httpOnly session cookie, and redirects to /", async () => {
    const res = await fetch(`${baseUrl}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `password=${encodeURIComponent(PASSWORD)}`,
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toContain("dash_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
  });

  it("serves static files and the SPA fallback once authenticated", async () => {
    const login = await fetch(`${baseUrl}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `password=${encodeURIComponent(PASSWORD)}`,
      redirect: "manual",
    });
    const cookie = parseSetCookie(login);

    const index = await fetch(`${baseUrl}/`, { headers: { Cookie: cookie } });
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("dashboard");

    const asset = await fetch(`${baseUrl}/app.js`, { headers: { Cookie: cookie } });
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toContain("immutable");

    // A client-side route with no matching file falls back to index.html, not a 404.
    const spaRoute = await fetch(`${baseUrl}/backtest/strategy-finder`, { headers: { Cookie: cookie } });
    expect(spaRoute.status).toBe(200);
    expect(await spaRoute.text()).toContain("dashboard");
  });

  it("logout clears the session — a subsequent request is unauthenticated again", async () => {
    const login = await fetch(`${baseUrl}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `password=${encodeURIComponent(PASSWORD)}`,
      redirect: "manual",
    });
    const cookie = parseSetCookie(login);

    await fetch(`${baseUrl}/logout`, { method: "POST", headers: { Cookie: cookie }, redirect: "manual" });
    const after = await fetch(`${baseUrl}/`, { headers: { Cookie: cookie }, redirect: "manual" });
    expect(after.status).toBe(302);
  });
});

describe("API proxy", () => {
  it("injects the real Bearer token server-side and never leaks it back to the client", async () => {
    const login = await fetch(`${baseUrl}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `password=${encodeURIComponent(PASSWORD)}`,
      redirect: "manual",
    });
    const cookie = parseSetCookie(login);

    const res = await fetch(`${baseUrl}/api/echo-auth`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    // The bot actually received the real token (this endpoint deliberately echoes it back in
    // its body so the test can confirm injection happened — that's the fixture, not a leak).
    expect(body.receivedAuth).toBe(`Bearer ${API_TOKEN}`);
    // The browser's own request never carried it, and the proxy doesn't reflect it in headers.
    expect(res.headers.get("authorization")).toBeNull();
  });
});

describe("WebSocket proxy", () => {
  it("rejects an unauthenticated upgrade", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${dashPort}/`);
    const closeCode = await new Promise((resolve) => {
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode));
      ws.on("error", () => resolve("error"));
    });
    expect(closeCode).toBe(401);
  });

  it("proxies messages bidirectionally once authenticated, and the bot sees the real token", async () => {
    const login = await fetch(`${baseUrl}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `password=${encodeURIComponent(PASSWORD)}`,
      redirect: "manual",
    });
    const cookie = parseSetCookie(login);

    const ws = new WebSocket(`ws://127.0.0.1:${dashPort}/`, { headers: { Cookie: cookie } });
    await new Promise((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });

    const echoed = new Promise((resolve) => ws.once("message", (m) => resolve(m.toString())));
    ws.send("ping");
    expect(await echoed).toBe("echo:ping");
    expect(lastWsAuthHeader).toBe(`Bearer ${API_TOKEN}`);

    ws.close();
  });
});
