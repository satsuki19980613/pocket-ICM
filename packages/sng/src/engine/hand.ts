/**
 * 1 ハンドのライフサイクル: 配る → アクション適用 → 次ストリート/ショーダウン → 精算。
 *
 * すべて純関数。`TableState.players` のスタックはハンド中は変えない（`HandState.startStacks` /
 * `commits` だけで追跡し、精算時に一度だけ反映する）。
 */

import { gameModeSpec, type GameMode } from '@oshihiki/core';

import type {
  ActionKind,
  ActionRecord,
  HandState,
  PlayerState,
  SngConfig,
  TableState,
} from '../types';
import { ACTION_MS } from '../types';
import { blindsAt } from '../structure';
import { freshDeck, shuffle } from './cards';
import { computeButtonForHand, isLive, nextLive, type ButtonAssignment } from './button';
import { computeLevel } from './level';
import { computeDeadline, timeBankAfterManualAction } from './timer';
import { settleShowdown, settleUncontested } from './showdown';
import { computeLegalActions } from './betting';
import type { Rng } from '../engine';

export const BOARD_COUNT = [0, 3, 4, 5] as const;

/** street 内で「!folded && !allIn」な席から from の次を探す。無ければ null。 */
function nextActable(folded: readonly boolean[], allIn: readonly boolean[], from: number): number | null {
  const n = folded.length;
  for (let i = 1; i <= n; i++) {
    const seat = (from + i) % n;
    if (!folded[seat] && !allIn[seat]) return seat;
  }
  return null;
}

function actionableSeats(hand: HandState): number[] {
  const out: number[] = [];
  for (let s = 0; s < hand.folded.length; s++) if (!hand.folded[s] && !hand.allIn[s]) out.push(s);
  return out;
}

/** そのストリートで「まだ動いていない/直前のベットに追いついていない」actionable な席が残っていないか。 */
function isStreetComplete(hand: HandState): boolean {
  for (let s = 0; s < hand.folded.length; s++) {
    if (hand.folded[s] || hand.allIn[s]) continue;
    let acted = false;
    let lastBetTo = -1;
    for (const a of hand.actions) {
      if (a.street !== hand.street || a.seat !== s) continue;
      acted = true;
      lastBetTo = a.betTo;
    }
    if (!acted || lastBetTo !== hand.streetLastBetTo) return false;
  }
  return true;
}

/**
 * ストリートを閉じてよいか。`isStreetComplete` は actionable（!folded && !allIn）な席だけを
 * 見るので、actionable が 0（全員オールイン）なら空ループで自動的に true になる。actionable が
 * 1 人でも、その人がまだ現在の streetLastBetTo に追いついていなければ false のまま
 * （＝コール/フォールドの機会は必ず与える）。
 */
function shouldCloseStreet(hand: HandState): boolean {
  if (isStreetComplete(hand)) return true;
  // 賭けられる相手が居ない（actionable が 1 人以下）なら、その人が直前のベットに追いついている
  // 限り（＝コール/フォールドの必要が無い）ストリートを閉じ、残りのボードを一気に配る。
  // これが無いと「相手が短いスタックでオールイン → 自分がコール」のあと、フロップ・ターン・
  // リバーで自分だけに手番が回り、毎回 CHECK を押さないと進まない（さつき実機報告 2026-09-15）。
  const actionable = actionableSeats(hand);
  if (actionable.length <= 1) {
    return actionable.every((s) => hand.streetBet[s] === hand.streetLastBetTo);
  }
  return false;
}

// ---------------------------------------------------------------------------
// 配る
// ---------------------------------------------------------------------------

export interface DealResult {
  readonly hand: HandState;
  readonly prevSbSeat: number | null;
  readonly prevBbSeat: number | null;
  readonly button: ButtonAssignment;
}

