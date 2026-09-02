/**
 * 抽出層較正の probe（dev 専用）。src の純ロジックを実画像に当てて blinds 分割・
 * street（ボード枚数）を検証する。commit 前の座標・しきい値詰め用。
 */
import { readFileSync } from 'node:fs';
import { decodePng, type Raster } from './pngCodec.js';
import { bestMatch, matchConfidence, type Template } from '../src/match.js';
import { whiteMask, digitComponents, grayFromRgba } from '../src/numberField.js';
import { crop, resize } from '../src/raster.js';
import { findCardRects } from '../src/detect.js';
import { parseAmount } from '../src/digits.js';
import { loadTemplates, normGlyph } from './digitsCore.js';
import type { Rgba } from '../src/color.js';
import type { Gray, Rect } from '../src/types.js';

const DIR = 'local-fixtures';
const f = (n: string) => `${DIR}/Screenshot_20260901-${n}.png`;
const toRgba = (r: Raster): Rgba => ({ w: r.width, h: r.height, data: r.rgba });
const px = (r: Raster, fr: readonly number[]): Rect => ({ x: Math.round(fr[0]! * r.width), y: Math.round(fr[1]! * r.height), w: Math.round(fr[2]! * r.width), h: Math.round(fr[3]! * r.height) });

const templates = loadTemplates(`${DIR}/digits.json`);

/** blindsnum 領域（"330/660"）を認識して文字列化。'/' は slashTpl でマッチ。 */
function readGlyphStr(img: Raster, fr: readonly number[], tpls: readonly Template[], minCh?: number): { text: string; comps: number } {
  const rgba = toRgba(img);
  const rect = px(img, fr);
  const strip = grayFromRgba(rgba, rect);
  const rects = digitComponents(whiteMask(rgba, rect, minCh !== undefined ? { minCh } : {}));
  let text = '';
  for (const r of rects) {
    const m = bestMatch(normGlyph(strip, r), tpls);
    text += m.label;
  }
  return { text, comps: rects.length };
}

/** 中央ボードのカード枚数（preflop=0）。 */
function boardCount(img: Raster, fr: readonly number[]): number {
  const rgba = toRgba(img);
  const g = grayFromRgba(rgba, px(img, fr));
  return findCardRects(g, { threshold: 190, minAreaFrac: 0.01, closeRadius: 1 }).length;
}

// --- blindsnum の座標候補 ---
const BLINDS_NUM = [0.172, 0.012, 0.084, 0.044] as const;
const BOARD = [0.30, 0.34, 0.40, 0.22] as const;

function splitBlinds(text: string): { sb: number | null; bb: number | null } {
  const [a, b] = text.split('/');
  return { sb: a ? parseAmount(a) : null, bb: b ? parseAmount(b) : null };
}

console.log('=== blinds（"/"テンプレあり, 分割）===');
for (const [n, truth] of [['142820', '330/660'], ['143007', '400/800'], ['143026', '480/960'], ['143240', '1200/2400'], ['142903', '330/660'], ['143020', '400/800']] as const) {
  const img = decodePng(readFileSync(f(n)));
  const r = readGlyphStr(img, BLINDS_NUM, templates);
  const s = splitBlinds(r.text);
  const ok = truth === `${s.sb}/${s.bb}`;
  console.log(`${ok ? 'OK' : 'XX'} ${n} truth=${truth.padEnd(10)} read="${r.text}" -> sb=${s.sb} bb=${s.bb}`);
}

console.log('\n=== board count（preflop=0）===');
for (const [n, kind] of [['142820', 'preflop'], ['142903', 'preflop'], ['143007', 'preflop'], ['143035', 'turn(4)'], ['143108', 'showdown']] as const) {
  const img = decodePng(readFileSync(f(n)));
  console.log(`${n} ${kind.padEnd(12)} boardCount=${boardCount(img, BOARD)}`);
}
