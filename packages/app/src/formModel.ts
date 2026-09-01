/**
 * 手入力フォームの状態モデルと BoardState 組み立て・検証（Phase 3-1b）。
 * フォームは push/fold の「開始状態」（全席 live・ブラインド投函済み・未開）を捉える。
 * 上流アクション（誰が push/fold したか）は結果画面のノード選択で扱う（solver は全木を解く）。
 */

import type { BoardState, Position } from '@oshihiki/core';
import {
  positionsForPlayersLeft,
  parseBoardState,
  checkBoardStateSemantics,
  potChecksumDelta,
  parseHandClass,
} from '@oshihiki/core';

export type AnteScheme = 'all' | 'bb' | 'none';

export interface BoardForm {
  playersLeft: number;
  sb: string;
  bb: string;
  anteScheme: AnteScheme;
  anteAmount: string;
  heroPos: Position;
  heroHand: string;
  /** ポジション → スタック（bb, 画面表示＝ベット差引後）の入力文字列。 */
  stacks: Partial<Record<Position, string>>;
}

/** 指定人数の既定フォーム（等スタック 15bb, blinds 0.5/1, ante なし）。 */
export function defaultForm(playersLeft = 5): BoardForm {
  const positions = positionsForPlayersLeft(playersLeft);
  const stacks: Partial<Record<Position, string>> = {};
  for (const p of positions) stacks[p] = '15';
  return {
    playersLeft,
    sb: '0.5',
    bb: '1',
    anteScheme: 'none',
    anteAmount: '0',
    heroPos: positions[0]!,
    heroHand: 'A5s',
    stacks,
  };
}

/** 人数変更時: ポジション集合に合わせて stacks/heroPos を整える（既存値は保持）。 */
export function reconcilePositions(form: BoardForm): BoardForm {
  const positions = positionsForPlayersLeft(form.playersLeft);
  const stacks: Partial<Record<Position, string>> = {};
  for (const p of positions) stacks[p] = form.stacks[p] ?? '15';
  const heroPos = positions.includes(form.heroPos) ? form.heroPos : positions[0]!;
  return { ...form, stacks, heroPos };
}

function num(s: string): number {
  return Number((s ?? '').trim());
}

export interface BuildResult {
  ok: boolean;
  state?: BoardState;
  issues: string[];
  /** ポット検算の差（|delta|）。null は pot 未算出。 */
  potDelta: number | null;
}

/** フォーム → BoardState 組み立て + zod/意味論/ハンド/ポット検算。 */
export function buildBoardState(form: BoardForm): BuildResult {
  const issues: string[] = [];
  const sb = num(form.sb);
  const bb = num(form.bb);
  const anteAmount = form.anteScheme === 'none' ? 0 : num(form.anteAmount);

  if (!Number.isFinite(sb) || sb <= 0) issues.push('SB は正の数で入力してください');
  if (!Number.isFinite(bb) || bb <= 0) issues.push('BB は正の数で入力してください');
  if (Number.isFinite(sb) && Number.isFinite(bb) && sb >= bb) issues.push('SB は BB より小さくしてください');
  if (form.anteScheme !== 'none' && (!Number.isFinite(anteAmount) || anteAmount < 0)) {
    issues.push('アンティ額は 0 以上で入力してください');
  }
  if (!parseHandClass(form.heroHand)) issues.push(`hero ハンド "${form.heroHand}" が不正です`);

  const positions = positionsForPlayersLeft(form.playersLeft);
  const seats = positions.map((pos) => {
    const stack = num(form.stacks[pos] ?? '');
    if (!Number.isFinite(stack) || stack <= 0) issues.push(`${pos} のスタックを正の数で入力してください`);
    const bet = pos === 'SB' ? sb : pos === 'BB' ? bb : 0;
    return { pos, stack, state: 'live' as const, bet };
  });

  const ante =
    form.anteScheme === 'none'
      ? { scheme: 'none' as const, amount: 0 }
      : { scheme: form.anteScheme, amount: anteAmount };

  const anteContribution = ante.scheme === 'all' ? ante.amount * seats.length : ante.scheme === 'bb' ? ante.amount : 0;
  const potBets = seats.reduce((a, s) => a + s.bet, 0);

  const candidate = {
    street: 'preflop',
    blinds: { sb, bb },
    ante,
    heroHand: form.heroHand,
    playersLeft: form.playersLeft,
    seats,
    heroPos: form.heroPos,
    pot: potBets + anteContribution,
  };

  const parsed = parseBoardState(candidate);
  if (!parsed.ok) {
    return { ok: false, issues: [...issues, ...parsed.issues], potDelta: null };
  }
  const sem = checkBoardStateSemantics(parsed.value!);
  const potDelta = potChecksumDelta(parsed.value!);
  const all = [...issues, ...sem.issues];
  return { ok: all.length === 0, state: all.length === 0 ? parsed.value : undefined, issues: all, potDelta };
}