export function dealHand(
  players: readonly PlayerState[],
  config: SngConfig,
  prevSbSeat: number | null,
  prevBbSeat: number | null,
  handNo: number,
  level: number,
  now: number,
  rng: Rng,
  forcedBtn?: number,
): DealResult {
  const n = players.length;
  const button = computeButtonForHand(players, prevSbSeat, prevBbSeat, forcedBtn);
  const { sb, bb, ante } = blindsAt(config.speed, level);

  const deck = shuffle(freshDeck(), rng);

  const startStacks = players.map((p) => (isLive(p) ? p.stack : 0));
  const commits = new Array<number>(n).fill(0);
  const folded = players.map((p) => !isLive(p));
  const allIn = new Array<boolean>(n).fill(false);
  const streetBet = new Array<number>(n).fill(0);

  // アンティ（全員）→ ブラインドの順に min(stack, 額)。
  if (ante > 0) {
    for (let s = 0; s < n; s++) {
      if (folded[s]) continue;
      const remaining = startStacks[s]! - commits[s]!;
      commits[s]! += Math.min(remaining, ante);
    }
  }
  if (button.sbSeat !== null) {
    const remaining = startStacks[button.sbSeat]! - commits[button.sbSeat]!;
    const paid = Math.min(remaining, sb);
    commits[button.sbSeat]! += paid;
    streetBet[button.sbSeat] = paid;
  }
  {
    const remaining = startStacks[button.bbSeat]! - commits[button.bbSeat]!;
    const paid = Math.min(remaining, bb);
    commits[button.bbSeat]! += paid;
    streetBet[button.bbSeat] = paid;
  }
  for (let s = 0; s < n; s++) {
    if (folded[s]) continue;
    if (startStacks[s]! - commits[s]! <= 0) allIn[s] = true;
  }

  // 手札。
  const hole: Record<number, readonly [string, string]> = {};
  let cardIdx = 0;
  for (let s = 0; s < n; s++) {
    if (folded[s]) continue;
    hole[s] = [deck[cardIdx]!, deck[cardIdx + 1]!];
    cardIdx += 2;
  }

  const streetLastBetTo = streetBet[button.bbSeat]!;

  let hand: HandState = {
    handNo,
    level,
    sb,
    bb,
    ante,
    btn: button.btn,
    sbSeat: button.sbSeat,
    bbSeat: button.bbSeat,
    street: 0,
    deck,
    hole,
    board: [],
    startStacks: startStacks as number[],
    commits: commits as number[],
    streetBet: streetBet as number[],
    folded: folded as boolean[],
    allIn: allIn as boolean[],
    toAct: -1,
    streetLastBetTo,
    lastBetSize: bb,
    actSeq: 0,
    actions: [],
    deadline: null,
    revealed: [],
    phase: 'betting',
    won: null,
    eliminated: [],
  };

  const firstToAct = nextActable(folded, allIn, button.bbSeat);
  if (firstToAct === null || shouldCloseStreet(hand)) {
    hand = advanceStreetsOrSettle(hand, players, now);
  } else {
    hand = { ...hand, toAct: firstToAct, deadline: computeDeadline(now, players[firstToAct]!.timeBankMs) };
  }

  return { hand, prevSbSeat: button.sbSeat, prevBbSeat: button.bbSeat, button };
}

function cardIdxOffset(hand: HandState): number {
  return Object.keys(hand.hole).length * 2;
}

/** ストリートを閉じられる間、次のボードを配り続ける（全員オールインなら river まで一気に）。 */
function advanceStreetsOrSettle(hand: HandState, players: readonly PlayerState[], now: number): HandState {
  let h = hand;
  const nonFolded = h.folded.filter((f) => !f).length;
  if (nonFolded <= 1) {
    return { ...h, toAct: -1, deadline: null, phase: 'showdown' };
  }
  while (shouldCloseStreet(h) && h.street < 3) {
    const nextStreet = h.street + 1;
    const offset = cardIdxOffset(h);
    const boardLen = BOARD_COUNT[nextStreet]!;
    const board = h.deck.slice(offset, offset + boardLen);
    h = {
      ...h,
      street: nextStreet,
      board,
      streetBet: new Array<number>(h.streetBet.length).fill(0),
      streetLastBetTo: 0,
      lastBetSize: h.bb,
    };
  }
  if (shouldCloseStreet(h)) {
    return { ...h, toAct: -1, deadline: null, phase: 'showdown' };
  }
  const firstToAct = nextActable(h.folded, h.allIn, h.btn);
  if (firstToAct === null) {
    return { ...h, toAct: -1, deadline: null, phase: 'showdown' };
  }
  return { ...h, toAct: firstToAct, deadline: computeDeadline(now, players[firstToAct]!.timeBankMs), actSeq: h.actSeq + 1 };
}

// ---------------------------------------------------------------------------
// アクション適用
// ---------------------------------------------------------------------------

