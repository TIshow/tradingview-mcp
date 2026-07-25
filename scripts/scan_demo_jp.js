/**
 * 録画用（SNS向け）ライブスキャン・デモ — 日本株版。
 *
 * 裏で全銘柄のデータを先読み・計算しておき、ENTER後に「一定テンポで」チャートを
 * 切り替えながらレトロ端末ダッシュボードを再生 → 最後に TOP5 を発表する。
 * データ待ちのカクつきが録画に入らないのがポイント。指標はすべて生バーから自前計算。
 *
 * 使い方（録画時）:
 *   1) TradingView と このターミナルを画面に並べる（縦動画ならTV上・端末下）
 *   2) node scripts/scan_demo_jp.js        ← 裏で準備し「ENTERで開始」で一時停止
 *   3) 画面録画を開始（Mac: ⌘+Shift+5）してから ENTER
 *   4) スキャン→TOP5が流れる。終わったら録画停止
 *   テンポ調整: node scripts/scan_demo_jp.js 1800   (ms/銘柄, 既定1400)
 */
import { evaluate, evaluateAsync, disconnect } from '../src/connection.js';

const SYMBOLS = [
  ['8035','東京エレクトロン'], ['6920','レーザーテック'], ['6146','ディスコ'],
  ['6857','アドバンテスト'], ['9984','ソフトバンクG'],
  ['8306','三菱UFJ'], ['8316','三井住友FG'], ['8766','東京海上HD'],
  ['5401','日本製鉄'], ['9101','日本郵船'],
];
const BENCH = 'TVC:NI225';
const BARS = 260;
const PACE = Number(process.argv[2] || 1400);   // ms/銘柄（再生テンポ）
const BEAT = 750;                               // チャート描画待ち
const CHART = 'window.TradingViewApi._activeChartWidgetWV.value()';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const C = {
  reset:'\x1b[0m', bold:'\x1b[1m', dim:'\x1b[2m',
  green:'\x1b[38;2;120;210;120m', red:'\x1b[38;2;235;95;95m', amber:'\x1b[38;2;235;175;70m',
  gray:'\x1b[38;2;150;155;150m', cyan:'\x1b[38;2;80;210;200m', ink:'\x1b[38;2;225;222;212m',
};

async function setResolution(res){ await evaluate(`(function(){${CHART}.setResolution(${JSON.stringify(res)},{});})()`); }
async function setSymbol(sym){ await evaluateAsync(`(function(){var c=${CHART};return new Promise(function(r){c.setSymbol(${JSON.stringify(sym)},{});setTimeout(r,350);});})()`); }
async function readBars(limit){
  return evaluate(`(function(){var s=${CHART}._chartWidget.model().mainSeries();var b=s.bars();
    if(!b||typeof b.lastIndex!=='function')return null;var o=[];var e=b.lastIndex();var st=Math.max(b.firstIndex(),e-${limit}+1);
    for(var i=st;i<=e;i++){var v=b.valueAt(i);if(v)o.push([v[0],v[1],v[2],v[3],v[4],v[5]]);}return {bars:o};})()`);
}
async function waitBars(limit, prevClose){
  let last=-1,lc=null,st=0;
  for(let i=0;i<30;i++){ await sleep(450);
    const d=await readBars(limit).catch(()=>null); const n=d?.bars?.length||0; const c=n?d.bars[n-1][4]:null;
    const changed = prevClose==null||c!==prevClose;
    if(n>60&&n===last&&c===lc&&changed){ if(++st>=2) return d; } else st=0;
    last=n; lc=c;
  }
  return readBars(limit);
}

const smaAt=(a,i,w)=>{ if(i<w-1)return null; let s=0; for(let j=i-w+1;j<=i;j++)s+=a[j]; return s/w; };
function rsiW(c,p=14){ const o=new Array(c.length).fill(null); let ag=0,al=0; for(let i=1;i<c.length;i++){const ch=c[i]-c[i-1],g=Math.max(ch,0),l=Math.max(-ch,0); if(i<=p){ag+=g;al+=l; if(i===p){ag/=p;al/=p;o[i]=al===0?100:100-100/(1+ag/al);}} else {ag=(ag*(p-1)+g)/p;al=(al*(p-1)+l)/p;o[i]=al===0?100:100-100/(1+ag/al);}} return o; }

