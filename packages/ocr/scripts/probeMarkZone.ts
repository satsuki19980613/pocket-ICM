/**
 * マーク探索帯の較正用プローブ（dev）。
 *
 * 指定フレームの指定席について、`markZoneRect` が作る帯を PNG に書き出し、
 * `locateMarkPlate` の結果（プレート矩形・彩度）と、帯の中の「枠線候補行」の一覧を出す。
 * 帯がプレートを外している／背景を拾っているのを目で確かめるために使う。
 *
 * 使い方: npx tsx scripts/probeMarkZone.ts <frame.png> <SLOT...> [--out <dir>] [--pad <f>]
 *   --pad 0.5 を付けると帯を 1.5 倍に広げて書き出す（帯がプレートを外しているときの原因調査用）。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng, encodePng, type Raster } from './pngCodec.js';
import { normalizeForAnchors } from '../src/upscaleNormalize.js';
import { enumerateSeats, type Slot } from '../src/seatEnum.js';
import { markZoneRect, pickMarkGrid } from '../src/actionMarkZone.js';
import { locateMarkPlate } from '../src/actionMark.js';
import { whiteMask } from '../src/numberField.js';
import type { Rgba } from '../src/color.js';
import type { Rect } from '../src/types.js';

const args = process.argv.slice(2);
const frame = args[0]!;
const outDir = args.includes('--out') ? args[args.indexOf('--out') + 1]! : 'local-fixtures/_markzone';
const pad = args.includes('--pad') ? Number(args[args.indexOf('--pad') + 1]) : 0;
const slots = args.slice(1).filter((a) => /^(TL|TC|TR|BR|BC|BL)$/.test(a)) as Slot[];
mkdirSync(outDir, { recursive: true });

const img: Rgba = (() => {
  const r = decodePng(readFileSync(frame.includes('/') ? frame : join('local-fixtures', frame)));
  return { w: r.width, h: r.height, data: r.rgba };
})();
const { img: nimg } = normalizeForAnchors(img);
const enr = enumerateSeats(img);

const cropPng = (src: Rgba, r: Rect): Raster => {
  const w = Math.max(1, Math.min(src.w - Math.max(0, r.x), r.w));
  const h = Math.max(1, Math.min(src.h - Math.max(0, r.y), r.h));
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = ((Math.max(0, r.y) + y) * src.w + (Math.max(0, r.x) + x)) * 4;
      const d = (y * w + x) * 4;
      rgba[d] = src.data[s] ?? 0; rgba[d + 1] = src.data[s + 1] ?? 0;
      rgba[d + 2] = src.data[s + 2] ?? 0; rgba[d + 3] = 255;
    }
  return { width: w, height: h, rgba };
};

console.log(`frame ${frame}  raw ${img.w}x${img.h}  norm ${nimg.w}x${nimg.h}  aspect ${(img.w / img.h).toFixed(4)}`);
for (const slot of slots) {
  const seat = enr.seats.find((s) => s.slot === slot);
  const zone0 = markZoneRect(nimg, slot, seat?.nameBox, pickMarkGrid(img.w / img.h));
  const zone: Rect = pad
    ? {
        x: Math.round(zone0.x - pad * zone0.w / 2),
        y: Math.round(zone0.y - pad * zone0.h / 2),
        w: Math.round(zone0.w * (1 + pad)),
        h: Math.round(zone0.h * (1 + pad)),
      }
    : zone0;
  const plate = locateMarkPlate(nimg, zone);
  const nb = seat?.nameBox;
  console.log(
    `  ${slot}: occupied=${seat?.occupied} nameBox=${nb ? `${nb.cx.toFixed(0)},${nb.cy.toFixed(0)}` : 'none'}` +
      ` zone=${zone.x},${zone.y} ${zone.w}x${zone.h}` +
      ` plate=${plate ? `${plate.rect.x},${plate.rect.y} ${plate.rect.w}x${plate.rect.h} sat=${plate.meanSat.toFixed(1)}` : 'NOT LOCATED'}`,
  );
  // 枠線候補行の一覧（帯幅比のラン長）。
  const mask = whiteMask(nimg, zone, { minCh: 100, maxSat: 90 });
  const runs: string[] = [];
  for (let y = 0; y < mask.h; y++) {
    let best = 0, cur = 0;
    for (let x = 0; x < mask.w; x++) {
      if (mask.data[y * mask.w + x]! > 0) { cur++; if (cur > best) best = cur; } else cur = 0;
    }
    if (best / mask.w >= 0.35) runs.push(`y${y}:${(best / mask.w).toFixed(2)}`);
  }
  console.log(`    runs(>=0.35w): ${runs.length ? runs.join(' ') : '(none)'}`);
  writeFileSync(join(outDir, `${slot}_zone.png`), encodePng(cropPng(nimg, zone)));
}
console.log(`\nwrote zone PNGs to ${outDir}`);
