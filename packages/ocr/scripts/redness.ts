/**
 * 較正ツール（dev 専用）: 検出カードの角の「インク赤み」を測り、スート色（赤/黒）判定の
 * 妥当性を AI 目視スートと照合する。使い方:
 *   tsx redness.ts <input.png> <zx,zy,zw,zh> <threshold> <truthSuit,...>  (truthSuit は h/d/s/c を検出順)
 */
import { readFileSync } from 'node:fs';
import { decodePng, type Raster } from './pngCodec.js';
import { findCardRects, cornerOf } from '../src/detect.js';
import type { Gray } from '../src/types.js';

function toGraySub(r: Raster, x0: number, y0: number, w: number, h: number): Gray {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = ((y0 + y) * r.width + (x0 + x)) * 4;
      data[y * w + x] = (r.rgba[s]! * 77 + r.rgba[s + 1]! * 150 + r.rgba[s + 2]! * 29) >> 8;
    }
  return { w, h, data };
}

/** 角領域のインク画素の平均 RGB（白背景を除外）。 */
function inkRGB(r: Raster, gx: number, gy: number, gw: number, gh: number): { R: number; G: number; B: number; ink: number } {
  let sr = 0, sg = 0, sb = 0, ink = 0;
  for (let y = 0; y < gh; y++)
    for (let x = 0; x < gw; x++) {
      const s = ((gy + y) * r.width + (gx + x)) * 4;
      const R = r.rgba[s]!, G = r.rgba[s + 1]!, B = r.rgba[s + 2]!;
      const bright = (R * 77 + G * 150 + B * 29) >> 8;
      if (bright > 200) continue;
      sr += R; sg += G; sb += B; ink++;
    }
  return { R: ink ? sr / ink : 0, G: ink ? sg / ink : 0, B: ink ? sb / ink : 0, ink };
}

/** 4 色デッキのスート判定（♠=黒, ♥=赤, ♦=青, ♣=緑）。 */
function suitByColor(R: number, G: number, B: number): 's' | 'h' | 'd' | 'c' {
  const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
  if (mx - mn < 35) return 's'; // 低彩度＝黒＝スペード
  if (R >= G && R >= B) return 'h'; // 赤＝ハート
  if (B >= R && B >= G) return 'd'; // 青＝ダイヤ
  return 'c'; // 緑＝クラブ
}

const [, , input, zoneStr, thStr, truthStr] = process.argv;
const [zx, zy, zw, zh] = zoneStr!.split(',').map(Number);
const truth = (truthStr ?? '').split(',').filter(Boolean);
const img = decodePng(readFileSync(input));
const x0 = Math.round(zx! * img.width), y0 = Math.round(zy! * img.height);
const w = Math.round(zw! * img.width), h = Math.round(zh! * img.height);
const gray = toGraySub(img, x0, y0, w, h);
const rects = findCardRects(gray, { threshold: Number(thStr), minAreaFrac: 0.008, aspectRange: [0.4, 0.78], minFill: 0.3 });
console.log(`detected ${rects.length}`);
let ok = 0, n = 0;
rects.forEach((r, i) => {
  const c = cornerOf(r);
  const s = inkRGB(img, x0 + c.x, y0 + c.y, c.w, c.h);
  const pred = suitByColor(s.R, s.G, s.B);
  const t = truth[i];
  const match = t ? (pred === t ? 'OK ' : 'XX ') : '.. ';
  if (t) { n++; if (pred === t) ok++; }
  console.log(`${match} truth=${t ?? '?'} pred=${pred} RGB=(${s.R.toFixed(0)},${s.G.toFixed(0)},${s.B.toFixed(0)}) ink=${s.ink}`);
});
console.log(`\nスート色判定 目視 vs 推定: ${ok}/${n}`);
