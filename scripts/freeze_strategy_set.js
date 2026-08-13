/**
 * フォワード記録の戦略集合を凍結する（契約 §10 / forward-record.schema.yaml）。
 *
 * ★ ハッシュを手で書かないこと。実装そのものから生成する。
 *   手で書いた識別子は、コードを変えても気づかずに同じままになる。
 *   ここでは各戦略の rank 関数のソース文字列を直接ハッシュしているので、
 *   ロジックを1文字でも変えれば code_hash が変わり、凍結違反として検出できる。
 *
 * 凍結は一度きり。既存ファイルがあれば上書きせずに止まる。
 *
 * Usage:
 *   node scripts/freeze_strategy_set.js            # 凍結する
 *   node scripts/freeze_strategy_set.js --verify   # 実装が凍結時と一致するか検査
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';
import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { BASELINES, BASELINE_VERSION } from './lib/baselines.js';
import { CONTRACT } from './lib/portfolio.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'research', 'forward', 'jp', 'strategy-set.yaml');
const CONTRACT_ID = 'RC-20260812-jp';
const HOLD = 20;

const sha = s => createHash('sha256').update(s).digest('hex');
/** 戦略の同定: ランク付けロジックのソースと、判定に効くパラメータ。 */
const codeHash = s => sha(JSON.stringify({ id: s.id, warmup: s.warmup, rank: String(s.rank) }));

if (process.argv.includes('--verify')) {
  if (!existsSync(OUT)) { console.error('凍結ファイルがありません。まず凍結してください。'); process.exit(1); }
  const txt = readFileSync(OUT, 'utf8');
  let bad = 0;
  for (const s of BASELINES) {
    const h = codeHash(s);
    if (!txt.includes(h)) { console.error(`  ❌ ${s.id}: 実装が凍結時と違う（${h.slice(0, 16)}…）`); bad++; }
    else console.log(`  ✅ ${s.id}`);
  }
  console.log(bad ? `\n凍結違反 ${bad}件。契約 §10 に反する変更です。` : '\n全戦略が凍結時と一致。');
  process.exit(bad ? 1 : 0);
}

if (existsSync(OUT)) {
  console.error(`既に凍結されています: ${OUT}`);
  console.error('凍結は一度きりです。戦略を追加する場合は cohort を分けて追記してください（別集計）。');
  process.exit(1);
}

const commit = execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim();
const now = new Date().toISOString();
// 日付はJSTで書く。この研究は東証の営業日で動いており、UTC日付だと1日ずれる
// （寄り前08:00 JST は前日のUTC日付になる）。
const jst = new Date(Date.now() + 9 * 3600 * 1000).toISOString();
const jstDate = jst.slice(0, 10);

const y = [];
y.push('# フォワード記録の戦略集合 — 凍結済み');
y.push('#');
y.push('# ★ このファイルは書き換えない。戦略を追加する場合は cohort を分けて追記し、');
y.push('#   開始コホートと混ぜて集計しない（後から良かったものを紹介するのは多重検定）。');
y.push('# ★ 実装が変わっていないかは以下で検査できる:');
y.push('#     node scripts/freeze_strategy_set.js --verify');
y.push('#');
y.push('# 参照: research/contracts/RC-20260812-jp.md §10 / research/forward-record.schema.yaml');
y.push('');
y.push('strategy_set:');
y.push(`  frozen_at: "${now}"          # UTC`);
y.push(`  frozen_at_jst: "${jst.slice(0, 19).replace('T', ' ')}"   # JST（東証の営業日基準）`);
y.push(`  contract_id: ${CONTRACT_ID}`);
y.push(`  baseline_version: ${BASELINE_VERSION}`);
y.push(`  code_version: ${commit}`);
y.push('  market: jp');
y.push('');
y.push('  # 執行の前提（契約 §5・§7 と同一。ここで上書きしない）');
y.push('  execution:');
y.push(`    hold: ${HOLD}                       # 保有銘柄数`);
y.push(`    rebalance_days: ${CONTRACT.rebalanceDays}                # 週次`);
y.push('    decision_at: "大引け後（前日終値までの情報のみ）"');
y.push('    execution_at: "翌営業日の始値"       # 同じ足で判断して同じ足で約定させない');
y.push(`    commission_bp: ${CONTRACT.commissionBp}                 # 片道 0.05%`);
y.push(`    slippage_bp: ${CONTRACT.slippageBp}                   # 片道 0.10%`);
y.push(`    max_weight_per_name: ${CONTRACT.maxWeightPerName}`);
y.push('    long_only: true');
y.push('  universe: "プライム/スタンダード/グロース上場の株式で、20日平均売買代金10億円以上（ETF/ETN/REITを除く）"');
y.push('  signal_data_source: same_day_quotes_yfinance   # J-Quantsは12週遅延のため当日には使えない');
y.push('  signal_time_jst: "08:00"                       # 東証の寄り付き1時間前');
y.push('');
y.push('  strategies:');
for (const s of BASELINES) {
  y.push(`    - strategy_id: ${s.id}`);
  y.push(`      name: ${s.name}`);
  y.push(`      code_hash: ${codeHash(s)}`);
  y.push(`      warmup_days: ${s.warmup}`);
  y.push(`      added_at: "${jstDate}"`);
  y.push('      cohort: 開始コホート');
  y.push(`      economic_rationale: "${s.rationale}"`);
}
y.push('');
y.push('# ---------------------------------------------------------------');
y.push('# 期待値の宣言（開始時に書いておく。3ヶ月目に失速しないため）');
y.push('# ---------------------------------------------------------------');
y.push('expectations:');
y.push('  purpose: |');
y.push('    この5戦略は「勝つための戦略」ではない。新しい候補を測るための基準線である。');
y.push('    探索期間（2016-2023）の実測では5種すべてがベンチマーク（ユニバース等ウェイト）に負け、');
y.push('    5種すべてが位相不変性テストで脆いと判定され、');
y.push('    5種すべてがランダム選択の分布（コスト0）の上位20〜55%に留まった。');
y.push('    つまり銘柄選択の情報を示していない。それを承知の上で開始コホートとして凍結する。');
y.push('  year_one_success_criterion: |');
y.push('    1年目の成果は「市場に勝ったか」ではなく【汚染のない記録が存在すること】。');
y.push('    年間の観測は約250件で、穏当な優位性の統計的検出には数年かかる。');
y.push('  expected_outcome: |');
y.push('    5戦略ともベンチマークを下回ることが最も確からしい予測である。');
y.push('    それが起きた場合、これは失敗ではなく【探索期間の測定がフォワードで再現された】という結果になる。');
y.push('  falsification: |');
y.push('    探索期間の結論（＝情報なし）と食い違う結果が出た場合、まず記録側の欠陥を疑う。');
y.push('    データ源・執行時刻・コスト計上を先に検査してから、戦略の実力を論じる。');
y.push('');

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, y.join('\n'));
console.log(`凍結しました: ${OUT}`);
console.log(`  契約: ${CONTRACT_ID}`);
console.log(`  戦略: ${BASELINES.length}種（${BASELINE_VERSION}）`);
console.log(`  コード: ${commit.slice(0, 12)}`);
console.log(`  日時: ${now}`);
