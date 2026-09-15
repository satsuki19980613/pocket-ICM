/**
 * テーブルのライフサイクル（join/leave/sitin/connected/act/wake）。docs/SNG_DESIGN.md §1。
 * `engine/hand.ts` が 1 ハンドの中身、ここは部屋全体の状態遷移。
 */

import { gameModeSpec } from '@oshihiki/core';

import { BASE_BB } from '../types';
import type {
  EngineCommand,
  EngineEffect,
  EngineError,
  EngineResult,
} from '../engine';
import type { ActionKind, HandState, PlayerState, SngConfig, SngGameResult, SngHandRecord, TableState } from '../types';
import {
  AUTO_TO_SITOUT,
  BETWEEN_HANDS_MS,
  PAUSED_EXPIRES_MS,
  TIME_BANK_MS,
  WAITING_EXPIRES_MS,
} from '../types';
import { computeLevel } from './level';
import {
  applyResolvedAction,
  dealHand,
  resolveAction,
  settleHand,
  type ResolvedAction,
} from './hand';
import type { Rng } from '../engine';

function err(error: EngineError): EngineResult {
  return { ok: false, error };
}

function ok(state: TableState, effects: readonly EngineEffect[] = []): EngineResult {
  return { ok: true, state, effects };
}

function bump(state: TableState): TableState {
  return { ...state, seq: state.seq + 1 };
}

// ---------------------------------------------------------------------------
// createTable
// ---------------------------------------------------------------------------

export function createTable(
  roomId: string,
  hostId: string,
  hostName: string,
  config: SngConfig,
  now: number,
): TableState {
  const host: PlayerState = {
    userId: hostId,
    name: hostName,
    seat: 0,
    stack: config.startBb * BASE_BB,
    status: 'active',
    connected: true,
    timeBankMs: TIME_BANK_MS,
    autoCount: 0,
    place: null,
    pt: null,
  };
  return {
    roomId,
    hostId,
    config,
    status: 'waiting',
    createdAt: now,
    startedAt: null,
    endedAt: null,
    players: [host],
    hand: null,
    handNo: 0,
    prevSbSeat: null,
    prevBbSeat: null,
    seq: 1,
    wake: { at: now + WAITING_EXPIRES_MS, kind: 'waiting_expired' },
  };
}

// ---------------------------------------------------------------------------
// 手番の自動処理（sitout/left の即時処理・タイムアウトの自動処理）を共通化。
// ---------------------------------------------------------------------------

function needsAutoAct(p: PlayerState): boolean {
  return p.status === 'sitout' || p.status === 'left';
}

function autoResolveFor(hand: HandState, seat: number, stack: number): ResolvedAction {
  const check = resolveAction(hand, seat, 'check', undefined, stack);
  if (check) return check;
  const fold = resolveAction(hand, seat, 'fold', undefined, stack);
  if (fold) return fold;
  // 理論上ここには来ない（toAct ならどちらかは必ず合法）。安全側でチェック相当を返す。
  return { kind: 'check', betTo: hand.streetLastBetTo, put: 0 };
}

function stackOf(hand: HandState, players: readonly PlayerState[], seat: number): number {
  return hand.startStacks[seat]! - hand.commits[seat]!;
}

/**
 * hand.toAct が sitout/left の間、タイマー無しで自動処理し続ける。
 */
function advanceAutoTurns(hand: HandState, players: readonly PlayerState[], now: number): HandState {
  let h = hand;
  while (h.toAct !== -1 && needsAutoAct(players[h.toAct]!)) {
    const seat = h.toAct;
    const resolved = autoResolveFor(h, seat, stackOf(h, players, seat));
    const applied = applyResolvedAction(h, players, seat, resolved, true, now);
    h = applied.hand;
  }
  return h;
}

interface Progression {
  readonly hand: HandState;
  readonly players: readonly PlayerState[];
  readonly effects: EngineEffect[];
  readonly gameOver: SngGameResult | null;
}

/**
 * アクション適用後の共通の後処理: sitout/left の自動消化 → ショーダウンなら精算 →
 * 試合終了判定まで。呼び出し側（apply の各ハンドラ）はこれを使って TableState を組み立てる。
 */
