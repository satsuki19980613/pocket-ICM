/**
 * N-way（4〜6人）逐次 push/fold 求解の実コスト計測（M4 / R-9 の続き）。
 *
 * 実行:
 *   node --import tsx packages/solver/scripts/benchNway.ts
 *   OSHIHIKI_WORKERS=16 node --import tsx packages/solver/scripts/benchNway.ts  # 並列も計測
 *
 * 計測:
 *   1. 4/5/6-way の単一スレッド求解時間・exploitability・収束
 *   2. worker 並列（CPU 60% 上限）での求解時間と、単一スレッドとの結果一致
 * 出力は stderr（人間可読）。数値は docs に転記する。
 *
 * 注: worker パスは dist（コンパイル済み）を起動する。事前に `npx tsc -b packages/solver`。
 */

import type { BoardState } from '@oshihiki/core';
import { positionsForPlayersLeft } from '@oshihiki/core';
import { solveMultiway, maxWorkerCap, type MultiwayNSolveResult } from '../src/nwaySolver.js';

const log = (s: string): void => void process.stderr.write(s + '\n');
const now = (): number => Number(process.hrtime.bigint() / 1000000n);

function equalStacks(n: number, stack: number, sb = 0.5, bb = 1.0): BoardState {
  const order = positionsForPlayersLeft(n);
  const seats = order.map((pos) => {
    const bet = pos === 'SB' ? sb : pos === 'BB' ? bb : 0;
    return { pos, stack: stack - bet, state: 'live' as const, bet };
  });
  return {
    street: 'preflop',
    blinds: { sb, bb },
    ante: { scheme: 'none', amount: 0 },
    heroHand: 'KQo',
    playersLeft: n,
    seats,
    heroPos: order[0]!,
    pot: sb + bb,
  } as BoardState;
}

/** 2 解の戦略最大絶対差（同一シードなら worker/単一で 0 のはず）。 */
function maxStratDiff(a: MultiwayNSolveResult, b: MultiwayNSolveResult): number {
  let d = 0;
  for (const [key, arr] of a.strategies) {
    const other = b.strategies.get(key)!;
    for (let i = 0; i < arr.length; i++) d = Math.max(d, Math.abs(arr[i]! - other[i]!));
  }
  return d;
}

async function main(): Promise<void> {
  log('# N-way 求解コスト実測');
  log(`node ${process.version} / cpus 60% = ${maxWorkerCap()} workers\n`);

  const CFG = { maxIters: 400, refreshEvery: 100 } as const;

  for (const n of [4, 5, 6]) {
    const state = equalStacks(n, 10);
    log(`## ${n}-way（等スタック 10bb, ante 無し）`);

    const t0 = now();
    const single = await solveMultiway(state, { ...CFG, workers: 0 });
    const msSingle = now() - t0;
    const pu = single.nodes.find((x) => x.actionType === 'PU')!;
    log(
      `  単一: ${(msSingle / 1000).toFixed(1)}s  iters=${single.iterations}  ` +
        `expl=${single.exploitabilityPt.toFixed(4)}pt  converged=${single.converged}  ` +
        `先手PU=${pu.pct.toFixed(1)}%`,
    );

    const cap = maxWorkerCap();
    if (cap > 1) {
      const t1 = now();
      const par = await solveMultiway(state, { ...CFG, workers: cap });
      const msPar = now() - t1;
      const diff = maxStratDiff(single, par);
      log(
        `  並列(${cap}): ${(msPar / 1000).toFixed(1)}s  ` +
          `speedup=${(msSingle / msPar).toFixed(2)}x  単一との戦略最大差=${diff.toExponential(2)}`,
      );
    }
    log('');
  }
}

void main();
