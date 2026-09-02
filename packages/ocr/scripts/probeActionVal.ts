/** dev: 検証済みGTのアクティブ席で recognizeAction（profile actionZone）を照合。 */
import { readFileSync } from 'node:fs';
import { decodePng } from './pngCodec.js';
import { CHIPS_6MAX, type ScreenSeat } from '../src/frameProfile.js';
import { toPx } from '../src/layout.js';
import { recognizeAction, ACTION_WORDS } from '../src/actionTag.js';
import type { Template } from '../src/match.js';
import type { Rgba } from '../src/color.js';
import type { SeatAction } from '../src/types.js';

const DIR = 'local-fixtures';
function load(path: string): Template[] {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as any; const t = raw.templates ?? raw;
  return t.map((g: any) => ({ label: g.label, img: { w: g.w, h: g.h, data: Uint8Array.from(g.data) } }));
}
const actions = load(`${DIR}/actions.json`);
const W: Record<string, SeatAction> = { 'レイズ': 'raise', 'コール': 'call', 'オールイン': 'allin', 'チェック': 'check' };

// 検証済み GT（アクティブタグのみ）。[frame, seat, 語]。
const GT: [string, ScreenSeat, keyof typeof W][] = [
  ['142826', 'TR', 'レイズ'],
  ['101510', 'TL', 'レイズ'], ['103554', 'BR', 'レイズ'], ['114640', 'TL', 'レイズ'], ['114643', 'TL', 'レイズ'],
  ['101510', 'TR', 'コール'], ['115034', 'TL', 'コール'], ['115037', 'TL', 'コール'],
  ['114640', 'BR', 'コール'], ['114643', 'BR', 'コール'],
  ['123731', 'TC', 'コール'], ['124620', 'TC', 'コール'], ['124738', 'TC', 'コール'],
  ['101510', 'BC', 'オールイン'], ['115309', 'TR', 'オールイン'], ['115313', 'TR', 'オールイン'], ['123636', 'TC', 'オールイン'],
  ['143035', 'TR', 'チェック'], ['143035', 'TC', 'チェック'],
];
const path = (f: string) => `${DIR}/Screenshot_${f.startsWith('11') || f.startsWith('12') ? '20260902' : '20260901'}-${f}.png`;

let ok = 0; const bad: string[] = [];
for (const [frame, seatId, word] of GT) {
  const img = decodePng(readFileSync(path(frame)));
  const rgba: Rgba = { w: img.width, h: img.height, data: img.rgba };
  const seat = CHIPS_6MAX.seats.find((s) => s.screen === seatId)!;
  const r = recognizeAction(rgba, toPx(seat.actionZone, rgba.w, rgba.h), actions);
  const want = W[word];
  const m = r.value === want;
  if (m) ok++; else bad.push(`${frame} ${seatId}: got ${r.value}(${r.conf.toFixed(2)}) want ${want}(${word})`);
}
console.log(`action recognize (GT active): ${ok}/${GT.length}`);
if (bad.length) console.log(bad.join('\n'));

// 誤検出チェック: 'なし'（居るがタグ無し）席は none を返すべき。
const NONE: [string, ScreenSeat][] = [
  ['142826', 'BC'], ['142826', 'BL'], ['143035', 'BC'], ['101510', 'BL'],
  ['103554', 'TL'], ['103554', 'TC'], ['103554', 'BL'], ['114640', 'BC'],
  ['115034', 'BC'], ['115309', 'TL'], ['115309', 'BC'], ['123636', 'BC'],
  ['123731', 'BC'], ['124620', 'BC'], ['124738', 'BC'],
];
let nok = 0; const nbad: string[] = [];
for (const [frame, seatId] of NONE) {
  const img = decodePng(readFileSync(path(frame)));
  const rgba: Rgba = { w: img.width, h: img.height, data: img.rgba };
  const seat = CHIPS_6MAX.seats.find((s) => s.screen === seatId)!;
  const r = recognizeAction(rgba, toPx(seat.actionZone, rgba.w, rgba.h), actions);
  if (r.value === 'none') nok++; else nbad.push(`${frame} ${seatId}: 誤検出 ${r.value}(${r.conf.toFixed(2)})`);
}
console.log(`none 席 誤検出なし: ${nok}/${NONE.length}`);
if (nbad.length) console.log(nbad.join('\n'));
