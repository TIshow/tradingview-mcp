/**
 * ポートフォリオ・バックテスター。
 *
 * 契約 RC-20260812-jp の条件をコードで強制する。数値は呼び出し側で上書きしない。
 *   - ロングのみ・レバレッジなし
 *   - 週次リバランス、判定は大引け後、執行は翌営業日の始値
 *   - 手数料 片道0.05% / スリッページ 片道0.1%
 *   - 1銘柄あたり最大20%
 *   - 最大DD -20% を超えたら停止
 *
 * ★ 先読みを構造的に防ぐ:
 *   di 日の情報でランク付けし、執行は di+1 日の【始値】。
 *   同じ足の終値で判断して同じ足で約定させると、現実には不可能な取引になる。
 *
 * 参照: research/contracts/RC-20260812-jp.md §2, §5, §7
 */
import { sharpe } from './indicators.js';

export const CONTRACT = {
  commissionBp: 5,        // 片道 0.05%
  slippageBp: 10,         // 片道 0.10%
  maxWeightPerName: 0.20,
  maxDrawdown: -0.20,     // 候補の棄却条件（★実運用の停止ルール。研究では測定を打ち切らない）
  minTradedValue: 10e8,   // ユニバース条件（20日平均売買代金）
  rebalanceDays: 5,       // 週次
  longOnly: true,
};

/**
 * 戦略を回す。
 *   strategy : { id, name, rank(panel, di, universe), warmup }
 *   universeByDate : 各日のユニバース（銘柄インデックス配列）
 *   hold : 保有銘柄数
 */
/**
 * haltOnDrawdown について:
 *   実運用では「DDが上限を超えたら止める」が正しい。しかし研究でこれを有効にすると
 *   バックテストが途中で打ち切られ、戦略の性質を測れなくなる。
 *   実測: ロングオンリーでは【何もしない等ウェイト保有ですら】2018-12 に -20% を超え、
 *   8年の検証が2年で終わってしまった。
 *   したがって研究では既定で無効にし、最大DDは【指標として測って事後に棄却判定する】。
 */
