/**
 * Bottom-up technical scanner — "AIが面白いチャートを探す".
 *
 * Reads raw daily OHLCV for every name in scripts/watchlist.json (adds NO chart
 * indicators), computes a set of "notability" signals locally, tags each fired
 * signal, scores it, and prints a ranked leaderboard of the most interesting
 * charts today. Relative strength is measured vs Nikkei 225.
 *
 * All numbers are computed from raw bars — the MCP indicator readouts are stale
 * and are NOT used. See docs/tooling-notes.md.
 *
 * Usage: node scripts/scan.js [top N=15] [--json out.json]
 */
import { evaluate, evaluateAsync, disconnect } from '../src/connection.js';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const WL = JSON.parse(readFileSync(join(__dir, 'watchlist.json'), 'utf8'));
const UNIVERSE = [];
for (const [theme, arr] of Object.entries(WL)) {
  if (theme.startsWith('_')) continue;
  for (const [code, name] of arr) UNIVERSE.push({ code, name, theme, sym: `TSE:${code}` });
}
const TOPN = Number(process.argv.find(a => /^\d+$/.test(a)) || 15);
const jsonIdx = process.argv.indexOf('--json');
const JSON_OUT = jsonIdx >= 0 ? process.argv[jsonIdx + 1] : null;
const BENCH = 'TVC:NI225';
const BARS = 260;
const CHART = 'window.TradingViewApi._activeChartWidgetWV.value()';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function setResolution(res){ await evaluate(`(function(){${CHART}.setResolution(${JSON.stringify(res)},{});})()`); }
async function setSymbol(sym){ await evaluateAsync(`(function(){var c=${CHART};return new Promise(function(r){c.setSymbol(${JSON.stringify(sym)},{});setTimeout(r,400);});})()`); }
async function readBars(limit){
  return evaluate(`
    (function(){
      var s=${CHART}._chartWidget.model().mainSeries(); var b=s.bars();
      if(!b||typeof b.lastIndex!=='function') return null;
      var out=[]; var end=b.lastIndex(); var st=Math.max(b.firstIndex(), end-${limit}+1);
      for(var i=st;i<=end;i++){var v=b.valueAt(i); if(v) out.push([v[0],v[1],v[2],v[3],v[4],v[5]]);}
      var sym=''; try{sym=s.symbolInfo()?s.symbolInfo().full_name||'':'';}catch(e){}
      return {bars:out, sym:sym};
    })()`);
}
async function waitBars(limit, prevClose){
  let last=-1,lc=null,stable=0;
  for(let i=0;i<30;i++){
    await sleep(450);
    const d=await readBars(limit).catch(()=>null);
    const n=d?.bars?.length||0; const c=n?d.bars[n-1][4]:null;
    const changed = prevClose==null || c!==prevClose;
    if(n>60 && n===last && c===lc && changed){ if(++stable>=2) return d; } else stable=0;
    last=n; lc=c;
  }
  return readBars(limit);
}

// --- indicators ---
const smaAt=(a,i,w)=>{ if(i<w-1) return null; let s=0; for(let j=i-w+1;j<=i;j++) s+=a[j]; return s/w; };
function ema(v,p){ const k=2/(p+1); const o=new Array(v.length).fill(null); let pr; for(let i=0;i<v.length;i++){ if(i<p-1) continue; if(pr===undefined){let s=0;for(let j=i-p+1;j<=i;j++)s+=v[j];pr=s/p;} else pr=v[i]*k+pr*(1-k); o[i]=pr;} return o; }
function rsiW(c,p=14){ const o=new Array(c.length).fill(null); let ag=0,al=0; for(let i=1;i<c.length;i++){const ch=c[i]-c[i-1],g=Math.max(ch,0),l=Math.max(-ch,0); if(i<=p){ag+=g;al+=l; if(i===p){ag/=p;al/=p;o[i]=al===0?100:100-100/(1+ag/al);}} else {ag=(ag*(p-1)+g)/p;al=(al*(p-1)+l)/p;o[i]=al===0?100:100-100/(1+ag/al);}} return o; }
function atrW(h,l,c,p=14){ const tr=[]; for(let i=0;i<c.length;i++){ if(i===0){tr.push(h[i]-l[i]);continue;} tr.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]))); } const o=new Array(c.length).fill(null); let a; for(let i=0;i<tr.length;i++){ if(i<p-1) continue; if(a===undefined){let s=0;for(let j=i-p+1;j<=i;j++)s+=tr[j];a=s/p;} else a=(a*(p-1)+tr[i])/p; o[i]=a; } return {atr:o,tr}; }
const maxOf=a=>Math.max(...a), minOf=a=>Math.min(...a);

