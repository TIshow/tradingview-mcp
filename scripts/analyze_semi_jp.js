/**
 * Professional multi-indicator technical analysis for a basket of symbols.
 *
 * Reads raw daily OHLCV via CDP (adds NO chart indicators — free-plan safe) and
 * computes SMA(25/75/200), EMA(50/200), RSI(14 Wilder), MACD(12/26/9), volume
 * stats, range position, and a trend classification — all in JS, so it does NOT
 * depend on the (unreliable) MCP study_values / screenshot-legend readouts.
 *
 * Prints a compact JSON summary per symbol to stdout. Restores chart when done.
 *
 * Usage: node scripts/analyze_semi_jp.js [SYM1 SYM2 ...]
 */
import { evaluate, evaluateAsync, disconnect } from '../src/connection.js';

const SYMBOLS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['TSE:8035', 'TSE:6857', 'TSE:6146', 'TSE:6920', 'TSE:7735'];
const BARS = 400;
const RESTORE = 'TSE:6857';
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
      var s = ${CHART}._chartWidget.model().mainSeries();
      var bars = s.bars();
      if(!bars||typeof bars.lastIndex!=='function') return null;
      var out=[]; var end=bars.lastIndex(); var start=Math.max(bars.firstIndex(), end-${limit}+1);
      for(var i=start;i<=end;i++){var v=bars.valueAt(i); if(v) out.push({t:v[0],o:v[1],h:v[2],l:v[3],c:v[4],v:v[5]});}
      var sym=''; try{sym=s.symbolInfo()?s.symbolInfo().full_name||s.symbolInfo().name||'':'';}catch(e){}
      return {bars:out, sym:sym};
    })()
  `);
}
// Wait until bars for the NEW symbol have loaded and stabilized.
// prevClose = last close of the PREVIOUS symbol; the chart holds the old symbol's
// bars for a moment after setSymbol (symbolInfo() flips first, bars() lag), so we
// must wait until the close actually changes away from prevClose before trusting it.
async function waitBars(limit, prevClose) {
  let last = -1, lastClose = null, stable = 0;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const d = await readBars(limit).catch(() => null);
    const n = d?.bars?.length || 0;
    const c = n ? d.bars[n - 1].c : null;
    const changed = prevClose == null || c !== prevClose;
    if (n > 60 && n === last && c === lastClose && changed) {
      if (++stable >= 2) return d;
    } else {
      stable = 0;
    }
    last = n; lastClose = c;
  }
  return readBars(limit); // fallback after timeout
}

const sma = (v, p) => v.length < p ? null : v.slice(v.length - p).reduce((a, b) => a + b, 0) / p;
function emaArr(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let prev;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) continue;
    if (prev === undefined) { let s = 0; for (let j = i - period + 1; j <= i; j++) s += values[j]; prev = s / period; }
    else prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}
function rsiWilderArr(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  let ag = 0, al = 0;
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const g = Math.max(ch, 0), l = Math.max(-ch, 0);
    if (i <= period) { ag += g; al += l; if (i === period) { ag /= period; al /= period; out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); } }
    else { ag = (ag * (period - 1) + g) / period; al = (al * (period - 1) + l) / period; out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); }
  }
  return out;
}
const pct = (a, b) => (b == null || b === 0) ? null : +(((a / b) - 1) * 100).toFixed(2);
const r0 = x => x == null ? null : Math.round(x);
const r1 = x => x == null ? null : +x.toFixed(1);
const r2 = x => x == null ? null : +x.toFixed(2);

function analyze(d) {
  const bars = (d?.bars || []).filter(b => b && Number.isFinite(b.c));
  const n = bars.length;
  if (n < 60) return { bars: n, error: 'insufficient bars' };
  const c = bars.map(b => b.c);
  const vol = bars.map(b => Number.isFinite(b.v) ? b.v : 0);
  const last = n - 1;
  const close = c[last];

  const sma25 = sma(c, 25), sma75 = sma(c, 75), sma200 = sma(c, 200);
  const e50 = emaArr(c, 50), e200 = emaArr(c, 200);
  const ema50 = e50[last], ema200 = e200[last];
  // slopes: compare MA now vs 10 bars ago
  const slope = (arr, k = 10) => (arr[last] != null && arr[last - k] != null) ? Math.sign(arr[last] - arr[last - k]) : null;
  const smaArr25 = c.map((_, i) => i >= 24 ? sma(c.slice(0, i + 1), 25) : null);

  const e12 = emaArr(c, 12), e26 = emaArr(c, 26);
  const macdLine = c.map((_, i) => (e12[i] != null && e26[i] != null) ? e12[i] - e26[i] : null);
  const macdVals = macdLine.map(v => v == null ? 0 : v);
  const signal = emaArr(macdVals, 9).map((v, i) => macdLine[i] == null ? null : v);
  const hist = macdLine.map((v, i) => (v != null && signal[i] != null) ? v - signal[i] : null);
  // bars since last MACD cross
  let crossAgo = null, crossDir = null;
  for (let i = last; i > 1; i--) {
    if (macdLine[i] == null || signal[i] == null || macdLine[i - 1] == null || signal[i - 1] == null) break;
    const up = macdLine[i - 1] <= signal[i - 1] && macdLine[i] > signal[i];
    const dn = macdLine[i - 1] >= signal[i - 1] && macdLine[i] < signal[i];
    if (up || dn) { crossAgo = last - i; crossDir = up ? 'bull' : 'bear'; break; }
  }

  const rsi = rsiWilderArr(c, 14);
  const winHi = (arr, w) => Math.max(...arr.slice(Math.max(0, n - w)));
  const winLo = (arr, w) => Math.min(...arr.slice(Math.max(0, n - w)));
  const hi250 = winHi(bars.map(b => b.h), 250), lo250 = winLo(bars.map(b => b.l), 250);
  const hi100 = winHi(bars.map(b => b.h), 100), lo100 = winLo(bars.map(b => b.l), 100);

  const avgVol25 = sma(vol, 25);

  // trend classification
  let trend;
  const above = (m) => m != null && close > m;
  const perfBull = above(ema50) && above(ema200) && ema50 > ema200;
  const perfBear = ema50 != null && ema200 != null && close < ema50 && close < ema200 && ema50 < ema200;
  if (perfBull) trend = slope(e50) > 0 ? '上昇（強気配列）' : '上昇（配列強気/50日横這い）';
  else if (perfBear) trend = '下降（弱気配列）';
  else if (above(ema200) && !above(ema50)) trend = '上昇トレンド内の調整（50日EMA下・200日EMA上）';
  else if (!above(ema200) && above(ema50)) trend = '底打ち試し（50日EMA上・200日EMA下）';
  else trend = '中立/もみ合い';

  return {
    bars: n,
    close: r0(close),
    chg: { d1: pct(close, c[last - 1]), d5: pct(close, c[last - 5]), d20: pct(close, c[last - 20]), d60: pct(close, c[last - 60]) },
    ma: {
      sma25: r0(sma25), sma75: r0(sma75), sma200: r0(sma200),
      ema50: r0(ema50), ema200: r0(ema200),
      distSma25: pct(close, sma25), distSma75: pct(close, sma75), distSma200: pct(close, sma200),
      distEma50: pct(close, ema50), distEma200: pct(close, ema200),
      sma25slope: slope(smaArr25), ema50slope: slope(e50), ema200slope: slope(e200),
    },
    rsi14: r1(rsi[last]),
    rsi14_5ago: r1(rsi[last - 5]),
    macd: { line: r1(macdLine[last]), signal: r1(signal[last]), hist: r1(hist[last]), hist_5ago: r1(hist[last - 5]), crossAgo, crossDir },
    vol: { today: r0(vol[last]), avg25: r0(avgVol25), ratio: r2(avgVol25 ? vol[last] / avgVol25 : null) },
    range: {
      hi250: r0(hi250), lo250: r0(lo250), offHi250: pct(close, hi250),
      hi100: r0(hi100), lo100: r0(lo100),
      rangePos100: hi100 === lo100 ? null : r1(((close - lo100) / (hi100 - lo100)) * 100),
    },
    trend,
  };
}

async function main() {
  await setResolution('D');
  const results = {};
  // seed prevClose with whatever symbol the chart is currently showing
  let prevClose = null;
  try { const cur = await readBars(3); const b = cur?.bars || []; prevClose = b.length ? b[b.length - 1].c : null; } catch {}
  for (const sym of SYMBOLS) {
    process.stderr.write(`analyzing ${sym}... `);
    await setSymbol(sym);
    const d = await waitBars(BARS, prevClose);
    const a = analyze(d);
    a.resolved = d?.sym || null;
    results[sym] = a;
    if (Number.isFinite(a.close)) prevClose = a.close;
    process.stderr.write(`${a.bars} bars, close ${a.close}, RSI ${a.rsi14}, ${a.trend || a.error}\n`);
  }
  await setSymbol(RESTORE);
  await setResolution('D');
  console.log(JSON.stringify(results, null, 2));
  await disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
