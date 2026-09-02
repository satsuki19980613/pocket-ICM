/** dev: 全 BB frame の hero スタックを readAmountBb で読み、地上真実(AI目視)と照合。 */
import { readFileSync } from 'node:fs';
import { decodePng } from './pngCodec.js';
import { CHIPS_6MAX } from '../src/frameProfile.js';
import { toPx } from '../src/layout.js';
import { readAmountBb } from '../src/bbAmount.js';
import type { Template } from '../src/match.js';
import type { Rgba } from '../src/color.js';

const DIR = 'local-fixtures';
function load(path: string): Template[] {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as any;
  const t = raw.templates ?? raw;
  if (Array.isArray(t)) return t.map((g: any) => ({ label: g.label, img: { w: g.w, h: g.h, data: Uint8Array.from(g.data) } }));
  return Object.entries(t).map(([label, g]: any) => ({ label, img: { w: g.w, h: g.h, data: Uint8Array.from(g.data) } }));
}
const digits = load(`${DIR}/digits.json`).filter((t) => t.label !== '/'); // '/' は除外

// 地上真実（AI 目視, hero さつき）。
const GT: Record<string, number> = {
  '142936': 20.2, '142947': 6.9, '142955': 5.4, '143002': 5.2,
  '114437': 15.1, '114522': 14.9, '114544': 14.6, '114602': 14.4, '114640': 13.1,
  '114700': 12.4, '114717': 8.6, '114732': 27.5, '114751': 26.2, '114808': 25.5,
  '114832': 25.2, '114851': 26.2, '114922': 25.5, '114934': 23.4, '114951': 15.6,
  '115004': 14.8, '115018': 14.5, '115034': 15.6,
  '115048': 14.8, '115108': 13.3, '115121': 12.5, '115142': 12.3, '115158': 25.1,
  '115211': 24.3, '115213': 24.3, '115220': 24, '115309': 21.1, '115329': 52.2,
  '115331': 52.2, '123636': 17, '123649': 27.6, '123651': 27.6, '123704': 24.9,
  '123717': 23.1, '123731': 17, '124600': 19.7, '124620': 23, '124645': 25.7,
  '124700': 26.5, '124723': 25.7, '124738': 24,
};

const hero = CHIPS_6MAX.seats.find((s) => s.isHero)!;
let ok = 0, tot = 0;
const bad: string[] = [];
for (const [id, gt] of Object.entries(GT)) {
  const prefix = id.startsWith('11') || id.startsWith('12') ? '20260902' : '20260901';
  const img = decodePng(readFileSync(`${DIR}/Screenshot_${prefix}-${id}.png`));
  const rgba: Rgba = { w: img.width, h: img.height, data: img.rgba };
  const rect = toPx(hero.stack, rgba.w, rgba.h);
  const r = readAmountBb(rgba, rect, digits);
  const match = Math.abs(r.value - gt) < 0.05;
  tot++; if (match) ok++; else bad.push(`${id}: got ${r.value}(${r.conf.toFixed(2)}) want ${gt}`);
  console.log(`${match ? 'OK ' : 'XX '} ${id} got=${Number.isFinite(r.value) ? r.value : 'NaN'}(${r.conf.toFixed(2)}) want=${gt}`);
}
console.log(`\n=== hero BB read: ${ok}/${tot} ===`);
if (bad.length) console.log('MISMATCH:\n' + bad.join('\n'));
