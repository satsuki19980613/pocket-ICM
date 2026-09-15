/**
 * 持ち時間・タイムバンクの計算。docs/SNG_DESIGN.md §1: deadline は最初からタイムバンク込みで置き、
 * 手動で動いたときに「15 秒を超えた分」だけタイムバンクから減らす（切れたら 0）。
 */

import { ACTION_MS } from '../types';

/** 手番が来た瞬間の期限（epoch ms）。 */
export function computeDeadline(now: number, timeBankMs: number): number {
  return now + ACTION_MS + timeBankMs;
}

/**
 * 手動でアクションしたときの残りタイムバンク。
 * `deadline` はそのプレイヤーの手番開始時に `computeDeadline(turnStartedAt, timeBankMs)` で
 * 置かれたもの（timeBankMs は手番開始時点の値＝まだ動いていないので現在値と同じ）。
 */
export function timeBankAfterManualAction(deadline: number, timeBankMs: number, now: number): number {
  const turnStartedAt = deadline - ACTION_MS - timeBankMs;
  const elapsed = now - turnStartedAt;
  const usedBank = Math.max(0, elapsed - ACTION_MS);
  return Math.max(0, timeBankMs - usedBank);
}