function progressHand(state: TableState, handAfterAction: HandState, playersAfterAction: readonly PlayerState[], now: number): Progression {
  let hand = advanceAutoTurns(handAfterAction, playersAfterAction, now);
  let players = playersAfterAction;
  const effects: EngineEffect[] = [];

  if (hand.phase === 'showdown') {
    const settled = settleHand(hand, players, state.config.mode);
    hand = settled.hand;
    players = settled.players;

    const shown: Record<number, readonly [string, string]> = {};
    for (const seat of hand.revealed) {
      const h = hand.hole[seat];
      if (h) shown[seat] = h;
    }
    const record: SngHandRecord = {
      gameId: state.roomId,
      handNo: hand.handNo,
      playedAt: now,
      level: hand.level,
      sb: hand.sb,
      bb: hand.bb,
      ante: hand.ante,
      btn: hand.btn,
      sbSeat: hand.sbSeat,
      bbSeat: hand.bbSeat,
      startStacks: hand.startStacks,
      shown,
      board: hand.board,
      actions: hand.actions,
      won: hand.won!,
      eliminated: hand.eliminated,
    };
    const holes: Record<string, readonly [string, string]> = {};
    for (const [seatStr, cards] of Object.entries(hand.hole)) {
      const seat = Number(seatStr);
      holes[players[seat]!.userId] = cards;
    }
    effects.push({ t: 'hand_finished', record, holes });

    const aliveAfter = players.filter((p) => p.status !== 'out').length;
    if (aliveAfter <= 1) {
      const gameOver = buildGameResult(state, players, now, 'finished');
      return { hand, players, effects, gameOver };
    }
  }

  return { hand, players, effects, gameOver: null };
}

/** progressHand の結果を TableState へ反映する（wake の張り替え・試合終了の共通処理）。 */
function finalizeProgression(
  state: TableState,
  progressed: Progression,
  now: number,
  extra: Partial<TableState> = {},
): { state: TableState; effects: EngineEffect[] } {
  const effects = [...progressed.effects];
  let next: TableState = { ...state, ...extra, players: progressed.players, hand: progressed.hand };
  if (progressed.gameOver) {
    next = { ...next, status: 'finished', endedAt: now, wake: null };
    effects.push({ t: 'game_over', result: progressed.gameOver });
    effects.push({ t: 'lobby_changed' });
  } else if (progressed.hand.phase === 'settled') {
    next = { ...next, wake: { at: now + BETWEEN_HANDS_MS, kind: 'next_hand' } };
  } else if (progressed.hand.deadline !== null) {
    next = { ...next, wake: { at: progressed.hand.deadline, kind: 'action_timeout' } };
  } else {
    next = { ...next, wake: null };
  }
  return { state: bump(next), effects };
}

function buildGameResult(
  state: TableState,
  players: readonly PlayerState[],
  now: number,
  status: 'finished' | 'cancelled',
): SngGameResult {
  return {
    gameId: state.roomId,
    hostId: state.hostId,
    config: state.config,
    status,
    startedAt: state.startedAt,
    endedAt: now,
    hands: state.handNo,
    players: players.map((p) => ({ userId: p.userId, name: p.name, seat: p.seat, place: p.place, pt: p.pt })),
  };
}

// ---------------------------------------------------------------------------
// 次のハンドを配る / ポーズ判定（ハンド間で判定）
// ---------------------------------------------------------------------------

function dealNextHand(state: TableState, now: number, rng: Rng, forcedBtn?: number): { state: TableState; effects: EngineEffect[] } {
  const level = computeLevel(state.config, state.startedAt!, now);
  const dealt = dealHand(state.players, state.config, state.prevSbSeat, state.prevBbSeat, state.handNo + 1, level, now, rng, forcedBtn);

  const effects: EngineEffect[] = [];
  for (const [seatStr, cards] of Object.entries(dealt.hand.hole)) {
    const seat = Number(seatStr);
    effects.push({ t: 'hole', userId: state.players[seat]!.userId, handNo: dealt.hand.handNo, cards });
  }

  const progressed = progressHand(state, dealt.hand, state.players, now);

  const { state: next, effects: finalEffects } = finalizeProgression(state, progressed, now, {
    status: 'running',
    handNo: dealt.hand.handNo,
    prevSbSeat: dealt.prevSbSeat,
    prevBbSeat: dealt.prevBbSeat,
  });

  return { state: next, effects: [...effects, ...finalEffects] };
}

