/**
 * Drill（§7.4 トレーニング）の出題生成（純ロジック, Node テスト可）。
 *
 * 出題＝**未開（first-in）プッシュ/フォールド**局面。フォールドで hero に回ってきて、
 * hero が「オールイン or フォールド」を裁定する押し引きの基本形。hero は最後手番の BB を
 * 除く（BB 未開＝ウォークで決定が無い）。状態は formModel.buildBoardState で検証して返す
 * ＝手入力と同じ真実を経由する。
 *
 * 対象人数は「速い卓（2〜4人）」に限定（さつき承認: 裏で先読みしつつ即応性優先）。
 */

import type { BoardState } from '@oshihiki/core';
import { positionsForPlayersLeft } from '@oshihiki/core';
import { RANKS, handLabel } from '../handGrid';
import { buildBoardState, type BoardForm } from '../formModel';
import type { SolveOpts } from '../solverProtocol';

/** 0..1 の擬似乱数。テストでは seed 固定で決定的にする。 */
export type Rng = () => number;

/** mulberry32: 小さく決定的な RNG（seed 可能）。 */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface DrillFilter {
  /** 出題する残り人数の候補（2〜4）。 */
  counts: number[];
  /** スタック（合計 bb）の下限・上限。押し引き帯。 */
  minBb: number;
  maxBb: number;
}

export const DEFAULT_FILTER: DrillFilter = { counts: [2, 3, 4], minBb: 6, maxBb: 20 };

function randInt(rng: Rng, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

function pick<T>(rng: Rng, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

/** 人数別の求解パラメータ（対話速度優先＝速い卓）。 */
export function drillOpts(n: number): SolveOpts {
  switch (n) {
    case 2:
      return {};
    case 3:
      return { maxIters: 400, samples: 40_000 };
    default:
      return { maxIters: 400, samples: 30_000 };
  }
}

/**
 * 1 局面を生成して検証済み BoardState を返す。
 * 生成→buildBoardState で妥当性確認、稀に不整合なら再試行。
 */
export function generateSpot(rng: Rng, filter: DrillFilter = DEFAULT_FILTER): BoardState {
  const counts = filter.counts.length > 0 ? filter.counts : [2];
  const lo = Math.max(2, Math.min(filter.minBb, filter.maxBb));
  const hi = Math.max(filter.minBb, filter.maxBb);

  for (let tries = 0; tries < 40; tries++) {
    const n = pick(rng, counts);
    const positions = positionsForPlayersLeft(n);
    // hero は BB 以外（未開の BB はウォーク＝決定が無い）。
    const heroCandidates = positions.filter((p) => p !== 'BB');
    const heroPos = pick(rng, heroCandidates);

    const stacks: BoardForm['stacks'] = {};
    for (const p of positions) {
      const total = randInt(rng, lo, hi); // 合計スタック（bb）
      const blind = p === 'SB' ? 0.5 : p === 'BB' ? 1 : 0;
      // フォーム stack は「ベット差引後（後ろの持ち）」＝ total − blind。
      stacks[p] = String(total - blind);
    }

    const heroHand = handLabel(randInt(rng, 0, RANKS.length - 1), randInt(rng, 0, RANKS.length - 1));

    const form: BoardForm = {
      playersLeft: n,
      sb: '0.5',
      bb: '1',
      anteScheme: 'none',
      anteAmount: '0',
      heroPos,
      heroHand,
      stacks,
      gameMode: 'club', // ドリルはクラブマッチ固定。
    };

    const built = buildBoardState(form);
    if (built.ok && built.state) return built.state;
  }
  // ここに到達しないはずだが、保険として既定 HU を返す。
  const fallback = buildBoardState({
    gameMode: 'club',
    playersLeft: 2,
    sb: '0.5',
    bb: '1',
    anteScheme: 'none',
    anteAmount: '0',
    heroPos: 'SB',
    heroHand: 'A5s',
    stacks: { SB: '9.5', BB: '9' },
  });
  return fallback.state!;
}
