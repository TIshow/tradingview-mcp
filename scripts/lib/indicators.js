/**
 * テクニカル指標。すべて生の終値配列から計算する。
 *
 * MCP の指標読み取り（data_get_study_values・スクショ凡例）は銘柄切替に追随せず
 * stale な値を返すため使わない。ここでの計算値は、チャートに登録された EMA と
 * 一致することを実測で確認済み（28,939 = 28,939）。
 *
 * 参照: docs/tooling-notes.md
 */

/** 直近 p 本の単純移動平均。データ不足なら null。 */
export const sma = (v, p) =>
  v.length < p ? null : v.slice(v.length - p).reduce((a, b) => a + b, 0) / p;

/** 位置 i における単純移動平均。 */
export const smaAt = (a, i, w) => {
  if (i < w - 1) return null;
  let s = 0;
  for (let j = i - w + 1; j <= i; j++) s += a[j];
  return s / w;
};

/** 指数移動平均の系列。最初の値は単純平均で初期化する。 */
export function ema(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let prev;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) continue;
    if (prev === undefined) {
      let s = 0;
      for (let j = i - period + 1; j <= i; j++) s += values[j];
      prev = s / period;
    } else {
      prev = values[i] * k + prev * (1 - k);
    }
    out[i] = prev;
  }
  return out;
}

const rsiVal = (g, l) => (l === 0 ? 100 : 100 - 100 / (1 + g / l));

/** RSI の系列（Wilder 平滑。TradingView の ta.rsi と同一式）。 */
export function rsiWilder(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const g = Math.max(ch, 0), l = Math.max(-ch, 0);
    if (i <= period) {
      avgGain += g; avgLoss += l;
      if (i === period) {
        avgGain /= period; avgLoss /= period;
        out[i] = rsiVal(avgGain, avgLoss);
      }
    } else {
      avgGain = (avgGain * (period - 1) + g) / period;
      avgLoss = (avgLoss * (period - 1) + l) / period;
      out[i] = rsiVal(avgGain, avgLoss);
    }
  }
  return out;
}

/** MACD（TradingView の既定値と同一）。line / signal / hist の系列を返す。 */
export function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  const ef = ema(closes, fast), es = ema(closes, slow);
  const line = closes.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
  const signal = ema(line.map(v => (v == null ? 0 : v)), signalPeriod)
    .map((v, i) => (line[i] == null ? null : v));
  const hist = line.map((v, i) => (v != null && signal[i] != null ? v - signal[i] : null));
  return { line, signal, hist };
}

/** ATR（Wilder）。true range の系列も返す。 */
export function atrWilder(high, low, close, period = 14) {
  const tr = [];
  for (let i = 0; i < close.length; i++) {
    if (i === 0) { tr.push(high[i] - low[i]); continue; }
    tr.push(Math.max(
      high[i] - low[i],
      Math.abs(high[i] - close[i - 1]),
      Math.abs(low[i] - close[i - 1]),
    ));
  }
  const out = new Array(close.length).fill(null);
  let a;
  for (let i = 0; i < tr.length; i++) {
    if (i < period - 1) continue;
    if (a === undefined) {
      let s = 0;
      for (let j = i - period + 1; j <= i; j++) s += tr[j];
      a = s / period;
    } else {
      a = (a * (period - 1) + tr[i]) / period;
    }
    out[i] = a;
  }
  return { atr: out, tr };
}

/** 変化率（%）。分母が 0 か null なら null。 */
export const pct = (a, b) => (b == null || b === 0 ? null : +(((a / b) - 1) * 100).toFixed(2));

/**
 * 年率シャープレシオ。日次リターン配列から。
 *
 * sd === 0 の厳密比較では不十分。定数リターンでも浮動小数点誤差で
 * sd が 1e-18 程度になり、Sharpe が 1e16 まで発散する（実測）。
 * 判定装置の中核指標なので、実質ゼロの分散は 0 として扱う。
 */
export function sharpe(dailyReturns, periodsPerYear = 252) {
  const n = dailyReturns.length;
  if (n < 2) return 0;
  const mean = dailyReturns.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(dailyReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  const scale = Math.max(Math.abs(mean), 1e-12);
  if (sd < scale * 1e-9) return 0;   // 分散が実質ゼロ＝リスクを取っていない
  return (mean / sd) * Math.sqrt(periodsPerYear);
}