function analyze(bars, benchMap){
  const B=bars.filter(x=>x&&Number.isFinite(x[4]));
  const n=B.length; if(n<80) return null;
  const t=B.map(x=>x[0]),o=B.map(x=>x[1]),h=B.map(x=>x[2]),l=B.map(x=>x[3]),c=B.map(x=>x[4]),v=B.map(x=>Number.isFinite(x[5])?x[5]:0);
  const i=n-1, close=c[i], prev=c[i-1];
  const chg1d=(close/prev-1)*100;
  const gap=(o[i]-prev)/prev*100;
  const avgVol20=smaAt(v,i-1,20)||smaAt(v,i,20)||0;  // prior 20
  const volR=avgVol20? v[i]/avgVol20 : 0;
  const rsi=rsiW(c,14), rNow=rsi[i], r5=rsi[i-5], r20=rsi[i-20];
  const e50=ema(c,50), e200=ema(c,200);
  const {atr,tr}=atrW(h,l,c,14); const atrR=atr[i]? tr[i]/atr[i] : 0;
  const hi52=maxOf(h.slice(Math.max(0,n-250))), lo52=minOf(l.slice(Math.max(0,n-250)));
  const priorHi20=maxOf(h.slice(i-20,i)), priorLo20=minOf(l.slice(i-20,i));
  const distHi52=(close/hi52-1)*100, distLo52=(close/lo52-1)*100;

  // relative strength vs benchmark
  let rsRatio=null, rsMom=null, quad=null;
  if(benchMap){
    const rs=[]; const idx=[];
    for(let k=0;k<n;k++){ const bc=benchMap.get(t[k]); if(bc){ rs.push(c[k]/bc); idx.push(k);} }
    if(rs.length>65){
      const ratio=rs.map((_,k)=>{const s=smaAt(rs,k,50);return s?100*rs[k]/s:null;});
      const mom=ratio.map((_,k)=>{if(ratio[k]==null)return null;const s=smaAt(ratio,k,10);return s?100*ratio[k]/s:null;});
      rsRatio=ratio[ratio.length-1]; rsMom=mom[mom.length-1];
      if(rsRatio!=null&&rsMom!=null) quad=rsRatio>=100?(rsMom>=100?'Leading':'Weakening'):(rsMom>=100?'Improving':'Lagging');
    }
  }

  // --- signals ---
  const tags=[]; let score=0; let bull=0, bear=0;
  const add=(pts,label,dir)=>{ score+=pts; tags.push(label); if(dir>0)bull+=pts; if(dir<0)bear+=pts; };

  if(volR>=2) add(Math.min(volR,6)*4, `出来高急増 ${volR.toFixed(1)}x`, 0);
  if(h[i]>=hi52) add(18, '新高値(52週)', 1);
  else if(distHi52>=-3) add(8, `高値接近 ${distHi52.toFixed(1)}%`, 1);
  if(l[i]<=lo52) add(16, '新安値(52週)', -1);
  if(close>priorHi20 && prev<=priorHi20) add(volR>=1.3?14:8, '上放れ(20日ブレイク)', 1);
  if(close<priorLo20 && prev>=priorLo20) add(12, '下放れ(20日割れ)', -1);
  if(Math.abs(gap)>=3) add(Math.min(Math.abs(gap),10)*1.4, `窓 ${gap>0?'+':''}${gap.toFixed(1)}%`, gap>0?1:-1);
  // MA crosses within last 10 bars
  if(e50[i]!=null&&e200[i]!=null){
    for(let k=i;k>i-10&&k>0;k--){ if(e50[k-1]==null||e200[k-1]==null) break;
      if(e50[k-1]<=e200[k-1]&&e50[k]>e200[k]){ add(14, `GC(${i-k}日前)`, 1); break; }
      if(e50[k-1]>=e200[k-1]&&e50[k]<e200[k]){ add(12, `DC(${i-k}日前)`, -1); break; } }
  }
  if(rNow!=null){
    if(rNow<35 && r5!=null && rNow>r5) add(12, `売られすぎ反転 RSI${rNow.toFixed(0)}`, 1);
    else if(rNow<30) add(8, `売られすぎ RSI${rNow.toFixed(0)}`, -1);
    if(rNow>75) add(8, `過熱 RSI${rNow.toFixed(0)}`, 0);
    // simple divergence proxy over 20 bars
    if(r20!=null){
      if(close<c[i-20] && rNow>r20 && rNow<48) add(12, '強気ダイバージェンス(候補)', 1);
      if(close>c[i-20] && rNow<r20 && rNow>52) add(8, '弱気ダイバージェンス(候補)', -1);
    }
  }
  if(atrR>=1.8) add(6, `ボラ急拡大 ${atrR.toFixed(1)}x`, 0);
  if(Math.abs(chg1d)>=5) add(Math.min(Math.abs(chg1d),15), `大幅変動 ${chg1d>0?'+':''}${chg1d.toFixed(1)}%`, chg1d>0?1:-1);
  if(rsRatio!=null){
    if(rsRatio>=108) add(10, `独歩高(対日経 R${rsRatio.toFixed(0)})`, 1);
    else if(rsRatio<=92) add(8, `独歩安(対日経 R${rsRatio.toFixed(0)})`, -1);
  }

  const bias = bull>bear*1.3 ? '強気' : bear>bull*1.3 ? '弱気' : '中立';
  return { close:Math.round(close), chg1d:+chg1d.toFixed(1), volR:+volR.toFixed(1),
    rsi:rNow==null?null:+rNow.toFixed(0), distHi52:+distHi52.toFixed(1),
    quad, rsRatio:rsRatio==null?null:+rsRatio.toFixed(1),
    score:+score.toFixed(1), bias, tags };
}

