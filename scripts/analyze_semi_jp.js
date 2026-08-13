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
import { disconnect } from '../src/connection.js';
import { setSymbol, setResolution, waitBars, currentClose, H, L, C, V } from './lib/tv.js';
import { sma, smaAt, ema, rsiWilder, macd as macdOf, pct } from './lib/indicators.js';

const SYMBOLS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['TSE:8035', 'TSE:6857', 'TSE:6146', 'TSE:6920', 'TSE:7735'];
const BARS = 400;
const RESTORE = 'TSE:6857';
const r0 = x => x == null ? null : Math.round(x);
const r1 = x => x == null ? null : +x.toFixed(1);
const r2 = x => x == null ? null : +x.toFixed(2);

function analyze(d) {
  const bars = (d?.bars || []).filter(b => b && Number.isFinite(b[C]));
  const n = bars.length;
  if (n < 60) return { bars: n, error: 'insufficient bars' };
  const c = bars.map(b => b[C]);
  const vol = bars.map(b => Number.isFinite(b[V]) ? b[V] : 0);
  const last = n - 1;
  const close = c[last];

  const sma25 = sma(c, 25), sma75 = sma(c, 75), sma200 = sma(c, 200);
  const e50 = ema(c, 50), e200 = ema(c, 200);
  const ema50 = e50[last], ema200 = e200[last];
  // slopes: compare MA now vs 10 bars ago
  const slope = (arr, k = 10) => (arr[last] != null && arr[last - k] != null) ? Math.sign(arr[last] - arr[last - k]) : null;
  const smaArr25 = c.map((_, i) => smaAt(c, i, 25));

  const { line: macdLine, signal, hist } = macdOf(c, 12, 26, 9);
  // bars since last MACD cross
  let crossAgo = null, crossDir = null;
  for (let i = last; i > 1; i--) {
    if (macdLine[i] == null || signal[i] == null || macdLine[i - 1] == null || signal[i - 1] == null) break;
    const up = macdLine[i - 1] <= signal[i - 1] && macdLine[i] > signal[i];
    const dn = macdLine[i - 1] >= signal[i - 1] && macdLine[i] < signal[i];
    if (up || dn) { crossAgo = last - i; crossDir = up ? 'bull' : 'bear'; break; }
  }

  const rsi = rsiWilder(c, 14);
  const winHi = (arr, w) => Math.max(...arr.slice(Math.max(0, n - w)));
  const winLo = (arr, w) => Math.min(...arr.slice(Math.max(0, n - w)));
  const hi250 = winHi(bars.map(b => b[H]), 250), lo250 = winLo(bars.map(b => b[L]), 250);
  const hi100 = winHi(bars.map(b => b[H]), 100), lo100 = winLo(bars.map(b => b[L]), 100);

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
  let prevClose = await currentClose();
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
