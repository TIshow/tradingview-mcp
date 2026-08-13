/**
 * TradingView チャート読み取りの共通処理。
 *
 * 各スクリプトに同じコードが8箇所コピーされていたため集約した。
 * とくに waitBars の stale 対策ゲートは、欠けていると静かに誤ったデータを返す。
 * 一箇所に置くことで、以後どのスクリプトからも同じ保護が効く。
 *
 * バー形式は配列 [time, open, high, low, close, volume] に統一する。
 * 参照: docs/tooling-notes.md
 */
import { evaluate, evaluateAsync } from '../../src/connection.js';

export const CHART = 'window.TradingViewApi._activeChartWidgetWV.value()';
export const sleep = ms => new Promise(r => setTimeout(r, ms));

// バー配列のインデックス
export const T = 0, O = 1, H = 2, L = 3, C = 4, V = 5;

export async function setSymbol(sym) {
  await evaluateAsync(
    `(function(){var c=${CHART};return new Promise(function(r){` +
    `c.setSymbol(${JSON.stringify(sym)},{});setTimeout(r,400);});})()`
  );
}

export async function setResolution(res) {
  await evaluate(`(function(){${CHART}.setResolution(${JSON.stringify(res)},{});})()`);
}

/** 生バーを取得する。{bars: [[t,o,h,l,c,v],...], sym} を返す。 */
export async function readBars(limit) {
  return evaluate(`
    (function(){
      var s = ${CHART}._chartWidget.model().mainSeries();
      var b = s.bars();
      if(!b || typeof b.lastIndex !== 'function') return null;
      var out = []; var end = b.lastIndex();
      var st = Math.max(b.firstIndex(), end - ${limit} + 1);
      for (var i = st; i <= end; i++) { var v = b.valueAt(i); if (v) out.push([v[0],v[1],v[2],v[3],v[4],v[5]]); }
      var sym = ''; try { sym = s.symbolInfo() ? (s.symbolInfo().full_name || s.symbolInfo().name || '') : ''; } catch(e) {}
      return { bars: out, sym: sym };
    })()`);
}

/**
 * 新しい銘柄のバーが読み込まれ、安定するまで待つ。
 *
 * ★ prevClose を必ず渡すこと。
 *   setSymbol 直後は symbolInfo() だけが先に切り替わり、bars() は前の銘柄を保持する。
 *   バー数の安定だけを見ると【前の銘柄のデータ】を掴んでしまう（実際に 8035 が 6857 の
 *   データになる事故が起きた）。終値が prevClose から変化したことを確認して初めて信用する。
 */
export async function waitBars(limit, prevClose, { minBars = 60, tries = 30, interval = 450 } = {}) {
  let last = -1, lastClose = null, stable = 0;
  for (let i = 0; i < tries; i++) {
    await sleep(interval);
    const d = await readBars(limit).catch(() => null);
    const n = d?.bars?.length || 0;
    const c = n ? d.bars[n - 1][C] : null;
    const changed = prevClose == null || c !== prevClose;
    if (n > minBars && n === last && c === lastClose && changed) {
      if (++stable >= 2) return d;
    } else {
      stable = 0;
    }
    last = n; lastClose = c;
  }
  return readBars(limit); // タイムアウト時のフォールバック
}

/** チャートに現在表示されている終値。waitBars の prevClose 初期値に使う。 */
export async function currentClose() {
  try {
    const d = await readBars(3);
    const b = d?.bars || [];
    return b.length ? b[b.length - 1][C] : null;
  } catch { return null; }
}

/**
 * 複数銘柄を順に読む。stale ゲートを自動で連鎖させる。
 * cb(symbol, bars, resolvedSym, index) を各銘柄で呼ぶ。
 */
export async function forEachSymbol(symbols, { bars = 400, resolution = 'D' } = {}, cb) {
  if (resolution) await setResolution(resolution);
  let prevClose = await currentClose();
  const results = [];
  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    await setSymbol(sym);
    const d = await waitBars(bars, prevClose).catch(() => null);
    const rows = d?.bars || [];
    if (rows.length) prevClose = rows[rows.length - 1][C];
    results.push(await cb(sym, rows, d?.sym || null, i));
  }
  return results;
}

export const ymd = t => new Date(t * 1000).toISOString().slice(0, 10);
