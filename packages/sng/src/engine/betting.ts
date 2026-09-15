/**
 * 合法手の計算。画面のボタン出し分けとサーバーの検証で同じ関数を使う（`Engine.legalActions`）。
 *
 * ミニマムレイズ＝直前の上乗せ幅（`lastBetSize`）と bb の大きい方。残りスタックがそれに満たなければ
 * オールインへクランプ（Slumbot 実装と同じ思想。`packages/app/src/slumbot/rules.ts` 参照）。
 */

import type { LegalActions } from '../types';

/** legalActions の計算に要る最小限のハンド情報（HandState / PublicHand どちらでも渡せる）。 */
export interface LegalHandView {
  readonly bb: number;
  readonly toAct: number;
  readonly streetLastBetTo: number;
  readonly lastBetSize: number;
  readonly folded: readonly boolean[];
  readonly allIn: readonly boolean[];
  readonly streetBet: readonly number[];
}

const NO_LEGAL: LegalActions = {
  canFold: false,
  canCheck: false,
  callPut: null,
  betTo: null,
  aggression: null,
};

export function computeLegalActions(hand: LegalHandView, seat: number, stack: number): LegalActions {
  if (hand.toAct !== seat || hand.folded[seat] || hand.allIn[seat] || stack <= 0) {
    return NO_LEGAL;
  }
  const myBet = hand.streetBet[seat] ?? 0;
  const toCall = Math.max(0, hand.streetLastBetTo - myBet);
  const callPut = toCall > 0 ? Math.min(toCall, stack) : null;
  const canCheck = toCall === 0;
  const canFold = toCall > 0;
  const remainingAfterCall = stack - (callPut ?? 0);

  let betTo: { min: number; max: number } | null = null;
  let aggression: 'bet' | 'raise' | null = null;
  if (remainingAfterCall > 0) {
    let minInc = Math.max(hand.lastBetSize, hand.bb);
    if (minInc > remainingAfterCall) minInc = remainingAfterCall;
    betTo = { min: hand.streetLastBetTo + minInc, max: hand.streetLastBetTo + remainingAfterCall };
    aggression = hand.streetLastBetTo > 0 ? 'raise' : 'bet';
  }

  return { canFold, canCheck, callPut, betTo, aggression };
}
