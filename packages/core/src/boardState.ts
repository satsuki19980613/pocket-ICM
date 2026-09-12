/**
 * 盤面状態（IMPLEMENTATION_PLAN §3.1）。
 * OCR / 手入力の出力であり、Solver の入力。単位はすべて BB 換算。
 *
 * bet:   このストリートで既にコミットした総額（ブラインド・アンティのブラインド分を含む）
 * stack: ベット分を差し引いた残額（画面表示と同じ）
 * state: live | fold | allin | call | empty（empty は不在・接続切れ。残り人数から除外）
 */

import { z } from 'zod';
import { GAME_MODES } from './gameMode.js';
import { POSITIONS } from './positions.js';
import { isHandClass } from './cards.js';
import { positionsMatchPlayersLeft, isValidPlayersLeft } from './positions.js';

export const SEAT_STATES = ['live', 'fold', 'allin', 'call', 'empty'] as const;
export type SeatState = (typeof SEAT_STATES)[number];

const unitAmount = z.number().finite().nonnegative();

export const ConfidenceSchema = z
  .object({
    stack: z.number().min(0).max(1),
    bet: z.number().min(0).max(1),
    state: z.number().min(0).max(1),
  })
  .partial()
  .optional();

export const SeatSchema = z.object({
  pos: z.enum(POSITIONS),
  stack: unitAmount,
  state: z.enum(SEAT_STATES),
  bet: unitAmount,
  name: z.string().optional(),
  confidence: ConfidenceSchema,
});
export type Seat = z.infer<typeof SeatSchema>;

export const AnteSchema = z.object({
  scheme: z.enum(['all', 'bb', 'none']),
  amount: unitAmount,
});
export type Ante = z.infer<typeof AnteSchema>;

export const BlindsSchema = z.object({
  sb: z.number().finite().positive(),
  bb: z.number().finite().positive(),
});

export const BoardStateSchema = z.object({
  street: z.literal('preflop'),
  blinds: BlindsSchema,
  ante: AnteSchema,
  heroHand: z.string().refine(isHandClass, { message: 'invalid hand-class notation' }),
  playersLeft: z.number().int(),
  seats: z.array(SeatSchema).min(2).max(6),
  heroPos: z.enum(POSITIONS),
  pot: unitAmount.optional(),
  heroHandConfidence: z.number().min(0).max(1).optional(),
  /**
   * どのゲームモードの局面か（プライズ表・開始スタックが決まる）。**省略時はクラブマッチ**。
   * `results.spot` は BoardState をそのまま jsonb で持つので、ここに足すだけで記録にも
   * Worker にも自動で流れる（DB マイグレーション不要）。v3 以前の記録は未指定＝クラブ。
   */
  gameMode: z.enum(GAME_MODES).optional(),
});
export type BoardState = z.infer<typeof BoardStateSchema>;

export interface ValidationResult {
  ok: boolean;
  issues: string[];
}

/**
 * zod による構造検証。失敗時は issues にメッセージを詰める。
 */
export function parseBoardState(input: unknown): ValidationResult & { value?: BoardState } {
  const r = BoardStateSchema.safeParse(input);
  if (!r.success) {
    return { ok: false, issues: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
  }
  return { ok: true, issues: [], value: r.data };
}

/**
 * 構造検証を通過した盤面に対する意味論的検証。
 * empty 席は残り人数から除外して整合を確認する。
 */
export function checkBoardStateSemantics(state: BoardState): ValidationResult {
  const issues: string[] = [];

  if (!isValidPlayersLeft(state.playersLeft)) {
    issues.push(`playersLeft must be 2..6, got ${state.playersLeft}`);
  }

  const activeSeats = state.seats.filter((s) => s.state !== 'empty');

  if (activeSeats.length !== state.playersLeft) {
    issues.push(
      `active seats (${activeSeats.length}) must equal playersLeft (${state.playersLeft})`,
    );
  }

  const activePositions = activeSeats.map((s) => s.pos);
  const dup = activePositions.filter((p, i) => activePositions.indexOf(p) !== i);
  if (dup.length > 0) {
    issues.push(`duplicate positions among active seats: ${[...new Set(dup)].join(', ')}`);
  }

  if (
    isValidPlayersLeft(state.playersLeft) &&
    !positionsMatchPlayersLeft(activePositions, state.playersLeft)
  ) {
    issues.push(
      `active seat positions [${activePositions.join(', ')}] do not match the canonical set for ${state.playersLeft} players`,
    );
  }

  if (!activePositions.includes(state.heroPos)) {
    issues.push(`heroPos ${state.heroPos} is not among active seats`);
  }

  if (state.ante.scheme === 'none' && state.ante.amount !== 0) {
    issues.push(`ante.scheme is "none" but amount is ${state.ante.amount}`);
  }

  return { ok: issues.length === 0, issues };
}

/**
 * ポット・チェックサム（SPEC §6.3）: Σ(各席 bet) + アンティ寄与 ≒ pot。
 * アンティ寄与は scheme により決まる:
 *   all:  amount × アクティブ人数
 *   bb:   amount（総額）
 *   none: 0
 * 返り値は理論ポットと申告 pot の差の絶対値（pot 未指定なら null）。
 */
export function potChecksumDelta(state: BoardState): number | null {
  if (state.pot === undefined) return null;
  const activeSeats = state.seats.filter((s) => s.state !== 'empty');
  const betSum = activeSeats.reduce((acc, s) => acc + s.bet, 0);
  let anteContribution = 0;
  if (state.ante.scheme === 'all') anteContribution = state.ante.amount * activeSeats.length;
  else if (state.ante.scheme === 'bb') anteContribution = state.ante.amount;
  const theoretical = betSum + anteContribution;
  return Math.abs(theoretical - state.pot);
}
