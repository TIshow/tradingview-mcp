/**
 * フォワード記録 — 日次シグナルの生成（契約 RC-20260812-jp §10）。
 *
 * 未来に向けた記録は定義上アウトオブサンプルであり、汚染が構造的に消える。
 * ただしそれが成立するのは【結果が出る前に、書き換え不能な形で記録された場合】に限る。
 * したがってこのスクリプトは次を機械的に強制する。
 *
 *   1. 寄り付き前であること（generated_at < market_open）。過ぎていたら書かない
 *   2. 戦略集合が凍結時と一致すること。実装が変わっていたら書かない
 *   3. 既存のシグナルファイルを上書きしないこと。訂正は別レコードで追記する
 *   4. 全5戦略を必ず出すこと。一部だけの報告を禁止する
 *
 * ★ 判定は「前週最終営業日の終値」まで、執行は「今週初営業日の始値」。
 *   バックテストと同じ規律（同じ足で判断して同じ足で約定させない）。
 *
 * Usage:
 *   node scripts/forward_signals.js              # 今日のシグナルを生成
 *   node scripts/forward_signals.js --dry-run    # 書き出さずに表示だけ
 *   node scripts/forward_signals.js --date YYYY-MM-DD   # 日付を指定（再構成用）
 */
import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { loadPanel, universeByDate, dropCorrupt } from './lib/dataset.js';
import { BASELINES, BASELINE_VERSION, strategyCodeHash } from './lib/baselines.js';
import { CONTRACT } from './lib/portfolio.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FROZEN = join(ROOT, 'research', 'forward', 'jp', 'strategy-set.yaml');
const SIGNAL_DIR = join(ROOT, 'research', 'forward', 'jp', 'signals');
const HOLD = 20;
const MARKET_OPEN_JST = 9;    // 東証の寄り付き（時）
const MAX_STALE_DAYS = 5;     // これ以上データが古ければ実行しない

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const DRY = argv.includes('--dry-run');
const RECONSTRUCT = argv.includes('--reconstruct');

// --- JSTで日付を扱う。UTC日付だと寄り前08:00が前日になってしまう ---
const jstNow = () => new Date(Date.now() + 9 * 3600 * 1000);
const jstIso = d => d.toISOString().slice(0, 19).replace('T', ' ');
const DATE = arg('--date', jstNow().toISOString().slice(0, 10));

/** その日を含むISO週の月曜日（YYYY-MM-DD）。 */
function weekStart(ymd) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));   // 月曜=0 に正規化
  return d.toISOString().slice(0, 10);
}

// =============================================================
// 0. 営業日かどうか（土日は記録しない）
// =============================================================
// 祝日はここでは判定しない。休場日に書かれた記録は執行が発生しないため無害であり、
// 実行後に「その日のバーが存在しない」ことで結果側から検出できる。
// 一方で土日は確実に休場なので、無駄なレコードを作らない。
const dow = new Date(DATE + 'T00:00:00Z').getUTCDay();
if (dow === 0 || dow === 6) {
  console.log(`${DATE} は${dow === 0 ? '日曜' : '土曜'}です。東証は休場のため記録しません。`);
  process.exit(0);
}

// =============================================================
// 1. 日付の範囲と、寄り付き前かどうか
// =============================================================
const now = jstNow();
const today = now.toISOString().slice(0, 10);
const daysAhead = Math.round((new Date(DATE) - new Date(today)) / 86400000);

// 未来を無制限に生成できると、複数日ぶんを作って良かったものだけ残せてしまう。
// 判定に使える情報（前週最終営業日の終値）が確定している範囲＝次の営業日までに限る。
if (daysAhead > 3) {
  console.error(`❌ ${DATE} は先すぎます（${daysAhead}日先）。生成できるのは翌営業日までです。`);
  console.error('   先の日付をまとめて作れると、後から都合の良い日だけ残せてしまいます。');
  process.exit(1);
}
if (daysAhead < 0 && !RECONSTRUCT) {
  console.error(`❌ ${DATE} は過去です。過去日の生成は記録の証拠になりません。`);
  console.error('   欠測の穴埋めが目的なら --reconstruct を付けてください（採点対象外として記録します）。');
  process.exit(1);
}

