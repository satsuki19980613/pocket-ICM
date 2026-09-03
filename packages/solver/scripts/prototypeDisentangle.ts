/**
 * プロトタイプ（dev専用）: 精度悪化の主因が「サンプル数」か「反復回数」かを切り分ける。
 * 前回 prototypeFastSolve では両方を同時に落としたため、どちらが効いているか不明だった。
 *   A) 反復を高く固定（600）してサンプルだけ振る → サンプルの寄与
 *   B) サンプルを高く固定（80k）して反復だけ振る → 反復（収束）の寄与
 * 参照は実 HRC 5-way。指標は 平均 |freq% 差| と exploitability。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { BoardState, Position } from '@oshihiki/core';
import { positionsForPlayersLeft, normalizeKey, parseRangeToSet } from '@oshihiki/core';
import type { ActionChar } from '@oshihiki/core';
import { solveMultiway, maxWorkerCap, type MultiwayNSolveOptions } from '../src/nwaySolver.js';

const log = (s: string): void => void process.stderr.write(s + '\n');
const HERE = dirname(fileURLToPath(import.meta.url));
const REF = join(HERE, '..', '..', 'harness', 'cases', '_reference-hrc-5way-blinds05-1-025.json');

interface RefStrategy { actor: Position; vs?: string; type: 'PU' | 'CA' | 'OC'; freqPct: number; range: string; }
interface RefPlayer { pos: Position; stack: number; eqPrePct: number; eqPostPct: number; }
interface RefFile {
  setup: { blinds: { sb: number; bb: number }; ante: { scheme: string; amount: number }; poolPt: number };
  players: RefPlayer[]; strategies: RefStrategy[];
}

function keyOf(order: Position[], s: RefStrategy): string {
  const aggressors = s.vs ? s.vs.split(',').map((x) => x.trim()) : [];
  const actions: Partial<Record<Position, ActionChar>> = {};
  const ai = order.indexOf(s.actor);
  for (let j = 0; j < ai; j++) {
    const p = order[j]!;
    if (aggressors.includes(p)) actions[p] = p === aggressors[0] ? 'P' : 'C';
    else actions[p] = 'F';
  }
  return normalizeKey(order.length, actions);
}
function buildState(ref: RefFile): BoardState {
  const { sb, bb } = ref.setup.blinds; const ante = ref.setup.ante.amount;
  const seats = ref.players.map((p) => {
    const bet = p.pos === 'SB' ? sb : p.pos === 'BB' ? bb : 0;
    return { pos: p.pos, stack: p.stack - bet - ante, state: 'live' as const, bet };
  });
  const potBets = seats.reduce((a, s) => a + s.bet, 0);
  return { street: 'preflop', blinds: { sb, bb }, ante: { scheme: 'all', amount: ante },
    heroHand: 'KQo', playersLeft: 5, seats, heroPos: 'UTG', pot: potBets + ante * seats.length } as BoardState;
}

async function runOne(state: BoardState, ref: RefFile, order: Position[], name: string, opts: MultiwayNSolveOptions) {
  const t0 = Number(process.hrtime.bigint() / 1000000n);
  const res = await solveMultiway(state, opts);
  const ms = Number(process.hrtime.bigint() / 1000000n) - t0;
  const byKey = Object.fromEntries(res.nodes.map((n) => [n.key, n]));
  let sum = 0, max = 0, cnt = 0;
  for (const s of ref.strategies) {
    const node = byKey[keyOf(order, s)];
    if (!node) continue;
    const d = Math.abs(node.pct - s.freqPct); sum += d; max = Math.max(max, d); cnt++;
  }
  log(`${name} | ${(ms / 1000).toFixed(1).padStart(6)}s | iters ${String(res.iterations).padStart(3)} conv=${res.converged ? 'Y' : 'n'} | ` +
      `expl ${res.exploitabilityPt.toFixed(4)} | 平均|freq%| ${(sum / cnt).toFixed(2)}pt 最大 ${max.toFixed(1)}pt`);
}

async function main(): Promise<void> {
  const ref = JSON.parse(readFileSync(REF, 'utf8')) as RefFile;
  const order = positionsForPlayersLeft(5);
  const state = buildState(ref);
  const workers = maxWorkerCap();
  log(`# 切り分け: サンプル vs 反復（実 HRC 5-way）  workers=${workers}\n`);

  log('## A) 反復=600 固定, サンプルを振る（サンプルの寄与）');
  for (const s of [80_000, 40_000, 20_000, 10_000]) {
    await runOne(state, ref, order, `  samples ${String(s).padStart(6)} /600`, { samples: s, maxIters: 600, refreshEvery: 100, workers });
  }
  log('\n## B) サンプル=80k 固定, 反復を振る（収束の寄与）');
  for (const it of [800, 600, 400, 250]) {
    await runOne(state, ref, order, `  80k /${String(it).padStart(3)}      `, { samples: 80_000, maxIters: it, refreshEvery: 100, workers });
  }
  log('\n## C) 反復=1500 まで伸ばす（80k, 収束余地の確認）');
  for (const it of [1000, 1500]) {
    await runOne(state, ref, order, `  80k /${String(it).padStart(4)}     `, { samples: 80_000, maxIters: it, refreshEvery: 100, workers });
  }
}
void main();
