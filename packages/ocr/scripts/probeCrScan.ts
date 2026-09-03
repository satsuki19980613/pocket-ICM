/** dev: 強制 contentRect を拡大パスに当ててスキャンし、canonical profile が復活するか調べる。 */
import { readFileSync } from 'node:fs';
import { decodePng } from './pngCodec.js';
import { extractRawReadsAuto, type ExtractTemplates } from '../src/extract.js';
import { CHIPS_6MAX } from '../src/frameProfile.js';
import { runOcrPipeline } from '../src/pipeline.js';
import { templatesFromJson } from '../src/templates.js';
import type { Rgba } from '../src/color.js';

const A = 'assets';
const load = (p: string) => templatesFromJson(JSON.parse(readFileSync(p, 'utf8')));
const templates: ExtractTemplates = {
  digits: load(`${A}/digits.json`),
  ranks: load(`${A}/ranks_hero.json`),
  actions: load(`${A}/actions.json`),
  letters: load(`${A}/letters_bb.json`),
};

const frame = process.argv[2]!;
const img0 = decodePng(readFileSync(`local-fixtures/${frame}`));
const rgba: Rgba = { w: img0.width, h: img0.height, data: img0.rgba };
const dm = process.argv[3] === 'chips' ? 'chips' : process.argv[3] === 'bb' ? 'bb' : undefined;

const f = (r: { value: number; conf: number }) =>
  `${Number.isFinite(r.value) ? r.value.toFixed(2) : 'NaN'}(${r.conf.toFixed(2)})`;

const scales = [0.86, 0.88, 0.9, 0.92, 0.94, 0.96, 0.98, 1.0];
const offs = [-0.02, 0, 0.015, 0.03, 0.045, 0.06];
type Row = { cr: string; ok: boolean; occ: number; heroOk: boolean; heroConf: number; stackFin: number };
const rows: Row[] = [];
for (const sc of scales)
  for (const ox of offs)
    for (const oy of offs) {
      const cr = { x: ox, y: oy, w: sc, h: sc };
      const { reads } = extractRawReadsAuto(rgba, CHIPS_6MAX, templates, { betMinCh: 125, contentRect: cr, ...(dm ? { displayMode: dm } : {}) });
      const res = runOcrPipeline(reads);
      const occ = reads.seats.filter((s) => s.occupancy.value === 'occupied').length;
      const stackFin = reads.seats.filter((s) => Number.isFinite(s.stack.value)).length;
      rows.push({ cr: `${ox},${oy},${sc}`, ok: res.ok, occ, heroOk: reads.heroHand.value.length >= 2, heroConf: reads.heroHand.conf, stackFin });
    }
rows.sort((a, b) => Number(b.ok) - Number(a.ok) || b.stackFin - a.stackFin || b.heroConf - a.heroConf);
console.log(`=== ${frame} (top 12 by ok/stackFin/heroConf) ===`);
for (const r of rows.slice(0, 12))
  console.log(`  cr=${r.cr.padEnd(16)} ok=${r.ok} occ=${r.occ} stackFin=${r.stackFin} hero=${r.heroOk}(${r.heroConf.toFixed(2)})`);

// 最良 cr の詳細
const best = rows[0]!;
const [ox, oy, sc] = best.cr.split(',').map(Number);
const { reads } = extractRawReadsAuto(rgba, CHIPS_6MAX, templates, { betMinCh: 125, contentRect: { x: ox!, y: oy!, w: sc!, h: sc! }, ...(dm ? { displayMode: dm } : {}) });
console.log(`\n--- best cr=${best.cr} detail ---`);
console.log(`mode=${reads.displayMode} blinds=${f(reads.blinds.sb)}/${f(reads.blinds.bb)} ante=${f(reads.ante.amount)} pot=${f(reads.pot)} hero=${reads.heroHand.value}(${reads.heroHand.conf.toFixed(2)})`);
for (const s of reads.seats)
  console.log(`  ${s.id} ${s.isHero ? 'H' : ' '}${s.isButton ? 'D' : ' '} occ=${s.occupancy.value} act=${s.action.value}(${s.action.conf.toFixed(2)}) stack=${f(s.stack)} bet=${f(s.bet)}`);