export interface ResolvedAction {
  readonly kind: ActionKind;
  readonly betTo: number;
  readonly put: number;
}

/**
 * 額とスタックから実際に記録する kind/betTo/put を決める（全額出したら allin に格上げ）。
 * 合法性は `computeLegalActions`（唯一の正本）で判定する。
 */
export function resolveAction(
  hand: HandState,
  seat: number,
  requested: ActionKind,
  betTo: number | undefined,
  stack: number,
): ResolvedAction | null {
  const legal = computeLegalActions(hand, seat, stack);
  const myBet = hand.streetBet[seat] ?? 0;

  if (requested === 'fold') {
    if (!legal.canFold) return null;
    return { kind: 'fold', betTo: hand.streetLastBetTo, put: 0 };
  }
  if (requested === 'check') {
    if (!legal.canCheck) return null;
    return { kind: 'check', betTo: hand.streetLastBetTo, put: 0 };
  }
  if (requested === 'call') {
    if (legal.callPut === null) return null;
    const newBetTo = myBet + legal.callPut;
    return { kind: legal.callPut >= stack ? 'allin' : 'call', betTo: newBetTo, put: legal.callPut };
  }
  if (requested === 'allin') {
    if (legal.betTo !== null) {
      const put = legal.betTo.max - myBet;
      return { kind: 'allin', betTo: legal.betTo.max, put };
    }
    if (legal.callPut !== null) {
      const newBetTo = myBet + legal.callPut;
      return { kind: 'allin', betTo: newBetTo, put: legal.callPut };
    }
    return null;
  }
  // bet / raise
  if (betTo === undefined || legal.betTo === null) return null;
  if (requested === 'bet' && legal.aggression !== 'bet') return null;
  if (requested === 'raise' && legal.aggression !== 'raise') return null;
  if (betTo < legal.betTo.min || betTo > legal.betTo.max) return null;
  const put = betTo - myBet;
  return { kind: betTo >= legal.betTo.max ? 'allin' : requested, betTo, put };
}

export interface ApplyActionResult {
  readonly hand: HandState;
  readonly newTimeBankMs: number;
  readonly newAutoCount: number;
}

/**
 * 1 アクションを適用する。合法性チェックは呼び出し側（table.ts）が `resolveAction` で先に済ませる。
 * ここでは commits/streetBet/folded/allIn/actions を更新し、次の手番かストリート送りを決める。
 */
export function applyResolvedAction(
  hand: HandState,
  players: readonly PlayerState[],
  seat: number,
  resolved: ResolvedAction,
  auto: boolean,
  now: number,
): ApplyActionResult {
  const commits = hand.commits.slice();
  const streetBet = hand.streetBet.slice();
  const folded = hand.folded.slice();
  const allIn = hand.allIn.slice();

  commits[seat]! += resolved.put;
  // streetBet は「この席がこのストリートで実際に出した額」。fold は出さずに降りるだけなので
  // 上書きしない（resolved.betTo は記録用に streetLastBetTo を積んでいるだけ＝ActionRecord.betTo /
  // 圧縮表現 v1 の decode との整合のためで、実際の拠出額ではない）。check も toCall===0 の場合だけ
  // 合法なので resolved.betTo は元々 streetBet[seat] と同じ値（no-op）だが、意図を明確にするため
  // 同様に除外する。2026-09-15 QA: フォールドした席の streetBet が「そのストリートの最高額」に
  // 化けて画面に誤ったベット額が描かれるバグとして発見。
  if (resolved.kind !== 'fold' && resolved.kind !== 'check') streetBet[seat] = resolved.betTo;
  if (resolved.kind === 'fold') folded[seat] = true;
  if (resolved.kind === 'allin') allIn[seat] = true;

  let streetLastBetTo = hand.streetLastBetTo;
  let lastBetSize = hand.lastBetSize;
  if (resolved.betTo > streetLastBetTo) {
    const inc = resolved.betTo - streetLastBetTo;
    // オールインが最小レイズに満たなければレイズ権は再開しない＝lastBetSize を更新しない。
    if (resolved.kind !== 'allin' || inc >= Math.max(lastBetSize, hand.bb)) {
      lastBetSize = inc;
    }
    streetLastBetTo = resolved.betTo;
  }

  const player = players[seat]!;
  const newTimeBankMs = auto ? 0 : timeBankAfterManualAction(hand.deadline!, player.timeBankMs, now);
  const newAutoCount = auto ? player.autoCount + 1 : 0;

  const record: ActionRecord = {
    seat,
    kind: resolved.kind,
    betTo: resolved.betTo,
    put: resolved.put,
    auto,
    street: hand.street,
  };

  let h: HandState = {
    ...hand,
    commits: commits as number[],
    streetBet: streetBet as number[],
    folded: folded as boolean[],
    allIn: allIn as boolean[],
    streetLastBetTo,
    lastBetSize,
    actions: [...hand.actions, record],
  };

  const nonFolded = folded.filter((f) => !f).length;
  if (nonFolded <= 1) {
    h = { ...h, toAct: -1, deadline: null, phase: 'showdown' };
  } else if (shouldCloseStreet(h)) {
    h = advanceStreetsOrSettle(h, players, now);
  } else {
    const next = nextActable(h.folded, h.allIn, seat);
    if (next === null) {
      h = { ...h, toAct: -1, deadline: null, phase: 'showdown' };
    } else {
      h = { ...h, toAct: next, deadline: computeDeadline(now, players[next]!.timeBankMs), actSeq: h.actSeq + 1 };
    }
  }

  return { hand: h, newTimeBankMs, newAutoCount };
}

