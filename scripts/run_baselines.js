/**
 * ベースライン5種を実行する。
 *
 * ★ 既定では【探索期間のみ】を使う。調整期間・封印期間には触れない。
 *   封印期間（2025-06 以降）はプロジェクトを通じて1回しかアクセスできない（契約 §8）。
 *
 * Usage:
 *   node scripts/run_baselines.js            # 探索期間で実行
 *   node scripts/run_baselines.js --hold 10  # 保有銘柄数を変える
 *   node scripts/run_baselines.js --json out.json
 */
import { writeFileSync } from 'fs';
import { loadPanel, universeByDate, dropCorrupt, auditExtremeMoves } from './lib/dataset.js';
import { BASELINES, BASELINE_VERSION, randomPicker } from './lib/baselines.js';
import { runStrategy, runBuyAndHold, summarize, CONTRACT } from './lib/portfolio.js';

// 契約 §8 の期間分割
const PERIODS = {
  explore: { from: '2016-01-04', to: '2023-12-31' },
  tune:    { from: '2024-01-01', to: '2025-05-31' },
  sealed:  { from: '2025-06-01', to: null },   // ★1回のみ。通常は触らない
};

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const HOLD = Number(arg('--hold', 20));
const PERIOD = arg('--period', 'explore');
const JSON_OUT = arg('--json', null);

if (PERIOD === 'sealed') {
  console.error('封印期間へのアクセスは契約で1回に制限されています。');
  console.error('意図的に使う場合は research/registry.jsonl に sealed_test の記録を残してから実行してください。');
  process.exit(1);
}

const p = PERIODS[PERIOD];
if (!p) { console.error(`不明な期間: ${PERIOD}`); process.exit(1); }

console.log(`データ読み込み中...`);
// 品質ゲート①（loadPanel 内）: 出来高0のバーを読まない。
//   上場前・上場廃止中・市場休日に yfinance が入れてくる架空の価格を排除する。
// 品質ゲート②: それでも残る、値幅制限を超える変動を含む銘柄を落とす。
const raw = loadPanel({ from: p.from, to: p.to });
const panel = dropCorrupt(raw);
console.log(`  ${panel.tickers.length}銘柄 / ${panel.dates.length}日 / ${panel.dates[0]} 〜 ${panel.dates.at(-1)}`);
console.log(`  出来高0で除外したバー: ${raw.zeroVolumeDropped.toLocaleString()}本（上場前・上場廃止中・休場日）`);
if (panel.excluded.length) {
  console.log(`  残余ゲートで除外: ${panel.excluded.length}銘柄 — ${panel.excluded.map(e => e.ticker).join(', ')}`);
}
console.log(`  dataset: ${panel.datasetId} @ ${panel.manifestHash.slice(0, 12)}`);

const uni = universeByDate(panel, { minTradedValue: CONTRACT.minTradedValue });
const sizes = uni.map(u => u.length).filter(x => x > 0).sort((a, b) => a - b);
console.log(`  ユニバース: 中央 ${sizes[sizes.length >> 1]}銘柄（株式のみ・売買代金${CONTRACT.minTradedValue / 1e8}億円以上）`);

// 極端な値動きは自動で消さず、必ず目に見える形で出す（契約 §6）。
const extreme = auditExtremeMoves(panel, uni);
console.log(`\nユニバース内の |日次変動| 40%超: ${extreme.length}件`);
for (const e of extreme) {
  console.log(`  ${e.date}  ${e.ticker.padEnd(8)} ${String(e.prev).padStart(9)} → ${String(e.cur).padStart(9)}` +
              `  ${((e.ret + 1).toFixed(2) + 'x').padStart(7)}  ${(e.name || '').slice(0, 18)}`);
}

console.log(`\n期間: ${PERIOD}  保有: ${HOLD}銘柄  コスト: 片道${(CONTRACT.commissionBp + CONTRACT.slippageBp) / 100}%\n`);

