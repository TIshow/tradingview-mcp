/**
 * Multi-symbol RSI x MACD momentum backtest.
 *
 * Adds NO indicators to the chart (free-plan 2-study limit safe). It switches the
 * chart symbol, reads raw daily OHLCV via CDP, and computes the strategy in JS.
 *
 * Strategy (long-only, daily):
 *   entry: MACD crosses above signal AND RSI(14) > 50
 *   exit : MACD crosses below signal OR RSI(14) > 70
 *   commission: 0.03% per side. All-in (100% equity) per trade.
 *
 * Restores the chart to BATS:TTWO / 5m when done.
 *
 * Usage: node scripts/backtest_rsi_macd.js
 */
import { evaluate, evaluateAsync, disconnect } from '../src/connection.js';

const SYMBOLS = ['NVDA', 'TSLA', 'AAPL', 'MSFT', 'AMD', 'META', 'TTWO'];
const BARS = 400;
const COMMISSION = 0.0003; // per side
const CHART = 'window.TradingViewApi._activeChartWidgetWV.value()';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function setSymbol(sym) {
  await evaluateAsync(`(function(){var c=${CHART};return new Promise(function(res){c.setSymbol(${JSON.stringify(sym)},{});setTimeout(res,400);});})()`);
}
async function setResolution(res) {
  await evaluate(`(function(){${CHART}.setResolution(${JSON.stringify(res)},{});})()`);
}
async function readBars(limit) {
  return evaluate(`
    (function(){
      var bars = ${CHART}._chartWidget.model().mainSeries().bars();
      if(!bars||typeof bars.lastIndex!=='function') return null;
      var out=[]; var end=bars.lastIndex(); var start=Math.max(bars.firstIndex(), end-${limit}+1);
      for(var i=start;i<=end;i++){var v=bars.valueAt(i); if(v) out.push({t:v[0],c:v[4]});}
      return {bars:out, size:bars.size()};
    })()
  `);
}

// Wait until bars for the new symbol have loaded and stabilized.
async function waitBars(limit) {
  let last = -1;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const d = await readBars(limit).catch(() => null);
    const n = d?.bars?.length || 0;
    if (n > 50 && n === last) return d;
    last = n;
  }
  return readBars(limit);
}

function ema(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let prev;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) continue;
    if (prev === undefined) {
      let s = 0; for (let j = i - period + 1; j <= i; j++) s += values[j];
      prev = s / period;
    } else {
      prev = values[i] * k + prev * (1 - k);
    }
    out[i] = prev;
  }
  return out;
}

function rsiWilder(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const g = Math.max(ch, 0), l = Math.max(-ch, 0);
    if (i <= period) { avgGain += g; avgLoss += l; if (i === period) { avgGain /= period; avgLoss /= period; out[i] = rsiVal(avgGain, avgLoss); } }
    else { avgGain = (avgGain * (period - 1) + g) / period; avgLoss = (avgLoss * (period - 1) + l) / period; out[i] = rsiVal(avgGain, avgLoss); }
  }
  return out;
}
const rsiVal = (g, l) => l === 0 ? 100 : 100 - 100 / (1 + g / l);

function backtest(bars) {
  const closes = bars.map(b => b.c);
  const e12 = ema(closes, 12), e26 = ema(closes, 26);
  const macd = closes.map((_, i) => (e12[i] != null && e26[i] != null) ? e12[i] - e26[i] : null);
  const macdVals = macd.map(v => v == null ? 0 : v);
  const signal = ema(macdVals, 9).map((v, i) => macd[i] == null ? null : v);
  const rsi = rsiWilder(closes, 14);

  let pos = null; const trades = [];
  for (let i = 1; i < closes.length; i++) {
    if (macd[i] == null || signal[i] == null || macd[i - 1] == null || signal[i - 1] == null || rsi[i] == null) continue;
    const crossUp = macd[i - 1] <= signal[i - 1] && macd[i] > signal[i];
    const crossDn = macd[i - 1] >= signal[i - 1] && macd[i] < signal[i];
    if (pos == null && crossUp && rsi[i] > 50) {
      pos = { entry: closes[i] };
    } else if (pos != null && (crossDn || rsi[i] > 70)) {
      const ret = (closes[i] / pos.entry) * (1 - COMMISSION) * (1 - COMMISSION) - 1;
      trades.push(ret); pos = null;
    }
  }
  const wins = trades.filter(r => r > 0);
  const losses = trades.filter(r => r <= 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  let eq = 1, peak = 1, maxDD = 0;
  for (const r of trades) { eq *= (1 + r); peak = Math.max(peak, eq); maxDD = Math.min(maxDD, eq / peak - 1); }
  const buyHold = closes.length > 30 ? closes[closes.length - 1] / closes[30] - 1 : null;
  return {
    trades: trades.length,
    wins: wins.length,
    winRate: trades.length ? wins.length / trades.length * 100 : 0,
    totalReturn: (eq - 1) * 100,
    profitFactor: grossLoss === 0 ? (grossWin > 0 ? Infinity : 0) : grossWin / grossLoss,
    maxDD: maxDD * 100,
    avgWin: wins.length ? grossWin / wins.length * 100 : 0,
    avgLoss: losses.length ? -grossLoss / losses.length * 100 : 0,
    buyHold: buyHold == null ? null : buyHold * 100,
  };
}

async function main() {
  const results = [];
  await setResolution('D');
  for (const sym of SYMBOLS) {
    process.stderr.write(`scanning ${sym}... `);
    await setSymbol(sym);
    const d = await waitBars(BARS);
    const bars = d?.bars || [];
    if (bars.length < 60) { process.stderr.write(`only ${bars.length} bars, skip\n`); continue; }
    const r = backtest(bars);
    r.symbol = sym; r.bars = bars.length;
    results.push(r);
    process.stderr.write(`${bars.length} bars, ${r.trades} trades, ${r.winRate.toFixed(1)}% WR\n`);
  }
  // restore
  await setSymbol('BATS:TTWO');
  await setResolution('5');

  results.sort((a, b) => b.winRate - a.winRate || b.totalReturn - a.totalReturn);
  console.log(JSON.stringify({ strategy: 'RSI x MACD momentum (daily, long-only, 0.03%/side)', ranked: results }, null, 2));
  await disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
