import type { Server } from "node:http";

import WebSocket from "ws";

import type { EventBus } from "./eventBus.js";
import { env } from "./env.js";

export function attachWebSocketServer(httpServer: Server, bus: EventBus): WebSocket.Server {
  // Same Bearer-token check as backtestRoutes.ts's onRequest hook (routes/api.ts has its own
  // copy too) — this server previously accepted any connection and broadcast every trade/balance
  // event to it. The dashboard's server (server/createServer.js) is the only client that should
  // ever reach this: it authenticates the browser via its own session cookie, then connects here
  // server-to-server with the real token, which a browser's native WebSocket API couldn't attach
  // as a header itself.
  const wss = new WebSocket.Server({
    server: httpServer,
    verifyClient: (info, cb) => {
      if (info.req.headers.authorization === `Bearer ${env.API_TOKEN}`) cb(true);
      else cb(false, 401, "Unauthorized");
    },
  });

  wss.on("connection", (socket: WebSocket) => {
    const ping = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.ping();
    }, 30_000);
    socket.on("close", () => clearInterval(ping));
  });

  bus.on("event", (payload: unknown) => {
    const msg = JSON.stringify(payload);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    }
  });

  return wss;
}
