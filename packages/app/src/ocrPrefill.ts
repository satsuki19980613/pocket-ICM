/**
 * OCR プリフィル・アダプタ（Plan 3-3）。
 *
 * OCR パイプラインが復元した root BoardState を、手入力フォーム BoardForm に写す。
 * SPEC §6.1: OCR は「手入力フォームを埋めるプリフィル」であり、結果は必ず条件確認
 * 画面を経由して全項目修正可能。ここは BoardState → BoardForm の純変換で、
 * buildBoardState を通すと元の state を再現する（round-trip）。
 *
 * 低信頼項目（lowConfidenceFields）は Position keyed のキー（"UTG.stack" 等）で渡され、
 * 条件確認画面の強調に使う。
 */

import type { BoardState, Position } from '@oshihiki/core';
import type { BoardForm } from './formModel';

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '';
  // 浮動小数の綴じ目を丸めて簡潔に（14.5 → "14.5", 15 → "15"）。
  return String(Number(n.toFixed(4)));
}

/** OCR の root BoardState → 手入力フォーム。empty 席は除外される。 */
export function boardStateToForm(state: BoardState): BoardForm {
  const stacks: Partial<Record<Position, string>> = {};
  for (const s of state.seats) {
    if (s.state === 'empty') continue;
    stacks[s.pos] = fmt(s.stack);
  }
  return {
    playersLeft: state.playersLeft,
    sb: fmt(state.blinds.sb),
    bb: fmt(state.blinds.bb),
    anteScheme: state.ante.scheme,
    anteAmount: fmt(state.ante.amount),
    heroPos: state.heroPos,
    heroHand: state.heroHand,
    stacks,
    gameMode: state.gameMode ?? 'club',
  };
}
