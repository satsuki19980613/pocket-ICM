/**
 * 数字 OCR（セグメント＋テンプレートマッチ組み立て）。SPEC §6.3 の #2/#5/#6/#7。
 *
 * 描画フォントが固定なので、数字ストリップを縦投影でグリフに分割し、各グリフを
 * 0-9 / 小数点 のテンプレへ NCC マッチして数値を組み立てる。グリフテンプレは実
 * スクショから生成するが（後続）、分割と組み立てのロジックはここで確定・検証する。
 */

import type { Gray, Rect, Read } from './types.js';
import { crop, otsuThreshold, binarize } from './raster.js';
import { bestMatch, matchConfidence, type Template } from './match.js';

/**
 * 2 値化ストリップを縦投影でグリフ矩形に分割する（左→右）。
 * @param bin 前景=255 の 2 値画像。
 * @param minGap グリフを区切る背景列の最小連続数。
 * @param minInkRows 列を「インクあり」とみなす前景画素の最小数。
 */
export function segmentGlyphs(bin: Gray, minGap = 1, minInkRows = 1): Rect[] {
  const { w, h } = bin;
  const colInk = new Array<number>(w).fill(0);
  for (let x = 0; x < w; x++) {
    let c = 0;
    for (let y = 0; y < h; y++) if (bin.data[y * w + x]! > 0) c++;
    colInk[x] = c;
  }

  const spans: Array<{ x0: number; x1: number }> = [];
  let start = -1;
  let gap = 0;
  for (let x = 0; x < w; x++) {
    const ink = colInk[x]! >= minInkRows;
    if (ink) {
      if (start < 0) start = x;
      gap = 0;
    } else if (start >= 0) {
      gap++;
      if (gap >= minGap) {
        spans.push({ x0: start, x1: x - gap + 1 });
        start = -1;
        gap = 0;
      }
    }
  }
  if (start >= 0) spans.push({ x0: start, x1: w });

  // 各 span を縦方向にインク行へトリム。
  const rects: Rect[] = [];
  for (const s of spans) {
    let y0 = h;
    let y1 = 0;
    for (let y = 0; y < h; y++) {
      let has = false;
      for (let x = s.x0; x < s.x1; x++) {
        if (bin.data[y * w + x]! > 0) {
          has = true;
          break;
        }
      }
      if (has) {
        if (y < y0) y0 = y;
        if (y + 1 > y1) y1 = y + 1;
      }
    }
    if (y1 > y0) rects.push({ x: s.x0, y: y0, w: s.x1 - s.x0, h: y1 - y0 });
  }
  return rects;
}

/** 認識した文字列を数値へ。数字・小数点以外は無視し、'bb' 等の単位は落とす。 */
export function parseAmount(s: string): number | null {
  const cleaned = s.replace(/[^0-9.]/g, '');
  if (cleaned === '' || cleaned === '.') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export interface DigitReadOptions {
  readonly minGap?: number;
  readonly minInkRows?: number;
  /** グリフ信頼度の下限（未満のグリフがあると全体信頼度を下げる）。 */
  readonly glyphFloor?: number;
}

/**
 * 数字ストリップ → 文字列＋信頼度。
 * テンプレの label は 1 文字（'0'..'9','.'、任意で 'b' 等）を想定。
 */
export function recognizeDigitString(
  strip: Gray,
  templates: readonly Template[],
  opts: DigitReadOptions = {},
): Read<string> {
  const t = otsuThreshold(strip);
  const bin = binarize(strip, t, true);
  const rects = segmentGlyphs(bin, opts.minGap ?? 1, opts.minInkRows ?? 1);
  if (rects.length === 0) return { value: '', conf: 0 };

  let out = '';
  let minConf = 1;
  for (const r of rects) {
    const glyph = crop(strip, r);
    const m = bestMatch(glyph, templates);
    out += m.label;
    const c = matchConfidence(m);
    if (c < minConf) minConf = c;
  }
  return { value: out, conf: minConf };
}

/** 数字ストリップ → 数値＋信頼度。パース不能なら conf=0。 */
export function recognizeNumber(
  strip: Gray,
  templates: readonly Template[],
  opts: DigitReadOptions = {},
): Read<number> {
  const s = recognizeDigitString(strip, templates, opts);
  const n = parseAmount(s.value);
  if (n === null) return { value: NaN, conf: 0 };
  return { value: n, conf: s.conf };
}