const bench = runBuyAndHold(panel, uni);   // ユニバース全銘柄を等ウェイト（上位N銘柄ではない）
console.log('  ' + summarize(bench));
console.log('  ' + '-'.repeat(90));

const results = [];
for (const s of BASELINES) {
  const r = runStrategy(panel, s, uni, { hold: HOLD });
  r.vsBenchmark = r.totalReturn - bench.totalReturn;
  results.push(r);
  console.log('  ' + summarize(r) + `  ベンチ差 ${(r.vsBenchmark * 100).toFixed(1)}%`);
}

// コスト耐性（契約 §9 の反証テスト: 1倍・2倍・4倍）
console.log('\nコスト耐性（総リターン）');
console.log('  ' + '戦略'.padEnd(14) + '1倍'.padStart(9) + '2倍'.padStart(9) + '4倍'.padStart(9));
const costRobust = {};
for (const s of BASELINES) {
  const rs = [1, 2, 4].map(m => runStrategy(panel, s, uni, { hold: HOLD, costMultiplier: m }).totalReturn);
  costRobust[s.id] = { x1: rs[0], x2: rs[1], x4: rs[2] };
  console.log('  ' + s.name.padEnd(14) + rs.map(x => ((x * 100).toFixed(1) + '%').padStart(9)).join(''));
}

/**
 * リバランス位相の不変性（契約 §9 の反証テスト）。
 *
 * 開始日を1営業日ずつずらすと、週次リバランスの曜日が変わる。
 * これは戦略の中身とは無関係な設定なので、実体のある戦略なら結果は動かないはず。
 * 大きく動くなら、その数字は「たまたまその曜日だった」以上の意味を持たない。
 *
 * 実測でこれを入れた理由: 逆張りは位相を変えるだけで -18.4% 〜 +52.6%（71pt）動いた。
 * ベンチマーク自身の振れ幅（5.8pt）を基準に、それを大きく超えるものは脆いと判定する。
 */
const PHASE_IX = 260;   // 最大 warmup(252) の直後。全戦略を同じ日から始めて比較する
const phases = [0, 1, 2, 3, 4];
const spread = rs => Math.max(...rs) - Math.min(...rs);
console.log('\n位相不変性（開始日を1営業日ずつずらす / 総リターン）');
console.log('  ' + '戦略'.padEnd(14) + phases.map(k => `位相${k}`.padStart(9)).join('') + '   最大−最小');
const benchPhase = phases.map(k => runBuyAndHold(panel, uni, { from: panel.dates[PHASE_IX + k] }).totalReturn);
const fmt = rs => rs.map(x => ((x * 100).toFixed(1) + '%').padStart(9)).join('');
console.log('  ' + 'ベンチマーク'.padEnd(12) + fmt(benchPhase) + ((spread(benchPhase) * 100).toFixed(1) + '%').padStart(11));
const phaseRobust = {};
for (const s of BASELINES) {
  const rs = phases.map(k => runStrategy(panel, s, uni, { hold: HOLD, from: panel.dates[PHASE_IX + k] }).totalReturn);
  phaseRobust[s.id] = { returns: rs, spread: spread(rs) };
  const flag = spread(rs) > spread(benchPhase) * 3 ? '  ← 脆い' : '';
  console.log('  ' + s.name.padEnd(14) + fmt(rs) + ((spread(rs) * 100).toFixed(1) + '%').padStart(11) + flag);
}
console.log(`  （ベンチマーク自身の振れ幅 ${(spread(benchPhase) * 100).toFixed(1)}% の3倍を超えたら脆いと表示）`);

/**
 * ランダム選択との比較（帰無仮説）。
 *
 * 20銘柄のポートフォリオは、選び方に情報が無くても大きくばらつく。
 * そのばらつきの分布を作り、各ベースラインがどの位置にいるかを見る。
 * 分布の中に埋もれているなら、その戦略は「でたらめに選ぶのと区別がつかない」。
 *
 * 比較を公平にするため、ベースラインもランダムも【同じ開始日】から走らせる。
 */
