/**
 * Pot アンカー（OCR_PHASE2 §B5）。中央の "Pot :" ピルの金額を **BB アンカー**で読む。
 *
 * BB 表示のテーブル中央には「Pot : 2.5 BB」のように、暗色角丸ピル内に "Pot :" ラベル・数字・
 * 白 "BB" 接尾辞が横並びで載る。ピルは画面上で一意かつフレーム上部中央に置かれる（席スタックは
 * 外周にあり中央帯には来ない）。よって「テーブル中央帯の中で、直左に数字塊を持つ BB トークン」を
 * 探せば pot 数字を選べる（席の "BB" は中央帯に入らない）。
 *
 * 実装は席スタックと同型の two-anchor リーダ（readAmountBbAnchored）を再利用する。中央ピルの
 * 数字領域に相当する小矩形を渡すと、リーダ内部が左右へ広げて "BB" を NCC で特定し、その直左の
 * 連続数字塊（"2.5"）だけを採る。"Pot :" の白文字（P/o/t/:）は数字塊の左のギャップ／背の高い
 * 非数字で打ち切られ、数値スパンに混入しない。数字が chips（末尾 "BB" 無し）のフレームでは
 * BB ペアが見つからず NaN を返す（§B7 の chips ゲートで別途棄却される想定）。
 */

import type { Read, Rect } from './types.js';
import type { Rgba } from './color.js';
import type { Template } from './match.js';
import type { BbAmountOptions } from './bbAmount.js';
import { readAmountBbAnchored } from './bbAmount.js';

/** 中央ピルの数字領域に相当するフラクショナル矩形（正規化画像に対して不変）。 */
export interface PotAnchorRegion {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** CHIPS_6MAX の pot 領域（frameProfile）に合わせた中央ピル数字帯（少し左・広めに取る）。 */
export const DEFAULT_POT_REGION: PotAnchorRegion = { x: 0.46, y: 0.305, w: 0.09, h: 0.05 };

export interface PotAnchorResult extends Read<number> {
  /** 探索に使った pot 数字帯（px, 正規化画像座標）。デバッグ／クロップ用。 */
  readonly box: Rect;
}

/**
 * 中央 "Pot :" ピルの金額（BB）を読む。img は §B2 正規化済み画像を渡す。
 * letters（"B"）が必須（BB 接尾辞の NCC 特定に使う）。数字が無ければ value=NaN, conf=0。
 */
export function readPotAnchored(
  img: Rgba,
  digits: readonly Template[],
  letters?: readonly Template[],
  opts: BbAmountOptions = {},
  region: PotAnchorRegion = DEFAULT_POT_REGION,
): PotAnchorResult {
  const rect: Rect = {
    x: Math.round(region.x * img.w),
    y: Math.round(region.y * img.h),
    w: Math.round(region.w * img.w),
    h: Math.round(region.h * img.h),
  };
  // ピル中央を名前アンカーに見立てる（中央帯に BB 候補は pot のみのはずだが、
  // 万一 side pot 等が入っても中央に最も近いものを選ぶ）。
  const nameCx = rect.x + rect.w / 2;
  const r = readAmountBbAnchored(img, rect, digits, opts, letters, nameCx);
  return { value: r.value, conf: r.conf, box: rect };
}
