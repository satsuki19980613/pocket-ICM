/**
 * 較正ツール（dev 専用）: 割合矩形でスクショから領域を切り出して PNG 保存。
 * 使い方: tsx crop.ts <input.png> <outdir> <name:x,y,w,h> [name:x,y,w,h ...]
 * x,y,w,h は [0,1] の割合。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng, encodePng, type Raster } from './pngCodec.js';

function crop(r: Raster, fx: number, fy: number, fw: number, fh: number): Raster {
  const x0 = Math.max(0, Math.round(fx * r.width));
  const y0 = Math.max(0, Math.round(fy * r.height));
  const w = Math.min(r.width - x0, Math.round(fw * r.width));
  const h = Math.min(r.height - y0, Math.round(fh * r.height));
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = ((y0 + y) * r.width + (x0 + x)) * 4;
      const d = (y * w + x) * 4;
      rgba[d] = r.rgba[s]!;
      rgba[d + 1] = r.rgba[s + 1]!;
      rgba[d + 2] = r.rgba[s + 2]!;
      rgba[d + 3] = 255;
    }
  return { width: w, height: h, rgba };
}

const [, , input, outdir, ...specs] = process.argv;
if (!input || !outdir || specs.length === 0) {
  console.error('usage: crop.ts <input.png> <outdir> <name:x,y,w,h> ...');
  process.exit(1);
}
mkdirSync(outdir, { recursive: true });
const img = decodePng(readFileSync(input));
for (const spec of specs) {
  const [name, rest] = spec.split(':');
  const [x, y, w, h] = rest!.split(',').map(Number);
  const c = crop(img, x!, y!, w!, h!);
  const path = join(outdir, `${name}.png`);
  writeFileSync(path, encodePng(c));
  console.log(`${path} ${c.width}x${c.height}`);
}
