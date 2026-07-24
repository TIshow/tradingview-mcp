/**
 * Recording-ready autonomous watchlist scan.
 *
 * Flips the TradingView chart through a basket of individual stocks, reads each
 * one's RSI(14) + MACD from raw bars (adds NO indicator — free-plan 2-study safe),
 * and renders a live retro-terminal dashboard with deliberate pacing for screen
 * recording. Restores the chart to BATS:TTWO / 5m when done.
 *
 * Capture the TradingView window + this terminal side by side.
 *
 * Usage: node scripts/scan_demo.js
 */
import { evaluate, evaluateAsync, disconnect } from '../src/connection.js';

const SYMBOLS = ['NVDA', 'TSLA', 'AAPL', 'MSFT', 'AMD', 'META', 'GOOGL', 'AMZN'];
const BARS = 200;
const PACE_MS = 900;            // pause per symbol so it's watchable on video
const CHART = 'window.TradingViewApi._activeChartWidgetWV.value()';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- ANSI (truecolor) ---
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[38;2;120;200;90m', red: '\x1b[38;2;230;90;90m',
  amber: '\x1b[38;2;230;170;60m', gray: '\x1b[38;2;150;150;140m',
  cyan: '\x1b[38;2;70;200;170m', ink: '\x1b[38;2;220;218;208m',
};

async function setSymbol(sym) {
  await evaluateAsync(`(function(){var c=${CHART};return new Promise(function(res){c.setSymbol(${JSON.stringify(sym)},{});setTimeout(res,400);});})()`);
}
async function setResolution(res) {
  await evaluate(`(function(){${CHART}.setResolution(${JSON.stringify(res)},{});})()`);
}
async function readCloses(limit) {
  const d = await evaluate(`
    (function(){
      var bars = ${CHART}._chartWidget.model().mainSeries().bars();
      if(!bars||typeof bars.lastIndex!=='function') return null;
      var out=[]; var end=bars.lastIndex(); var start=Math.max(bars.firstIndex(), end-${limit}+1);
      for(var i=start;i<=end;i++){var v=bars.valueAt(i); if(v) out.push(v[4]);}
      return out;
    })()
  `).catch(() => null);
  return d || [];
}
async function waitCloses(limit) {
  let last = -1;
  for (let i = 0; i < 16; i++) {
    await sleep(400);
    const c = await readCloses(limit);
    if (c.length > 40 && c.length === last) return c;
    last = c.length;
  }
  return readCloses(limit);
}

function ema(v, p) {
  const k = 2 / (p + 1); let prev; const out = new Array(v.length).fill(null);
  for (let i = 0; i < v.length; i++) {
    if (i < p - 1) continue;
    if (prev === undefined) { let s = 0; for (let j = i - p + 1; j <= i; j++) s += v[j]; prev = s / p; }
    else prev = v[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}
function rsi14(cl) {
  let g = 0, l = 0; const p = 14;
  for (let i = 1; i <= p; i++) { const ch = cl[i] - cl[i - 1]; g += Math.max(ch, 0); l += Math.max(-ch, 0); }
  g /= p; l /= p;
  for (let i = p + 1; i < cl.length; i++) { const ch = cl[i] - cl[i - 1]; g = (g * (p - 1) + Math.max(ch, 0)) / p; l = (l * (p - 1) + Math.max(-ch, 0)) / p; }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
function indicators(cl) {
  const e12 = ema(cl, 12), e26 = ema(cl, 26);
  const macd = cl.map((_, i) => (e12[i] != null && e26[i] != null) ? e12[i] - e26[i] : 0);
  const sig = ema(macd, 9);
  const n = cl.length - 1;
  return { rsi: rsi14(cl), hist: macd[n] - (sig[n] ?? macd[n]) };
}

function zone(r) {
  if (r >= 70) return { col: C.red, tag: '過熱' };
  if (r >= 55) return { col: C.green, tag: '強気' };
  if (r >= 45) return { col: C.gray, tag: '中立' };
  if (r >= 30) return { col: C.amber, tag: '弱含み' };
  return { col: C.cyan, tag: '売られすぎ' };
}
function gauge(r) {
  const cells = 12, fill = Math.round(r / 100 * cells);
  return '█'.repeat(fill) + C.dim + '░'.repeat(cells - fill) + C.reset;
}
function pad(s, n) { s = String(s); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); }

async function main() {
  process.stdout.write('\n' + C.bold + C.ink + '  ╓──────────────────────────────────────────────────╖\n');
  process.stdout.write('  ║   AI WATCHLIST SCAN · RSI × MACD · live from TV   ║\n');
  process.stdout.write('  ╙──────────────────────────────────────────────────╜' + C.reset + '\n\n');

  const rows = [];
  for (const sym of SYMBOLS) {
    process.stdout.write(C.dim + '  ▶ scanning ' + C.reset + C.bold + pad(sym, 6) + C.reset + C.dim + ' …' + C.reset);
    await setSymbol(sym);
    const cl = await waitCloses(BARS);
    if (cl.length < 40) { process.stdout.write(C.red + '  no data\n' + C.reset); continue; }
    const { rsi, hist } = indicators(cl);
    const z = zone(rsi);
    const arrow = hist >= 0 ? C.green + '▲' : C.red + '▼';
    rows.push({ sym, rsi, hist, z });
    process.stdout.write('\r  ' + C.green + '✓' + C.reset + ' ' + C.bold + pad(sym, 6) + C.reset +
      '  RSI ' + z.col + gauge(rsi) + ' ' + pad(rsi.toFixed(1), 5) + C.reset +
      '  MACD ' + arrow + C.reset + '  ' + z.col + z.tag + C.reset + '          \n');
    await sleep(PACE_MS);
  }

  // restore
  await setSymbol('BATS:TTWO');
  await setResolution('5');

  rows.sort((a, b) => b.rsi - a.rsi);
  process.stdout.write('\n' + C.bold + C.ink + '  ┌─ RANKED · 強い順 ────────────────────────────────┐' + C.reset + '\n');
  rows.forEach((r, i) => {
    const arrow = r.hist >= 0 ? C.green + '▲' + C.reset : C.red + '▼' + C.reset;
    process.stdout.write('  ' + C.dim + pad(i + 1, 2) + C.reset + ' ' + C.bold + pad(r.sym, 6) + C.reset +
      ' ' + r.z.col + gauge(r.rsi) + C.reset + ' ' + pad(r.rsi.toFixed(1), 5) +
      ' ' + arrow + ' ' + r.z.col + pad(r.z.tag, 10) + C.reset + '\n');
  });
  process.stdout.write(C.bold + C.ink + '  └──────────────────────────────────────────────────┘' + C.reset + '\n\n');
  await disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
