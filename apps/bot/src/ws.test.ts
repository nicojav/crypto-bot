import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer } from "node:http";
import type { Server } from "node:http";
import WebSocket from "ws";
import { attachWebSocketServer } from "./ws.js";
import { EventBus } from "./eventBus.js";
import { env } from "./env.js";

let httpServer: Server;
let port: number;
let bus: EventBus;

beforeEach(async () => {
  httpServer = createServer();
  bus = new EventBus();
  attachWebSocketServer(httpServer, bus);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  port = (httpServer.address() as { port: number }).port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

describe("attachWebSocketServer auth", () => {
  it("rejects a connection with no Authorization header", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
    const statusCode = await new Promise<number | undefined>((resolve) => {
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode));
      ws.on("error", () => resolve(undefined));
    });
    expect(statusCode).toBe(401);
  });

  it("rejects a connection with the wrong token", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { authorization: "Bearer wrong-token" } });
    const statusCode = await new Promise<number | undefined>((resolve) => {
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode));
      ws.on("error", () => resolve(undefined));
    });
    expect(statusCode).toBe(401);
  });

  it("accepts a connection with the correct token and forwards published events", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { authorization: `Bearer ${env.API_TOKEN}` } });
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });

    const received = new Promise<string>((resolve) => ws.once("message", (m) => resolve(m.toString())));
    bus.publish({ type: "balance.updated", data: { equityUsd: 100, availableUsd: 90 } });

    expect(JSON.parse(await received)).toEqual({ type: "balance.updated", data: { equityUsd: 100, availableUsd: 90 } });
    ws.close();
  });
});
