/**
 * スートの色分類（ポーカーチェイスは 4 色デッキ）。
 *
 * accuracy 検証で判明: このゲームは ♠=黒, ♥=赤, ♦=青, ♣=緑 の 4 色デッキ。
 * したがってスートはインク画素の平均色でほぼ決定的に分類できる（実測 17/17）。
 * ランクはグレースケール NCC、スートは色 —— の 2 系統に分けるのが最も堅牢。
 */

import type { Rect } from './types.js';

export type Suit = 's' | 'h' | 'd' | 'c';

/** RGBA 画像（行優先, data.length = w*h*4）。 */
export interface Rgba {
  readonly w: number;
  readonly h: number;
  readonly data: Uint8Array | Uint8ClampedArray;
}

/**
 * 矩形内の「インク画素」（白背景を除いた濃い画素）の平均 RGB。
 * brightCut より明るい画素（白地）は除外する。
 */
export function inkMeanRGB(
  img: Rgba,
  rect: Rect,
  brightCut = 200,
): { R: number; G: number; B: number; ink: number } {
  let sr = 0, sg = 0, sb = 0, ink = 0;
  const x1 = Math.min(img.w, rect.x + rect.w);
  const y1 = Math.min(img.h, rect.y + rect.h);
  for (let y = Math.max(0, rect.y); y < y1; y++)
    for (let x = Math.max(0, rect.x); x < x1; x++) {
      const s = (y * img.w + x) * 4;
      const R = img.data[s]!, G = img.data[s + 1]!, B = img.data[s + 2]!;
      const bright = (R * 77 + G * 150 + B * 29) >> 8;
      if (bright > brightCut) continue;
      sr += R; sg += G; sb += B; ink++;
    }
  return { R: ink ? sr / ink : 0, G: ink ? sg / ink : 0, B: ink ? sb / ink : 0, ink };
}

export interface SuitColorOptions {
  /** 低彩度（max-min がこの値未満）は黒＝スペード。既定 35。 */
  grayBand?: number;
}

/**
 * 平均 RGB → スート（4 色デッキ）。
 * 低彩度＝黒(♠)、赤優勢＝♥、青優勢＝♦、緑優勢＝♣。
 */
export function classifySuitColor(R: number, G: number, B: number, opts: SuitColorOptions = {}): Suit {
  const grayBand = opts.grayBand ?? 35;
  const mx = Math.max(R, G, B);
  const mn = Math.min(R, G, B);
  if (mx - mn < grayBand) return 's';
  if (R >= G && R >= B) return 'h';
  if (B >= R && B >= G) return 'd';
  return 'c';
}

/** 矩形のインク色からスートを判定（信頼度付き）。ink が少なすぎると conf を下げる。 */
export function recognizeSuit(
  img: Rgba,
  rect: Rect,
  opts: SuitColorOptions & { minInk?: number } = {},
): { value: Suit; conf: number } {
  const { R, G, B, ink } = inkMeanRGB(img, rect);
  const suit = classifySuitColor(R, G, B, opts);
  const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
  const sat = suit === 's' ? 1 : Math.min(1, (mx - mn) / 80); // 彩度が高いほど確信
  const enough = ink >= (opts.minInk ?? 30) ? 1 : ink / (opts.minInk ?? 30);
  return { value: suit, conf: Math.max(0, Math.min(1, sat * enough)) };
}
