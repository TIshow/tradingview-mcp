/**
 * Multi-symbol RSI x MACD momentum backtest — ベースライン戦略。
 *
 * 判定装置の比較対象として使う。チャートに指標は追加せず、生バーから自前計算する。
 *
 * Strategy (long-only, daily):
 *   entry: MACD crosses above signal AND RSI(14) > 50
 *   exit : MACD crosses below signal OR RSI(14) > 70
 *   commission: 0.03% per side. All-in (100% equity) per trade.
 *
 * Restores the chart to TSE:6857 / daily when done.
 *
 * Usage: node scripts/backtest_rsi_macd.js
 */
import { disconnect } from '../src/connection.js';
import { setSymbol, setResolution, waitBars, currentClose, ymd, T, C } from './lib/tv.js';
import { rsiWilder, macd as macdOf } from './lib/indicators.js';

// Usage: node scripts/backtest_rsi_macd.js [--bars N] [SYM ...]
const argv = process.argv.slice(2);
const barsIdx = argv.indexOf('--bars');
const BARS = barsIdx >= 0 ? Number(argv[barsIdx + 1]) : 400;
const symArgs = argv.filter((a, i) => !a.startsWith('--') && i !== barsIdx + 1);
const SYMBOLS = symArgs.length ? symArgs : ['NVDA', 'TSLA', 'AAPL', 'MSFT', 'AMD', 'META', 'TTWO'];
const COMMISSION = 0.0003; // per side
function backtest(bars) {
  const closes = bars.map(b => b[C]);
  const { line: macd, signal } = macdOf(closes, 12, 26, 9);
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
  let prevClose = await currentClose();
  for (const sym of SYMBOLS) {
    process.stderr.write(`scanning ${sym}... `);
    await setSymbol(sym);
    const d = await waitBars(BARS, prevClose);
    const bars = d?.bars || [];
    if (bars.length < 60) { process.stderr.write(`only ${bars.length} bars, skip\n`); continue; }
    prevClose = bars[bars.length - 1][C];
    const r = backtest(bars);
    r.symbol = sym; r.resolved = d?.sym || null; r.bars = bars.length;
    r.from = ymd(bars[0][T]);
    r.to = ymd(bars[bars.length - 1][T]);
    results.push(r);
    process.stderr.write(`${bars.length} bars (${r.from}~${r.to}, ${r.resolved}), ${r.trades} trades, ${r.winRate.toFixed(1)}% WR\n`);
  }
  // restore
  await setSymbol('TSE:6857');
  await setResolution('D');

  results.sort((a, b) => b.winRate - a.winRate || b.totalReturn - a.totalReturn);
  console.log(JSON.stringify({ strategy: 'RSI x MACD momentum (daily, long-only, 0.03%/side)', ranked: results }, null, 2));
  await disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
