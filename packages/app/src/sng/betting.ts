/**
 * SIT & GO のベット操作。`PublicHand` + 席 + 残りスタック → `SizingState`（slumbot/sizes.ts）。
 * docs/SNG_DESIGN.md §5・§6（A3a 所有）。
 *
 * `PublicHand` は「〜まで（betTo）」表記の合意ハンド状態（packages/sng/src/types.ts）。
 * `commits[seat]` はそのハンドの累計拠出（アンティ・ブラインド込み・このストリート分も含む）
 * なので、全席ぶん合計するとそのままポットになる（サイドポットの内訳は不要・合計だけでよい）。
 */

import type { PublicHand } from '@oshihiki/sng';

import {
  allInBetToSizing,
  categoryOfSizing,
  clampBetToSizing,
  resolvePresetSizing,
  snapBetToSizing,
  stepBetToSizing,
  type HandleUnit,
  type SizeCategory,
  type SizePreset,
  type SizingState,
} from '../slumbot/sizes';

/**
 * 卓の公開ハンド状態を、指定した席の視点の `SizingState` へ変換する。
 * `stack` はその席の**現在の残りスタック**（このハンドで既に出した分を除く。
 * `Engine.legalActions(hand, seat, stack)` の第3引数と同じ意味）。
 */
export function toSizingState(hand: PublicHand, seat: number, stack: number): SizingState {
  const pot = hand.commits.reduce((sum, c) => sum + c, 0);
  return {
    street: hand.street,
    bb: hand.bb,
    streetLastBetTo: hand.streetLastBetTo,
    lastBetSize: hand.lastBetSize,
    actingStreetBet: hand.streetBet[seat] ?? 0,
    actingRemaining: stack,
    pot,
  };
}

// ---- 再エクスポート（画面側は sng/betting.ts だけを見ればよいように） ----

export function categoryOf(hand: PublicHand, seat: number, stack: number): SizeCategory {
  return categoryOfSizing(toSizingState(hand, seat, stack));
}

export function resolvePreset(p: SizePreset, hand: PublicHand, seat: number, stack: number): number {
  return resolvePresetSizing(p, toSizingState(hand, seat, stack));
}

export function allInBetTo(hand: PublicHand, seat: number, stack: number): number {
  return allInBetToSizing(toSizingState(hand, seat, stack));
}

export function clampBetTo(betTo: number, hand: PublicHand, seat: number, stack: number): number {
  return clampBetToSizing(betTo, toSizingState(hand, seat, stack));
}

export function snapBetTo(
  betTo: number,
  hand: PublicHand,
  seat: number,
  stack: number,
  handleUnit: HandleUnit,
): number {
  return snapBetToSizing(betTo, toSizingState(hand, seat, stack), handleUnit);
}

export function stepBetTo(
  betTo: number,
  hand: PublicHand,
  seat: number,
  stack: number,
  handleUnit: HandleUnit,
  dir: 1 | -1,
): number {
  return stepBetToSizing(betTo, toSizingState(hand, seat, stack), handleUnit, dir);
}
