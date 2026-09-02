/** dev: 広めのゾーンで白文字クラスタを全ダンプ（アクションタグの正確な位置較正用）。 */
import { readFileSync } from 'node:fs';
import { decodePng } from './pngCodec.js';
import { whiteMask, binaryComponents } from '../src/numberField.js';
import type { Rgba } from '../src/color.js';
import type { Rect } from '../src/types.js';

const DIR = 'local-fixtures';
// 引数: frame x y w h（割合, 広め）。
const [frame, xs, ys, ws, hs] = process.argv.slice(2);
const pre = frame!.startsWith('11') || frame!.startsWith('12') ? '20260902' : '20260901';
const img = decodePng(readFileSync(`${DIR}/Screenshot_${pre}-${frame}.png`));
const rgba: Rgba = { w: img.width, h: img.height, data: img.rgba };
const zx = +xs! * rgba.w, zy = +ys! * rgba.h, zw = +ws! * rgba.w, zh = +hs! * rgba.h;
const rect: Rect = { x: Math.round(zx), y: Math.round(zy), w: Math.round(zw), h: Math.round(zh) };
console.log(`zone px ${rect.x},${rect.y},${rect.w},${rect.h}`);
const comps = binaryComponents(whiteMask(rgba, rect, { minCh: 125, maxSat: 70 })).sort((a, b) => a.x - b.x);
// x ギャップでクラスタ化（actionTag と同様 gapMax=0.6*h だが h はマスク高）。
const gapMax = 0.6 * rect.h;
type Cl = { x0: number; y0: number; x1: number; y1: number; area: number; n: number };
const cls: Cl[] = []; let cur: Cl | null = null;
for (const c of comps) {
  if (cur && c.x - cur.x1 <= gapMax) { cur.area += c.w * c.h; cur.n++; cur.x0 = Math.min(cur.x0, c.x); cur.y0 = Math.min(cur.y0, c.y); cur.x1 = Math.max(cur.x1, c.x + c.w); cur.y1 = Math.max(cur.y1, c.y + c.h); }
  else { cur = { x0: c.x, y0: c.y, x1: c.x + c.w, y1: c.y + c.h, area: c.w * c.h, n: 1 }; cls.push(cur); }
}
cls.sort((a, b) => b.area - a.area);
for (const c of cls.slice(0, 6)) {
  // ゾーン内相対→フレーム割合も出す
  const fx = (rect.x + c.x0) / rgba.w, fy = (rect.y + c.y0) / rgba.h;
  const fw = (c.x1 - c.x0) / rgba.w, fh = (c.y1 - c.y0) / rgba.h;
  console.log(`  cluster n${c.n} box ${c.x1 - c.x0}x${c.y1 - c.y0} area${c.area} @zone(${c.x0},${c.y0})  frac x${fx.toFixed(3)} y${fy.toFixed(3)} w${fw.toFixed(3)} h${fh.toFixed(3)}`);
}
