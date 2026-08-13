/**
 * TradingView の生バーを表示する。
 *
 * 分析に使っている入力データが本物かを人間が目で照合するための道具。
 * 外部データ源（J-Quants 等）を追加するときの照合基準にもなる。
 * 参照: research/data-bias-registry.yaml の verification_protocol
 *
 * Usage: node scripts/dump_bars.js TSE:6857 15
 */
import { disconnect } from '../src/connection.js';
import { setSymbol, setResolution, readBars, waitBars, currentClose, ymd, T, O, H, L, C, V } from './lib/tv.js';

const SYM = process.argv[2] || 'TSE:6857';
const N = Number(process.argv[3] || 15);
const pad = (s, n) => String(s).padStart(n);

async function main() {
  await setResolution('D');
  const prev = await currentClose();
  await setSymbol(SYM);
  const d = await waitBars(300, prev, { minBars: 5 });
  const bars = (d?.bars || []).slice(-N);

  console.log(`\nSymbol resolved to: ${d?.sym || '?'}   (requested ${SYM})`);
  console.log('date         open     high      low    close       volume');
  console.log('----------  ------   ------   ------   ------   ----------');
  for (const b of bars) {
    console.log(`${ymd(b[T])}  ${pad(b[O], 6)}   ${pad(b[H], 6)}   ${pad(b[L], 6)}   ${pad(b[C], 6)}   ${pad(b[V], 10)}`);
  }
  await disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
