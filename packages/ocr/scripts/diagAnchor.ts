/** 2.44失敗フレームの実パイプライン診断（dev・使い捨て）。本番と同じ extractAnchored({}) を回す。 */
import { readFileSync } from 'node:fs';
import { decodePng } from './pngCodec.js';
import { extractAnchored } from '../src/extractAnchored.js';
import { pickSeatAnchorGrid } from '../src/seatAnchorGrids.js';
import { runOcrPipeline } from '../src/pipeline.js';
import { templatesFromJson } from '../src/templates.js';

const A = 'assets';
const load = (p: string) => templatesFromJson(JSON.parse(readFileSync(p, 'utf8')));
const templates = {
  digits: load(`${A}/digits.json`),
  ranks: load(`${A}/ranks_hero.json`),
  actions: load(`${A}/actions.json`),
  letters: load(`${A}/letters_bb.json`),
};

for (const path of process.argv.slice(2)) {
  const { width, height, rgba } = decodePng(readFileSync(path));
  const img = { w: width, h: height, data: rgba };
  const seatAnchors = pickSeatAnchorGrid(width / height);
  const reads = extractAnchored(img, templates, seatAnchors ? { seatAnchors } : {});
  console.log(`\n=== ${path.split(/[\\/]/).pop()}  ${width}x${height}  mode=${reads.displayMode} ===`);
  console.log(`pot=${fmt(reads.pot.value)}  blinds sb/bb=${fmt(reads.blinds.sb.value)}/${fmt(reads.blinds.bb.value)}`);
  for (const s of reads.seats) {
    console.log(
      `  ${s.id}${s.isHero ? '*' : ' '} occ=${s.occupancy.value.padEnd(8)} ` +
        `stack=${fmt(s.stack.value).padStart(7)}(c${s.stack.conf.toFixed(2)}) ` +
        `bet=${fmt(s.bet.value).padStart(6)} act=${s.action.value}${s.isButton ? ' [BTN]' : ''}`,
    );
  }
  console.log(`  blindChips=${JSON.stringify(reads.blindChips)}`);
  const res = runOcrPipeline(reads);
  if (res.chipCheck) {
    const c = res.chipCheck;
    console.log(`  chipCheck: mode=${c.mode} theory=${c.totalBbTheory?.toFixed(2)} read=${c.totalBbRead?.toFixed(2)} delta=${c.deltaBb?.toFixed(2)} corrected=${c.correctedSeatId ?? '-'} notes=${JSON.stringify(c.notes)}`);
  }
  console.log(`  → pipeline ok=${res.ok}  issues=${JSON.stringify(res.issues)}  lowConf=${JSON.stringify(res.lowConfidenceFields)}`);
}
function fmt(x: number): string { return Number.isFinite(x) ? x.toFixed(2) : 'NaN'; }
