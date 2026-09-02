/** dev: BB frame の hero スタック末尾2つの背高成分（"B","B"）を "B" テンプレとして生成。 */
import { readFileSync, writeFileSync } from 'node:fs';
import { decodePng } from './pngCodec.js';
import { CHIPS_6MAX } from '../src/frameProfile.js';
import { toPx } from '../src/layout.js';
import { grayFromRgba, whiteMask } from '../src/numberField.js';
import { crop, resize } from '../src/raster.js';
import type { Rgba } from '../src/color.js';
import type { Gray, Rect } from '../src/types.js';

const DIR = 'local-fixtures';
const NORM_H = 32;

function rawComps(bin: Gray): Array<Rect & { area: number }> {
  const { w, h, data } = bin;
  const label = new Int32Array(w * h).fill(-1);
  const boxes: { x0: number; y0: number; x1: number; y1: number; area: number }[] = [];
  const st: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (data[i] === 0 || label[i] !== -1) continue;
    const id = boxes.length; boxes.push({ x0: w, y0: h, x1: -1, y1: -1, area: 0 });
    st.length = 0; st.push(i); label[i] = id;
    while (st.length) {
      const p = st.pop()!; const px = p % w, py = (p / w) | 0; const b = boxes[id]!; b.area++;
      if (px < b.x0) b.x0 = px; if (px > b.x1) b.x1 = px; if (py < b.y0) b.y0 = py; if (py > b.y1) b.y1 = py;
      if (px > 0 && data[p - 1]! > 0 && label[p - 1] === -1) { label[p - 1] = id; st.push(p - 1); }
      if (px < w - 1 && data[p + 1]! > 0 && label[p + 1] === -1) { label[p + 1] = id; st.push(p + 1); }
      if (py > 0 && data[p - w]! > 0 && label[p - w] === -1) { label[p - w] = id; st.push(p - w); }
      if (py < h - 1 && data[p + w]! > 0 && label[p + w] === -1) { label[p + w] = id; st.push(p + w); }
    }
  }
  return boxes.map((b) => ({ x: b.x0, y: b.y0, w: b.x1 - b.x0 + 1, h: b.y1 - b.y0 + 1, area: b.area })).sort((a, b) => a.x - b.x);
}

const hero = CHIPS_6MAX.seats.find((s) => s.isHero)!;
const templates: Array<{ label: string; w: number; h: number; data: number[] }> = [];
// 複数フレームから B を採取（多例）。
for (const frame of ['Screenshot_20260901-142936.png', 'Screenshot_20260902-114732.png', 'Screenshot_20260902-123636.png']) {
  const img = decodePng(readFileSync(`${DIR}/${frame}`));
  const rgba: Rgba = { w: img.width, h: img.height, data: img.rgba };
  const rect = toPx(hero.stack, rgba.w, rgba.h);
  const strip = grayFromRgba(rgba, rect);
  const comps = rawComps(whiteMask(rgba, rect, { minCh: 120, maxSat: 80 }))
    .filter((c) => c.area >= 15 && c.h >= 5 && c.w <= 0.6 * rect.w && c.w / c.h <= 4);
  const maxH = Math.max(...comps.map((c) => c.h));
  const tall = comps.filter((c) => c.h >= 0.45 * maxH);
  const bb = tall.slice(-2); // 末尾2つ ＝ "B","B"
  for (const c of bb) {
    const g = crop(strip, c);
    const nw = Math.max(1, Math.round((g.w * NORM_H) / g.h));
    const r = resize(g, nw, NORM_H);
    templates.push({ label: 'B', w: r.w, h: r.h, data: Array.from(r.data) });
  }
  console.log(`${frame}: B x${bb.length} (w=${bb.map((c) => c.w).join(',')})`);
}
writeFileSync(`${DIR}/letters_bb.json`, JSON.stringify({ templates }));
console.log(`wrote letters_bb.json with ${templates.length} B exemplars`);
