/**
 * 実験: 「賭けの数を増やす」「市場リスクを消す」で信号は見えるようになるか
 *
 * シモンズ流の構造との差は主に2つ。
 *   (A) 同時ポジション数が20しかない → 個別銘柄のノイズに支配される
 *   (B) ロングのみ＝市場リスクを取ったまま → 成績の大半が相場の上下で決まる
 *
 * どちらも「予測を良くする」話ではなく【測定できるようにする】話。
 * 信号が弱くても、ノイズを減らせば見えるようになる。
 *
 * ★ 凍結した baseline_v1 には触れない。保有数と多空の構成を変えるだけ。
 *   これは契約 RC-20260812-jp（ロングのみ・保有20）の【範囲外】であり、
 *   採用する場合は新しい契約を起こす必要がある。ここでは測定のみ行う。
 *
 * Usage: node scripts/experiments/bets_and_neutrality.js
 */
import { loadPanel, universeByDate, dropCorrupt } from '../lib/dataset.js';
import { BASELINES } from '../lib/baselines.js';
import { runStrategy, runBuyAndHold, CONTRACT } from '../lib/portfolio.js';
import { sharpe } from '../lib/indicators.js';

const PERIOD = { from: '2016-01-04', to: '2023-12-31' };
const HOLDS = [20, 50, 100, 200];
const PHASE_IX = 260, PHASES = [0, 1, 2, 3, 4];

const panel = dropCorrupt(loadPanel(PERIOD));
const uni = universeByDate(panel, { minTradedValue: CONTRACT.minTradedValue });
const P = x => ((x * 100).toFixed(1) + '%').padStart(9);
const spread = a => Math.max(...a) - Math.min(...a);

/**
 * ロング・ショート（マーケットニュートラル）。
 * 上位N銘柄を買い、下位N銘柄を売る。買いと売りが同額なので、
 * 相場全体が上下しても打ち消し合い、【順位付けが当たっているか】だけが残る。
 */
function runLongShort(panel, strategy, universeByDate, { n = 20, from = null, to = null, costMultiplier = 1 } = {}) {
  const { dates, close, open } = panel;
  const cost = (CONTRACT.commissionBp + CONTRACT.slippageBp) / 10000 * costMultiplier;
  let i0 = 0, i1 = dates.length - 1;
  if (from) while (i0 < dates.length && dates[i0] < from) i0++;
  if (to) while (i1 > 0 && dates[i1] > to) i1--;
  i0 = Math.max(i0, strategy.warmup || 0);

  let equity = 1, positions = new Map();
  const curve = [];
  let peak = 1, maxDD = 0, turnoverSum = 0, nReb = 0;

  for (let di = i0; di <= i1; di++) {
    let dayRet = 0;
    for (const [si, w] of positions) {
      const c0 = close[si][di - 1], c1 = close[si][di];
      if (c0 != null && c1 != null && c0 !== 0) dayRet += w * (c1 / c0 - 1);
    }
    equity *= (1 + dayRet);
    curve.push(equity);
    peak = Math.max(peak, equity);
    maxDD = Math.min(maxDD, equity / peak - 1);

    if ((di - i0) % CONTRACT.rebalanceDays !== 0 || di + 1 > i1) continue;
    const u = universeByDate[di];
    if (!u || u.length < n * 2) continue;
    const ranked = strategy.rank(panel, di, u).sort((a, b) => b.score - a.score)
      .filter(r => open[r.si][di + 1] != null && close[r.si][di + 1] != null);
    if (ranked.length < n * 2) continue;

    const next = new Map();
    for (const r of ranked.slice(0, n)) next.set(r.si, 0.5 / n);        // 買い 合計 +50%
    for (const r of ranked.slice(-n)) next.set(r.si, -0.5 / n);         // 売り 合計 -50%

    let turnover = 0;
    for (const si of new Set([...positions.keys(), ...next.keys()])) {
      turnover += Math.abs((next.get(si) || 0) - (positions.get(si) || 0));
    }
    turnoverSum += turnover; nReb++;
    equity *= (1 - turnover * cost);
    positions = next;
  }
  const rets = curve.slice(1).map((e, i) => e / curve[i] - 1);
  const years = Math.max((i1 - i0) / 252, 1e-9);
  return {
    totalReturn: equity - 1, cagr: Math.pow(equity, 1 / years) - 1,
    sharpe: sharpe(rets), maxDD, turnoverPerYear: nReb ? turnoverSum / years : 0,
  };
}