export function runStrategy(panel, strategy, universeByDate, {
  hold = 20, from = null, to = null, costMultiplier = 1, seed = null,
  haltOnDrawdown = false,
} = {}) {
  const { dates, close, open } = panel;
  const cost = (CONTRACT.commissionBp + CONTRACT.slippageBp) / 10000 * costMultiplier;

  let i0 = 0, i1 = dates.length - 1;
  if (from) while (i0 < dates.length && dates[i0] < from) i0++;
  if (to) while (i1 > 0 && dates[i1] > to) i1--;
  i0 = Math.max(i0, strategy.warmup || 0);

  let equity = 1;
  let positions = new Map();     // si -> weight
  const equityCurve = [];
  let peak = 1, maxDD = 0, turnoverSum = 0, nRebalance = 0, halted = false, haltedAt = null;

  for (let di = i0; di <= i1; di++) {
    // --- 保有中の値洗い（当日終値ベース）---
    let dayRet = 0;
    for (const [si, w] of positions) {
      const c0 = close[si][di - 1], c1 = close[si][di];
      if (c0 != null && c1 != null && c0 !== 0) dayRet += w * (c1 / c0 - 1);
    }
    equity *= (1 + dayRet);
    equityCurve.push({ date: dates[di], equity });
    peak = Math.max(peak, equity);
    maxDD = Math.min(maxDD, equity / peak - 1);

    if (haltOnDrawdown && !halted && maxDD <= CONTRACT.maxDrawdown) {
      halted = true; haltedAt = dates[di]; positions = new Map();
    }
    if (halted) continue;

    // --- リバランス判定（di の情報で決め、di+1 の始値で執行）---
    if ((di - i0) % CONTRACT.rebalanceDays !== 0 || di + 1 > i1) continue;
    const uni = universeByDate[di];
    // ポートフォリオを埋められない日は取引しない。hold=Infinity（ユニバース全部）なら1銘柄あればよい。
    if (!uni || uni.length < (Number.isFinite(hold) ? hold : 1)) continue;

    const ranked = strategy.rank(panel, di, uni);
    if (!ranked.length) continue;
    ranked.sort((a, b) => b.score - a.score);

    // 翌営業日に始値がある銘柄のみ（執行できない銘柄は選ばない）
    const picks = [];
    for (const r of ranked) {
      if (open[r.si][di + 1] != null && close[r.si][di + 1] != null) picks.push(r.si);
      if (picks.length >= hold) break;
    }
    if (!picks.length) continue;

    const w = Math.min(1 / picks.length, CONTRACT.maxWeightPerName);
    const next = new Map(picks.map(si => [si, w]));

    // 売買回転率とコスト
    let turnover = 0;
    const all = new Set([...positions.keys(), ...next.keys()]);
    for (const si of all) turnover += Math.abs((next.get(si) || 0) - (positions.get(si) || 0));
    turnoverSum += turnover; nRebalance++;
    equity *= (1 - turnover * cost);

    positions = next;
  }

  // ★ 日次リターンは【執行コストを引いた後】の資産曲線から出す。
  //   コストを資産に直接掛けるだけにして日次リターンから漏らすと、
  //   売買回転率の高い戦略ほど Sharpe が過大に出る。
  //   実測: ランダム選択（回転率104回/年）は総リターン -46% なのに Sharpe 0.37 と表示されていた。
  const dailyReturns = equityCurve.slice(1).map((p, i) => p.equity / equityCurve[i].equity - 1);

  const years = Math.max((i1 - i0) / 252, 1e-9);
  const totalReturn = equity - 1;
  return {
    strategy: strategy.id,
    name: strategy.name,
    from: dates[i0], to: dates[i1],
    nDays: i1 - i0 + 1,
    hold: Number.isFinite(hold) ? hold : 'all', costMultiplier,
    totalReturn,
    cagr: Math.pow(equity, 1 / years) - 1,
    sharpe: sharpe(dailyReturns),
    maxDD,
    turnoverPerYear: nRebalance ? turnoverSum / years : 0,
    nRebalance,
    halted, haltedAt,
    ddWithinLimit: maxDD > CONTRACT.maxDrawdown,   // 事後の棄却判定に使う
    equityCurve,
    dailyReturns,
  };
}

/**
 * ベンチマーク: ユニバース【全体】を等ウェイトで保有する（週次で構成銘柄を入れ替え）。
 *
 * ★ 上位N銘柄ではなく全銘柄を持つこと。
 *   実測の教訓: 当初は hold=20 で「順位なし＝先頭から」拾う実装だった。
 *   銘柄インデックスは証券コード順なので、これは【コードの若い20銘柄】を持つ意味になる。
 *   ETFをユニバースから外した途端、先頭が 1801大成建設・1802大林組・1803清水建設… と並び、
 *   ベンチマークが建設株の集中ポートフォリオに化けて総リターンが 29.5% → 68.4% に跳ねた。
 *   基準線が銘柄選択をしてしまっては、それとの比較に意味がない。
 */
export function runBuyAndHold(panel, universeByDate, { from = null, to = null } = {}) {
  return runStrategy(panel, {
    id: 'benchmark', name: 'ユニバース等ウェイト', warmup: 21,
    rank: (p, di, uni) => uni.map(si => ({ si, score: 0 })),
  }, universeByDate, { hold: Infinity, from, to });
}

/** 結果の要約（1行）。 */
export function summarize(r) {
  const pct = x => (x * 100).toFixed(1) + '%';
  return `${r.name.padEnd(12)} ret=${pct(r.totalReturn).padStart(8)} CAGR=${pct(r.cagr).padStart(7)} ` +
         `Sharpe=${r.sharpe.toFixed(2).padStart(6)} maxDD=${pct(r.maxDD).padStart(7)} ` +
         `turnover=${r.turnoverPerYear.toFixed(1)}x/年${r.halted ? ` [停止 ${r.haltedAt}]` : ''}`;
}
