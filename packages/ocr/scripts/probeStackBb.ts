/** dev: BB建てスタックの成分分解（小数点欠落 71.3→713 の原因究明）。 */
import { readFileSync, existsSync } from 'node:fs';
import { decodePng, type Raster } from './pngCodec.js';
import { readAmountBb } from '../src/bbAmount.js';
import { whiteMask, grayFromRgba } from '../src/numberField.js';
import { templatesFromJson } from '../src/templates.js';
import { bestMatch, matchConfidence } from '../src/match.js';
import { crop, resize } from '../src/raster.js';
import type { Rgba } from '../src/color.js';
import type { Rect } from '../src/types.js';

const DIR = 'local-fixtures';
const file = (ts: string) => { for (const p of [`${DIR}/Screenshot_20260901-${ts}.png`, `${DIR}/Screenshot_20260902-${ts}.png`]) if (existsSync(p)) return p; throw new Error(ts); };
const toRgba = (r: Raster): Rgba => ({ w: r.width, h: r.height, data: r.rgba });
const px = (r: Raster, fr: readonly number[]): Rect => ({ x: Math.round(fr[0]! * r.width), y: Math.round(fr[1]! * r.height), w: Math.round(fr[2]! * r.width), h: Math.round(fr[3]! * r.height) });
const T = templatesFromJson(JSON.parse(readFileSync(`${DIR}/digits.json`, 'utf8')));

const STACK: Record<string, readonly number[]> = {
  TL: [0.221, 0.249, 0.09, 0.038], TC: [0.491, 0.151, 0.061, 0.041], TR: [0.766, 0.249, 0.085, 0.04],
  BR: [0.811, 0.601, 0.115, 0.04], BC: [0.575, 0.715, 0.115, 0.045], BL: [0.191, 0.594, 0.065, 0.036],
};

function rawComps(bin: { w: number; h: number; data: Uint8Array }) {
  const { w, h, data } = bin; const label = new Int32Array(w * h).fill(-1);
  const boxes: { x0: number; y0: number; x1: number; y1: number; area: number }[] = []; const st: number[] = [];
  for (let i = 0; i < w * h; i++) { if (data[i] === 0 || label[i] !== -1) continue; const id = boxes.length;
    boxes.push({ x0: w, y0: h, x1: -1, y1: -1, area: 0 }); st.length = 0; st.push(i); label[i] = id;
    while (st.length) { const p = st.pop()!; const pxx = p % w, py = (p / w) | 0; const b = boxes[id]!; b.area++;
      if (pxx < b.x0) b.x0 = pxx; if (pxx > b.x1) b.x1 = pxx; if (py < b.y0) b.y0 = py; if (py > b.y1) b.y1 = py;
      if (pxx > 0 && data[p - 1]! > 0 && label[p - 1] === -1) { label[p - 1] = id; st.push(p - 1); }
      if (pxx < w - 1 && data[p + 1]! > 0 && label[p + 1] === -1) { label[p + 1] = id; st.push(p + 1); }
      if (py > 0 && data[p - w]! > 0 && label[p - w] === -1) { label[p - w] = id; st.push(p - w); }
      if (py < h - 1 && data[p + w]! > 0 && label[p + w] === -1) { label[p + w] = id; st.push(p + w); } } }
  return boxes.map((b) => ({ x: b.x0, y: b.y0, w: b.x1 - b.x0 + 1, h: b.y1 - b.y0 + 1, area: b.area })).sort((a, b) => a.x - b.x);
}

// [frame, seat, expected, minCh]
const cases: [string, string, number, number][] = [
  ['114437', 'TL', 71.3, 120], ['114437', 'BR', 34.9, 120], ['114437', 'TR', 92.2, 120],
  ['114437', 'TL', 71.3, 90], ['114437', 'BR', 34.9, 90],
  ['114437', 'TL', 71.3, 70], ['114437', 'BR', 34.9, 70],
];
for (const [ts, seat, exp, minCh] of cases) {
  const img = decodePng(readFileSync(file(ts))); const rgba = toRgba(img); const rect = px(img, STACK[seat]!);
  const mask = whiteMask(rgba, rect, { minCh, maxSat: 80 }); const strip = grayFromRgba(rgba, rect);
  const comps = rawComps(mask); const maxH = comps.length ? Math.max(...comps.map((c) => c.h)) : 0;
  console.log(`\n=== ${ts} ${seat} exp=${exp} minCh=${minCh} rect=${rect.w}x${rect.h} maxH=${maxH} ===`);
  for (const c of comps) {
    const g = crop(strip, c); const nw = Math.max(1, Math.round((g.w * 26) / g.h)); const m = bestMatch(resize(g, nw, 26), T);
    const low = c.h < 0.45 * maxH ? ' <LOW=.>' : '';
    console.log(`  x=${c.x} w=${c.w} h=${c.h} area=${c.area} h/maxH=${(c.h / maxH).toFixed(2)} wh=${(c.w / c.h).toFixed(2)} -> '${m.label}'(${matchConfidence(m).toFixed(2)})${low}`);
  }
  const r = readAmountBb(rgba, rect, T, { minCh });
  console.log(`  readAmountBb => ${r.value}(${r.conf.toFixed(2)})`);
}
