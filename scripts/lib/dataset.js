/**
 * キャッシュした日足データの読み込み。
 *
 * data/<market>/daily/<ticker>.json.gz を読み、日付で揃えた行列にする。
 * 保存されているのは生のOHLCVのみ。指標は使う側で lib/indicators.js を使って都度計算する。
 *
 * ★ マニフェストのハッシュを必ず検証すること。
 *   yfinance は分割が起きると過去の価格を書き換えるため、再取得すると数値が変わりうる。
 *   検証しないと「再現できていない結果を再現したと誤認する」。
 *
 * 参照: research/data-bias-registry.yaml
 */
import { readFileSync, existsSync, readdirSync } from 'fs';
import { gunzipSync } from 'zlib';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const T = 0, O = 1, H = 2, L = 3, C = 4, V = 5, ADJC = 6;

export function manifestPath(market = 'jp') { return join(ROOT, 'data', market, 'manifest.json'); }
export function loadManifest(market = 'jp') { return JSON.parse(readFileSync(manifestPath(market), 'utf8')); }

// ハッシュは【ファイルの実バイト列】を対象にする。
// オブジェクトを各言語で直列化してハッシュすると、同じデータでも不一致になる
// （Python は 1440.0、JS は 1440 と書き出すため。実測で判明）。
const sha256Bytes = buf => createHash('sha256').update(buf).digest('hex');

/** 1銘柄を読む。verify=true ならマニフェストのハッシュと照合する。 */
export function loadSymbol(ticker, { market = 'jp', verify = true, manifest = null } = {}) {
  const p = join(ROOT, 'data', market, 'daily', `${ticker}.json.gz`);
  if (!existsSync(p)) return null;
  const raw = gunzipSync(readFileSync(p));
  if (verify) {
    const man = manifest || loadManifest(market);
    const rec = man.symbols[ticker];
    if (!rec) throw new Error(`${ticker}: マニフェストに未登録`);
    if (sha256Bytes(raw) !== rec.sha256) {
      throw new Error(`${ticker}: ハッシュ不一致。データが書き換わっている（yfinanceの分割遡及の可能性）`);
    }
  }
  return JSON.parse(raw.toString('utf8'));
}

/**
 * 全銘柄を読み、日付で揃えた行列を返す。
 *   dates    : ソート済みの日付（YYYY-MM-DD）
 *   tickers  : 銘柄配列
 *   close/open/high/low/volume : [銘柄][日付] の二次元配列（欠損は null）
 * from/to で期間を絞れる。
 */
export function loadPanel({ market = 'jp', from = null, to = null, tickers = null, verify = true,
                            dropIncompleteTail = true, minCoverage = 0.5 } = {}) {
  const man = loadManifest(market);
  const list = tickers || Object.keys(man.symbols);
  const ymd = t => new Date(t * 1000).toISOString().slice(0, 10);

  const perSym = [];
  const dateSet = new Set();
  for (const tk of list) {
    const d = loadSymbol(tk, { market, verify, manifest: man });
    if (!d) continue;
    const m = new Map();
    for (const b of d.bars) {
      const day = ymd(b[T]);
      if (from && day < from) continue;
      if (to && day > to) continue;
      m.set(day, b);
      dateSet.add(day);
    }
    if (m.size) perSym.push({ ticker: tk, name: d.name, code: d.code, byDate: m });
  }

  let dates = [...dateSet].sort();

  // 取得を取引時間中に走らせると、最終日は一部の銘柄しかバーが無い（未確定）。
  // 実測: 2026-08-13 は 1,187銘柄中1銘柄しか終値が無かった。
  // カバー率が極端に低い末尾の日付は、断面を歪めるので落とす。
  if (dropIncompleteTail && dates.length > 1) {
    const coverage = d => perSym.reduce((n, s) => n + (s.byDate.has(d) ? 1 : 0), 0);
    const med = coverage(dates[Math.floor(dates.length / 2)]);
    while (dates.length > 1 && coverage(dates[dates.length - 1]) < med * minCoverage) {
      dates.pop();
    }
  }

  const dateIx = new Map(dates.map((d, i) => [d, i]));
  const n = perSym.length, T_ = dates.length;
  const mk = () => Array.from({ length: n }, () => new Array(T_).fill(null));
  const close = mk(), open = mk(), high = mk(), low = mk(), volume = mk();

  perSym.forEach((s, si) => {
    for (const [day, b] of s.byDate) {
      const di = dateIx.get(day);
      if (di === undefined) continue;   // 落とした末尾の日付
      open[si][di] = b[O]; high[si][di] = b[H]; low[si][di] = b[L];
      close[si][di] = b[C]; volume[si][di] = b[V];
    }
  });

  return {
    market, dates, dateIx,
    tickers: perSym.map(s => s.ticker),
    names: perSym.map(s => s.name),
    close, open, high, low, volume,
    manifestHash: man.manifest_sha256,
    datasetId: man.dataset_id,
  };
}