const preOpen = daysAhead > 0 || now.getUTCHours() < MARKET_OPEN_JST;
if (!preOpen && !RECONSTRUCT) {
  console.error(`❌ 既に寄り付き（${MARKET_OPEN_JST}:00 JST）を過ぎています。現在 ${jstIso(now)} JST。`);
  console.error('   寄り後に書いた記録はアウトオブサンプルではありません。この日は記録しません。');
  console.error('   （欠測として扱い、翌営業日に再開してください。埋め合わせは行わない）');
  process.exit(1);
}

// =============================================================
// 2. 戦略集合が凍結時と一致するか
// =============================================================
if (!existsSync(FROZEN)) { console.error(`❌ 戦略集合が凍結されていません: ${FROZEN}`); process.exit(1); }
const frozenTxt = readFileSync(FROZEN, 'utf8');
const drift = BASELINES.filter(s => !frozenTxt.includes(strategyCodeHash(s)));
if (drift.length) {
  console.error(`❌ 実装が凍結時と違います: ${drift.map(s => s.id).join(', ')}`);
  console.error('   契約 §10 に反します。実装を戻すか、新しいコホートとして別に登録してください。');
  process.exit(1);
}

// =============================================================
// 3. 上書き禁止
// =============================================================
const OUT = join(SIGNAL_DIR, `${DATE}.yaml`);
if (existsSync(OUT) && !DRY) {
  console.error(`❌ ${DATE} のシグナルは既に存在します: ${OUT}`);
  console.error('   一度 push した記録は書き換えません。訂正は別レコードで追記してください。');
  process.exit(1);
}

// =============================================================
// 4. データ
// =============================================================
console.log('データ読み込み中...');
const panel = dropCorrupt(loadPanel({}));            // 品質ゲート①②③は dataset.js 側で強制される
const uni = universeByDate(panel, { minTradedValue: CONTRACT.minTradedValue });
const dataAsOf = panel.dates.at(-1);
const staleDays = Math.round((new Date(DATE) - new Date(dataAsOf)) / 86400000);
console.log(`  ${panel.tickers.length}銘柄 / データ最終日 ${dataAsOf}（${staleDays}日前）`);
if (staleDays > MAX_STALE_DAYS) {
  console.error(`❌ データが古すぎます（${staleDays}日前）。先に取得してください:`);
  console.error('     python3 scripts/fetch_daily.py --update');
  process.exit(1);
}

// --- 判定日: 今週が始まる【前】の最終営業日 ---
const ws = weekStart(DATE);
let di = -1;
for (let i = panel.dates.length - 1; i >= 0; i--) { if (panel.dates[i] < ws) { di = i; break; } }
if (di < 0) { console.error('❌ 判定に使える営業日がありません'); process.exit(1); }
const decisionDate = panel.dates[di];
const universe = uni[di];
console.log(`  判定日 ${decisionDate}（今週 ${ws} 開始の直前）/ ユニバース ${universe.length}銘柄`);
if (universe.length < HOLD) { console.error(`❌ ユニバースが${HOLD}銘柄に満たない`); process.exit(1); }

// =============================================================
// 5. 全5戦略のシグナル
// =============================================================
const weight = Math.min(1 / HOLD, CONTRACT.maxWeightPerName);
const picksByStrategy = BASELINES.map(s => {
  const ranked = s.rank(panel, di, universe).sort((a, b) => b.score - a.score).slice(0, HOLD);
  return { s, picks: ranked };
});

for (const { s, picks } of picksByStrategy) {
  console.log(`  ${s.name.padEnd(12)} ${picks.length}銘柄  上位5: ` +
    picks.slice(0, 5).map(p => panel.tickers[p.si].replace('.T', '')).join(' '));
}

