// Generates a .pine file equivalent to a backtest config, so a winning combination can be
// promoted to live TradingView by pasting instead of hand-translating. Mirrors the structural
// conventions of strategies/ema-cross-tpsl.pine (ATR bracket) and strategies/ema-rsi-pct-tpsl.pine
// (RSI filter + % bracket) already in this repo.

// Mirrors customMaCross.ts's/bbMeanReversion.ts's param `options` ordering — keep in sync.
const MA_SMA = 1;
const TPSL_ATR = 1;
const TPSL_PCT = 2;

type Push = (s?: string) => void;

function maCall(type: number, source: string, length: string): string {
  return type === MA_SMA ? `ta.sma(${source}, ${length})` : `ta.ema(${source}, ${length})`;
}

function pushHeader(push: Push, title: string) {
  push("// @version=6");
  push(`// Generated from the crypto-bot backtesting tool's "${title}" strategy.`);
  push("// Paste this into TradingView, tune the webhook secret, and compare against the");
  push("// backtested config before going live.");
  push("//");
  push("// TradingView setup:");
  push("//   1. Add to a chart. Paste your WEBHOOK_SECRET into the \"Webhook secret\" field.");
  push("//   2. Run the Strategy Tester and compare against the backtest results here.");
  push("//   3. Create an alert: condition \"Any alert() function call\", Message field empty.");
  push("//   4. Set webhook URL: https://your-domain.com/webhook/<botId>");
  push("");
  push("strategy(");
  push(`  title              = "${title} (exported)",`);
  push("  overlay            = true,");
  push("  calc_on_every_tick = false,");
  push("  default_qty_type   = strategy.percent_of_equity,");
  push("  default_qty_value  = 10");
  push(")");
  push("");
  push("webhookSecret = input.string(\"\", \"Webhook secret\", confirm=true, display=display.none)");
}

// Shared TP/SL input declarations — appended after a strategy's own inputs.
function pushTpSlInputs(push: Push, tpslMode: number, atrLen: number, slAtrMult: number, tpAtrMult: number, tpPct: number, slPct: number) {
  if (tpslMode === TPSL_ATR) {
    push(`atrLen = input.int(${atrLen}, "ATR length", minval=1)`);
    push(`slMult = input.float(${slAtrMult}, "SL ATR mult", minval=0.1, step=0.1)`);
    push(`tpMult = input.float(${tpAtrMult}, "TP ATR mult", minval=0.1, step=0.1)`);
  } else if (tpslMode === TPSL_PCT) {
    push(`tpPct = input.float(${tpPct}, "TP %", minval=0.1, step=0.1)`);
    push(`slPct = input.float(${slPct}, "SL %", minval=0.1, step=0.1)`);
  }
}