function analyze(bars, benchMap){
  const B=bars.filter(x=>x&&Number.isFinite(x[4])); const n=B.length; if(n<80) return null;
  const t=B.map(x=>x[0]),h=B.map(x=>x[2]),l=B.map(x=>x[3]),c=B.map(x=>x[4]),v=B.map(x=>Number.isFinite(x[5])?x[5]:0),o=B.map(x=>x[1]);
  const i=n-1, close=c[i], prev=c[i-1];
  const chg1d=(close/prev-1)*100, gap=(o[i]-prev)/prev*100;
  const avgVol20=smaAt(v,i-1,20)||smaAt(v,i,20)||0; const volR=avgVol20?v[i]/avgVol20:0;
  const rsi=rsiW(c,14), rNow=rsi[i], r5=rsi[i-5];
  const hi52=Math.max(...h.slice(Math.max(0,n-250))), lo52=Math.min(...l.slice(Math.max(0,n-250)));
  const distHi52=(close/hi52-1)*100;
  let rsRatio=null;
  if(benchMap){ const rs=[]; for(let k=0;k<n;k++){const bc=benchMap.get(t[k]); if(bc)rs.push(c[k]/bc);}
    if(rs.length>55){ const s=smaAt(rs,rs.length-1,50); if(s) rsRatio=100*rs[rs.length-1]/s; } }
  const tags=[]; let score=0,bull=0,bear=0;
  const add=(p,lab,d)=>{score+=p;tags.push(lab);if(d>0)bull+=p;if(d<0)bear+=p;};
  if(volR>=2) add(Math.min(volR,6)*4,`出来高急増${volR.toFixed(1)}x`,0);
  if(h[i]>=hi52) add(18,'新高値(52週)',1); else if(distHi52>=-3) add(8,`高値接近${distHi52.toFixed(1)}%`,1);
  if(l[i]<=lo52) add(16,'新安値(52週)',-1);
  if(Math.abs(gap)>=3) add(Math.min(Math.abs(gap),10)*1.4,`窓${gap>0?'+':''}${gap.toFixed(1)}%`,gap>0?1:-1);
  if(rNow!=null){ if(rNow<35&&r5!=null&&rNow>r5) add(12,`売られすぎ反転RSI${rNow.toFixed(0)}`,1); if(rNow>75) add(8,`過熱RSI${rNow.toFixed(0)}`,0); }
  if(Math.abs(chg1d)>=5) add(Math.min(Math.abs(chg1d),15),`大幅変動${chg1d>0?'+':''}${chg1d.toFixed(1)}%`,chg1d>0?1:-1);
  if(rsRatio!=null){ if(rsRatio>=108) add(10,`独歩高R${rsRatio.toFixed(0)}`,1); else if(rsRatio<=92) add(8,`独歩安R${rsRatio.toFixed(0)}`,-1); }
  const bias= bull>bear*1.3?'強気':bear>bull*1.3?'弱気':'中立';
  return { close:Math.round(close), chg1d, volR:+volR.toFixed(1), rsi:rNow==null?null:Math.round(rNow), score:+score.toFixed(0), bias, tags };
}

const vlen=s=>{let w=0;for(const ch of String(s))w+=ch.charCodeAt(0)>0x2e80?2:1;return w;};
const pad=(s,n)=>String(s)+' '.repeat(Math.max(0,n-vlen(s)));
const padL=(s,n)=>{s=String(s);const w=vlen(s);return w>=n?s:' '.repeat(n-w)+s;};
const gauge=sc=>{const cells=12,f=Math.max(0,Math.min(cells,Math.round(Math.min(sc,60)/60*cells)));return '█'.repeat(f)+C.dim+'░'.repeat(cells-f)+C.reset;};
const biasCol=b=>b==='強気'?C.green:b==='弱気'?C.red:C.gray;
const biasMark=b=>b==='強気'?'▲':b==='弱気'?'▼':'●';

