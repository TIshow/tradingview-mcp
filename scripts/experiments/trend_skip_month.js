/**
 * 実験: トレンド追随は「直近1ヶ月を外す」べきか（パラメータ変種）
 *
 * 凍結した baseline_v1 の trend は 252営業日前 → 21営業日前 のリターンを使う。
 * 直近1ヶ月を外すのは短期反転を避けるための教科書的な慣習だが、
 * 【この日本株データで実際にそうなのか】は測っていなかった。
 *
 * ★ 凍結した実装（scripts/lib/baselines.js）には一切触れない。
 *   変種はこのファイル内で別物として定義する。触ると凍結ハッシュが壊れる。
 *
 * 事前宣言（結果を見る前に書く）:
 *   仮説        : 直近1ヶ月を外すほうが成績が良い（短期反転が混ざるのを避けられるため）
 *   棄却条件    : skip=21 が skip=0 を、総リターンでもSharpeでも上回らなければ棄却
 *   適用範囲    : jp_only（この契約のデータでのみ判定する）
 *   期間        : 探索期間のみ。調整期間・封印期間には触れない
 *
 * Usage: node scripts/experiments/trend_skip_month.js
 */
import { appendFileSync } from 'fs';
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { loadPanel, universeByDate, dropCorrupt } from '../lib/dataset.js';
import { runStrategy, runBuyAndHold, CONTRACT } from '../lib/portfolio.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REGISTRY = join(ROOT, 'research', 'registry.jsonl');
const PERIOD = { from: '2016-01-04', to: '2023-12-31' };   // 探索期間のみ
const HOLD = 20;
const SKIPS = [0, 5, 10, 21, 42, 63];                      // 0=直近1ヶ月も含める / 21=凍結版

/** 252営業日前 → skip営業日前 のリターンで順位付けする。skip=21 が凍結版と同一。 */
const trendVariant = skip => ({
  id: `trend_skip${skip}`,
  name: skip === 21 ? `skip=${skip}（凍結版）` : `skip=${skip}`,
  warmup: 252,
  rank(panel, di, universe) {
    return universe.map(si => {
      const cs = panel.close[si];
      const a = cs[di - 252], b = cs[di - skip];
      return { si, score: (a == null || b == null || a === 0) ? null : b / a - 1 };
    }).filter(x => x.score != null);
  },
});

const panel = dropCorrupt(loadPanel({ from: PERIOD.from, to: PERIOD.to }));
const uni = universeByDate(panel, { minTradedValue: CONTRACT.minTradedValue });
const bench = runBuyAndHold(panel, uni);
const P = x => ((x * 100).toFixed(1) + '%').padStart(9);

console.log(`探索期間 ${panel.dates[0]} 〜 ${panel.dates.at(-1)} / ${panel.tickers.length}銘柄`);
console.log(`ベンチマーク（ユニバース等ウェイト）: ${P(bench.totalReturn)}  Sharpe ${bench.sharpe.toFixed(2)}\n`);

// --- 本体 ---
console.log('  ' + '変種'.padEnd(16) + '総リターン' + 'Sharpe'.padStart(8) + '最大DD'.padStart(10) + '回転率'.padStart(9));
const rows = [];
for (const skip of SKIPS) {
  const s = trendVariant(skip);
  const r = runStrategy(panel, s, uni, { hold: HOLD });
  rows.push({ skip, r });
  console.log('  ' + s.name.padEnd(16) + P(r.totalReturn) + r.sharpe.toFixed(2).padStart(8) +
    P(r.maxDD) + (r.turnoverPerYear.toFixed(1) + 'x').padStart(9));
}

// --- 反証テスト: 位相を1〜4営業日ずらす ---
const PHASE_IX = 260, phases = [0, 1, 2, 3, 4];
const spread = a => Math.max(...a) - Math.min(...a);
const benchPhase = phases.map(k => runBuyAndHold(panel, uni, { from: panel.dates[PHASE_IX + k] }).totalReturn);
console.log('\n位相不変性（リバランス曜日をずらす。中身と無関係な設定で結果が動くなら脆い）');
console.log('  ' + '変種'.padEnd(16) + phases.map(k => `位相${k}`.padStart(9)).join('') + '   最大−最小');
console.log('  ' + 'ベンチマーク'.padEnd(14) + phases.map((_, i) => P(benchPhase[i])).join('') + P(spread(benchPhase)));
for (const row of rows) {
  const rs = phases.map(k => runStrategy(panel, trendVariant(row.skip), uni,
    { hold: HOLD, from: panel.dates[PHASE_IX + k] }).totalReturn);
  row.phase = { returns: rs, spread: spread(rs) };
  console.log('  ' + trendVariant(row.skip).name.padEnd(16) + rs.map(P).join('') + P(spread(rs)));
}