const N_RANDOM = 40;
const FROM = panel.dates[PHASE_IX];
const q = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];
const P = x => ((x * 100).toFixed(1) + '%');

// コスト0（＝銘柄選択そのものの力）と コスト1倍（＝実際に手元に残る額）を分けて見る。
// ランダム選択は毎週全入れ替えで回転率が最大になるため、コスト込みだけで比べると
// 「回転率が低い」というだけの理由でベースラインが勝ってしまい、選択力を測れない。
const nullTest = {};
for (const [tag, mult] of [['コスト0（選択力そのもの）', 0], ['コスト1倍（手取り）', 1]]) {
  const runs = Array.from({ length: N_RANDOM }, (_, i) =>
    runStrategy(panel, randomPicker(i + 1), uni, { hold: HOLD, from: FROM, costMultiplier: mult }));
  const rRet = runs.map(r => r.totalReturn).sort((a, b) => a - b);
  const rSh = runs.map(r => r.sharpe).sort((a, b) => a - b);

  console.log(`\nランダム選択との比較 — ${tag}（${N_RANDOM}試行・開始 ${FROM}・保有${HOLD}銘柄）`);
  console.log(`  ランダム 総リターン: 最小 ${P(rRet[0])} / 25% ${P(q(rRet, .25))} / 中央 ${P(q(rRet, .5))} / 75% ${P(q(rRet, .75))} / 最大 ${P(rRet.at(-1))}`);
  console.log(`  ランダム Sharpe   : 最小 ${rSh[0].toFixed(2)} / 中央 ${q(rSh, .5).toFixed(2)} / 最大 ${rSh.at(-1).toFixed(2)}`);
  console.log('  ' + '戦略'.padEnd(14) + '総リターン'.padStart(10) + 'ランダム内順位'.padStart(14) + 'Sharpe'.padStart(9) + 'ランダム内順位'.padStart(14));
  for (const s of BASELINES) {
    const r = runStrategy(panel, s, uni, { hold: HOLD, from: FROM, costMultiplier: mult });
    const topRet = (1 - rRet.filter(x => x < r.totalReturn).length / N_RANDOM) * 100;
    const topSh = (1 - rSh.filter(x => x < r.sharpe).length / N_RANDOM) * 100;
    (nullTest[s.id] ||= {})[mult ? 'net' : 'gross'] =
      { totalReturn: r.totalReturn, sharpe: r.sharpe, topPctReturn: topRet, topPctSharpe: topSh };
    console.log('  ' + s.name.padEnd(14) + P(r.totalReturn).padStart(10) +
      `上位${topRet.toFixed(0)}%`.padStart(14) + r.sharpe.toFixed(2).padStart(9) +
      `上位${topSh.toFixed(0)}%`.padStart(14));
  }
}
console.log('\n  上位50%前後に留まる＝でたらめに選ぶのと区別がつかない。');

if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify({
    baseline_version: BASELINE_VERSION,
    dataset_id: panel.datasetId, data_version: panel.manifestHash,
    period: PERIOD, range: { from: panel.dates[0], to: panel.dates.at(-1) },
    quality_gates: {
      zero_volume_bars_dropped: raw.zeroVolumeDropped,
      residual_excluded_symbols: panel.excluded.map(e => ({
        ticker: e.ticker, maxMove: Math.max(...e.events.map(x => Math.abs(x.ret))),
      })),
      universe_excluded_markets: ['その他'],
      extreme_moves_in_universe: extreme,
    },
    hold: HOLD, contract: CONTRACT,
    benchmark: { ...bench, equityCurve: undefined, dailyReturns: undefined },
    results: results.map(r => ({ ...r, equityCurve: undefined, dailyReturns: undefined })),
    robustness: {
      cost: costRobust,
      rebalance_phase: { benchmark: { returns: benchPhase, spread: spread(benchPhase) }, ...phaseRobust },
      random_null: { n_trials: N_RANDOM, from: FROM, strategies: nullTest },
    },
  }, null, 2));
  console.log(`\n保存: ${JSON_OUT}`);
}