// ============================================================
console.log(`探索期間 ${panel.dates[0]} 〜 ${panel.dates.at(-1)} / ユニバース中央 ${
  uni.map(u => u.length).filter(x => x).sort((a, b) => a - b)[Math.floor(uni.filter(u => u.length).length / 2)]}銘柄`);
const bench = runBuyAndHold(panel, uni);
console.log(`ベンチマーク（全銘柄等ウェイト）: ${P(bench.totalReturn)} Sharpe ${bench.sharpe.toFixed(2)} maxDD ${P(bench.maxDD)}\n`);

// --- (A) 保有数を増やすとノイズはどれだけ減るか ---
console.log('━━━ (A) ロングのみ・保有数を変える');
console.log('  ' + '戦略'.padEnd(14) + HOLDS.map(h => `${h}銘柄`.padStart(11)).join('') + '   ← 括弧内は位相振れ幅');
for (const s of BASELINES) {
  const cells = HOLDS.map(h => {
    const r = runStrategy(panel, s, uni, { hold: h });
    const ph = PHASES.map(k => runStrategy(panel, s, uni, { hold: h, from: panel.dates[PHASE_IX + k] }).totalReturn);
    return `${(r.totalReturn * 100).toFixed(0)}%(${(spread(ph) * 100).toFixed(0)})`.padStart(11);
  });
  console.log('  ' + s.name.padEnd(14) + cells.join(''));
}
console.log(`  ${'ベンチマーク(全銘柄)'.padEnd(12)}${P(bench.totalReturn)} 位相振れ ${(spread(PHASES.map(k => runBuyAndHold(panel, uni, { from: panel.dates[PHASE_IX + k] }).totalReturn)) * 100).toFixed(1)}%`);

// --- (B) 市場リスクを消すと、順位付けの実力が見えるか ---
console.log('\n━━━ (B) ロング・ショート（買いと売りが同額＝相場の上下を打ち消す）');
console.log('  ' + '戦略'.padEnd(14) + HOLDS.map(h => `上下${h}銘柄`.padStart(13)).join(''));
for (const s of BASELINES) {
  const cells = HOLDS.map(h => {
    const r = runLongShort(panel, s, uni, { n: h });
    return `${(r.totalReturn * 100).toFixed(0)}% S${r.sharpe.toFixed(2)}`.padStart(13);
  });
  console.log('  ' + s.name.padEnd(14) + cells.join(''));
}

console.log('\n━━━ ロング・ショート 上下100銘柄の詳細（相場リスクを消した状態の実力）');
console.log('  ' + '戦略'.padEnd(14) + '総リターン' + 'CAGR'.padStart(8) + 'Sharpe'.padStart(9) + '最大DD'.padStart(10) + '回転率'.padStart(9));
for (const s of BASELINES) {
  const r = runLongShort(panel, s, uni, { n: 100 });
  console.log('  ' + s.name.padEnd(14) + P(r.totalReturn) + P(r.cagr) + r.sharpe.toFixed(2).padStart(9) +
    P(r.maxDD) + (r.turnoverPerYear.toFixed(1) + 'x').padStart(9));
}
// --- (C) コストを0にすると、順位付け自体に情報はあるか ---
// 「順位が逆」と「情報が無くてコストに食われた」は全く別の話。分けて見る。
console.log('\n━━━ (C) 順位付けそのものに情報はあるか（ロング・ショート上下100銘柄）');
console.log('  ' + '戦略'.padEnd(14) + 'コスト0'.padStart(12) + 'コスト1倍'.padStart(12) + '   コストの負担');
for (const s of BASELINES) {
  const g = runLongShort(panel, s, uni, { n: 100, costMultiplier: 0 });
  const n1 = runLongShort(panel, s, uni, { n: 100, costMultiplier: 1 });
  console.log('  ' + s.name.padEnd(14) + P(g.totalReturn) + P(n1.totalReturn) +
    P(n1.totalReturn - g.totalReturn) + `  Sharpe(コスト0) ${g.sharpe.toFixed(2)}`);
}
console.log('  → コスト0でもマイナスなら【順位が逆】。コスト0でほぼ0なら【情報が無い】。');

console.log('\n  ※ ロング・ショートは信用取引が必要で、契約 RC-20260812-jp（ロングのみ）の範囲外。');
console.log('     採用する場合は新しい契約を起こす。ここでは測定のみ。');
