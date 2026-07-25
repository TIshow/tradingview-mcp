/**
 * Print the raw daily OHLCV bars that the analysis reads from TradingView's
 * internal data model via CDP — so a human can eyeball them against the chart
 * and confirm the INPUT to the RSI/MACD/EMA math is real.
 *
 * Usage: node scripts/dump_bars.js TSE:6857 15
 */
import { evaluate, evaluateAsync, disconnect } from '../src/connection.js';

const SYM = process.argv[2] || 'TSE:6857';
const N = Number(process.argv[3] || 15);
const CHART = 'window.TradingViewApi._activeChartWidgetWV.value()';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function setResolution(res) { await evaluate(`(function(){${CHART}.setResolution(${JSON.stringify(res)},{});})()`); }
async function setSymbol(sym) {
  await evaluateAsync(`(function(){var c=${CHART};return new Promise(function(res){c.setSymbol(${JSON.stringify(sym)},{});setTimeout(res,400);});})()`);
}
async function readBars(limit) {
  return evaluate(`
    (function(){
      var s=${CHART}._chartWidget.model().mainSeries(); var bars=s.bars();
      if(!bars||typeof bars.lastIndex!=='function') return null;
      var out=[]; var end=bars.lastIndex(); var start=Math.max(bars.firstIndex(), end-${limit}+1);
      for(var i=start;i<=end;i++){var v=bars.valueAt(i); if(v) out.push({t:v[0],o:v[1],h:v[2],l:v[3],c:v[4],v:v[5]});}
      var sym=''; try{sym=s.symbolInfo()?s.symbolInfo().full_name||'':'';}catch(e){}
      return {bars:out, sym:sym};
    })()`);
}
async function waitBars(limit, prevClose) {
  let last=-1,lc=null,stable=0;
  for(let i=0;i<30;i++){
    await sleep(500);
    const d=await readBars(limit).catch(()=>null);
    const n=d?.bars?.length||0; const c=n?d.bars[n-1].c:null;
    const changed = prevClose==null || c!==prevClose;
    if(n>5 && n===last && c===lc && changed){ if(++stable>=2) return d; } else stable=0;
    last=n; lc=c;
  }
  return readBars(limit);
}
const ymd = t => { const d=new Date(t*1000); return d.toISOString().slice(0,10); };
const pad=(s,n)=>{s=String(s);return s.length>=n?s:' '.repeat(n-s.length)+s;};

async function main(){
  await setResolution('D');
  let prev=null; try{const c=await readBars(3);const b=c?.bars||[];prev=b.length?b[b.length-1].c:null;}catch{}
  await setSymbol(SYM);
  const d = await waitBars(300, prev);
  const bars = (d?.bars||[]).slice(-N);
  console.log(`\nSymbol resolved to: ${d?.sym||'?'}   (requested ${SYM})`);
  console.log('date         open     high      low    close       volume');
  console.log('----------  ------   ------   ------   ------   ----------');
  for(const b of bars){
    console.log(`${ymd(b.t)}  ${pad(b.o,6)}   ${pad(b.h,6)}   ${pad(b.l,6)}   ${pad(b.c,6)}   ${pad(b.v,10)}`);
  }
  await disconnect();
}
main().catch(e=>{console.error(e);process.exit(1);});