/** ハンド間の判定: 生存者全員が sitout/left/未接続なら paused。誰か動けるなら次のハンドを配る。 */
function checkPauseOrDeal(state: TableState, now: number, rng: Rng): { state: TableState; effects: EngineEffect[] } {
  const survivors = state.players.filter((p) => p.status !== 'out' && p.status !== 'left');
  const allAway = survivors.length === 0 || survivors.every((p) => p.status === 'sitout' || !p.connected);
  if (allAway) {
    return {
      state: bump({ ...state, status: 'paused', hand: null, wake: { at: now + PAUSED_EXPIRES_MS, kind: 'paused_expired' } }),
      effects: [{ t: 'lobby_changed' }],
    };
  }
  return dealNextHand(state, now, rng);
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

export function apply(state: TableState, cmd: EngineCommand, now: number, rng: Rng): EngineResult {
  switch (cmd.t) {
    case 'join':
      return handleJoin(state, cmd.userId, cmd.name, now, rng);
    case 'leave':
      return handleLeave(state, cmd.userId, now, rng);
    case 'sitin':
      return handleSitin(state, cmd.userId, now, rng);
    case 'connected':
      return handleConnected(state, cmd.userId, cmd.connected, now, rng);
    case 'act':
      return handleAct(state, cmd.userId, cmd.handNo, cmd.actSeq, cmd.kind, cmd.betTo, now);
    case 'wake':
      return handleWake(state, now, rng);
    default:
      return err('illegal');
  }
}

function handleJoin(state: TableState, userId: string, name: string, now: number, rng: Rng): EngineResult {
  if (state.status === 'finished' || state.status === 'cancelled') return err('room_closed');

  const existing = state.players.find((p) => p.userId === userId);

  if (state.status === 'waiting') {
    if (existing) {
      const players = state.players.map((p) => (p.userId === userId ? { ...p, connected: true } : p));
      return ok(bump({ ...state, players }));
    }
    if (state.players.length >= state.config.players) return err('room_full');
    const seat = state.players.length;
    const newPlayer: PlayerState = {
      userId,
      name,
      seat,
      stack: state.config.startBb * BASE_BB,
      status: 'active',
      connected: true,
      timeBankMs: TIME_BANK_MS,
      autoCount: 0,
      place: null,
      pt: null,
    };
    const players = [...state.players, newPlayer];

    if (players.length === state.config.players) {
      const shuffled = shuffleSeats(players, rng);
      const forcedBtn = Math.floor(rng() * shuffled.length);
      const started: TableState = {
        ...state,
        players: shuffled,
        status: 'running',
        startedAt: now,
      };
      const { state: dealt, effects } = dealNextHand(started, now, rng, forcedBtn);
      return ok(dealt, [...effects, { t: 'lobby_changed' }]);
    }

    return ok(bump({ ...state, players }), [{ t: 'lobby_changed' }]);
  }

  // running / paused: 既に着席している人の再入室のみ。
  if (!existing) return err('room_full');
  return handleConnected(state, userId, true, now, rng);
}

function shuffleSeats(players: readonly PlayerState[], rng: Rng): PlayerState[] {
  const order = players.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = order[i]!;
    order[i] = order[j]!;
    order[j] = tmp;
  }
  const bySeat = new Array<PlayerState>(players.length);
  order.forEach((originalIdx, seat) => {
    bySeat[seat] = { ...players[originalIdx]!, seat };
  });
  return bySeat;
}

function handleLeave(state: TableState, userId: string, now: number, rng: Rng): EngineResult {
  const existing = state.players.find((p) => p.userId === userId);
  if (!existing) return err('not_seated');

  if (state.status === 'waiting') {
    if (userId === state.hostId) {
      const result = buildGameResult(state, state.players, now, 'cancelled');
      const next: TableState = { ...state, status: 'cancelled', endedAt: now, wake: null };
      return ok(bump(next), [{ t: 'game_over', result }, { t: 'lobby_changed' }]);
    }
    const players = state.players.filter((p) => p.userId !== userId).map((p, i) => ({ ...p, seat: i }));
    return ok(bump({ ...state, players }), [{ t: 'lobby_changed' }]);
  }

  if (state.status !== 'running' && state.status !== 'paused') return err('room_closed');

  let players = state.players.map((p) => (p.userId === userId ? { ...p, status: 'left' as const, connected: false } : p));

  // 生存者(active/sitout)が 1 人だけになったら、その人の勝ちで即終了。
  const stillIn = players.filter((p) => p.status === 'active' || p.status === 'sitout');
  if (stillIn.length === 1) {
    const winnerId = stillIn[0]!.userId;
    const totalPlayers = players.length;
    const payouts = gameModeSpec(state.config.mode).payouts.slice(0, totalPlayers);

    const usedPlaces = new Set(players.filter((p) => p.place !== null).map((p) => p.place!));
    usedPlaces.add(1);
    const openSlots: number[] = [];
    for (let pl = 2; pl <= totalPlayers; pl++) if (!usedPlaces.has(pl)) openSlots.push(pl);
    const strandedLeft = players
      .filter((p) => p.userId !== winnerId && p.place === null)
      .sort((a, b) => b.stack - a.stack);

    const placeByUserId = new Map<string, number>();
    placeByUserId.set(winnerId, 1);
    strandedLeft.forEach((p, i) => placeByUserId.set(p.userId, openSlots[i]!));

    players = players.map((p) => {
      const place = placeByUserId.get(p.userId);
      if (place === undefined) return p;
      return { ...p, place, pt: payouts[place - 1] ?? 0 };
    });

    const result = buildGameResult(state, players, now, 'finished');
    const next: TableState = { ...state, status: 'finished', endedAt: now, players, hand: null, wake: null };
    return ok(bump(next), [{ t: 'game_over', result }, { t: 'lobby_changed' }]);
  }

  const hand = state.hand;
  if (hand !== null && hand.toAct !== -1 && players[hand.toAct]!.userId === userId) {
    const progressed = progressHand(state, hand, players, now);
    const { state: next, effects } = finalizeProgression(state, progressed, now);
    return ok(next, [...effects, { t: 'lobby_changed' }]);
  }

  return ok(bump({ ...state, players }), [{ t: 'lobby_changed' }]);
}

