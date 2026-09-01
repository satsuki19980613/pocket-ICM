/**
 * 較正ツール（dev 専用）: カード角（ランク＋スート）を切り出し、
 *   1) 目視確認用モンタージュ PNG（各クロップを 3x 拡大してタイル＋ラベルは順序で対応）
 *   2) テンプレ JSON（label -> グレースケール Gray）
 * を同時に出力する。ラベルは私（AI）が画像を目視で読み取って与える＝ ground-truth。
 *
 * 使い方:
 *   tsx cardtool.ts <input.png> <outMontage.png> <outTemplates.json> <label:x,y,w,h> ...
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { decodePng, encodePng, type Raster } from './pngCodec.js';

function cropGray(r: Raster, fx: number, fy: number, fw: number, fh: number): { w: number; h: number; data: number[] } {
  const x0 = Math.max(0, Math.round(fx * r.width));
  const y0 = Math.max(0, Math.round(fy * r.height));
  const w = Math.min(r.width - x0, Math.round(fw * r.width));
  const h = Math.min(r.height - y0, Math.round(fh * r.height));
  const data: number[] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = ((y0 + y) * r.width + (x0 + x)) * 4;
      const g = (r.rgba[s]! * 77 + r.rgba[s + 1]! * 150 + r.rgba[s + 2]! * 29) >> 8;
      data.push(g);
    }
  return { w, h, data };
}

function montage(tiles: { w: number; h: number; data: number[] }[], up = 3, pad = 4): Raster {
  const maxH = Math.max(...tiles.map((t) => t.h)) * up;
  const totalW = tiles.reduce((a, t) => a + t.w * up + pad, pad);
  const H = maxH + pad * 2;
  const rgba = new Uint8Array(totalW * H * 4).fill(40);
  for (let i = 0; i < totalW * H; i++) rgba[i * 4 + 3] = 255;
  let ox = pad;
  for (const t of tiles) {
    for (let y = 0; y < t.h * up; y++)
      for (let x = 0; x < t.w * up; x++) {
        const g = t.data[Math.floor(y / up) * t.w + Math.floor(x / up)]!;
        const d = ((pad + y) * totalW + (ox + x)) * 4;
        rgba[d] = g; rgba[d + 1] = g; rgba[d + 2] = g; rgba[d + 3] = 255;
      }
    ox += t.w * up + pad;
  }
  return { width: totalW, height: H, rgba };
}

const [, , input, outMontage, outJson, ...specs] = process.argv;
if (!input || !outMontage || !outJson || specs.length === 0) {
  console.error('usage: cardtool.ts <input.png> <montage.png> <templates.json> <label:x,y,w,h> ...');
  process.exit(1);
}
const img = decodePng(readFileSync(input));
const labels: string[] = [];
const tiles: { w: number; h: number; data: number[] }[] = [];
const templates: Record<string, { w: number; h: number; data: number[] }> = {};
for (const spec of specs) {
  const idx = spec.indexOf(':');
  const label = spec.slice(0, idx);
  const [x, y, w, h] = spec.slice(idx + 1).split(',').map(Number);
  const g = cropGray(img, x!, y!, w!, h!);
  labels.push(label);
  tiles.push(g);
  templates[label] = g;
}
writeFileSync(outMontage, encodePng(montage(tiles)));
writeFileSync(outJson, JSON.stringify({ source: input, labels, templates }));
console.log(`montage: ${outMontage} | labels(左→右): ${labels.join(' ')} | templates: ${outJson}`);
