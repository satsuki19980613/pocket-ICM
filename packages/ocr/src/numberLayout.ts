/**
 * 数字フィールドの座標プロファイル（割合矩形）と一括読み取り。SPEC §6.2/§6.4。
 *
 * 実スクショ（2730×1260, リプレイ・プリフロップ終了フレーム, 6 人）で dev harness を用い
 * AI 目視 vs OCR を照合して較正した結果（chips・6 人・CLEAN 11 枚で 85/88）。座標は割合なので
 * 機種差の解像度・アスペクトを吸収する。数字は白マスク＋連結成分＋NCC（numberField.ts）で読む。
 *
 * 注意（未較正の残り）: ブラインドは "SB/BB 330/660" の分割 sb/bb 領域、6 席分のベット領域、
 * BB 建て（小数）モードは後続。ここは chips・6 人の数値フィールドのみを提供する。
 */

import type { Read } from './types.js';
import type { Rgba } from './color.js';
import type { Template } from './match.js';
import { recognizeAmount, type RecognizeAmountOptions } from './numberField.js';

/** 割合矩形（各成分 [0,1]）＋任意の白マスク閾値。 */
export interface NumberRegion {
  readonly frac: readonly [number, number, number, number];
  /** この領域だけ白マスク閾値を上げる（装飾を除く）等の上書き。 */
  readonly minCh?: number;
}

/**
 * 6 人・chips レイアウトの数値フィールド領域（較正済み）。
 * 席の画面位置: hero=下中央(SB席側), bb=下左, br=下右(D 近辺), tl=上左, tc=上中央, tr=上右。
 */
export const CHIPS_6MAX_NUMBER_REGIONS = {
  ante: { frac: [0.18, 0.058, 0.06, 0.04] },
  pot: { frac: [0.50, 0.315, 0.09, 0.048] },
  herostk: { frac: [0.575, 0.715, 0.115, 0.045] },
  bbstk: { frac: [0.191, 0.594, 0.065, 0.036], minCh: 168 },
  tlstk: { frac: [0.221, 0.249, 0.09, 0.038] },
  tcstk: { frac: [0.491, 0.151, 0.061, 0.041] },
  trstk: { frac: [0.766, 0.249, 0.085, 0.04] },
  brstk: { frac: [0.811, 0.601, 0.115, 0.04] },
} as const satisfies Record<string, NumberRegion>;

export type Chips6MaxField = keyof typeof CHIPS_6MAX_NUMBER_REGIONS;

/** 割合矩形 → px 矩形（フレームサイズでスケール）。 */
function fracToRect(frac: readonly [number, number, number, number], w: number, h: number) {
  return { x: Math.round(frac[0] * w), y: Math.round(frac[1] * h), w: Math.round(frac[2] * w), h: Math.round(frac[3] * h) };
}

/**
 * プロファイルの全数値フィールドを一括認識 → フィールド名 → `Read<number>`。
 * conf < confFloor（既定 0.80）が「低信頼＝条件確認で強調」の目安。
 */
export function readNumberFields<K extends string>(
  img: Rgba,
  regions: Record<K, NumberRegion>,
  templates: readonly Template[],
  opts: RecognizeAmountOptions = {},
): Record<K, Read<number>> {
  const out = {} as Record<K, Read<number>>;
  for (const key of Object.keys(regions) as K[]) {
    const reg = regions[key];
    const rect = fracToRect(reg.frac, img.w, img.h);
    out[key] = recognizeAmount(img, rect, templates, { ...opts, minCh: reg.minCh ?? opts.minCh });
  }
  return out;
}
