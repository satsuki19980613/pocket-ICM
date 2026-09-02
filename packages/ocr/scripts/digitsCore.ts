/**
 * 数字 OCR の較正コア（dev 専用, 共有）。**src/numberField.ts の製品コードをそのまま使う**
 * 薄いアダプタ（Raster→Rgba 変換, 割合矩形→px, 生 NCC score を dev 表示用に返す）。
 * こうすることで dev harness（verifyFrame/tuneField, 実画像 85/88 検証済み）が製品コードを直接保証する。
 * digitsTool.ts / verifyFrame.ts / tuneField.ts が共用。
 */
import { readFileSync } from 'node:fs';
import type { Raster } from './pngCodec.js';
import { bestMatch, type Template } from '../src/match.js';
import { parseAmount } from '../src/digits.js';
import {
  whiteMask as srcWhiteMask,
  digitComponents,
  grayFromRgba,
  DIGIT_NORM_H,
} from '../src/numberField.js';
import { crop, resize } from '../src/raster.js';
import type { Gray, Rect } from '../src/types.js';
import type { Rgba } from '../src/color.js';

export const NH = DIGIT_NORM_H;

/** Raster(pngCodec) → src の Rgba 型。 */
function toRgba(r: Raster): Rgba {
  return { w: r.width, h: r.height, data: r.rgba };
}
/** 割合矩形 → px 矩形。 */
function toPxRect(r: Raster, fx: number, fy: number, fw: number, fh: number): Rect {
  return { x: Math.round(fx * r.width), y: Math.round(fy * r.height), w: Math.round(fw * r.width), h: Math.round(fh * r.height) };
}

/** グリフを高さ NH に正規化（幅アスペクト維持）。 */
export function normGlyph(strip: Gray, r: Rect): Gray {
  const g = crop(strip, r);
  const w = Math.max(1, Math.round((g.w * NH) / g.h));
  return resize(g, w, NH);
}

export type TplStore = Record<string, { w: number; h: number; data: number[] }>;

export function loadTemplates(path: string): Template[] {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { templates: TplStore };
  return Object.entries(raw.templates).map(([label, g]) => ({
    label,
    img: { w: g.w, h: g.h, data: Uint8Array.from(g.data) },
  }));
}

export interface FieldRead {
  readonly text: string;
  readonly value: number | null;
  readonly minScore: number;
  readonly glyphs: { label: string; score: number }[];
}

/**
 * 割合矩形の数字フィールドを認識（src の whiteMask/digitComponents を使い、
 * dev 表示のため生 NCC score も返す）。build 用に rects も露出。
 */
export function recognizeField(
  img: Raster,
  frac: readonly [number, number, number, number],
  templates: readonly Template[],
  opts: { minCh?: number; maxSat?: number } = {},
): FieldRead & { rects: Rect[]; strip: Gray } {
  const rgba = toRgba(img);
  const rect = toPxRect(img, frac[0], frac[1], frac[2], frac[3]);
  const strip = grayFromRgba(rgba, rect);
  const rects = digitComponents(srcWhiteMask(rgba, rect, opts));
  let text = '', minScore = 1;
  const glyphs: { label: string; score: number }[] = [];
  for (const r of rects) {
    const m = bestMatch(normGlyph(strip, r), templates);
    text += m.label;
    glyphs.push({ label: m.label, score: m.score });
    if (m.score < minScore) minScore = m.score;
  }
  return { text, value: parseAmount(text), minScore: rects.length ? minScore : 0, glyphs, rects, strip };
}

/** build 用: 割合矩形の数字グリフ矩形と正規化前ストリップ。 */
export function fieldGlyphRects(
  img: Raster,
  frac: readonly [number, number, number, number],
  opts: { minCh?: number; maxSat?: number } = {},
): { rects: Rect[]; strip: Gray } {
  const rgba = toRgba(img);
  const rect = toPxRect(img, frac[0], frac[1], frac[2], frac[3]);
  const strip = grayFromRgba(rgba, rect);
  const rects = digitComponents(srcWhiteMask(rgba, rect, opts));
  return { rects, strip };
}
