/**
 * 数字フィールド認識（スタック/ベット/ポット/ブラインド/アンティ）。SPEC §6.3。
 *
 * カード認識と同型の **白マスク→連結成分→グレースケール NCC**:
 *  - 白マスク: このゲームは 4 色デッキで数字は白なので、近白（min(R,G,B) 高・低彩度）
 *    だけを前景にすると赤/青/緑の装飾色を除去できる（スート色分類と同じ発想, color.ts 参照）。
 *  - 連結成分: `0`/`8` の中空を縦投影で割らず、背景ノイズは面積で除去。背の低い成分
 *    （コンマ/小数点/線飾り）を落として数字だけ左→右に整列 → `parseAmount`。
 *
 * 実画像検証（dev harness, AI 目視 vs OCR）: chips・6 人・CLEAN フレーム 11 枚で 85/88（96.6%）。
 * 誤りは全て物理的な遮蔽/手番発光で、信頼度 < 0.80 でフラグ（正読は ≥0.80）。
 * テンプレは 0-9 の 10 種のみ（スート別不要）。実スクショから初回セットアップで生成（SPEC §10, 非同梱）。
 */

import type { Gray, Rect, Read } from './types.js';
import type { Rgba } from './color.js';
import { crop, resize } from './raster.js';
import { bestMatch, matchConfidence, type Template } from './match.js';
import { parseAmount } from './digits.js';

/** 正規化グリフ高さ（幅はアスペクト維持）。 */
export const DIGIT_NORM_H = 32;

export interface WhiteMaskOptions {
  /** 前景とみなす最小チャンネル値（min(R,G,B) ≥ minCh）。既定 150。 */
  readonly minCh?: number;
  /** 許容彩度（max-min ≤ maxSat）。既定 80。 */
  readonly maxSat?: number;
}

/** 矩形をグレースケール（Rec.601）で切り出す。NCC 用の輝度。 */
export function grayFromRgba(img: Rgba, rect: Rect): Gray {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(img.w, Math.floor(rect.x + rect.w));
  const y1 = Math.min(img.h, Math.floor(rect.y + rect.h));
  const w = Math.max(0, x1 - x0), h = Math.max(0, y1 - y0);
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = ((y0 + y) * img.w + (x0 + x)) * 4;
      data[y * w + x] = (img.data[s]! * 77 + img.data[s + 1]! * 150 + img.data[s + 2]! * 29) >> 8;
    }
  return { w, h, data };
}

/**
 * 白マスク（前景=白文字, 255）。装飾色（赤蝶/青キラキラ/緑）を除去して数字だけ残す。
 */
export function whiteMask(img: Rgba, rect: Rect, opts: WhiteMaskOptions = {}): Gray {
  const minCh = opts.minCh ?? 150;
  const maxSat = opts.maxSat ?? 80;
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(img.w, Math.floor(rect.x + rect.w));
  const y1 = Math.min(img.h, Math.floor(rect.y + rect.h));
  const w = Math.max(0, x1 - x0), h = Math.max(0, y1 - y0);
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = ((y0 + y) * img.w + (x0 + x)) * 4;
      const R = img.data[s]!, G = img.data[s + 1]!, B = img.data[s + 2]!;
      const mn = Math.min(R, G, B), mx = Math.max(R, G, B);
      data[y * w + x] = mn >= minCh && mx - mn <= maxSat ? 255 : 0;
    }
  return { w, h, data };
}

/** 2 値画像（前景>0）の連結成分（4 近傍）の外接矩形を左→右で返す。 */
export function binaryComponents(bin: Gray): Rect[] {
  const { w, h, data } = bin;
  if (w === 0 || h === 0) return [];
  const label = new Int32Array(w * h).fill(-1);
  const boxes: { x0: number; y0: number; x1: number; y1: number; area: number }[] = [];
  const stack: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (data[i] === 0 || label[i] !== -1) continue;
    const id = boxes.length;
    boxes.push({ x0: w, y0: h, x1: -1, y1: -1, area: 0 });
    stack.length = 0; stack.push(i); label[i] = id;
    while (stack.length) {
      const p = stack.pop()!;
      const px = p % w, py = (p / w) | 0;
      const b = boxes[id]!;
      b.area++;
      if (px < b.x0) b.x0 = px; if (px > b.x1) b.x1 = px;
      if (py < b.y0) b.y0 = py; if (py > b.y1) b.y1 = py;
      if (px > 0 && data[p - 1]! > 0 && label[p - 1] === -1) { label[p - 1] = id; stack.push(p - 1); }
      if (px < w - 1 && data[p + 1]! > 0 && label[p + 1] === -1) { label[p + 1] = id; stack.push(p + 1); }
      if (py > 0 && data[p - w]! > 0 && label[p - w] === -1) { label[p - w] = id; stack.push(p - w); }
      if (py < h - 1 && data[p + w]! > 0 && label[p + w] === -1) { label[p + w] = id; stack.push(p + w); }
    }
  }
  const minArea = Math.max(6, Math.round(w * h * 0.004));
  const minH = Math.max(3, Math.round(h * 0.15));
  return boxes
    .filter((b) => b.area >= minArea && b.y1 - b.y0 + 1 >= minH)
    .map((b) => ({ x: b.x0, y: b.y0, w: b.x1 - b.x0 + 1, h: b.y1 - b.y0 + 1 }))
    .sort((a, b) => a.x - b.x);
}

