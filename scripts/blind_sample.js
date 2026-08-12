/**
 * 盲検サンプル生成 — AI視覚判断実験の1サンプルを作る。
 *
 * スクリプトが銘柄と日付をランダムに選び、
 *   - 判定者(AI)には「匿名化されたチャート画像」だけを渡す
 *   - 正解(その後N日のリターン)は別ファイルに隠して保存する
 * ことで、判定者が答えを知らない状態を作る。
 *
 * 匿名化の内容:
 *   - 凡例(銘柄名・ティッカー・指標値)をCSSで非表示
 *   - 価格軸(右端)と時間軸(下)をクリップ範囲から除外 → 価格水準と年月が写らない
 *   - サイドバー(実際の現在値・ニュース)は元々クリップ範囲外
 *
 * リーク対策: サンプル日はアシスタントの知識カットオフ(2026-01)以降のみ。
 *
 * Usage:
 *   node scripts/blind_sample.js            # 1サンプル生成
 *   node scripts/blind_sample.js --reveal   # 直近サンプルの正解を表示
 */
import { evaluate, evaluateAsync, getClient, disconnect } from '../src/connection.js';
import * as replay from '../src/core/replay.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');
const OUT_DIR = join(ROOT, 'experiments');
const ANSWER_FILE = join(OUT_DIR, 'answers.jsonl');
const PENDING_FILE = join(OUT_DIR, 'pending.json');

const CLEAN_FROM = '2026-02-01';   // 知識カットオフ以降のみ
const HORIZON = 20;                // 何営業日先の結果を測るか
const LOOKBACK_DAYS = 200;         // 表示する過去の長さ(暦日)
const CHART = 'window.TradingViewApi._activeChartWidgetWV.value()';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- reveal mode ----------
if (process.argv.includes('--reveal')) {
  if (!existsSync(PENDING_FILE)) { console.error('保留中のサンプルがありません'); process.exit(1); }
  const p = JSON.parse(readFileSync(PENDING_FILE, 'utf8'));
  console.log('\n=== 正解 ===');
  console.log(`サンプルID : ${p.id}`);
  console.log(`銘柄       : ${p.code} ${p.name}`);
  console.log(`判断時点   : ${p.date}  (終値 ${p.close.toLocaleString()}円)`);
  console.log(`${HORIZON}営業日後 : ${p.futureDate}  (終値 ${p.futureClose.toLocaleString()}円)`);
  console.log(`結果       : ${p.ret >= 0 ? '+' : ''}${p.ret.toFixed(2)}%   → ${p.label}`);
  console.log(`最大上昇/下落(期間中): +${p.maxUp.toFixed(2)}% / ${p.maxDown.toFixed(2)}%\n`);
  process.exit(0);
}

// ---------- helpers ----------
async function setSymbol(sym) {
  await evaluateAsync(`(function(){var c=${CHART};return new Promise(function(r){c.setSymbol(${JSON.stringify(sym)},{});setTimeout(r,400);});})()`);
}
async function setResolution(res) { await evaluate(`(function(){${CHART}.setResolution(${JSON.stringify(res)},{});})()`); }
async function readBars(limit) {
  return evaluate(`
    (function(){
      var s=${CHART}._chartWidget.model().mainSeries(); var b=s.bars();
      if(!b||typeof b.lastIndex!=='function') return null;
      var out=[]; var e=b.lastIndex(); var st=Math.max(b.firstIndex(), e-${limit}+1);
      for(var i=st;i<=e;i++){var v=b.valueAt(i); if(v) out.push([v[0],v[2],v[3],v[4]]);}
      return {bars:out};
    })()`);
}
async function waitBars(limit, prevClose) {
  let last=-1, lc=null, stable=0;
  for (let i=0;i<30;i++) {
    await sleep(450);
    const d = await readBars(limit).catch(()=>null);
    const n = d?.bars?.length||0; const c = n ? d.bars[n-1][3] : null;
    const changed = prevClose==null || c!==prevClose;
    if (n>60 && n===last && c===lc && changed) { if (++stable>=2) return d; } else stable=0;
    last=n; lc=c;
  }
  return readBars(limit);
}
const ymd = t => new Date(t*1000).toISOString().slice(0,10);

