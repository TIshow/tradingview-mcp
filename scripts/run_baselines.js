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
import { loadPanel, universeByDate, dropCorrupt } from './lib/dataset.js';
import { BASELINES, BASELINE_VERSION } from './lib/baselines.js';
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
const raw = loadPanel({ from: p.from, to: p.to });
// データ品質ゲート: 値幅制限を超える変動は未調整の分割か配信エラー。
// 除外しないと架空の利益を生む（実測: 8303.T の破損値で CAGR 531% が出た）。
const panel = dropCorrupt(raw);
console.log(`  ${panel.tickers.length}銘柄 / ${panel.dates.length}日 / ${panel.dates[0]} 〜 ${panel.dates.at(-1)}`);
if (panel.excluded.length) {
  console.log(`  品質ゲートで除外: ${panel.excluded.length}銘柄 — ${panel.excluded.map(e => e.ticker).join(', ')}`);
}
console.log(`  dataset: ${panel.datasetId} @ ${panel.manifestHash.slice(0, 12)}`);

const uni = universeByDate(panel, { minTradedValue: CONTRACT.minTradedValue });
const sizes = uni.map(u => u.length).filter(x => x > 0).sort((a, b) => a - b);
console.log(`  ユニバース: 中央 ${sizes[sizes.length >> 1]}銘柄（売買代金${CONTRACT.minTradedValue / 1e8}億円以上）`);
console.log(`\n期間: ${PERIOD}  保有: ${HOLD}銘柄  コスト: 片道${(CONTRACT.commissionBp + CONTRACT.slippageBp) / 100}%\n`);

const bench = runBuyAndHold(panel, uni, { hold: HOLD });
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
for (const s of BASELINES) {
  const rs = [1, 2, 4].map(m => runStrategy(panel, s, uni, { hold: HOLD, costMultiplier: m }).totalReturn);
  console.log('  ' + s.name.padEnd(14) + rs.map(x => ((x * 100).toFixed(1) + '%').padStart(9)).join(''));
}

if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify({
    baseline_version: BASELINE_VERSION,
    dataset_id: panel.datasetId, data_version: panel.manifestHash,
    period: PERIOD, range: { from: panel.dates[0], to: panel.dates.at(-1) },
    excluded_symbols: panel.excluded.map(e => ({ ticker: e.ticker, maxMove: Math.max(...e.events.map(x => Math.abs(x.ret))) })),
    hold: HOLD, contract: CONTRACT,
    benchmark: { ...bench, equityCurve: undefined, dailyReturns: undefined },
    results: results.map(r => ({ ...r, equityCurve: undefined, dailyReturns: undefined })),
  }, null, 2));
  console.log(`\n保存: ${JSON_OUT}`);
}
