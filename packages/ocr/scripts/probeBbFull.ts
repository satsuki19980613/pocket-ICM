/** dev: BB 4 フレームで extractRawReads の全席 stack を per-seat GT と照合（統合検証）。 */
import { readFileSync } from 'node:fs';
import { decodePng } from './pngCodec.js';
import { extractRawReads, type ExtractTemplates } from '../src/extract.js';
import { CHIPS_6MAX } from '../src/frameProfile.js';
import type { Template } from '../src/match.js';
import type { Rgba } from '../src/color.js';

const DIR = 'local-fixtures';
function load(path: string): Template[] {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as any; const t = raw.templates ?? raw;
  if (Array.isArray(t)) return t.map((g: any) => ({ label: g.label, img: { w: g.w, h: g.h, data: Uint8Array.from(g.data) } }));
  return Object.entries(t).map(([label, g]: any) => ({ label, img: { w: g.w, h: g.h, data: Uint8Array.from(g.data) } }));
}
const templates: ExtractTemplates = {
  digits: load(`${DIR}/digits.json`), ranks: load(`${DIR}/ranks_hero.json`),
  actions: load(`${DIR}/actions.json`), letters: load(`${DIR}/letters_bb.json`),
};

// per-seat GT（AI 目視, 席 id → BB 値）。
const GT: Record<string, Record<string, number>> = {
  '142936': { TL: 12.9, TC: 13, TR: 39.2, BR: 34.5, BC: 20.2, BL: 13.5 },
  '142947': { TL: 12.2, TC: 27.9, TR: 39, BR: 34.2, BC: 6.9, BL: 13.2 },
  '142955': { TL: 9.8, TC: 27.7, TR: 30.9, BR: 28, BC: 5.4, BL: 7.8 },
  '143002': { TL: 8.5, TC: 27.4, TR: 30.1, BR: 30.7, BC: 5.2, BL: 7.5 },
};

let ok = 0, tot = 0; const bad: string[] = [];
for (const [id, gt] of Object.entries(GT)) {
  const img = decodePng(readFileSync(`${DIR}/Screenshot_20260901-${id}.png`));
  const rgba: Rgba = { w: img.width, h: img.height, data: img.rgba };
  const reads = extractRawReads(rgba, CHIPS_6MAX, templates, { betMinCh: 125 });
  const line: string[] = [`${id} mode=${reads.displayMode}`];
  for (const s of reads.seats) {
    const want = gt[s.id]!;
    const got = s.stack.value;
    const m = Number.isFinite(got) && Math.abs(got - want) < 0.05;
    tot++; if (m) ok++; else bad.push(`${id} ${s.id}: got ${Number.isFinite(got) ? got : 'NaN'}(${s.stack.conf.toFixed(2)}) want ${want}`);
    line.push(`${s.id}=${Number.isFinite(got) ? got : 'NaN'}${m ? '' : '✗'}`);
  }
  console.log(line.join(' '));
}
console.log(`\n=== BB per-seat stack: ${ok}/${tot} ===`);
if (bad.length) console.log(bad.join('\n'));