function handleSitin(state: TableState, userId: string, now: number, rng: Rng): EngineResult {
  const existing = state.players.find((p) => p.userId === userId);
  if (!existing) return err('not_seated');
  if (existing.status === 'out' || existing.status === 'left') return err('illegal');

  const players = state.players.map((p) => (p.userId === userId ? { ...p, status: 'active' as const, autoCount: 0 } : p));
  let next: TableState = { ...state, players };

  if (state.status === 'paused') {
    return okWithPauseCheck({ ...state, players }, now, rng);
  }
  return ok(bump(next));
}

function handleConnected(state: TableState, userId: string, connected: boolean, now: number, rng: Rng): EngineResult {
  const existing = state.players.find((p) => p.userId === userId);
  if (!existing) return err('not_seated');
  const players = state.players.map((p) => (p.userId === userId ? { ...p, connected } : p));

  if (state.status === 'paused' && connected) {
    return okWithPauseCheck({ ...state, players }, now, rng);
  }
  return ok(bump({ ...state, players }));
}

function okWithPauseCheck(state: TableState, now: number, rng: Rng): EngineResult {
  const { state: next, effects } = checkPauseOrDeal(state, now, rng);
  return ok(next, effects);
}

function handleAct(
  state: TableState,
  userId: string,
  handNo: number,
  actSeq: number,
  kind: ActionKind,
  betTo: number | undefined,
  now: number,
): EngineResult {
  if (state.status === 'finished' || state.status === 'cancelled') return err('room_closed');
  if (state.hand === null) return err('illegal');
  const hand = state.hand;
  const player = state.players.find((p) => p.userId === userId);
  if (!player) return err('not_seated');
  const seat = player.seat;
  if (hand.handNo !== handNo || hand.actSeq !== actSeq) return err('stale');
  if (hand.toAct !== seat) return err('not_your_turn');

  const stack = hand.startStacks[seat]! - hand.commits[seat]!;
  const resolved = resolveAction(hand, seat, kind, betTo, stack);
  if (!resolved) return err('illegal');

  const applied = applyResolvedAction(hand, state.players, seat, resolved, false, now);
  const players = state.players.map((p, s) =>
    s === seat ? { ...p, timeBankMs: applied.newTimeBankMs, autoCount: applied.newAutoCount } : p,
  );

  const progressed = progressHand(state, applied.hand, players, now);
  const { state: next, effects } = finalizeProgression(state, progressed, now);
  return ok(next, effects);
}

function handleWake(state: TableState, now: number, rng: Rng): EngineResult {
  if (state.wake === null || now < state.wake.at) return ok(state);

  switch (state.wake.kind) {
    case 'waiting_expired': {
      const result = buildGameResult(state, state.players, now, 'cancelled');
      const next: TableState = { ...state, status: 'cancelled', endedAt: now, wake: null };
      return ok(bump(next), [{ t: 'game_over', result }, { t: 'lobby_changed' }]);
    }
    case 'paused_expired': {
      const result = buildGameResult(state, state.players, now, 'cancelled');
      const next: TableState = { ...state, status: 'cancelled', endedAt: now, hand: null, wake: null };
      return ok(bump(next), [{ t: 'game_over', result }, { t: 'lobby_changed' }]);
    }
    case 'next_hand': {
      const { state: next, effects } = checkPauseOrDeal(state, now, rng);
      return ok(next, effects);
    }
    case 'action_timeout': {
      const hand = state.hand;
      if (hand === null || hand.toAct === -1 || hand.deadline === null) return ok(state);
      const seat = hand.toAct;
      const player = state.players[seat]!;
      const stack = hand.startStacks[seat]! - hand.commits[seat]!;
      const resolved = autoResolveFor(hand, seat, stack);
      const applied = applyResolvedAction(hand, state.players, seat, resolved, true, now);
      const newAutoCount = player.autoCount + 1;
      const newStatus = newAutoCount >= AUTO_TO_SITOUT ? ('sitout' as const) : player.status;
      const players = state.players.map((p, s) =>
        s === seat ? { ...p, timeBankMs: 0, autoCount: newAutoCount, status: newStatus } : p,
      );
      const progressed = progressHand(state, applied.hand, players, now);
      const { state: next, effects } = finalizeProgression(state, progressed, now);
      return ok(next, effects);
    }
    default:
      return ok(state);
  }
}
