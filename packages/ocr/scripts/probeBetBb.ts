/** dev: BB建てベット領域の成分分解を可視化（0.5→1.5 誤読の原因究明）。 */
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
const file = (ts: string) => {
  for (const p of [`${DIR}/Screenshot_20260901-${ts}.png`, `${DIR}/Screenshot_20260902-${ts}.png`]) if (existsSync(p)) return p;
  throw new Error(ts);
};
const toRgba = (r: Raster): Rgba => ({ w: r.width, h: r.height, data: r.rgba });
const px = (r: Raster, fr: readonly number[]): Rect => ({ x: Math.round(fr[0]! * r.width), y: Math.round(fr[1]! * r.height), w: Math.round(fr[2]! * r.width), h: Math.round(fr[3]! * r.height) });
const T = templatesFromJson(JSON.parse(readFileSync(`${DIR}/digits.json`, 'utf8')));

const BET: Record<string, readonly number[]> = {
  TL: [0.315, 0.335, 0.075, 0.044], TC: [0.487, 0.243, 0.08, 0.044], TR: [0.665, 0.335, 0.066, 0.048],
  BL: [0.303, 0.466, 0.066, 0.05], BC: [0.516, 0.592, 0.066, 0.05], BR: [0.699, 0.47, 0.062, 0.05],
};

// rawComponents 相当を再現して各成分を表示（bbAmount 内部と同ロジック）。
function rawComps(bin: { w: number; h: number; data: Uint8Array }): { x: number; y: number; w: number; h: number; area: number }[] {
  const { w, h, data } = bin; const label = new Int32Array(w * h).fill(-1);
  const boxes: { x0: number; y0: number; x1: number; y1: number; area: number }[] = []; const st: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (data[i] === 0 || label[i] !== -1) continue; const id = boxes.length;
    boxes.push({ x0: w, y0: h, x1: -1, y1: -1, area: 0 }); st.length = 0; st.push(i); label[i] = id;
    while (st.length) { const p = st.pop()!; const pxx = p % w, py = (p / w) | 0; const b = boxes[id]!; b.area++;
      if (pxx < b.x0) b.x0 = pxx; if (pxx > b.x1) b.x1 = pxx; if (py < b.y0) b.y0 = py; if (py > b.y1) b.y1 = py;
      if (pxx > 0 && data[p - 1]! > 0 && label[p - 1] === -1) { label[p - 1] = id; st.push(p - 1); }
      if (pxx < w - 1 && data[p + 1]! > 0 && label[p + 1] === -1) { label[p + 1] = id; st.push(p + 1); }
      if (py > 0 && data[p - w]! > 0 && label[p - w] === -1) { label[p - w] = id; st.push(p - w); }
      if (py < h - 1 && data[p + w]! > 0 && label[p + w] === -1) { label[p + w] = id; st.push(p + w); } } }
  return boxes.map((b) => ({ x: b.x0, y: b.y0, w: b.x1 - b.x0 + 1, h: b.y1 - b.y0 + 1, area: b.area })).sort((a, b) => a.x - b.x);
}

// dx: 領域を左へずらす割合（0=元）。widen: 幅を割合で拡げる。
// 一様 -0.008/+0.008 が全 BB席・全ベット値で安全かを網羅検証。
const D = -0.008, W = 0.008;
const cases: [string, string, number, number, number][] = [
  ['123636', 'TC', 5.9, D, W],
  ['115034', 'TR', 0.5, D, W], ['114717', 'TR', 3.0, D, W],
  ['114437', 'BC', 0.5, D, W], ['115034', 'BC', 1.0, D, W], ['123636', 'BC', 1.0, D, W],
  ['114717', 'BL', 0.5, D, W], ['114437', 'BL', 1.0, D, W],
  ['114717', 'TL', 1.0, D, W], ['115034', 'TL', 1.0, D, W],
];
for (const [ts, seat, exp, dx, dw] of cases) {
  const img = decodePng(readFileSync(file(ts))); const rgba = toRgba(img);
  const fr0 = BET[seat]!; const fr = [fr0[0]! + dx, fr0[1]!, fr0[2]! + dw, fr0[3]!];
  const rect = px(img, fr);
  const minCh = 120, maxSat = 80;
  const mask = whiteMask(rgba, rect, { minCh, maxSat });
  const strip = grayFromRgba(rgba, rect);
  const comps = rawComps(mask);
  const maxH = comps.length ? Math.max(...comps.map((c) => c.h)) : 0;
  console.log(`\n=== ${ts} ${seat} exp=${exp} rect=${rect.w}x${rect.h} maxH=${maxH} ===`);
  for (const c of comps) {
    const g = crop(strip, c); const nw = Math.max(1, Math.round((g.w * 26) / g.h)); const ng = resize(g, nw, 26);
    const m = bestMatch(ng, T);
    console.log(`  x=${c.x} y=${c.y} w=${c.w} h=${c.h} area=${c.area} h/maxH=${(c.h / maxH).toFixed(2)} wh=${(c.w / c.h).toFixed(2)} -> '${m.label}'(${matchConfidence(m).toFixed(2)})`);
  }
  const r = readAmountBb(rgba, rect, T, { minCh });
  console.log(`  readAmountBb => ${r.value}(${r.conf.toFixed(2)})`);
}
