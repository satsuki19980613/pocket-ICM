/**
 * 3-1a の動作確認用サンプル盤面（手入力フォーム完成までの仮データ）。
 * hero は先頭（オープン）ポジション固定。等スタック中心で N=2..5 を用意。
 */

import type { BoardState, Position } from '@oshihiki/core';
import { positionsForPlayersLeft } from '@oshihiki/core';

export interface SampleSpot {
  label: string;
  state: BoardState;
  /** 目安の求解パラメータ（対話速度優先）。 */
  opts: { maxIters?: number; samples?: number };
}

function equalStacks(n: number, stack: number, heroHand: string, sb = 0.5, bb = 1.0): BoardState {
  const order = positionsForPlayersLeft(n);
  const seats = order.map((pos: Position) => {
    const bet = pos === 'SB' ? sb : pos === 'BB' ? bb : 0;
    return { pos, stack: stack - bet, state: 'live' as const, bet };
  });
  return {
    street: 'preflop',
    blinds: { sb, bb },
    ante: { scheme: 'none', amount: 0 },
    heroHand,
    playersLeft: n,
    seats,
    heroPos: order[0]!,
    pot: sb + bb,
  } as BoardState;
}

export const SAMPLE_SPOTS: SampleSpot[] = [
  { label: '2-way HU 10bb（hero SB, A5s）', state: equalStacks(2, 10, 'A5s'), opts: {} },
  { label: '3-way 10bb（hero BU, KQo）', state: equalStacks(3, 10, 'KQo'), opts: { maxIters: 300, samples: 40_000 } },
  { label: '4-way 10bb（hero CO, ATs）', state: equalStacks(4, 10, 'ATs'), opts: { maxIters: 200, samples: 30_000 } },
  { label: '5-way 12bb（hero UTG, 99）', state: equalStacks(5, 12, '99'), opts: { maxIters: 150, samples: 24_000 } },
];
