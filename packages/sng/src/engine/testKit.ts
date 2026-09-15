/**
 * テスト専用の小道具（決定的 rng・テーブルの立ち上げヘルパー）。`*.test.ts` からのみ import する。
 */

import { engine, type Rng } from '../engine';
import type { ActionKind, PlayerState, SngConfig, TableState } from '../types';

/** 決定的な LCG。rng() は [0,1)。 */
export function makeRng(seed: number): Rng {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function defaultConfig(overrides: Partial<SngConfig> = {}): SngConfig {
  return {
    players: 6,
    startBb: 100,
    speed: 'normal',
    levelMin: 3,
    mode: 'club',
    ...overrides,
  };
}

/** ホスト u0 でテーブルを作り、config.players 人になるまで join させる（満席で自動開始）。 */
export function startTable(config: SngConfig, seed: number, now = 0): { state: TableState; rng: Rng } {
  const rng = makeRng(seed);
  let state = engine.createTable('sg_test', 'u0', 'Host', config, now);
  for (let i = 1; i < config.players; i++) {
    const r = engine.apply(state, { t: 'join', userId: `u${i}`, name: `P${i}` }, now, rng);
    if (!r.ok) throw new Error(`join failed at i=${i}: ${r.error}`);
    state = r.state;
  }
  return { state, rng };
}

export function playerBySeat(state: TableState, seat: number): PlayerState {
  return state.players.find((p) => p.seat === seat)!;
}

export function currentActorUserId(state: TableState): string {
  const hand = state.hand;
  if (!hand || hand.toAct === -1) throw new Error('no one to act');
  return playerBySeat(state, hand.toAct).userId;
}

export function act(state: TableState, now: number, rng: Rng, kind: ActionKind, betTo?: number): TableState {
  const hand = state.hand;
  if (!hand) throw new Error('no hand in progress');
  const userId = currentActorUserId(state);
  const r = engine.apply(state, { t: 'act', userId, handNo: hand.handNo, actSeq: hand.actSeq, kind, betTo }, now, rng);
  if (!r.ok) throw new Error(`act(${kind}) failed: ${r.error}`);
  return r.state;
}

/** ハンドが終わる(hand===null か phase==='settled')まで、手番の人が check/call し続ける（フォールドなし）。 */
export function runToShowdown(state: TableState, now: number, rng: Rng, maxSteps = 200): TableState {
  let s = state;
  for (let i = 0; i < maxSteps; i++) {
    if (!s.hand || s.hand.phase === 'settled' || s.hand.toAct === -1) return s;
    const legal = engine.legalActions(engine.publicTable(s).hand!, s.hand.toAct, stackOfSeat(s, s.hand.toAct));
    if (legal.canCheck) s = act(s, now, rng, 'check');
    else s = act(s, now, rng, 'call');
  }
  throw new Error('runToShowdown: too many steps');
}

export function stackOfSeat(state: TableState, seat: number): number {
  const hand = state.hand!;
  return hand.startStacks[seat]! - hand.commits[seat]!;
}

/** 手番の人が check できれば check、できなければ call する 1 手。 */
export function actCheckOrCall(state: TableState, now: number, rng: Rng): TableState {
  const hand = state.hand!;
  const legal = engine.legalActions(engine.publicTable(state).hand!, hand.toAct, stackOfSeat(state, hand.toAct));
  return act(state, now, rng, legal.canCheck ? 'check' : 'call');
}

/** currentActor が targetUserId になるまで check/call を繰り返す。 */
export function actCheckOrCallUntil(state: TableState, targetUserId: string, now: number, rng: Rng, maxSteps = 50): TableState {
  let s = state;
  for (let i = 0; i < maxSteps; i++) {
    if (!s.hand || s.hand.toAct === -1) return s;
    if (currentActorUserId(s) === targetUserId) return s;
    s = actCheckOrCall(s, now, rng);
  }
  throw new Error('actCheckOrCallUntil: too many steps');
}