/**
 * データ品質ゲート — 物理的にあり得ない変動を含む銘柄を除外する。
 *
 * 日本株には値幅制限（制限値幅）があるため、1日で数百%動くことは起こらない。
 * そうした値は未調整の分割か配信エラーであり、放置すると架空の利益を生む。
 *
 * 実測（2016-2023・1,145銘柄）:
 *   8303.T  2,798 → 55,319,998,464  (+1,977,126,364%)  ← 明白な破損
 *   1326.T  117 → 13,190            (+11,140%)
 *   7564.T  286 → 3,610             (+1,161%)
 * これを除外しないと、低ボラ戦略が CAGR 531% という架空の成績を出した。
 *
 * 閾値は保守的に置く。値がさの低い銘柄は値幅制限が相対的に緩く、
 * +90%程度の正当な変動がありうるため（例: 28円→54円は制限内）。
 */
export function findCorruptSymbols(panel, { maxDailyMove = 1.5 } = {}) {
  const bad = new Map();
  for (let si = 0; si < panel.tickers.length; si++) {
    const cs = panel.close[si];
    for (let di = 1; di < cs.length; di++) {
      if (cs[di] == null || cs[di - 1] == null || cs[di - 1] === 0) continue;
      const r = cs[di] / cs[di - 1] - 1;
      if (Math.abs(r) > maxDailyMove) {
        if (!bad.has(si)) bad.set(si, []);
        bad.get(si).push({ date: panel.dates[di], prev: cs[di - 1], cur: cs[di], ret: r });
      }
    }
  }
  return bad;
}

/** 破損銘柄を除いたパネルを返す。除外した銘柄は excluded に記録する。 */
export function dropCorrupt(panel, opts = {}) {
  const bad = findCorruptSymbols(panel, opts);
  if (!bad.size) return { ...panel, excluded: [] };
  const keep = panel.tickers.map((_, si) => !bad.has(si));
  const pick = arr => arr.filter((_, si) => keep[si]);
  return {
    ...panel,
    tickers: pick(panel.tickers), names: pick(panel.names),
    close: pick(panel.close), open: pick(panel.open),
    high: pick(panel.high), low: pick(panel.low), volume: pick(panel.volume),
    excluded: [...bad.entries()].map(([si, evs]) => ({
      ticker: panel.tickers[si], name: panel.names[si], events: evs,
    })),
  };
}

/** 売買代金（終値×出来高）の20日平均。ユニバース判定に使う。 */
export function tradedValueMA(panel, window = 20) {
  const { close, volume } = panel;
  return close.map((cs, si) => {
    const vs = volume[si];
    const out = new Array(cs.length).fill(null);
    let sum = 0, cnt = 0;
    const buf = [];
    for (let i = 0; i < cs.length; i++) {
      const tv = (cs[i] != null && vs[i] != null) ? cs[i] * vs[i] : null;
      buf.push(tv);
      if (tv != null) { sum += tv; cnt++; }
      if (buf.length > window) {
        const old = buf.shift();
        if (old != null) { sum -= old; cnt--; }
      }
      out[i] = cnt >= Math.ceil(window * 0.6) ? sum / cnt : null;
    }
    return out;
  });
}

/**
 * 各日付のユニバース（契約 §1）: 20日平均売買代金が閾値以上の銘柄インデックス。
 * 契約の流動性条件がそのままユニバース定義を兼ねる。
 */
export function universeByDate(panel, { minTradedValue = 10e8, window = 20 } = {}) {
  const tv = tradedValueMA(panel, window);
  return panel.dates.map((_, di) => {
    const ix = [];
    for (let si = 0; si < panel.tickers.length; si++) {
      if (tv[si][di] != null && tv[si][di] >= minTradedValue && panel.close[si][di] != null) ix.push(si);
    }
    return ix;
  });
}
