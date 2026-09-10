/**
 * マーク位置グリッドの実測（dev）。
 *
 * 正解ラベル（accuracy*.groundtruth.json の action != none）を持つ (フレーム, 席) について、
 * **広い探索帯**で `locateMarkPlate` を走らせ、見つかったプレート矩形を**フラクショナル座標**で
 * 出す。解像度（＝アスペクト帯）×席ごとに集計して、静的グリッド（src/actionMarkZone.ts の
 * MARK_GRID）の値を決めるのに使う。
 *
 * 席名 nameBox にアンカーする方式は、装飾テーマ卓（薔薇・コイン等の黄色装飾）で
 * 名前重心が引っ張られて帯がプレートを外す（実測: 20260902-203304 の BR で 0.06h ずれ）。
 * 静的グリッドはその影響を受けない。
 *
 * 使い方: npx tsx scripts/measureMarkGrid.ts [--json <out.json>]
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng } from './pngCodec.js';
import { normalizeForAnchors } from '../src/upscaleNormalize.js';
import { SLOT_ANCHORS, SLOTS, type Slot } from '../src/seatEnum.js';
import { locateMarkPlate } from '../src/actionMark.js';
import type { Rgba } from '../src/color.js';
import type { Rect } from '../src/types.js';

const DIR = 'local-fixtures';
const GTS = [
  'scripts/accuracy.groundtruth.json',
  'scripts/accuracy.iphone.groundtruth.json',
  'scripts/accuracy.multidev.groundtruth.json',
];

/** 席アンカー中心から見た「マークがあるはず」の粗い中心（全席ほぼ 0.17h 上）。 */
const COARSE_DY = -0.175;
/** 広い探索帯の寸法（フラクショナル）。プレート実寸 ~0.057×0.043 の 3 倍弱。 */
const WIDE_W = 0.16;
const WIDE_H = 0.13;

interface Row {
  frame: string;
  w: number;
  h: number;
  aspect: number;
  slot: Slot;
  truth: string;
  cx: number;
  cy: number;
  pw: number;
  ph: number;
  sat: number;
}

const rows: Row[] = [];
const misses: string[] = [];

for (const gt of GTS) {
  const frames = JSON.parse(readFileSync(gt, 'utf8')).frames as Record<
    string,
    { seats?: Record<string, { occ?: string; action?: string }> }
  >;
  for (const [name, fr] of Object.entries(frames)) {
    const p = join(DIR, name);
    if (!existsSync(p)) continue;
    const dec = decodePng(readFileSync(p));
    const img: Rgba = { w: dec.width, h: dec.height, data: dec.rgba };
    const { img: nimg } = normalizeForAnchors(img);
    for (const slot of SLOTS) {
      const s = fr.seats?.[slot];
      if (!s || s.occ !== 'occupied') continue;
      const truth = s.action ?? 'none';
      if (truth === 'none') continue; // グリッド較正はマークが有る席だけで行う
      const a = SLOT_ANCHORS[slot];
      const zone: Rect = {
        x: Math.round((a.x - WIDE_W / 2) * nimg.w),
        y: Math.round((a.y + COARSE_DY - WIDE_H / 2) * nimg.h),
        w: Math.round(WIDE_W * nimg.w),
        h: Math.round(WIDE_H * nimg.h),
      };
      const plate = locateMarkPlate(nimg, zone, {
        runPxMin: 0.040 * nimg.w,
        runPxMax: 0.078 * nimg.w,
      });
      if (!plate) {
        misses.push(`${name}\t${slot}\t${truth}`);
        continue;
      }
      rows.push({
        frame: name,
        w: dec.width,
        h: dec.height,
        aspect: dec.width / dec.height,
        slot,
        truth,
        cx: (plate.rect.x + plate.rect.w / 2) / nimg.w,
        cy: (plate.rect.y + plate.rect.h / 2) / nimg.h,
        pw: plate.rect.w / nimg.w,
        ph: plate.rect.h / nimg.h,
        sat: plate.meanSat,
      });
    }
  }
}

// --- 集計: 解像度 × 席 ---
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? NaN : s[Math.floor(s.length / 2)]!;
};
const key = (r: Row) => `${r.w}x${r.h}`;
const bands = [...new Set(rows.map(key))].sort();
const grid: Record<string, Record<string, unknown>> = {};

console.log('=== per-instance ===');
for (const r of rows) {
  console.log(
    `${r.frame.padEnd(42)} ${r.slot} ${r.truth.padEnd(5)} c=(${r.cx.toFixed(4)},${r.cy.toFixed(4)}) ` +
      `size=(${r.pw.toFixed(4)},${r.ph.toFixed(4)}) sat=${r.sat.toFixed(1)}`,
  );
}
console.log(`\nmisses: ${misses.length}`);
for (const m of misses) console.log('  ' + m);

console.log('\n=== grid (median per band x slot) ===');
for (const b of bands) {
  const br = rows.filter((r) => key(r) === b);
  grid[b] = { aspect: Number((br[0]!.aspect).toFixed(4)), slots: {} };
  const slotsOut = (grid[b] as { slots: Record<string, unknown> }).slots;
  console.log(`[${b}] aspect ${br[0]!.aspect.toFixed(4)}  n=${br.length}`);
  for (const slot of SLOTS) {
    const sr = br.filter((r) => r.slot === slot);
    if (sr.length === 0) { console.log(`  ${slot}: no sample`); continue; }
    const cx = median(sr.map((r) => r.cx));
    const cy = median(sr.map((r) => r.cy));
    const pw = median(sr.map((r) => r.pw));
    const ph = median(sr.map((r) => r.ph));
    const spread = (xs: number[]) => (Math.max(...xs) - Math.min(...xs)).toFixed(4);
    slotsOut[slot] = { cx: +cx.toFixed(4), cy: +cy.toFixed(4), pw: +pw.toFixed(4), ph: +ph.toFixed(4), n: sr.length };
    console.log(
      `  ${slot}: n=${sr.length} c=(${cx.toFixed(4)},${cy.toFixed(4)}) size=(${pw.toFixed(4)},${ph.toFixed(4)}) ` +
        `spread cx=${spread(sr.map((r) => r.cx))} cy=${spread(sr.map((r) => r.cy))}`,
    );
  }
}

const outIdx = process.argv.indexOf('--json');
if (outIdx >= 0) {
  writeFileSync(process.argv[outIdx + 1]!, JSON.stringify({ rows, misses, grid }, null, 2), 'utf8');
  console.log(`\n(JSON: ${process.argv[outIdx + 1]})`);
}