// =============================================================
// 6. 書き出し
// =============================================================
const commit = execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim();
const y = [];
y.push(`# フォワード記録 — ${DATE} の日次シグナル`);
y.push('#');
y.push('# ★ このファイルは書き換えない。訂正が必要なら別レコードとして追記する。');
y.push('# ★ 外部の証人は、このファイルを含む GitHub コミットのサーバ側タイムスタンプ。');
y.push('#   寄り付き（09:00 JST）より前に push されていることが記録の有効条件。');
y.push('#');
y.push('# 参照: research/contracts/RC-20260812-jp.md §10 / research/forward/jp/strategy-set.yaml');
y.push('');
y.push('signal_record:');
y.push(`  date: "${DATE}"`);
y.push(`  generated_at: "${new Date().toISOString()}"      # UTC`);
y.push(`  generated_at_jst: "${jstIso(now)}"    # JST`);
y.push(`  market_open_at_jst: "${DATE} 09:00:00"`);
y.push(`  pre_open: ${preOpen}                         # generated_at < market_open（不変条件）`);
if (RECONSTRUCT) {
  y.push('  reconstructed: true                    # ★事後に作った記録。採点対象に含めない');
}
y.push(`  contract_id: RC-20260812-jp`);
y.push(`  baseline_version: ${BASELINE_VERSION}`);
y.push(`  code_version: ${commit}`);
y.push(`  data_version: ${panel.manifestHash}`);
y.push(`  dataset_id: ${panel.datasetId}`);
y.push(`  data_as_of: "${dataAsOf}"                  # この日の終値までしか見ていない`);
y.push('');
y.push('  # 判定は前週最終営業日の大引け、執行は今週初営業日の寄り付き。');
y.push('  # 週の途中はこの構成を持ち続ける（週次リバランス）。');
y.push(`  decision_date: "${decisionDate}"`);
y.push(`  week_start: "${ws}"`);
y.push(`  universe_size: ${universe.length}`);
y.push(`  hold: ${HOLD}`);
y.push(`  weight_per_name: ${weight}`);
y.push('');
y.push('  # baseline_v1 は建値からの逆指値を持たない。週次リバランスで上位20位を外れたら降りる。');
y.push('  # 契約 §7 の「1トレードあたりリスク2%」は最大DD -20% と同じく【実運用の規律】であり、');
y.push('  # 凍結した実装には含まれていない（含めるとバックテストと別の戦略になる）。');
y.push('  stop_loss_policy: none_by_design');
y.push('  exit_rule: "週次リバランスで上位20位から外れたら売却"');
y.push('');
y.push('  signals:');
for (const { s, picks } of picksByStrategy) {
  y.push(`    - strategy_id: ${s.id}`);
  y.push(`      name: ${s.name}`);
  y.push(`      code_hash: ${strategyCodeHash(s)}`);
  y.push('      positions:');
  for (const p of picks) {
    const tk = panel.tickers[p.si];
    y.push(`        - { symbol: ${tk}, name: "${(panel.names[p.si] || '').slice(0, 24)}", ` +
           `direction: long, weight: ${weight}, reference_price: ${panel.close[p.si][di]}, ` +
           `score: ${Number(p.score.toFixed(6))} }`);
  }
}
y.push('');
y.push('  # 外部の証人。このファイルを含むコミットが push された時刻が記録の証拠になる。');
y.push('  witness:');
y.push('    commit_sha: null        # このファイルを含むコミット（push 後に確定する）');
y.push('    pushed_at: null         # GitHub のサーバ側タイムスタンプ');
y.push('    published_url: null');
y.push('');

if (DRY) {
  console.log('\n--- dry-run（書き出していません）---');
  console.log(y.join('\n').split('\n').slice(0, 40).join('\n'));
  console.log(`... 全${y.length}行`);
} else {
  mkdirSync(SIGNAL_DIR, { recursive: true });
  writeFileSync(OUT, y.join('\n'));
  console.log(`\n書き出し: ${OUT}`);
  console.log('★ 寄り付き（09:00 JST）より前に commit & push すること。push が証人になる。');
}
