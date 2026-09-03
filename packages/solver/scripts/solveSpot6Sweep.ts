/**
 * 指定6人局面を「速い/中間/GOLD」で解き、各ポジションの first-in 押し% を HRC と並べる。
 * 目的: HRCとの押しレンジのズレが「速い設定のノイズ」か「設定を上げても残る根本差」かを切り分ける。
 * HRC(実測): UTG17.8 MP33.8 CO51.4 BU55.1 SB99.1 %.
 */

import type { BoardState, Position, SolutionNode } from '@oshihiki/core';
import { solveMultiway, maxWorkerCap, type MultiwayNSolveOptions } from '../src/nwaySolver.js';

const log = (s: string): void => void process.stderr.write(s + '\n');
const STACKS: Record<string, number> = { UTG: 9.7, HJ: 15.7, CO: 17.8, BU: 15.9, SB: 17.3, BB: 5.3 };
const HRC_FIRSTIN: Record<string, number> = { UTG: 17.8, HJ: 33.8, CO: 51.4, BU: 55.1, SB: 99.1 };

function buildSpot(): BoardState {
  const sb = 0.5, bb = 1, ante = 0.25;
  const seats = (Object.keys(STACKS) as Position[]).map((pos) => {
    const betBlind = pos === 'SB' ? sb : pos === 'BB' ? bb : 0;
    return { pos, stack: STACKS[pos]! - betBlind - ante, state: 'live' as const, bet: betBlind };
  });
  return {
    street: 'preflop', blinds: { sb, bb }, ante: { scheme: 'all', amount: ante },
    heroHand: 'KQo', playersLeft: 6, seats, heroPos: 'CO',
    pot: seats.reduce((a, s) => a + s.bet, 0) + ante * 6,
  } as BoardState;
}

function firstIn(nodes: SolutionNode[], pos: string): SolutionNode | undefined {
  // PU タイプ = 前方に押した人がいない（S=0）＝全員フォールドの first-in。各 actor に1つだけ。
  return nodes.find((nd) => nd.actor === pos && nd.actionType === 'PU');
}

async function run(state: BoardState, name: string, opts: MultiwayNSolveOptions) {
  const t0 = Number(process.hrtime.bigint() / 1000000n);
  const res = await solveMultiway(state, opts);
  const ms = Number(process.hrtime.bigint() / 1000000n) - t0;
  log(`\n== ${name}  (${(ms / 1000).toFixed(1)}s, iters=${res.iterations}, expl=${res.exploitabilityPt.toFixed(3)}) ==`);
  log(`  pos   HRC押%  自作押%   差`);
  let sum = 0, cnt = 0;
  for (const pos of Object.keys(HRC_FIRSTIN)) {
    const nd = firstIn(res.nodes, pos);
    if (!nd) { log(`  ${pos}: node無し`); continue; }
    const d = nd.pct - HRC_FIRSTIN[pos]!;
    sum += Math.abs(d); cnt++;
    log(`  ${pos.padEnd(4)} ${HRC_FIRSTIN[pos]!.toFixed(1).padStart(5)}  ${nd.pct.toFixed(1).padStart(6)}  ${(d >= 0 ? '+' : '') + d.toFixed(1)}`);
  }
  log(`  → first-in 平均|差| = ${(sum / cnt).toFixed(1)}pt`);
}

async function main(): Promise<void> {
  const workers = maxWorkerCap();
  const state = buildSpot();
  log(`# 6人局面 設定別 × HRC first-in 照合  workers=${workers}`);
  await run(state, '速い  5k/250', { samples: 5_000, maxIters: 250, refreshEvery: 100, workers });
  await run(state, '中間 24k/500', { samples: 24_000, maxIters: 500, refreshEvery: 100, workers });
  await run(state, 'GOLD 80k/800', { samples: 80_000, maxIters: 800, refreshEvery: 100, workers });
}
void main();