/**
 * 数字グリフだけを返す（左→右）。背の低い成分（コンマ/小数点/線飾り）を落とす
 * （数字は最大高の 0.55 以上）。数値は `parseAmount` でコンマ除去するので桁は保たれる。
 */
export function digitComponents(mask: Gray): Rect[] {
  // 領域全高に近い成分は数字ではなく枠/手番グロー枠のエッジ（実測 h=領域高 の縦線）。
  // 先に落とさないと maxH を押し上げ、実桁が 0.55*maxH 未満で全滅する（142903 BR）。
  const rects = binaryComponents(mask).filter((r) => r.h < 0.9 * mask.h);
  if (rects.length === 0) return rects;
  const maxH = Math.max(...rects.map((r) => r.h));
  return rects.filter((r) => r.h >= 0.55 * maxH);
}

/** グリフを高さ DIGIT_NORM_H に正規化（幅アスペクト維持）。 */
function normGlyph(strip: Gray, r: Rect): Gray {
  const g = crop(strip, r);
  const nw = Math.max(1, Math.round((g.w * DIGIT_NORM_H) / g.h));
  return resize(g, nw, DIGIT_NORM_H);
}

export interface RecognizeAmountOptions extends WhiteMaskOptions {
  /** 数値の下限信頼度（未満なら低信頼としてフラグ）。既定 0.80（実画像較正の分離線）。 */
  readonly confFloor?: number;
}

/** 認識したグリフ列（生ラベル）＋信頼度。数字以外（'/' 等）も含みうる。 */
export interface GlyphString {
  /** マッチしたラベルを左→右で連結（例 "330/660"）。 */
  readonly text: string;
  /** 各グリフ最小 NCC を [0,1] にクランプ。グリフ無しは 0。 */
  readonly conf: number;
  /** 各グリフの外接矩形（左→右）。 */
  readonly rects: readonly Rect[];
}

/**
 * 矩形のグリフ列を認識して生ラベル文字列にする（数値化しない）。
 * templates は数字＋区切り（例 '/'）。blinds "330/660" 等の分割前段に使う。
 */
export function recognizeGlyphs(
  img: Rgba,
  rect: Rect,
  templates: readonly Template[],
  opts: WhiteMaskOptions = {},
): GlyphString {
  const strip = grayFromRgba(img, rect);
  const rects = digitComponents(whiteMask(img, rect, opts));
  if (rects.length === 0) return { text: '', conf: 0, rects: [] };
  let text = '';
  let minScore = 1;
  for (const r of rects) {
    const m = bestMatch(normGlyph(strip, r), templates);
    text += m.label;
    const c = matchConfidence(m);
    if (c < minScore) minScore = c;
  }
  return { text, conf: Math.max(0, Math.min(1, minScore)), rects };
}

/**
 * 矩形の数字フィールドを認識 → `Read<number>`（金額 ＋ 信頼度 [0,1]）。
 * templates は 0-9 の 10 種（label は '0'..'9'）。conf は各グリフ最小 NCC を [0,1] にクランプ。
 * 数字が検出できなければ value=NaN, conf=0。
 */
export function recognizeAmount(
  img: Rgba,
  rect: Rect,
  templates: readonly Template[],
  opts: RecognizeAmountOptions = {},
): Read<number> {
  const g = recognizeGlyphs(img, rect, templates, opts);
  if (g.rects.length === 0) return { value: NaN, conf: 0 };
  const value = parseAmount(g.text);
  if (value === null) return { value: NaN, conf: 0 };
  return { value, conf: g.conf };
}
