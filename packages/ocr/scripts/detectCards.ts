/**
 * 較正ツール（dev 専用）: ハンド一覧のカード列で白札検出を実画像検証する。
 * 指定ゾーン（割合）を切り出し→findCardRects→検出矩形を重ねて保存＋座標を表示。
 * 使い方: tsx detectCards.ts <input.png> <overlay.png> <zx,zy,zw,zh> [threshold]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { decodePng, encodePng, type Raster } from './pngCodec.js';
import { findCardRects } from '../src/detect.js';
import type { Gray, Rect } from '../src/types.js';

function toGray(r: Raster): Gray {
  const data = new Uint8Array(r.width * r.height);
  for (let i = 0; i < data.length; i++)
    data[i] = (r.rgba[i * 4]! * 77 + r.rgba[i * 4 + 1]! * 150 + r.rgba[i * 4 + 2]! * 29) >> 8;
  return { w: r.width, h: r.height, data };
}
function cropRaster(r: Raster, fx: number, fy: number, fw: number, fh: number): { sub: Raster; x0: number; y0: number } {
  const x0 = Math.round(fx * r.width);
  const y0 = Math.round(fy * r.height);
  const w = Math.round(fw * r.width);
  const h = Math.round(fh * r.height);
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = ((y0 + y) * r.width + (x0 + x)) * 4;
      const d = (y * w + x) * 4;
      rgba[d] = r.rgba[s]!; rgba[d + 1] = r.rgba[s + 1]!; rgba[d + 2] = r.rgba[s + 2]!; rgba[d + 3] = 255;
    }
  return { sub: { width: w, height: h, rgba }, x0, y0 };
}
function drawRect(r: Raster, rect: Rect, th = 3): void {
  const put = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= r.width || y >= r.height) return;
    const i = (y * r.width + x) * 4;
    r.rgba[i] = 255; r.rgba[i + 1] = 40; r.rgba[i + 2] = 40; r.rgba[i + 3] = 255;
  };
  for (let t = 0; t < th; t++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) { put(x, rect.y + t); put(x, rect.y + rect.h - 1 - t); }
    for (let y = rect.y; y < rect.y + rect.h; y++) { put(rect.x + t, y); put(rect.x + rect.w - 1 - t, y); }
  }
}

const [, , input, overlay, zoneStr, thStr] = process.argv;
if (!input || !overlay || !zoneStr) {
  console.error('usage: detectCards.ts <input.png> <overlay.png> <zx,zy,zw,zh> [threshold]');
  process.exit(1);
}
const [zx, zy, zw, zh] = zoneStr.split(',').map(Number);
const img = decodePng(readFileSync(input));
const { sub, x0, y0 } = cropRaster(img, zx!, zy!, zw!, zh!);
const gray = toGray(sub);
const threshold = thStr ? Number(thStr) : 200;
const rects = findCardRects(gray, { threshold, minAreaFrac: 0.008, aspectRange: [0.4, 0.78], minFill: 0.3 });
for (const r of rects) drawRect(sub, r);
writeFileSync(overlay, encodePng(sub));
console.log(`zone ${sub.width}x${sub.height} @(${x0},${y0}) threshold=${threshold} → ${rects.length} cards`);
for (const r of rects) {
  const fx = (x0 + r.x) / img.width, fy = (y0 + r.y) / img.height;
  const fw = r.w / img.width, fh = r.h / img.height;
  console.log(`  rect zone(${r.x},${r.y},${r.w},${r.h}) frac(${fx.toFixed(4)},${fy.toFixed(4)},${fw.toFixed(4)},${fh.toFixed(4)}) aspect=${(r.w / r.h).toFixed(2)}`);
}