// Shared TP/SL variable block + order/alert block. Assumes `longEntry`/`shortEntry` (and, for
// ATR mode, `atrVal`) are already defined earlier in the script by the caller.
function pushBracketAndOrders(push: Push, tpslMode: number) {
  if (tpslMode === TPSL_ATR) {
    push("// ── TP / SL levels (captured once at the entry bar, held until next entry) ───");
    push("var float longSl  = na");
    push("var float longTp  = na");
    push("var float shortSl = na");
    push("var float shortTp = na");
    push("");
    push("if longEntry");
    push("    longSl  := close - atrVal * slMult");
    push("    longTp  := close + atrVal * tpMult");
    push("");
    push("if shortEntry");
    push("    shortSl := close + atrVal * slMult");
    push("    shortTp := close - atrVal * tpMult");
    push("");
  }

  push("// ── Orders ────────────────────────────────────────────────────────────────────");
  push("if longEntry");
  push("    strategy.close(\"Short\", comment=\"Exit Short\")");
  push("    strategy.entry(\"Long\",  strategy.long)");
  if (tpslMode === TPSL_ATR) {
    push("    longTpPct  = (longTp - close) / close * 100");
    push("    longSlPct  = (close - longSl) / close * 100");
    push("    tpSlSuffix = ',\"tpPct\":' + str.tostring(longTpPct, \"#.####\") + ',\"slPct\":' + str.tostring(longSlPct, \"#.####\")");
  } else if (tpslMode === TPSL_PCT) {
    push("    tpSlSuffix = ',\"tpPct\":' + str.tostring(tpPct, \"#.##\") + ',\"slPct\":' + str.tostring(slPct, \"#.##\")");
  } else {
    push("    tpSlSuffix = ''");
  }
  push("    alert('{\"secret\":\"' + webhookSecret + '\",\"webhookId\":\"' + syminfo.ticker + '-' + timeframe.period + '-' + str.tostring(time) + '-buy\",\"action\":\"buy\",\"symbol\":\"' + syminfo.ticker + '\",\"price\":' + str.tostring(close, \"#.########\") + tpSlSuffix + '}', alert.freq_once_per_bar_close)");
  push("");
  push("if shortEntry");
  push("    strategy.close(\"Long\",  comment=\"Exit Long\")");
  push("    strategy.entry(\"Short\", strategy.short)");
  if (tpslMode === TPSL_ATR) {
    push("    shortTpPct = (close - shortTp) / close * 100");
    push("    shortSlPct = (shortSl - close) / close * 100");
    push("    tpSlSuffix = ',\"tpPct\":' + str.tostring(shortTpPct, \"#.####\") + ',\"slPct\":' + str.tostring(shortSlPct, \"#.####\")");
  } else if (tpslMode === TPSL_PCT) {
    push("    tpSlSuffix = ',\"tpPct\":' + str.tostring(tpPct, \"#.##\") + ',\"slPct\":' + str.tostring(slPct, \"#.##\")");
  } else {
    push("    tpSlSuffix = ''");
  }
  push("    alert('{\"secret\":\"' + webhookSecret + '\",\"webhookId\":\"' + syminfo.ticker + '-' + timeframe.period + '-' + str.tostring(time) + '-sell\",\"action\":\"sell\",\"symbol\":\"' + syminfo.ticker + '\",\"price\":' + str.tostring(close, \"#.########\") + tpSlSuffix + '}', alert.freq_once_per_bar_close)");
  push("");
  push("// ── Visuals ───────────────────────────────────────────────────────────────────");
  push("plotshape(longEntry,  style=shape.triangleup,   location=location.belowbar, color=color.green, size=size.small, title=\"Long signal\")");
  push("plotshape(shortEntry, style=shape.triangledown, location=location.abovebar, color=color.red,   size=size.small, title=\"Short signal\")");
  if (tpslMode === TPSL_ATR) {
    push("");
    push("plot(strategy.position_size > 0 ? longSl : strategy.position_size < 0 ? shortSl : na, \"SL\", color=color.red,   style=plot.style_linebr, linewidth=1)");
    push("plot(strategy.position_size > 0 ? longTp : strategy.position_size < 0 ? shortTp : na, \"TP\", color=color.green, style=plot.style_linebr, linewidth=1)");
  }
}

export function pineForCustomMaCross(params: Record<string, number>): string {
  const fastMaType = params.fastMaType ?? 0;
  const fastLen = params.fastLen ?? 20;
  const slowMaType = params.slowMaType ?? 0;
  const slowLen = params.slowLen ?? 50;
  const useRsiFilter = (params.useRsiFilter ?? 0) === 1;
  const rsiLen = params.rsiLen ?? 14;
  const rsiMaxForLong = params.rsiMaxForLong ?? 60;
  const rsiMinForShort = params.rsiMinForShort ?? 40;
  const tpslMode = params.tpslMode ?? 0;
  const atrLen = params.atrLen ?? 14;
  const slAtrMult = params.slAtrMult ?? 1.5;
  const tpAtrMult = params.tpAtrMult ?? 3.0;
  const tpPct = params.tpPct ?? 1.5;
  const slPct = params.slPct ?? 0.75;

  const lines: string[] = [];
  const push: Push = (s = "") => lines.push(s);

  pushHeader(push, "Custom MA Cross");
  push(`fastLen       = input.int(${fastLen}, "Fast MA length", minval=2)`);
  push(`slowLen       = input.int(${slowLen}, "Slow MA length", minval=5)`);
  if (useRsiFilter) {
    push(`rsiLen         = input.int(${rsiLen}, "RSI length", minval=2)`);
    push(`rsiMaxForLong  = input.int(${rsiMaxForLong}, "RSI max for long", minval=1, maxval=100)`);
    push(`rsiMinForShort = input.int(${rsiMinForShort}, "RSI min for short", minval=1, maxval=100)`);
  }
  pushTpSlInputs(push, tpslMode, atrLen, slAtrMult, tpAtrMult, tpPct, slPct);
  push("");
  push("// ── Indicators ────────────────────────────────────────────────────────────────");
  push(`fastMA = ${maCall(fastMaType, "close", "fastLen")}`);
  push(`slowMA = ${maCall(slowMaType, "close", "slowLen")}`);
  if (useRsiFilter) push("rsiVal = ta.rsi(close, rsiLen)");
  if (tpslMode === TPSL_ATR) push("atrVal = ta.atr(atrLen)");
  push("");
  push("plot(fastMA, \"Fast MA\", color=color.blue,   linewidth=1)");
  push("plot(slowMA, \"Slow MA\", color=color.orange, linewidth=1)");
  push("");
  push("// ── Signals ───────────────────────────────────────────────────────────────────");
  if (useRsiFilter) {
    push("longEntry  = ta.crossover(fastMA, slowMA)  and rsiVal < rsiMaxForLong");
    push("shortEntry = ta.crossunder(fastMA, slowMA) and rsiVal > rsiMinForShort");
  } else {
    push("longEntry  = ta.crossover(fastMA, slowMA)");
    push("shortEntry = ta.crossunder(fastMA, slowMA)");
  }
  push("");

  pushBracketAndOrders(push, tpslMode);

  return lines.join("\n") + "\n";
}

