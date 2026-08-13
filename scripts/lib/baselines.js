/**
 * ベースライン戦略5種（契約 §10 の開始コホート）。
 *
 * これらは「勝つための戦略」ではなく、**新しい候補を評価するための基準線**である。
 * 判定は「単体で儲かるか」ではなく「この既存集合に対して増分があるか（ΔU）」で行う。
 *
 * 全戦略が同じ形式に従う:
 *   rank(panel, di, universe) → [{si, score}]  スコアの高い順に上位を保有する
 *
 * 指標は保存せず、生の価格から都度計算する（lib/indicators.js）。
 *
 * 参照: research/contracts/RC-20260812-jp.md §10
 */
import { smaAt, rsiWilder, ema, atrWilder } from './indicators.js';

/** 系列の [from, to] 区間のリターン。欠損なら null。 */
function ret(cs, from, to) {
  if (from < 0 || cs[from] == null || cs[to] == null || cs[from] === 0) return null;
  return cs[to] / cs[from] - 1;
}

/** 標準偏差（日次リターンの）。 */
function stdev(cs, di, win) {
  if (di < win) return null;
  const rs = [];
  for (let i = di - win + 1; i <= di; i++) {
    if (cs[i] == null || cs[i - 1] == null || cs[i - 1] === 0) continue;
    rs.push(cs[i] / cs[i - 1] - 1);
  }
  if (rs.length < win * 0.6) return null;
  const m = rs.reduce((a, b) => a + b, 0) / rs.length;
  return Math.sqrt(rs.reduce((a, b) => a + (b - m) ** 2, 0) / (rs.length - 1));
}

/**
 * 1. トレンド追随 — 12ヶ月モメンタム（直近1ヶ月を除く）
 * 直近1ヶ月を除くのは短期反転効果を避けるため。標準的な定義に従う。
 */
export const trend = {
  id: 'trend',
  name: 'トレンド追随',
  rationale: '過去の上昇が継続する（モメンタム）。直近1ヶ月は短期反転が混じるため除外する。',
  warmup: 252,
  rank(panel, di, universe) {
    return universe.map(si => {
      const cs = panel.close[si];
      return { si, score: ret(cs, di - 252, di - 21) };
    }).filter(x => x.score != null);
  },
};

/**
 * 2. 逆張り — 直近1ヶ月の下落率が大きいほど上位（短期反転）
 */
export const reversal = {
  id: 'reversal',
  name: '逆張り',
  rationale: '短期の急落は需給要因で行き過ぎることがあり、その後戻す（短期反転）。',
  warmup: 40,
  rank(panel, di, universe) {
    return universe.map(si => {
      const r = ret(panel.close[si], di - 21, di);
      return { si, score: r == null ? null : -r };   // 下落が大きいほど高スコア
    }).filter(x => x.score != null);
  },
};

/**
 * 3. 低ボラティリティ — 過去60日の変動が小さいほど上位
 */
export const lowVol = {
  id: 'lowvol',
  name: '低ボラティリティ',
  rationale: '低ボラ銘柄がリスク対比で優れるという広く報告された異常（low-volatility anomaly）。',
  warmup: 70,
  rank(panel, di, universe) {
    return universe.map(si => {
      const sd = stdev(panel.close[si], di, 60);
      return { si, score: sd == null || sd === 0 ? null : -sd };
    }).filter(x => x.score != null);
  },
};

/**
 * 4. 出来高 — 売買代金が平時より膨らんでいるほど上位
 */
export const volumeSurge = {
  id: 'volume',
  name: '出来高急増',
  rationale: '出来高の膨張は新しい情報の到来を示し、価格変化が続くことがある。',
  warmup: 70,
  rank(panel, di, universe) {
    return universe.map(si => {
      const cs = panel.close[si], vs = panel.volume[si];
      if (cs[di] == null || vs[di] == null) return { si, score: null };
      const tv = [];
      for (let i = Math.max(0, di - 59); i <= di; i++) {
        tv.push(cs[i] != null && vs[i] != null ? cs[i] * vs[i] : null);
      }
      const base = smaAt(tv.map(x => x ?? 0), tv.length - 1, Math.min(60, tv.length));
      const today = cs[di] * vs[di];
      return { si, score: base && base > 0 ? today / base : null };
    }).filter(x => x.score != null);
  },
};

/**
 * 5. 相対強度 — ユニバース平均に対する超過リターン（60日）
 * 市場全体の動きを引いた、銘柄固有の強さ。
 */
export const relStrength = {
  id: 'relstr',
  name: '相対強度',
  rationale: '市場全体の動きを除いた銘柄固有の強さが継続する。',
  warmup: 70,
  rank(panel, di, universe) {
    const rs = universe.map(si => ({ si, r: ret(panel.close[si], di - 60, di) }))
                       .filter(x => x.r != null);
    if (!rs.length) return [];
    const mkt = rs.reduce((a, b) => a + b.r, 0) / rs.length;   // 等ウェイトの市場リターン
    return rs.map(x => ({ si: x.si, score: x.r - mkt }));
  },
};

export const BASELINES = [trend, reversal, lowVol, volumeSurge, relStrength];
export const BASELINE_VERSION = 'baseline_v1';
