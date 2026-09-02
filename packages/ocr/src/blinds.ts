/**
 * ブラインド表示 "SB/BB 330/660" の数値部 "330/660" を SB/BB に分割して読む。SPEC §6.2。
 *
 * ヘッダーのブラインド表示は（本体スタックが BB 表記でも）常に chips 表記で固定。
 * 数字は白なので numberField の白マスク→連結成分→NCC をそのまま使い、区切り '/' を
 * テンプレに含めて認識し、'/' で SB/BB に分割する（実画像 6/6, blind level 4 種で検証）。
 *
 * templates には 0-9 に加えて label '/' の区切りテンプレが必要（初回セットアップで生成）。
 */

import type { Read, Rect } from './types.js';
import type { Rgba } from './color.js';
import type { Template } from './match.js';
import { recognizeGlyphs, type WhiteMaskOptions } from './numberField.js';
import { parseAmount } from './digits.js';

export interface Blinds {
  readonly sb: Read<number>;
  readonly bb: Read<number>;
}

function toRead(part: string | undefined, conf: number): Read<number> {
  const v = part ? parseAmount(part) : null;
  if (v === null) return { value: NaN, conf: 0 };
  return { value: v, conf };
}

/**
 * "330/660" 領域 → SB/BB。'/' の左右で分割。読めなければ conf=0。
 * 数値部（"SB/BB" の文字を含まない）の矩形を渡すこと。
 */
export function readBlinds(
  img: Rgba,
  numRect: Rect,
  templates: readonly Template[],
  opts: WhiteMaskOptions = {},
): Blinds {
  const g = recognizeGlyphs(img, numRect, templates, opts);
  const slash = g.text.indexOf('/');
  if (slash < 0) {
    // 区切りが読めない: 分割できないので両方低信頼。
    return { sb: { value: NaN, conf: 0 }, bb: { value: NaN, conf: 0 } };
  }
  const left = g.text.slice(0, slash);
  const right = g.text.slice(slash + 1);
  return { sb: toRead(left, g.conf), bb: toRead(right, g.conf) };
}
