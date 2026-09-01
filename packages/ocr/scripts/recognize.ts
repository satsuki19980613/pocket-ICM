/**
 * 較正ツール（dev 専用）: テンプレ JSON を使ってカード角を認識し、
 * 私（AI）の目視ラベルと OCR 出力を照合する（accuracy 検証の中核）。
 *
 * 使い方:
 *   tsx recognize.ts <templates.json> <input.png> <true:x,y,w,h> ...
 * true は私が目視で読んだ正解ラベル。OCR 出力と一致するか件数で報告する。
 */
import { readFileSync } from 'node:fs';
import { decodePng, type Raster } from './pngCodec.js';
import { bestMatch, matchConfidence, type Template } from '../src/match.js';
import type { Gray } from '../src/types.js';

function cropGray(r: Raster, fx: number, fy: number, fw: number, fh: number): Gray {
  const x0 = Math.max(0, Math.round(fx * r.width));
  const y0 = Math.max(0, Math.round(fy * r.height));
  const w = Math.min(r.width - x0, Math.round(fw * r.width));
  const h = Math.min(r.height - y0, Math.round(fh * r.height));
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = ((y0 + y) * r.width + (x0 + x)) * 4;
      data[y * w + x] = (r.rgba[s]! * 77 + r.rgba[s + 1]! * 150 + r.rgba[s + 2]! * 29) >> 8;
    }
  return { w, h, data };
}

const [, , tplPath, input, ...specs] = process.argv;
if (!tplPath || !input || specs.length === 0) {
  console.error('usage: recognize.ts <templates.json> <input.png> <true:x,y,w,h> ...');
  process.exit(1);
}
const tplRaw = JSON.parse(readFileSync(tplPath, 'utf8')) as {
  templates: Record<string, { w: number; h: number; data: number[] }>;
};
const templates: Template[] = Object.entries(tplRaw.templates).map(([label, g]) => ({
  label,
  img: { w: g.w, h: g.h, data: Uint8Array.from(g.data) },
}));

const img = decodePng(readFileSync(input));
let correct = 0;
let total = 0;
for (const spec of specs) {
  const idx = spec.indexOf(':');
  const truth = spec.slice(0, idx);
  const [x, y, w, h] = spec.slice(idx + 1).split(',').map(Number);
  const cand = cropGray(img, x!, y!, w!, h!);
  const m = bestMatch(cand, templates);
  const conf = matchConfidence(m).toFixed(2);
  const ok = m.label === truth;
  total++;
  if (ok) correct++;
  console.log(
    `${ok ? 'OK ' : 'XX '} truth=${truth.padEnd(3)} ocr=${m.label.padEnd(3)} score=${m.score.toFixed(3)} margin=${m.margin.toFixed(3)} conf=${conf}`,
  );
}
console.log(`\n目視 vs OCR 一致: ${correct}/${total}`);
