/**
 * 較正ツール（dev 専用）: local-fixtures の PNG を等倍 1/s に縮小して outdir に保存。
 * AI 目視ラベリング用（フルフレームは大きいので縮小して読ませる）。
 * 使い方: tsx downscaleAll.ts <indir> <outdir> [scale]
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng, encodePng, type Raster } from './pngCodec.js';

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

const [, , indir, outdir, scaleStr] = process.argv;
if (!indir || !outdir) { console.error('usage: downscaleAll.ts <indir> <outdir> [scale]'); process.exit(1); }
const scale = Number(scaleStr ?? '2');
mkdirSync(outdir, { recursive: true });
for (const f of readdirSync(indir)) {
  if (!f.toLowerCase().endsWith('.png')) continue;
  const img = decodePng(readFileSync(join(indir, f)));
  const out = downscale(img, scale);
  const short = f.replace(/^Screenshot_\d{8}-/, '').replace(/\.png$/, '');
  writeFileSync(join(outdir, `${short}.png`), encodePng(out));
  console.log(`${short}.png ${out.width}x${out.height}`);
}
