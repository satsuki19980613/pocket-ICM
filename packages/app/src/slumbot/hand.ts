/**
 * API のレスポンス（生）→ 画面が必要とする形（HandView）への変換と、
 * 「直前に相手が何をしたか」の復元。すべて純関数なので単体テストで検証できる。
 */

import type { SlumbotResponse } from './api';
import {
  BOARD_COUNT,
  STACK,
  bbLabel,
  isHandOver,
  legalActions,
  parseAction,
  potOf,
  stackOf,
  type HandState,
  type LegalActions,
} from './rules';

export interface HandView {
  /** 全アクション列（Slumbot の action そのまま）。 */
  readonly action: string;
  /** 自分の席。0=BB / 1=SB(BTN)。 */
  readonly heroSeat: number;
  /** 相手（Slumbot）の席。 */
  readonly botSeat: number;
  readonly holeCards: readonly string[];
  /** ハンド終了時のみ開示される相手の手札。 */
  readonly botCards: readonly string[] | null;
  /** そのストリートまでにめくれているぶんだけに切り詰めたボード。 */
  readonly board: readonly string[];
  readonly state: HandState;
  readonly legal: LegalActions;
  readonly over: boolean;
  /** 自分の手番か（over のときは false）。 */
  readonly heroToAct: boolean;
  readonly pot: number;
  /** 席ごとの残りスタック。 */
  readonly stacks: readonly [number, number];
  /** このハンドの純収支（チップ）。終了前は null。 */
  readonly winnings: number | null;
}

export type ViewResult = { ok: true; view: HandView } | { ok: false; error: string };

/** レスポンスから画面用の状態を作る。action が壊れていれば失敗を返す。 */
export function toView(res: SlumbotResponse): ViewResult {
  const action = res.action ?? '';
  const parsed = parseAction(action);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const state = parsed.state;

  const heroSeat = res.client_pos === 1 ? 1 : 0;
  const over = isHandOver(state) || res.winnings !== undefined;

  // Slumbot は次ストリートのカードを先に返してくることがあるので、
  // 表示は「いま到達しているストリート」までに切り詰める（オールイン決着だけは全部見せる）。
  const full = res.board ?? [];
  const limit = over ? 5 : (BOARD_COUNT[state.street] ?? 0);
  const board = full.slice(0, limit);

  return {
    ok: true,
    view: {
      action,
      heroSeat,
      botSeat: heroSeat === 1 ? 0 : 1,
      holeCards: res.hole_cards ?? [],
      botCards: res.bot_hole_cards ?? null,
      board,
      state,
      legal: over ? legalActions({ ...state, toAct: -1 }) : legalActions(state),
      over,
      heroToAct: !over && state.toAct === heroSeat,
      pot: potOf(state),
      stacks: [stackOf(state, 0), stackOf(state, 1)],
      winnings: res.winnings ?? null,
    },
  };
}

// ---- 直前のアクションの復元（吹き出し表示用） ----

export type ActionKind = 'check' | 'call' | 'fold' | 'bet' | 'raise';

export interface LastAction {
  /** そのアクションを取った席。 */
  readonly seat: number;
  readonly kind: ActionKind;
  /** bet / raise のときの「そこまでの額」（チップ）。 */
  readonly betTo: number;
  /** 画面に出す文字列（例 "RAISE 6bb"）。 */
  readonly label: string;
}

/** アクション列の最後の 1 手が始まる位置。無ければ -1。 */
function lastTokenStart(action: string): number {
  let end = action.length;
  while (end > 0 && action[end - 1] === '/') end -= 1; // 末尾のストリート区切りは飛ばす。
  if (end === 0) return -1;
  let i = end - 1;
  if (action[i]! >= '0' && action[i]! <= '9') {
    while (i > 0 && action[i - 1]! >= '0' && action[i - 1]! <= '9') i -= 1;
    if (i > 0 && action[i - 1] === 'b') return i - 1;
    return -1; // 数字だけで 'b' が無い＝壊れた文字列。
  }
  return i;
}

/**
 * アクション列の「最後の 1 手」を読み解く。
 * new_hand / act のレスポンスでは、これがそのまま相手の直前の手になる
 * （こちらが送った直後に相手が応じて返ってくるため）。
 */
export function describeLastAction(action: string): LastAction | null {
  const start = lastTokenStart(action);
  if (start < 0) return null;

  const prefix = action.slice(0, start);
  const before = parseAction(prefix);
  if (!before.ok) return null;
  const seat = before.state.toAct;
  if (seat < 0) return null;

  const c = action[start]!;
  if (c === 'k') return { seat, kind: 'check', betTo: 0, label: 'CHECK' };
  if (c === 'f') return { seat, kind: 'fold', betTo: 0, label: 'FOLD' };
  if (c === 'c') {
    const amount = before.state.streetLastBetTo - (before.state.streetBet[seat] ?? 0);
    return { seat, kind: 'call', betTo: before.state.streetLastBetTo, label: `CALL ${bbLabel(amount)}bb` };
  }
  if (c === 'b') {
    let i = start + 1;
    while (i < action.length && action[i]! >= '0' && action[i]! <= '9') i += 1;
    const betTo = Number.parseInt(action.slice(start + 1, i), 10);
    if (!Number.isFinite(betTo)) return null;
    // プリフロップは BB(=100) が常にベットとして立っているので、`b` は必ずレイズになる
    // （legalActions().isRaise ＝ ボタン表記と同じ判定にそろえてある）。
    const facing = before.state.streetLastBetTo > 0;
    const allIn = betTo >= before.state.streetLastBetTo + (STACK - before.state.totalLastBetTo);
    const kind: ActionKind = facing ? 'raise' : 'bet';
    const head = allIn ? 'ALL IN' : facing ? 'RAISE' : 'BET';
    return { seat, kind, betTo, label: `${head} ${bbLabel(betTo)}bb` };
  }
  return null;
}
