/**
 * 能動アクション語テンプレ生成（dev, 多例）。既知フレームの席探索帯から findTagBox で文字
 * 矩形を検出→正規化し、**語ごとに複数の出現**を actions.json（配列形式）に保存。席・フレーム
 * 差を多例テンプレで吸収する。src/actionTag.ts をそのまま使う（単一の真実）。
 * fold は扱わない（カード状態から別途判定）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { decodePng, type Raster } from './pngCodec.js';
import { findTagBox, normTag } from '../src/actionTag.js';
import type { Rgba } from '../src/color.js';
import type { Rect } from '../src/types.js';

const DIR = 'local-fixtures';
const f = (n: string) => `${DIR}/Screenshot_20260901-${n}.png`;
const toRgba = (r: Raster): Rgba => ({ w: r.width, h: r.height, data: r.rgba });
const px = (r: Raster, fr: readonly number[]): Rect => ({ x: Math.round(fr[0]! * r.width), y: Math.round(fr[1]! * r.height), w: Math.round(fr[2]! * r.width), h: Math.round(fr[3]! * r.height) });

// [word, frame, searchZone(割合)] — 語ごとに観測できた全出現を列挙（多例）。
const SPECS: [string, string, readonly number[]][] = [
  ['レイズ', '142826', [0.68, 0.09, 0.17, 0.06]],
  ['レイズ', '101510', [0.14, 0.075, 0.17, 0.065]],
  ['レイズ', '103554', [0.77, 0.51, 0.17, 0.06]],
  ['コール', '101510', [0.66, 0.09, 0.17, 0.065]],
  ['オールイン', '101510', [0.35, 0.545, 0.20, 0.055]],
  ['チェック', '143035', [0.43, 0.03, 0.16, 0.06]],
  ['チェック', '143035', [0.66, 0.09, 0.17, 0.065]],
];

const templates: { label: string; w: number; h: number; data: number[] }[] = [];
for (const [word, frame, zone] of SPECS) {
  const img = decodePng(readFileSync(f(frame)));
  const rgba = toRgba(img);
  const box = findTagBox(rgba, px(img, zone));
  if (!box) { console.log(`XX ${word} (${frame}): タグ未検出`); continue; }
  const norm = normTag(rgba, box.rect);
  templates.push({ label: word, w: norm.w, h: norm.h, data: Array.from(norm.data) });
  console.log(`OK ${word.padEnd(6)} (${frame}): box ${box.rect.w}x${box.rect.h} -> norm ${norm.w}x${norm.h}`);
}
writeFileSync(`${DIR}/actions.json`, JSON.stringify({ source: 'dev calibration (multi-exemplar)', templates }));
console.log(`\nwrote ${DIR}/actions.json with ${templates.length} exemplars`);
