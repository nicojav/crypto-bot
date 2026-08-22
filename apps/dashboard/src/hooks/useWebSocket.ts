import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { BotEvent } from "../api/client";

// Same rationale as api/client.ts: production connects same-origin through the dashboard's own
// server (which proxies to the bot's authenticated WS endpoint — see server/createServer.js and
// apps/bot/src/ws.ts's verifyClient). VITE_API_URL, when set, is a local-dev-only override for
// talking directly to a bot with no proxy in front of it.
const RAW_BASE = import.meta.env.VITE_API_URL as string | undefined;
const WS_URL = RAW_BASE
  ? RAW_BASE.replace(/^https:/, "wss:").replace(/^http:/, "ws:")
  : `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`;

export function useWebSocket() {
  const qc = useQueryClient();

  useEffect(() => {
    let ws: WebSocket;
    let retryTimer: ReturnType<typeof setTimeout>;

    function connect() {
      ws = new WebSocket(WS_URL);

      ws.onmessage = (e) => {
        const event = JSON.parse(e.data as string) as BotEvent;
        switch (event.type) {
          case "signal.received":
            void qc.invalidateQueries({ queryKey: ["signals"] });
            break;
          case "trade.opened":
          case "trade.closed":
            void qc.invalidateQueries({ queryKey: ["trades"] });
            void qc.invalidateQueries({ queryKey: ["bots"] });
            void qc.invalidateQueries({ queryKey: ["positions"] });
            void qc.invalidateQueries({ queryKey: ["equitySummary"] });
            break;
          case "balance.updated":
            void qc.invalidateQueries({ queryKey: ["equity"] });
            break;
        }
      };

      ws.onclose = () => {
        retryTimer = setTimeout(connect, 5_000);
      };
    }

    connect();

    return () => {
      clearTimeout(retryTimer);
      ws?.close();
    };
  }, [qc]);
}