// 凡例を隠す / 戻す
const HIDE_CSS_ID = 'blind-sample-hide';
async function hideLegend() {
  await evaluate(`
    (function(){
      var s = document.getElementById('${HIDE_CSS_ID}');
      if (!s) { s = document.createElement('style'); s.id='${HIDE_CSS_ID}'; document.head.appendChild(s); }
      s.textContent = '[class*="legend"]{visibility:hidden !important;}';
      return true;
    })()`);
}
async function showLegend() {
  await evaluate(`(function(){var s=document.getElementById('${HIDE_CSS_ID}'); if(s) s.remove(); return true;})()`);
}
// Replay Trading パネルを閉じてチャート高さを確保。
// リプレイ開始で .chart-widget は 687px → 276px に縮むため、これを戻さないと
// AIの視覚判断に耐える画像にならない。TradingView内部APIで確実に閉じる。
async function closeReplayPanel() {
  return evaluate(`
    (function(){
      var b = window.TradingView && window.TradingView.bottomWidgetBar;
      if (!b) return false;
      try { if (typeof b.close === 'function') b.close(); } catch(e){}
      try { if (typeof b.hide === 'function') b.hide(); } catch(e){}
      return true;
    })()`).catch(()=>false);
}
// チャートの高さが戻るまで待つ（縮んだままだと画像が使い物にならない）
async function waitChartHeight(minH = 450) {
  for (let i = 0; i < 16; i++) {
    const h = await evaluate(`
      (function(){var e=document.querySelector('.chart-widget');
       return e ? Math.round(e.getBoundingClientRect().height) : 0;})()`).catch(()=>0);
    if (h >= minH) return h;
    await sleep(400);
  }
  return evaluate(`
    (function(){var e=document.querySelector('.chart-widget');
     return e ? Math.round(e.getBoundingClientRect().height) : 0;})()`).catch(()=>0);
}
// 「Continue your last replay?」等のダイアログを閉じる（新規セッションを選ぶ）
async function dismissDialogs() {
  return evaluate(`
    (function(){
      var acted = false;
      var btns = document.querySelectorAll('button');
      for (var i=0;i<btns.length;i++){
        var t = (btns[i].innerText||'').trim();
        if (t === 'Start new' || t === '新規作成') { btns[i].click(); acted = true; break; }
      }
      if (!acted) {
        var closers = document.querySelectorAll('[data-name="close"],button[aria-label="Close"]');
        for (var j=0;j<closers.length;j++){
          var r = closers[j].getBoundingClientRect();
          if (r.width>0 && r.height>0) { closers[j].click(); acted = true; break; }
        }
      }
      return acted;
    })()`).catch(()=>false);
}
// リプレイが本当にその日付に到達したかを検証（違う日付を判断したら実験が壊れる）
async function verifyReplayDate(expectedYmd) {
  for (let i = 0; i < 12; i++) {
    await sleep(500);
    const d = await readBars(3).catch(()=>null);
    const b = d?.bars || [];
    if (b.length) {
      const lastYmd = ymd(b[b.length-1][0]);
      if (lastYmd === expectedYmd) return { ok: true, lastYmd };
      // 日付がずれている場合、最終バーが期待日を超えていたら失敗
      if (lastYmd > expectedYmd) return { ok: false, lastYmd };
    }
  }
  const d = await readBars(3).catch(()=>null);
  const b = d?.bars || [];
  return { ok: false, lastYmd: b.length ? ymd(b[b.length-1][0]) : null };
}
// チャート描画領域(価格ペイン＋サブペイン、軸を除く)の座標
// RIGHT_INSET: 右端に描かれる「最終値＋ティッカー」ラベル(例: 6857)を確実に切り落とす
const RIGHT_INSET = 90;
// クリップは .chart-widget を基準にする。
// 注意: リプレイ中は canvas と .chart-gui-wrapper の getBoundingClientRect() が
// 古い値のまま更新されず、これらを使うとツールバーやパネルまで写り込む。
// .chart-widget だけが現在のレイアウトを正しく返す（実測で確認）。
const BOTTOM_INSET = 32;   // 時間軸（年月）を切り落とす
async function chartClip() {
  return evaluate(`
    (function(){
      var w = document.querySelector('.chart-widget');
      if (!w) return null;
      var b = w.getBoundingClientRect();
      var pa = document.querySelector('.price-axis');
      var paw = pa ? Math.round(pa.getBoundingClientRect().width) : 60;
      return {x:Math.round(b.x), y:Math.round(b.y),
              width:Math.round(b.width) - paw - ${RIGHT_INSET},
              height:Math.round(b.height) - ${BOTTOM_INSET}};
    })()`);
}
async function captureClipped(path, clip) {
  const client = await getClient();
  const { data } = await client.Page.captureScreenshot({
    format: 'png',
    clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 2 },
    captureBeyondViewport: false,
  });
  writeFileSync(path, Buffer.from(data, 'base64'));
}