export function pineForBbMeanReversion(params: Record<string, number>): string {
  const bbLen = params.bbLen ?? 20;
  const bbMult = params.bbMult ?? 2.0;
  const useRsiConfirm = (params.useRsiConfirm ?? 1) === 1;
  const rsiLen = params.rsiLen ?? 14;
  const rsiOversold = params.rsiOversold ?? 30;
  const rsiOverbought = params.rsiOverbought ?? 70;
  const tpslMode = params.tpslMode ?? 0;
  const atrLen = params.atrLen ?? 14;
  const slAtrMult = params.slAtrMult ?? 1.5;
  const tpAtrMult = params.tpAtrMult ?? 3.0;
  const tpPct = params.tpPct ?? 1.5;
  const slPct = params.slPct ?? 0.75;

  const lines: string[] = [];
  const push: Push = (s = "") => lines.push(s);

  pushHeader(push, "BB Mean Reversion");
  push(`bbLen  = input.int(${bbLen}, "BB length", minval=5)`);
  push(`bbMult = input.float(${bbMult}, "BB std-dev mult", minval=0.5, step=0.1)`);
  if (useRsiConfirm) {
    push(`rsiLen        = input.int(${rsiLen}, "RSI length", minval=2)`);
    push(`rsiOversold   = input.int(${rsiOversold}, "RSI oversold", minval=1, maxval=100)`);
    push(`rsiOverbought = input.int(${rsiOverbought}, "RSI overbought", minval=1, maxval=100)`);
  }
  pushTpSlInputs(push, tpslMode, atrLen, slAtrMult, tpAtrMult, tpPct, slPct);
  push("");
  push("// ── Indicators ────────────────────────────────────────────────────────────────");
  push("basis = ta.sma(close, bbLen)");
  push("dev   = ta.stdev(close, bbLen) * bbMult");
  push("upperBand = basis + dev");
  push("lowerBand = basis - dev");
  if (useRsiConfirm) push("rsiVal = ta.rsi(close, rsiLen)");
  if (tpslMode === TPSL_ATR) push("atrVal = ta.atr(atrLen)");
  push("");
  push("plot(basis,     \"Basis\",       color=color.gray,   linewidth=1)");
  push("plot(upperBand, \"Upper band\",  color=color.red,    linewidth=1)");
  push("plot(lowerBand, \"Lower band\",  color=color.green,  linewidth=1)");
  push("");
  push("// ── Signals ───────────────────────────────────────────────────────────────────");
  // Long: price closes below the lower band (bet on reversion). Short: closes above the upper band.
  if (useRsiConfirm) {
    push("longEntry  = ta.crossunder(close, lowerBand) and rsiVal < rsiOversold");
    push("shortEntry = ta.crossover(close, upperBand)  and rsiVal > rsiOverbought");
  } else {
    push("longEntry  = ta.crossunder(close, lowerBand)");
    push("shortEntry = ta.crossover(close, upperBand)");
  }
  push("");

  pushBracketAndOrders(push, tpslMode);

  return lines.join("\n") + "\n";
}
