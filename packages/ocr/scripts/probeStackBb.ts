/** dev: BB建てスタックの成分分解（小数点欠落 71.3→713 の原因究明）。 */
import { readFileSync, existsSync } from 'node:fs';
import { decodePng, type Raster } from './pngCodec.js';
import { rawComponents as rawComps, readAmountBb } from '../src/bbAmount.js';
import { whiteMask, grayFromRgba } from '../src/numberField.js';
import { templatesFromJson } from '../src/templates.js';
import { bestMatch, matchConfidence } from '../src/match.js';
import { crop, resize } from '../src/raster.js';
import type { Rgba } from '../src/color.js';
import type { Rect } from '../src/types.js';

const DIR = 'local-fixtures';
const file = (ts: string) => { for (const p of [`${DIR}/Screenshot_20260901-${ts}.png`, `${DIR}/Screenshot_20260902-${ts}.png`]) { if (existsSync(p)) return p; } throw new Error(ts); };
const toRgba = (r: Raster): Rgba => ({ w: r.width, h: r.height, data: r.rgba });
const px = (r: Raster, fr: readonly number[]): Rect => ({ x: Math.round(fr[0]! * r.width), y: Math.round(fr[1]! * r.height), w: Math.round(fr[2]! * r.width), h: Math.round(fr[3]! * r.height) });
const T = templatesFromJson(JSON.parse(readFileSync(`${DIR}/digits.json`, 'utf8')));

const STACK: Record<string, readonly number[]> = {
  TL: [0.221, 0.249, 0.09, 0.038], TC: [0.491, 0.151, 0.061, 0.041], TR: [0.766, 0.249, 0.085, 0.04],
  BR: [0.811, 0.601, 0.115, 0.04], BC: [0.575, 0.715, 0.115, 0.045], BL: [0.191, 0.594, 0.065, 0.036],
};

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
