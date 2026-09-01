/**
 * 較正ツール（dev 専用）: 候補領域（割合矩形）をスクショに重ねて出力する。
 * 使い方: tsx packages/ocr/scripts/annotate.ts <input.png> <output.png> [scale]
 * profile は下に直書きし、出力を目視しながら座標を詰める。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { decodePng, encodePng, type Raster } from './pngCodec.js';

interface FR { x: number; y: number; w: number; h: number }
interface Named { name: string; rect: FR; color: [number, number, number] }

// --- 第一推定プロファイル（2730×1260, 6-handed 基準 142820）---
const RED: [number, number, number] = [255, 40, 40];
const GRN: [number, number, number] = [40, 255, 80];
const BLU: [number, number, number] = [60, 160, 255];
const YEL: [number, number, number] = [255, 220, 40];

const regions: Named[] = [
  { name: 'blinds', rect: { x: 0.112, y: 0.016, w: 0.13, h: 0.036 }, color: YEL },
  { name: 'ante', rect: { x: 0.112, y: 0.06, w: 0.122, h: 0.04 }, color: YEL },
  { name: 'street', rect: { x: 0.26, y: 0.063, w: 0.085, h: 0.037 }, color: BLU },
  { name: 'pot', rect: { x: 0.447, y: 0.325, w: 0.117, h: 0.05 }, color: BLU },
  { name: 'heroCard1', rect: { x: 0.429, y: 0.663, w: 0.043, h: 0.139 }, color: GRN },
  { name: 'heroCard2', rect: { x: 0.478, y: 0.663, w: 0.043, h: 0.139 }, color: GRN },
  // 6 席のスタック数字ボックス
  { name: 's0.stack', rect: { x: 0.20, y: 0.26, w: 0.11, h: 0.056 }, color: RED },
  { name: 's1.stack', rect: { x: 0.459, y: 0.163, w: 0.131, h: 0.067 }, color: RED },
  { name: 's2.stack', rect: { x: 0.75, y: 0.26, w: 0.128, h: 0.056 }, color: RED },
  { name: 's3.stack', rect: { x: 0.168, y: 0.607, w: 0.113, h: 0.067 }, color: RED },
  { name: 's4.stack', rect: { x: 0.57, y: 0.715, w: 0.123, h: 0.067 }, color: RED },
  { name: 's5.stack', rect: { x: 0.809, y: 0.607, w: 0.119, h: 0.067 }, color: RED },
  // ベット（今回の shot では SB/BB のみ）
  { name: 's3.bet', rect: { x: 0.28, y: 0.477, w: 0.07, h: 0.056 }, color: GRN },
  { name: 's4.bet', rect: { x: 0.49, y: 0.607, w: 0.07, h: 0.054 }, color: GRN },
];

function drawRect(r: Raster, rect: FR, color: [number, number, number], th = 4): void {
  const x0 = Math.round(rect.x * r.width);
  const y0 = Math.round(rect.y * r.height);
  const x1 = Math.round((rect.x + rect.w) * r.width);
  const y1 = Math.round((rect.y + rect.h) * r.height);
  const put = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= r.width || y >= r.height) return;
    const i = (y * r.width + x) * 4;
    r.rgba[i] = color[0];
    r.rgba[i + 1] = color[1];
    r.rgba[i + 2] = color[2];
    r.rgba[i + 3] = 255;
  };
  for (let t = 0; t < th; t++) {
    for (let x = x0; x <= x1; x++) { put(x, y0 + t); put(x, y1 - t); }
    for (let y = y0; y <= y1; y++) { put(x0 + t, y); put(x1 - t, y); }
  }
}

function downscale(r: Raster, s: number): Raster {
  const w = Math.round(r.width / s);
  const h = Math.round(r.height / s);
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sx = Math.min(r.width - 1, Math.round(x * s));
      const sy = Math.min(r.height - 1, Math.round(y * s));
      const src = (sy * r.width + sx) * 4;
      const dst = (y * w + x) * 4;
      rgba[dst] = r.rgba[src]!;
      rgba[dst + 1] = r.rgba[src + 1]!;
      rgba[dst + 2] = r.rgba[src + 2]!;
      rgba[dst + 3] = 255;
    }
  return { width: w, height: h, rgba };
}

const [, , input, output, scaleStr] = process.argv;
if (!input || !output) {
  console.error('usage: annotate.ts <input.png> <output.png> [scale]');
  process.exit(1);
}
const scale = Number(scaleStr ?? '2');
const img = decodePng(readFileSync(input));
console.log(`decoded ${img.width}x${img.height}`);
for (const rg of regions) drawRect(img, rg.rect, rg.color);
const out = downscale(img, scale);
writeFileSync(output, encodePng(out));
console.log(`wrote ${output} (${out.width}x${out.height}) with ${regions.length} regions`);