// ---------- main ----------
async function main() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const wl = JSON.parse(readFileSync(join(__dir, 'watchlist.json'), 'utf8'));
  const universe = [];
  for (const [theme, arr] of Object.entries(wl)) {
    if (theme.startsWith('_')) continue;
    for (const [code, name] of arr) universe.push({ code, name, theme });
  }

  await setResolution('D');
  let prev = null;
  try { const d = await readBars(3); const b = d?.bars||[]; prev = b.length ? b[b.length-1][3] : null; } catch {}

  // ランダムに銘柄を選び、条件を満たすまで試す
  let pick = null;
  for (let attempt = 0; attempt < 6 && !pick; attempt++) {
    const u = universe[Math.floor(Math.random() * universe.length)];
    await setSymbol(`TSE:${u.code}`);
    const d = await waitBars(400, prev);
    const bars = (d?.bars || []).filter(b => b && Number.isFinite(b[3]));
    if (bars.length < 120) continue;
    prev = bars[bars.length-1][3];
    // クリーン期間内で、HORIZON営業日先まで存在するバーを候補に
    const cands = [];
    for (let i = 0; i < bars.length - HORIZON; i++) {
      if (ymd(bars[i][0]) >= CLEAN_FROM) cands.push(i);
    }
    if (!cands.length) continue;
    const i = cands[Math.floor(Math.random() * cands.length)];
    const fut = bars.slice(i+1, i+1+HORIZON);
    const ret = (bars[i+HORIZON][3] / bars[i][3] - 1) * 100;
    const maxUp = (Math.max(...fut.map(b=>b[1])) / bars[i][3] - 1) * 100;
    const maxDown = (Math.min(...fut.map(b=>b[2])) / bars[i][3] - 1) * 100;
    pick = {
      id: `S${Date.now().toString(36).toUpperCase()}`,
      code: u.code, name: u.name, theme: u.theme,
      date: ymd(bars[i][0]), close: bars[i][3],
      // replay.selectDate(D) は「D より前」のバーまでを表示するため、
      // 判断時点 bars[i] を最終バーにするには翌営業日を指定する
      replayDate: ymd(bars[i+1][0]),
      futureDate: ymd(bars[i+HORIZON][0]), futureClose: bars[i+HORIZON][3],
      ret, maxUp, maxDown,
      label: ret >= 3 ? '上昇' : ret <= -3 ? '下落' : '横ばい',
      horizon: HORIZON,
    };
  }
  if (!pick) { console.error('サンプル生成に失敗しました'); await disconnect(); process.exit(1); }

  // 既存のリプレイセッションを一旦クリアしてからやり直す（"Continue your last replay?" 対策）
  await replay.stop().catch(()=>{});
  await sleep(600);
  await dismissDialogs();

  // リプレイで未来を隠す
  await replay.start({ date: pick.replayDate });
  await sleep(1000);
  await dismissDialogs();      // 開始直後に出るダイアログを閉じる
  await sleep(600);
  await closeReplayPanel();
  const chartH = await waitChartHeight(450);
  if (chartH < 450) {
    console.error(`チャート高さが不足: ${chartH}px（Replay Tradingパネルを閉じられていない）`);
    await showLegend().catch(()=>{});
    await replay.stop().catch(()=>{});
    await disconnect();
    process.exit(1);
  }

  // リプレイが本当にその日付に到達したか検証
  const v = await verifyReplayDate(pick.date);
  if (!v.ok) {
    console.error(`リプレイ日付の検証に失敗: 期待 ${pick.date} / 実際 ${v.lastYmd}`);
    await showLegend().catch(()=>{});
    await replay.stop().catch(()=>{});
    await disconnect();
    process.exit(1);
  }

  // 表示範囲: 判断時点までの LOOKBACK_DAYS
  const toTs = Math.floor(new Date(pick.date + 'T00:00:00Z').getTime() / 1000);
  const fromTs = toTs - LOOKBACK_DAYS * 86400;
  await evaluate(`(function(){${CHART}.setVisibleRange({from:${fromTs},to:${toTs}});})()`).catch(()=>{});
  await sleep(1200);

  // 匿名化して撮影
  await hideLegend();
  await sleep(400);
  const clip = await chartClip();
  if (!clip || clip.width < 200 || clip.height < 200) {
    console.error(`チャート領域が不正: ${JSON.stringify(clip)}`);
    await showLegend(); await replay.stop().catch(()=>{}); await disconnect(); process.exit(1);
  }
  const imgPath = join(OUT_DIR, `${pick.id}.png`);
  await captureClipped(imgPath, clip);
  await showLegend();

  // 後始末
  await replay.stop().catch(()=>{});
  await sleep(500);

  // 正解を隠して保存
  writeFileSync(PENDING_FILE, JSON.stringify(pick, null, 2));
  writeFileSync(ANSWER_FILE, readFileSync(ANSWER_FILE, 'utf8').concat(JSON.stringify(pick) + '\n'), 'utf8');

  // 判定者に渡すのは画像パスとIDだけ
  console.log(`\nサンプルID: ${pick.id}`);
  console.log(`画像: ${imgPath}`);
  console.log(`設問: このチャートの${HORIZON}営業日後を予想してください（上昇 +3%以上 / 横ばい / 下落 -3%以下）`);
  console.log(`\n正解の確認: node scripts/blind_sample.js --reveal\n`);
  await disconnect();
}

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
if (!existsSync(ANSWER_FILE)) writeFileSync(ANSWER_FILE, '');
main().catch(e => { console.error(e); process.exit(1); });
