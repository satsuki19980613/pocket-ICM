/** dev: フレーム+席の actionZone で findTagBox＋全テンプレNCCスコアを出す（レイズ↔コール等の診断）。 */
import { readFileSync } from 'node:fs';
import { decodePng } from './pngCodec.js';
import { CHIPS_6MAX, type ScreenSeat } from '../src/frameProfile.js';
import { toPx } from '../src/layout.js';
import { findTagBox, normTag } from '../src/actionTag.js';
import { ncc, type Template } from '../src/match.js';
import { resize } from '../src/raster.js';
import type { Rgba } from '../src/color.js';

const DIR = 'local-fixtures';
function load(path: string): Template[] {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as any; const t = raw.templates ?? raw;
  return t.map((g: any) => ({ label: g.label, img: { w: g.w, h: g.h, data: Uint8Array.from(g.data) } }));
}
const actions = load(`${DIR}/actions.json`);

// 引数: frame seat（例: 142826 TR）。複数ペアを続けて指定可。
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  const frame = args[i]!; const seatId = args[i + 1] as ScreenSeat;
  const pre = frame.startsWith('11') || frame.startsWith('12') ? '20260902' : '20260901';
  const img = decodePng(readFileSync(`${DIR}/Screenshot_${pre}-${frame}.png`));
  const rgba: Rgba = { w: img.width, h: img.height, data: img.rgba };
  const seat = CHIPS_6MAX.seats.find((s) => s.screen === seatId)!;
  const rect = toPx(seat.actionZone, rgba.w, rgba.h);
  const box = findTagBox(rgba, rect, { minTextAreaFrac: 0.03, confFloor: 0.3 });
  if (!box) { console.log(`${frame} ${seatId}: box なし`); continue; }
  const cand = normTag(rgba, box.rect);
  const scores = actions.map((t) => {
    const c = cand.w === t.img.w && cand.h === t.img.h ? cand : resize(cand, t.img.w, t.img.h);
    return { label: t.label, s: ncc(c, t.img) };
  }).sort((a, b) => b.s - a.s);
  const top = scores.slice(0, 5).map((x) => `${x.label}:${x.s.toFixed(2)}`).join(' ');
  console.log(`${frame} ${seatId}: box ${box.rect.w}x${box.rect.h}  ${top}`);
}
