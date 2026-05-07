import WebSocket from "ws";
import type { Server } from "node:http";
import type { EventBus } from "./eventBus.js";

export function attachWebSocketServer(httpServer: Server, bus: EventBus): WebSocket.Server {
  const wss = new WebSocket.Server({ server: httpServer });

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