async function collect(){
  await setResolution('D');
  let prev=null; try{const d=await readBars(3);const b=d?.bars||[];prev=b.length?b[b.length-1][4]:null;}catch{}
  process.stderr.write('準備中: ベンチ日経225 ');
  await setSymbol(BENCH); const bd=await waitBars(BARS,prev).catch(()=>null);
  let benchMap=null; if(bd?.bars?.length>60){benchMap=new Map(bd.bars.map(x=>[x[0],x[4]]));prev=bd.bars.at(-1)[4];process.stderr.write('✓\n');}else process.stderr.write('×\n');
  const rows=[];
  for(const [code,name] of SYMBOLS){
    process.stderr.write(`準備中: ${code} ${name} `);
    await setSymbol(`TSE:${code}`); const d=await waitBars(BARS,prev).catch(()=>null);
    const a=d?.bars?.length?analyze(d.bars,benchMap):null;
    if(a){prev=a.close; rows.push({code,name,...a}); process.stderr.write(`✓ score${a.score}\n`);} else process.stderr.write('skip\n');
  }
  return rows;
}

async function gate(){
  if(!process.stdin.isTTY) return;
  process.stdout.write('\n'+C.bold+C.cyan+'  ▶ 画面録画を開始してから ENTER を押してください…'+C.reset+'\n');
  await new Promise(res=>{ try{process.stdin.setRawMode(true);}catch{} process.stdin.resume();
    process.stdin.once('data',()=>{ try{process.stdin.setRawMode(false);}catch{} process.stdin.pause(); res(); }); });
}

async function replay(rows){
  process.stdout.write('\x1b[2J\x1b[H');
  process.stdout.write('\n'+C.bold+C.cyan+'  ▓▓  AI SCAN · 今日の面白いチャート  ▓▓'+C.reset+'\n');
  process.stdout.write(C.dim+`  ${rows.length}銘柄を1つずつ、生バーからRSI・出来高・相対強度を計算（対 日経225）`+C.reset+'\n\n');
  await sleep(900);
  for(const r of rows){
    await setSymbol(`TSE:${r.code}`); await sleep(BEAT);
    const col=biasCol(r.bias);
    process.stdout.write('  '+C.green+'▶'+C.reset+' '+C.bold+pad(`${r.code} ${r.name}`,20)+C.reset+
      ' '+col+gauge(r.score)+' '+padL(r.score,3)+C.reset+
      '  '+col+biasMark(r.bias)+C.reset+' '+C.gray+padL(r.rsi??'-',3)+C.reset+' '+C.gray+padL(r.volR+'x',6)+C.reset+
      '  '+C.dim+(r.tags.slice(0,2).join(' · ')||'—')+C.reset+'\n');
    await sleep(PACE);
  }
  await sleep(600);
  const top=[...rows].sort((a,b)=>b.score-a.score).slice(0,5);
  process.stdout.write('\n'+C.bold+C.ink+'  ┌─ 今日の面白いチャート TOP5 ───────────────'+C.reset+'\n');
  for(let k=0;k<top.length;k++){ const r=top[k],col=biasCol(r.bias);
    process.stdout.write('  '+C.bold+C.amber+padL(k+1,2)+C.reset+' '+C.bold+pad(`${r.code} ${r.name}`,20)+C.reset+
      ' '+col+gauge(r.score)+' '+padL(r.score,3)+C.reset+'  '+col+biasMark(r.bias)+' '+r.bias+C.reset+
      '  '+C.dim+(r.tags.slice(0,3).join(' · ')||'—')+C.reset+'\n');
    await sleep(700);
  }
  process.stdout.write(C.bold+C.ink+'  └────────────────────────────────────────────'+C.reset+'\n');
  process.stdout.write(C.dim+'\n  ※教育・分析目的のプロセス実演。投資助言ではありません／データは遅延（日足）。\n'+C.reset);
}

async function main(){
  const rows=await collect();
  if(!rows.length){ console.error('データ取得に失敗'); process.exit(1); }
  await gate();
  await replay(rows);
  await setSymbol('TSE:6857'); await setResolution('D');
  await disconnect();
}
main().catch(e=>{console.error(e);process.exit(1);});
