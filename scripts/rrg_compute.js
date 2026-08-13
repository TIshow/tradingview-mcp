/**
 * Relative Rotation Graph (RRG) computation from raw CDP bars.
 *
 * For each stock, computes RS-Ratio and RS-Momentum vs a benchmark (Nikkei 225,
 * falling back to an equal-weight basket of the universe if the index symbol
 * can't be fetched). Reads raw daily closes only — no chart indicators.
 *
 *   RS(t)        = stockClose(t) / benchClose(t)
 *   RS-Ratio(t)  = 100 * RS(t) / SMA(RS, RATIO_W)         (>100 = outperforming)
 *   RS-Momentum  = 100 * RS-Ratio(t) / SMA(RS-Ratio, MOM_W)   (>100 = accelerating)
 *
 * Quadrants: Leading(R≥100,M≥100) Weakening(R≥100,M<100)
 *            Lagging(R<100,M<100) Improving(R<100,M≥100)
 *
 * Usage: node scripts/rrg_compute.js > /tmp/rrg.json
 */
import { evaluate, disconnect } from '../src/connection.js';
import { setSymbol, setResolution, waitBars, currentClose, T, C } from './lib/tv.js';
import { smaAt } from './lib/indicators.js';

const UNIVERSE = [
  { code: '8035', sym: 'TSE:8035', name: '東京エレクトロン' },
  { code: '6857', sym: 'TSE:6857', name: 'アドバンテスト' },
  { code: '6146', sym: 'TSE:6146', name: 'ディスコ' },
  { code: '6920', sym: 'TSE:6920', name: 'レーザーテック' },
  { code: '7735', sym: 'TSE:7735', name: 'SCREEN' },
  { code: '6723', sym: 'TSE:6723', name: 'ルネサス' },
  { code: '6963', sym: 'TSE:6963', name: 'ローム' },
  { code: '4063', sym: 'TSE:4063', name: '信越化学' },
];
const BENCH_CANDIDATES = ['TVC:NI225', 'INDEX:NKY', 'TSE:998405', 'NIKKEI225'];
const BARS = 260, RATIO_W = 50, MOM_W = 10, TAIL_POINTS = 6, TAIL_STEP = 5;
async function tryFetch(sym, prevClose) {
  await setSymbol(sym);
  const d = await waitBars(BARS, prevClose).catch(()=>null);
  const n = d?.bars?.length||0;
  if (n > 60) return d;
  return null;
}


async function main() {
  await setResolution('D');
  let prev = await currentClose();

  // 1) fetch all stocks -> map code -> Map(t->close)
  const stockData = {};
  for (const u of UNIVERSE) {
    process.stderr.write(`fetch ${u.sym} ... `);
    const d = await tryFetch(u.sym, prev);
    if (!d) { process.stderr.write('FAIL\n'); continue; }
    const m = new Map(d.bars.map(b => [b[T], b[C]]));
    stockData[u.code] = m;
    prev = d.bars[d.bars.length-1][C];
    process.stderr.write(`${m.size} bars (${d.sym})\n`);
  }

  // 2) benchmark: try Nikkei, else equal-weight basket
  let benchMap = null, benchName = null;
  for (const b of BENCH_CANDIDATES) {
    process.stderr.write(`bench ${b} ... `);
    const d = await tryFetch(b, prev);
    if (d) { benchMap = new Map(d.bars.map(x=>[x[T],x[C]])); benchName = d.sym||b; prev=d.bars[d.bars.length-1][C]; process.stderr.write(`OK (${benchName})\n`); break; }
    process.stderr.write('no\n');
  }
  if (!benchMap) {
    // equal-weight basket normalized to each stock's earliest common close
    process.stderr.write('bench: equal-weight basket fallback\n');
    benchName = '半導体8銘柄 等ウェイト・バスケット';
    // common dates across all stocks
    const codes = Object.keys(stockData);
    let common = null;
    for (const c of codes) { const ts=new Set(stockData[c].keys()); common = common? new Set([...common].filter(t=>ts.has(t))) : ts; }
    const dates = [...common].sort((a,b)=>a-b);
    const base = {}; codes.forEach(c=>base[c]=stockData[c].get(dates[0]));
    benchMap = new Map(dates.map(t => [t, codes.reduce((s,c)=>s+stockData[c].get(t)/base[c],0)/codes.length]));
  }

  // 3) compute RRG per stock over common dates with benchmark
  const out = [];
  for (const u of UNIVERSE) {
    const m = stockData[u.code]; if (!m) continue;
    const dates = [...m.keys()].filter(t => benchMap.has(t)).sort((a,b)=>a-b);
    if (dates.length < RATIO_W + MOM_W + 5) continue;
    const rs = dates.map(t => m.get(t) / benchMap.get(t));
    const rsRatio = rs.map((_,i)=>{ const s=smaAt(rs,i,RATIO_W); return s? 100*rs[i]/s : null; });
    const rsMom = rsRatio.map((_,i)=>{ if(rsRatio[i]==null) return null; const s=smaAt(rsRatio,i,MOM_W); return s? 100*rsRatio[i]/s : null; });
    const valid = dates.map((t,i)=>({t,r:rsRatio[i],m:rsMom[i]})).filter(p=>p.r!=null&&p.m!=null);
    if (valid.length < TAIL_POINTS*TAIL_STEP) continue;
    const tail = [];
    for (let k=(TAIL_POINTS-1)*TAIL_STEP; k>=0; k-=TAIL_STEP) {
      const p = valid[valid.length-1-k];
      tail.push({ date: new Date(p.t*1000).toISOString().slice(0,10), r:+p.r.toFixed(2), m:+p.m.toFixed(2) });
    }
    const cur = tail[tail.length-1];
    const quad = cur.r>=100 ? (cur.m>=100?'Leading':'Weakening') : (cur.m>=100?'Improving':'Lagging');
    out.push({ code:u.code, name:u.name, close: Math.round([...m.values()].pop()),
               rsRatio: cur.r, rsMom: cur.m, quadrant: quad, tail });
  }

  await setSymbol('TSE:6857'); await setResolution('D');
  console.log(JSON.stringify({
    benchmark: benchName, asOf: out[0]?.tail?.slice(-1)[0]?.date || null,
    params: { ratioWindow: RATIO_W, momWindow: MOM_W, tailPoints: TAIL_POINTS, tailStepDays: TAIL_STEP },
    symbols: out,
  }, null, 2));
  await disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
