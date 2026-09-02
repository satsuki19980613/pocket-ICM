/**
 * Drill（§7.4）の純ロジック層（Node テスト可）。
 *
 * 出題への回答判定・1 手のスナップショット・セッション集計を集約する。
 * 判定・EV loss は records/model の**同じ真実**を再利用（結果画面・記録と一致）。
 */

import type { BoardState } from '@oshihiki/core';
import type { SolveResultDto } from '../solverProtocol';
import { evLossOf, headlineNode, verdictOf, type HeroAction } from '../records/model';

/**
 * 正解と見なす EV loss の許容幅（実払い pt）。混合境界（|heroEv|≈0）は
 * どちらを選んでも損が微小なので正解扱いにする（trainer として妥当）。
 */
export const MIX_EPS = 0.02;

export interface Judgement {
  /** 推奨判定（見出しノード）。 */
  verdict: HeroAction;
  /** 見出しノードの heroEv（アグレッシブ − フォールド, 実払い pt）。 */
  heroEv: number;
  /** 実行動の EV loss（≥0）。 */
  evLoss: number;
  /** 正解か（evLoss ≤ MIX_EPS）。 */
  correct: boolean;
  /** hero の決定ノードがあるか（無ければ出題不成立）。 */
  hasDecision: boolean;
}

/** 求解結果＋実行動 → 判定（純関数）。 */
export function judge(result: SolveResultDto, action: HeroAction): Judgement {
  const head = headlineNode(result);
  if (!head) return { verdict: 'FOLD', heroEv: 0, evLoss: 0, correct: true, hasDecision: false };
  const heroEv = head.heroEv;
  const verdict = verdictOf(head);
  const evLoss = evLossOf(heroEv, action);
  return { verdict, heroEv, evLoss, correct: evLoss <= MIX_EPS, hasDecision: true };
}

/** 求解済みの 1 局面（出題の実体）。 */
export interface SolvedSpot {
  state: BoardState;
  result: SolveResultDto;
  ms: number;
}

/** ドリル 1 手の記録（再表示用に完全スナップショットを持つ）。 */
export interface DrillAttempt {
  id: string;
  heroHand: string;
  heroPos: string;
  playersLeft: number;
  /** 利用者の選択。 */
  action: HeroAction;
  verdict: HeroAction;
  heroEv: number;
  evLoss: number;
  correct: boolean;
  state: BoardState;
  result: SolveResultDto;
  ms: number;
}

/** 出題＋実行動 → ドリル 1 手（純関数）。 */
export function makeAttempt(spot: SolvedSpot, action: HeroAction, id?: string): DrillAttempt {
  const j = judge(spot.result, action);
  const stamp = Date.now();
  return {
    id: id ?? `drill-${stamp}-${Math.random().toString(36).slice(2, 7)}`,
    heroHand: spot.result.heroHand,
    heroPos: spot.result.heroPos,
    playersLeft: spot.result.playersLeft,
    action,
    verdict: j.verdict,
    heroEv: j.heroEv,
    evLoss: j.evLoss,
    correct: j.correct,
    state: spot.state,
    result: spot.result,
    ms: spot.ms,
  };
}

export interface DrillSummary {
  hands: number;
  correct: number;
  /** 正答率（0..1）。 */
  accuracy: number;
  /** EV loss 合計（実払い pt）。 */
  totalEvLoss: number;
  /** 外した場面（EV loss 降順）。 */
  misses: DrillAttempt[];
}

/** セッションの集計（正答率・EV loss 合計・外した場面）。 */
export function summarize(attempts: readonly DrillAttempt[]): DrillSummary {
  const hands = attempts.length;
  const correct = attempts.reduce((n, a) => n + (a.correct ? 1 : 0), 0);
  const totalEvLoss = attempts.reduce((s, a) => s + a.evLoss, 0);
  const misses = attempts.filter((a) => !a.correct).slice().sort((x, y) => y.evLoss - x.evLoss);
  return { hands, correct, accuracy: hands ? correct / hands : 0, totalEvLoss, misses };
}
