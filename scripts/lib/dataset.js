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

/** 銘柄の属性（上場市場・業種）。ユニバース定義に使う。 */
export function loadInstrumentMeta(market = 'jp') {
  const u = JSON.parse(readFileSync(join(ROOT, 'scripts', 'data', `universe-${market}.json`), 'utf8'));
  return new Map(u.symbols.map(s => [s.ticker, s]));
}

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
 *
 * ★ 出来高0のバーは読み込まない（dropZeroVolume）。理由は下の注記を参照。
 */
export function loadPanel({ market = 'jp', from = null, to = null, tickers = null, verify = true,
                            dropIncompleteTail = true, minCoverage = 0.5,
                            dropZeroVolume = true } = {}) {
  const man = loadManifest(market);
  const list = tickers || Object.keys(man.symbols);
  const ymd = t => new Date(t * 1000).toISOString().slice(0, 10);

  const perSym = [];
  const dateSet = new Set();
  let zeroVolumeDropped = 0;
  for (const tk of list) {
    const d = loadSymbol(tk, { market, verify, manifest: man });
    if (!d) continue;
    const m = new Map();
    for (const b of d.bars) {
      const day = ymd(b[T]);
      if (from && day < from) continue;
      if (to && day > to) continue;
      // 出来高0＝約定が1株も無い＝その日の価格は存在しない。
      // yfinance はそこに値を埋めてくるが、それは市場が付けた値ではない（下の注記）。
      if (dropZeroVolume && !(b[V] > 0)) { zeroVolumeDropped++; continue; }
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
    zeroVolumeDropped,
    manifestHash: man.manifest_sha256,
    datasetId: man.dataset_id,
  };
}

/**
 * ─────────────────────────────────────────────────────────────
 * 【出来高0バーについて】 loadPanel の dropZeroVolume が主たる品質ゲート。
 *
 * yfinance は「まだ上場していない期間」「上場廃止中の期間」「市場休日」にも
 * バーを返す。価格欄は埋まっているが出来高は0で、市場が付けた値ではない。
 *
 * 実測（1,188銘柄・2,872,813本）:
 *   出来高0のバー ... 29,057本 (1.01%)。その内訳はほぼ全てが次の3種類。
 *
 *   ① 上場前の捏造バー（30銘柄）— 上場日の株価とは無関係な値で横ばいが続く
 *        7564.T ワークマン   695本を 286.25円 で埋め、初取引 2018-10-03 は 3,610円
 *        7944.T ローランド  1231本を 1,870円 で埋め、初取引 2020-12-16 は 2,920円
 *                           ↑ 全2,613本の47%が実在しないバー
 *        8919.T カチタス     484本を   312円 で埋め、初取引 2017-12-12 は   930円
 *      → 12ヶ月モメンタムは上場後1年間、+1,161% のような架空の値を返す。
 *        トレンド追随戦略はこれを最上位に買い続ける。
 *
 *   ② 上場廃止 → 再上場（8303.T ＳＢＩ新生銀行）
 *        2023-09-27 に上場廃止。最終バーが O=55,900,000,256（float32の桁化け）。
 *        2023-09-27 → 2025-11-17 の782日はバー自体が欠落。
 *        再上場（2025-12-17）の直前まで、桁化けした値のまま出来高0で並ぶ。
 *
 *   ③ 市場休日（23日）— 全銘柄が出来高0。例: 2018-01-01〜01-03（年始）。
 *      これをバーとして扱うと、休場日を営業日として数えることになる。
 *
 * 出来高0＝約定が無い＝価格が存在しない。埋めるのはデータの捏造にあたるので、
 * 「銘柄ごと落とす」のではなく【そのバーだけを無かったことにする】のが正しい。
 * 銘柄ごと落とすと、ワークマンの実在する8年分まで一緒に捨ててしまう。
 * ─────────────────────────────────────────────────────────────
 */

/**
 * 残余の品質ゲート — 出来高0を除いた【後】に、なお物理的にあり得ない変動が残る銘柄を探す。
 *
 * 日本株には値幅制限があるため、1日で数百%動くことは起こらない。
 * 出来高を伴ってそれが起きているなら、未調整の分割など別の原因があるということ。
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
 * 各日付のユニバース（契約 §1）。条件は2つ。
 *   ① 上場市場が プライム / スタンダード / グロース の【株式】であること
 *   ② 20日平均売買代金が閾値以上であること
 *
 * ①について — ETF・ETN・REIT（universe-jp.json で market="その他"、112銘柄）を外す。
 *   理由は2つあり、どちらも結果を見る前に成立する。
 *   (a) 研究課題が「株式の銘柄選択」であること。日経ダブルインバースのような
 *       レバレッジ型は構造的な減価を持つ商品で、企業の株式とは別物。
 *   (b) yfinance のデータ破損がこの層に集中している。
 *       実測（探索期間の|日次変動|40%超・22件）: ETFの4件はすべて
 *       「2営業日だけ価格が1/2または1/10になり、元に戻る」往復型の破損だった。
 *         1570.T 16,250 → 8,040（2日）→ 15,900   （OHLCも出来高も丸ごと1/2にスケール）
 *         1579.T 17,525 → 8,865（2日）→ 16,830
 *         1655.T    374 →  37.1（2日）→   379.6
 *       これは分割調整が2日だけ適用されて取り消された痕跡で、市場の値動きではない。
 *       逆張り戦略は「大きく下げた銘柄」を買うので、この往復を最優先で拾ってしまう。
 *       残り18件は任天堂のポケモンGO（+40%）など、すべて実際の値動きだった。
 *
 * ★ この除外は2026-08-14に追加した。契約凍結【前】であり、理由(a)は結果と独立に成立する。
 *   影響は research/results/ に前後の数字を残してある。
 */
export function universeByDate(panel, {
  minTradedValue = 10e8, window = 20, excludeMarkets = ['その他'], meta = null,
} = {}) {
  const tv = tradedValueMA(panel, window);
  const im = meta || loadInstrumentMeta(panel.market);
  const eligible = panel.tickers.map(tk => {
    const m = im.get(tk);
    return m ? !excludeMarkets.includes(m.market) : false;   // 属性不明は採用しない
  });
  return panel.dates.map((_, di) => {
    const ix = [];
    for (let si = 0; si < panel.tickers.length; si++) {
      if (!eligible[si]) continue;
      if (tv[si][di] != null && tv[si][di] >= minTradedValue && panel.close[si][di] != null) ix.push(si);
    }
    return ix;
  });
}

/**
 * 極端な値動きの一覧。自動で落とさず【必ず表示する】ためのもの。
 * 破損を静かに消すと、消したこと自体が見えなくなる。目視できる形で残す。
 */
export function auditExtremeMoves(panel, universeByDate, { threshold = 0.4 } = {}) {
  const inUni = new Set();
  for (const u of universeByDate) for (const si of u) inUni.add(si);
  const out = [];
  for (const si of inUni) {
    const cs = panel.close[si];
    for (let di = 1; di < cs.length; di++) {
      if (cs[di] == null || cs[di - 1] == null || cs[di - 1] === 0) continue;
      const r = cs[di] / cs[di - 1] - 1;
      if (Math.abs(r) > threshold) {
        out.push({ ticker: panel.tickers[si], name: panel.names[si], date: panel.dates[di],
                   prev: cs[di - 1], cur: cs[di], ret: r });
      }
    }
  }
  return out.sort((a, b) => a.ret - b.ret);
}
