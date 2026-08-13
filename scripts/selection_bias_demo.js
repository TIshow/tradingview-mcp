/**
 * 選択バイアスの実証。
 * 「優位性がゼロ」と分かっているランダムな価格データ61銘柄に対し、
 * MACD×RSI戦略をパラメータ50通りで試す（=3050試行）。
 * 真の優位性はゼロなのに、「Sharpe 1.5を超える組み合わせ」がいくつ見つかるかを数える。
 */
import { ema, rsiWilder, sharpe } from './lib/indicators.js';

const N_STOCKS = 61, N_DAYS = 400, DAILY_VOL = 0.02, COMMISSION = 0.0003;

// 再現可能な乱数
let seed = 20260811;
function rnd() { seed |= 0; seed = seed + 0x6D2B79F5 | 0;
  let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296; }
function gauss() { let u = 0, v = 0; while (u === 0) u = rnd(); while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

// ドリフトゼロ = 優位性ゼロのランダムウォーク（幾何ブラウン運動）
function makeStock() {
  const c = [1000];
  for (let i = 1; i < N_DAYS; i++) c.push(c[i-1] * Math.exp(DAILY_VOL * gauss() - 0.5 * DAILY_VOL ** 2));
  return c;
}
// 戦略：MACD上抜け かつ RSI>閾値 で買い、MACD下抜け または RSI>上限 で売り
function run(c, {fast, slow, sig, rsiLen, rsiEntry, rsiExit}) {
  const ef = ema(c, fast), es = ema(c, slow);
  const macd = c.map((_, i) => (ef[i]!=null && es[i]!=null) ? ef[i]-es[i] : null);
  const signal = ema(macd.map(v => v==null?0:v), sig).map((v,i) => macd[i]==null?null:v);
  const rsi = rsiWilder(c, rsiLen);
  let pos = null; const dailyRet = [];
  for (let i = 1; i < c.length; i++) {
    let r = 0;
    if (pos != null) r = c[i]/c[i-1] - 1;              // 保有中は日次リターンを受け取る
    if (macd[i]!=null && signal[i]!=null && macd[i-1]!=null && signal[i-1]!=null && rsi[i]!=null) {
      const up = macd[i-1] <= signal[i-1] && macd[i] > signal[i];
      const dn = macd[i-1] >= signal[i-1] && macd[i] < signal[i];
      if (pos == null && up && rsi[i] > rsiEntry) { pos = 1; r -= COMMISSION; }
      else if (pos != null && (dn || rsi[i] > rsiExit)) { pos = null; r -= COMMISSION; }
    }
    dailyRet.push(r);
  }
  const total = dailyRet.reduce((eq,r)=>eq*(1+r),1) - 1;
  return { sharpe: sharpe(dailyRet), total };
}

// パラメータグリッド（50通り）
const grid = [];
for (const fast of [8,12,16])
  for (const slow of [21,26,34])
    for (const rsiEntry of [45,50,55])
      for (const rsiExit of [70,75])
        grid.push({fast, slow, sig:9, rsiLen:14, rsiEntry, rsiExit});
const GRID = grid.slice(0, 50);

const stocks = Array.from({length: N_STOCKS}, makeStock);
const results = [];
for (let s = 0; s < N_STOCKS; s++)
  for (const p of GRID) {
    const r = run(stocks[s], p);
    results.push({ stock: s+1, ...p, ...r });
  }

results.sort((a,b) => b.sharpe - a.sharpe);
const trials = results.length;
const over15 = results.filter(r => r.sharpe >= 1.5);
const over20 = results.filter(r => r.sharpe >= 2.0);
const best = results[0];

console.log(`\n=== 選択バイアスの実証 ===`);
console.log(`データ: 完全にランダム（ドリフト0 = 真の優位性ゼロ）の${N_STOCKS}銘柄 × ${N_DAYS}日`);
console.log(`試行 : ${N_STOCKS}銘柄 × ${GRID.length}パラメータ = ${trials}通り\n`);
console.log(`Sharpe 1.5以上: ${over15.length}件 (${(over15.length/trials*100).toFixed(1)}%)`);
console.log(`Sharpe 2.0以上: ${over20.length}件 (${(over20.length/trials*100).toFixed(1)}%)`);
console.log(`\n--- 「発掘」された最強の組み合わせ TOP5 ---`);
results.slice(0,5).forEach((r,i) => console.log(
  `  ${i+1}. 銘柄#${String(r.stock).padStart(2)}  Sharpe ${r.sharpe.toFixed(2)}  総リターン ${(r.total*100).toFixed(1)}%` +
  `   [MACD ${r.fast}/${r.slow}/${r.sig}, RSI>${r.rsiEntry} 決済>${r.rsiExit}]`));
console.log(`\n理論値: 期待される最大Sharpe ≈ √(2·ln ${trials}) = ${Math.sqrt(2*Math.log(trials)).toFixed(2)} (SE=1.0の場合)`);
console.log(`実測の最大Sharpe = ${best.sharpe.toFixed(2)}`);
console.log(`\n※これらは全て「優位性ゼロ」のデータから出た数字。全部まぐれ。\n`);