// --- 判定 ---
const frozen = rows.find(x => x.skip === 21);
const noSkip = rows.find(x => x.skip === 0);
const better = frozen.r.totalReturn > noSkip.r.totalReturn && frozen.r.sharpe > noSkip.r.sharpe;
console.log(`\n事前宣言した棄却条件: skip=21 が skip=0 を 総リターンでもSharpeでも上回ること`);
console.log(`  skip=21: ${P(frozen.r.totalReturn)} / Sharpe ${frozen.r.sharpe.toFixed(2)}`);
console.log(`  skip= 0: ${P(noSkip.r.totalReturn)} / Sharpe ${noSkip.r.sharpe.toFixed(2)}`);
console.log(`  → ${better ? '✅ 慣習は支持された' : '❌ 棄却。この期間・このユニバースでは慣習を支持しない'}`);
console.log(`\n※ どの変種もベンチマーク ${P(bench.totalReturn)} を超えていない場合、`);
console.log('   「どちらが良いか」の議論自体に実益が無いことに注意する。');

/**
 * 判定は行ごとに計算する。全行に同じ結論を書き込まないこと。
 * （最初の実装で verdict をハードコードし、ベンチマークを超えた skip=42 まで
 *   「ベンチマーク未達」と記録してしまった。台帳に嘘が入ると台帳の意味が消える。）
 */
function verdictOf(row, bench, benchSpread) {
  const beatsBench = row.r.totalReturn > bench.totalReturn;
  const stable = row.phase.spread <= benchSpread * 3;
  const reasons = [];
  if (!beatsBench) reasons.push('ベンチマーク未達');
  if (!stable) reasons.push(`位相不変性で脆い（振れ幅${(row.phase.spread * 100).toFixed(1)}% > 基準${(benchSpread * 3 * 100).toFixed(1)}%）`);
  return {
    verdict: reasons.length ? 'rejected' : 'shelved',
    rejection_reason: reasons.join(' / ') || null,
    // 通過しても採用にはしない。探索期間のインサンプルであり、
    // 6通り試して最大を選んでいる（多重検定の補正をしていない）。
    hold_reason: reasons.length ? null : '探索期間のインサンプル・6試行中の最大・多重検定未補正のため保留',
  };
}

// --- 全試行を記録（勝った変種だけ残すと Deflated Sharpe の入力が壊れる）---
const now = new Date().toISOString();
const codeHash = createHash('sha256').update(String(trendVariant)).digest('hex').slice(0, 16);
const commit = execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim();
const lines = rows.map((row, i) => JSON.stringify({
  experiment_id: `EXP-${now.slice(0, 10).replace(/-/g, '')}-${String(i + 1).padStart(4, '0')}`,
  contract_id: 'RC-20260812-jp',
  timestamp: now,
  hypothesis_id: `trend_skip_${row.skip}`,
  parent_hypothesis_id: 'baseline_v1_trend',
  derivation: 'param_variant',
  hypothesis_family: 'トレンド系',
  economic_rationale: '直近1ヶ月には短期反転が混ざるため、除くと長期の勢いだけを取り出せる',
  falsification_condition: 'skip=21 が skip=0 を総リターンでもSharpeでも上回らなければ棄却',
  market_scope: 'jp_only',
  scope_declared_at: now,
  llm_model: 'claude-opus-5',
  code_hash: codeHash,
  code_version: commit,
  data_version: panel.manifestHash,
  seed: null,
  market_universe: 'jp_prime_standard_growth_va1e9',
  training_period: { from: panel.dates[0], to: panel.dates.at(-1) },
  validation_period: null,
  parameters_tested: { lookback: 252, skip: SKIPS },
  n_configurations: SKIPS.length,
  execution_assumptions: {
    commission_bp: CONTRACT.commissionBp, slippage_bp: CONTRACT.slippageBp,
    cost_multiplier: 1, fill_assumption: 'next_open', liquidity_filter_passed: true,
  },
  result: {
    status: 'completed',
    metrics: {
      sharpe: row.r.sharpe, max_dd: row.r.maxDD, turnover: row.r.turnoverPerYear,
      total_return: row.r.totalReturn, buy_and_hold: bench.totalReturn,
      phase_spread: row.phase.spread,
    },
  },
  ...verdictOf(row, bench, spread(benchPhase)),
  notes: '凍結した baseline_v1 は変更しない。これは物差しの妥当性を測る補助実験。',
})).join('\n') + '\n';
appendFileSync(REGISTRY, lines);
console.log(`\n全${SKIPS.length}試行を記録: research/registry.jsonl`);
console.log('（勝った変種だけ残すと、試行数を入力とする統計検定が成立しなくなる）');
