/**
 * ブラインド構造（レベル表)へのアクセス。docs/SNG_DESIGN.md §1。
 *
 * 表の正本は `@oshihiki/core` の blindStructure（ocr から移設）。ここでは SNG が使う形に包む。
 */

import { BLIND_TABLES } from '@oshihiki/core';

import type { Speed } from './types';

export interface BlindLevelChips {
  readonly level: number;
  readonly sb: number;
  readonly bb: number;
  readonly ante: number;
}

/** そのスピードの全レベル（1 始まり）。 */
export function levelsOf(speed: Speed): readonly BlindLevelChips[] {
  return BLIND_TABLES[speed].map(([bb, ante], i) => ({ level: i + 1, sb: bb / 2, bb, ante }));
}

/** レベル番号 → ブラインド（表の長さを超えたら最終レベル。1 未満は 1 として扱う）。 */
export function blindsAt(speed: Speed, level: number): BlindLevelChips {
  const levels = levelsOf(speed);
  const idx = Math.min(levels.length, Math.max(1, Math.floor(level))) - 1;
  return levels[idx]!;
}
