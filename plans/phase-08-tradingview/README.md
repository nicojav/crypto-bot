# Phase 8 — TradingView strategy & alert wiring

**Status:** Complete ✅

## Goal

Get a real Pine Script strategy firing webhooks into your bot.

## Tasks

1. Write or adapt a simple Pine Script strategy (start with a 20/50 EMA cross — the goal is to test the pipeline, not to print money).
2. In Pine, use `alertcondition()` or `strategy.entry` with `alert_message`. Only fire alerts on bar close (`barstate.isconfirmed`) to avoid repaint.
3. Alert message JSON template:
   ```json
   {
     "secret": "{{REDACTED}}",
     "webhookId": "{{ticker}}-{{interval}}-{{time}}-{{strategy.order.action}}",
     "action": "{{strategy.order.action}}",
     "symbol": "{{ticker}}",
     "price": {{close}}
   }
   ```
4. Configure the TradingView alert to POST to `https://yourdomain.com/webhook/<botId>`.
5. For local testing, use `ngrok` or `cloudflared` to expose your dev bot to TradingView's IPs.

## Checkpoint

A real chart event on TradingView fires an alert. Your bot logs receive it, the dashboard shows the signal, and a testnet trade opens. Let it run for a few hours and watch the trades flow.

## Notes

### What was delivered

- `strategies/ema-cross.pine` — 20/50 EMA cross strategy with `calc_on_every_tick=false` (bar close only, no repaints). Alert message template included in file header.
- Webhook normalises TradingView's lowercase `"buy"`/`"sell"` to `"BUY"`/`"SELL"` automatically (`apps/bot/src/routes/webhook.ts`)
- `calcQty` fixed to use `maxPositionUsd` as margin (not notional): `qty = maxPositionUsd × maxLeverage / markPrice / lotSize`
- `setLeverage` made non-blocking — testnet returns "Illegal category" but order placement proceeds
- Bybit testnet KYC required to place futures orders (Argentina ✅ — not on excluded jurisdictions list)
- Bybit testnet runs on Railway Singapore (`ap-southeast`) — EU West blocked for order placement

### Checkpoint achieved

TradingView EMA cross alert → POST `/webhook/<botId>` → signal accepted → testnet order placed → position visible in Bybit testnet (`XRPUSDT -104.5 XRP @ $1.3480`) and trade row in dashboard. Two bots running: BTCUSDT and XRPUSDT.
