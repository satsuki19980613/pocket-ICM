/**
 * 能動アクション語テンプレ生成（dev, 多例）。**検証済み GT（AI 目視, サブエージェント）**の
 * (語, フレーム, 画面席) から、**プロファイルの actionZone**（＝recognizeAction が実際に見る箱）で
 * findTagBox → 正規化して actions.json（配列, 多例）に保存。席・フレーム差を多例で吸収する。
 * src/actionTag.ts と frameProfile をそのまま使う（単一の真実）。fold は扱わない。
 *
 * 旧版はハードコード zone で crop が profile とズレ、本物のレイズが コール に誤マッチしていた。
 * profile zone で採ることで「テンプレ＝抽出時の箱」を一致させ、レイズ↔コール混同を解消する。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { decodePng, type Raster } from './pngCodec.js';
import { findTagBox, normTag } from '../src/actionTag.js';
import { CHIPS_6MAX, type ScreenSeat } from '../src/frameProfile.js';
import { toPx } from '../src/layout.js';
import type { Rgba } from '../src/color.js';

const DIR = 'local-fixtures';
const path = (frame: string) => {
  const pre = frame.startsWith('11') || frame.startsWith('12') ? '20260902' : '20260901';
  return `${DIR}/Screenshot_${pre}-${frame}.png`;
};
const toRgba = (r: Raster): Rgba => ({ w: r.width, h: r.height, data: r.rgba });

// [語, フレーム, 画面席] — 検証済み GT。TL/TR 系（box ~165x64 clean）を主に、席差も多例で吸収。
const SPECS: [string, string, ScreenSeat][] = [
  ['レイズ', '142826', 'TR'],
  ['レイズ', '101510', 'TL'],
  ['レイズ', '114640', 'TL'],
  ['レイズ', '114643', 'TL'],
  ['コール', '101510', 'TR'],
  ['コール', '115034', 'TL'],
  ['コール', '115037', 'TL'],
  ['コール', '124620', 'TC'], // TC 位置（頭上プレート）差を吸収
  ['オールイン', '115309', 'TR'],
  ['オールイン', '115313', 'TR'],
  ['オールイン', '101510', 'BC'],
  ['オールイン', '123636', 'TC'],
  ['チェック', '143035', 'TR'],
  ['チェック', '143035', 'TC'],
];

const templates: { label: string; w: number; h: number; data: number[] }[] = [];
for (const [word, frame, seatId] of SPECS) {
  const img = decodePng(readFileSync(path(frame)));
  const rgba = toRgba(img);
  const seat = CHIPS_6MAX.seats.find((s) => s.screen === seatId)!;
  const zone = toPx(seat.actionZone, rgba.w, rgba.h);
  const box = findTagBox(rgba, zone, { minTextAreaFrac: 0.03 });
  if (!box) { console.log(`XX ${word} (${frame} ${seatId}): タグ未検出`); continue; }
  const norm = normTag(rgba, box.rect);
  templates.push({ label: word, w: norm.w, h: norm.h, data: Array.from(norm.data) });
  console.log(`OK ${word.padEnd(6)} (${frame} ${seatId}): box ${box.rect.w}x${box.rect.h} -> norm ${norm.w}x${norm.h}`);
}
writeFileSync(`${DIR}/actions.json`, JSON.stringify({ source: 'dev calibration (GT-verified, profile zones, multi-exemplar)', templates }));
console.log(`\nwrote ${DIR}/actions.json with ${templates.length} exemplars`);
