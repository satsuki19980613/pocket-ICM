/**
 * `level = min(表の長さ, floor((now − startedAt) / levelMs) + 1)`（TDA: 次のハンドから適用）。
 */

import type { SngConfig } from '../types';
import { levelsOf } from '../structure';

export function computeLevel(config: SngConfig, startedAt: number, now: number): number {
  const levels = levelsOf(config.speed);
  const levelMs = config.levelMin * 60_000;
  const elapsed = Math.max(0, now - startedAt);
  const idx = Math.floor(elapsed / levelMs) + 1;
  return Math.min(levels.length, idx);
}
