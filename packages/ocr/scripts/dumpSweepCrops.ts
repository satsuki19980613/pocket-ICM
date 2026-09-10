/**
 * sweepActionMarks.ts の出力（JSON）を目視検証するためのクロップ書き出し（dev）。
 *
 * 各ヒットについて、報告されたプレート矩形そのもの（狭いクロップ）と、その周囲を広く
 * 取った文脈クロップ（帯全体＋アバター）の 2 枚を PNG で書き出す。AI がこれを Read で
 * 実際に見て TRUE/FALSE を判定する（[[ocr-accuracy-verification]] の規律: 数値だけで
 * 真偽を決めない）。
 *
 * 使い方: npx tsx scripts/dumpSweepCrops.ts <sweep.json> <outDir> [--start N] [--count N]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng, encodePng, type Raster } from './pngCodec.js';
import { normalizeForAnchors } from '../src/upscaleNormalize.js';
import type { Rgba } from '../src/color.js';

const DIR = 'local-fixtures';
const args = process.argv.slice(2);
const jsonPath = args[0]!;
const outDir = args[1]!;
const startIdx = args.includes('--start') ? Number(args[args.indexOf('--start') + 1]) : 0;
const count = args.includes('--count') ? Number(args[args.indexOf('--count') + 1]) : Infinity;
mkdirSync(outDir, { recursive: true });

interface Hit {
  file: string;
  slot: string;
  action: string;
  plateX: number | null;
  plateY: number | null;
  plateW: number | null;
  plateH: number | null;
}
const hits: Hit[] = JSON.parse(readFileSync(jsonPath, 'utf8'));

const cropRgbaToPng = (img: Rgba, r: { x: number; y: number; w: number; h: number }): Raster => {
  const x0 = Math.max(0, r.x), y0 = Math.max(0, r.y);
  const w = Math.max(1, Math.min(img.w - x0, r.w));
  const h = Math.max(1, Math.min(img.h - y0, r.h));
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = ((y0 + y) * img.w + (x0 + x)) * 4;
      const d = (y * w + x) * 4;
      rgba[d] = img.data[s] ?? 0; rgba[d + 1] = img.data[s + 1] ?? 0;
      rgba[d + 2] = img.data[s + 2] ?? 0; rgba[d + 3] = 255;
    }
  return { width: w, height: h, rgba };
};

const cache = new Map<string, Rgba>();
function loadNorm(file: string): Rgba | null {
  if (cache.has(file)) return cache.get(file)!;
  try {
    const dec = decodePng(readFileSync(join(DIR, file)));
    const img: Rgba = { w: dec.width, h: dec.height, data: dec.rgba };
    const { img: nimg } = normalizeForAnchors(img);
    cache.set(file, nimg);
    return nimg;
  } catch {
    return null;
  }
}

const end = Math.min(hits.length, startIdx + count);
let written = 0;
for (let i = startIdx; i < end; i++) {
  const h = hits[i]!;
  if (h.plateX === null || h.plateW === null) continue;
  const nimg = loadNorm(h.file);
  if (!nimg) continue;
  const plateRect = { x: h.plateX, y: h.plateY!, w: h.plateW, h: h.plateH! };
  const pad = 2.5;
  const ctxRect = {
    x: Math.round(plateRect.x - pad * plateRect.w),
    y: Math.round(plateRect.y - pad * plateRect.h),
    w: Math.round(plateRect.w * (1 + 2 * pad)),
    h: Math.round(plateRect.h * (1 + 2 * pad)),
  };
  const base = `${String(i).padStart(3, '0')}_${h.action}_${h.slot}_${h.file.replace(/\.png$/i, '').replace(/[^\w.-]/g, '_')}`;
  writeFileSync(join(outDir, `${base}_plate.png`), encodePng(cropRgbaToPng(nimg, plateRect)));
  writeFileSync(join(outDir, `${base}_ctx.png`), encodePng(cropRgbaToPng(nimg, ctxRect)));
  written++;
}
console.log(`wrote ${written * 2} PNGs (index ${startIdx}..${end - 1}) to ${outDir}`);