// ---------------------------------------------------------------------------
// 精算
// ---------------------------------------------------------------------------

export interface SettleResult {
  readonly hand: HandState;
  readonly players: readonly PlayerState[];
}

/** phase==='showdown' のハンドを精算する（won/eliminated/revealed を確定し、players のスタックへ反映）。 */
export function settleHand(hand: HandState, players: readonly PlayerState[], mode: GameMode): SettleResult {
  const n = players.length;
  const nonFoldedSeats: number[] = [];
  for (let s = 0; s < n; s++) if (!hand.folded[s]) nonFoldedSeats.push(s);

  let won: number[];
  let revealed: number[];
  if (nonFoldedSeats.length === 1) {
    won = settleUncontested(hand.commits, nonFoldedSeats[0]!);
    revealed = [];
  } else {
    const seated = players.map((_, s) => Object.prototype.hasOwnProperty.call(hand.hole, s));
    won = settleShowdown(hand.commits, hand.folded, seated, hand.hole, hand.board, hand.btn);
    revealed = nonFoldedSeats.slice();
  }

  const aliveBeforeSeats: number[] = [];
  for (let s = 0; s < n; s++) if (players[s]!.status !== 'out') aliveBeforeSeats.push(s);
  const aliveBefore = aliveBeforeSeats.length;

  const newStacks = players.map((p, s) => hand.startStacks[s]! - hand.commits[s]! + won[s]!);

  const bustedSeats = aliveBeforeSeats.filter((s) => newStacks[s] === 0);
  bustedSeats.sort((a, b) => hand.startStacks[b]! - hand.startStacks[a]! || a - b);

  const spec = gameModeSpec(mode);
  const payouts = spec.payouts.slice(0, players.length);

  const eliminated: { readonly seat: number; readonly place: number }[] = [];
  const placeBySeat = new Map<number, number>();
  bustedSeats.forEach((seat, i) => {
    const place = aliveBefore - bustedSeats.length + 1 + i;
    placeBySeat.set(seat, place);
    eliminated.push({ seat, place });
  });

  const remainingAfter = aliveBefore - bustedSeats.length;
  let championSeat: number | null = null;
  if (remainingAfter === 1) {
    championSeat = aliveBeforeSeats.find((s) => newStacks[s]! > 0)!;
    placeBySeat.set(championSeat, 1);
  }

  const newPlayers = players.map((p, s) => {
    const place = placeBySeat.get(s);
    if (place === undefined) {
      return { ...p, stack: newStacks[s]! };
    }
    return {
      ...p,
      stack: newStacks[s]!,
      status: 'out' as const,
      place,
      pt: payouts[place - 1] ?? 0,
    };
  });

  const settledHand: HandState = { ...hand, won, revealed, eliminated, phase: 'settled', toAct: -1, deadline: null };
  return { hand: settledHand, players: newPlayers };
}

export { nextActable, actionableSeats, isStreetComplete, shouldCloseStreet, nextLive };
export { computeLevel };