const pad=(s,n)=>{s=String(s);let w=0;for(const ch of s)w+=ch.charCodeAt(0)>0x2e80?2:1;return s+' '.repeat(Math.max(0,n-w));};
const padL=(s,n)=>{s=String(s);return s.length>=n?s:' '.repeat(n-s.length)+s;};

async function main(){
  await setResolution('D');
  let prev=null; try{const d=await readBars(3);const b=d?.bars||[];prev=b.length?b[b.length-1][4]:null;}catch{}

  process.stderr.write(`bench ${BENCH} ... `);
  await setSymbol(BENCH);
  const bd=await waitBars(BARS,prev).catch(()=>null);
  let benchMap=null;
  if(bd?.bars?.length>60){ benchMap=new Map(bd.bars.map(x=>[x[0],x[4]])); prev=bd.bars[bd.bars.length-1][4]; process.stderr.write(`ok\n`);}
  else process.stderr.write(`FAIL (相対強度なしで続行)\n`);

  const rows=[];
  for(const u of UNIVERSE){
    process.stderr.write(`  ${u.code} ${u.name} ... `);
    await setSymbol(u.sym);
    const d=await waitBars(BARS,prev).catch(()=>null);
    const a=d?.bars?.length? analyze(d.bars, benchMap): null;
    if(!a){ process.stderr.write('skip\n'); continue; }
    prev=a.close;
    rows.push({...u, ...a});
    process.stderr.write(`score ${a.score}  ${a.tags.slice(0,2).join(', ')||'—'}\n`);
  }
  await setSymbol('TSE:6857'); await setResolution('D');

  rows.sort((x,y)=>y.score-x.score);
  const top=rows.slice(0,TOPN);
  // leaderboard
  let out='\n';
  out+='━━━━ 今日の面白いチャート  '+ (new Date(bd?.bars?.at(-1)?.[0]*1000||Date.now()).toISOString().slice(0,10)) +'  （対日経225・日足）━━━━\n\n';
  out+='  # '+pad('銘柄',18)+pad('テーマ',14)+padL('スコア',6)+'  傾向  '+padL('RSI',4)+padL('出来高',7)+'  シグナル\n';
  top.forEach((r,k)=>{
    out+='  '+padL(k+1,2)+' '+pad(`${r.code} ${r.name}`,18)+pad(r.theme,14)+padL(r.score,6)+
      '  '+pad(r.bias,4)+'  '+padL(r.rsi??'-',4)+padL(r.volR+'x',7)+'  '+r.tags.slice(0,4).join(' / ')+'\n';
  });
  out+='\n（スコアはボトムアップ発見用のヒューリスティック。記事化には催材の確認が必要）\n';
  process.stdout.write(out);

  if(JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({asOf:new Date().toISOString().slice(0,10), benchmark:benchMap?BENCH:null, universe:UNIVERSE.length, ranked:rows},null,2));
  await disconnect();
}
main().catch(e=>{console.error(e);process.exit(1);});
