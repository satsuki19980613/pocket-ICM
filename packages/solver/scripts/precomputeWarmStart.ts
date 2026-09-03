/**
 * プロトタイプ（dev専用）: 共通乱数(CRN)＋ウォームスタートの実効測定。
 * 事前計算グリッドの用途を模す:
 *  A) base をコールド（従来）で解く … 基準の時間・反復・HRC精度
 *  B) base を CRN＋plateau停止で解く … 早期停止が効くか＋HRC精度維持か
 *  C) 近傍点(+2bb)を「コールド」vs「baseの解からウォームスタート」で解き、
 *     到達までの反復・時間と、両者の戦略一致（=温めても同じ答えか）を測る。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { BoardState, Position } from '@oshihiki/core';
import { positionsForPlayersLeft, normalizeKey, parseRangeToSet } from '@oshihiki/core';
import type { ActionChar } from '@oshihiki/core';
import { solveMultiway, maxWorkerCap, type MultiwayNSolveOptions, type MultiwayNSolveResult } from '../src/nwaySolver.js';

const log = (s: string): void => void process.stderr.write(s + '\n');
const HERE = dirname(fileURLToPath(import.meta.url));
const REF = join(HERE, '..', '..', 'harness', 'cases', '_reference-hrc-5way-blinds05-1-025.json');

interface RefStrategy { actor: Position; vs?: string; type: 'PU' | 'CA' | 'OC'; freqPct: number; range: string; }
interface RefPlayer { pos: Position; stack: number; eqPrePct: number; eqPostPct: number; }
interface RefFile { setup: { blinds: { sb: number; bb: number }; ante: { scheme: string; amount: number }; poolPt: number }; players: RefPlayer[]; strategies: RefStrategy[]; }

function keyOf(order: Position[], s: RefStrategy): string {
  const aggressors = s.vs ? s.vs.split(',').map((x) => x.trim()) : [];
  const actions: Partial<Record<Position, ActionChar>> = {};
  const ai = order.indexOf(s.actor);
  for (let j = 0; j < ai; j++) { const p = order[j]!; actions[p] = aggressors.includes(p) ? (p === aggressors[0] ? 'P' : 'C') : 'F'; }
  return normalizeKey(order.length, actions);
}
function buildState(ref: RefFile, bump = 0): BoardState {
  const { sb, bb } = ref.setup.blinds; const ante = ref.setup.ante.amount;
  const seats = ref.players.map((p, i) => {
    const bet = p.pos === 'SB' ? sb : p.pos === 'BB' ? bb : 0;
    const stackTotal = p.stack + (i === 0 ? bump : 0); // player0 を +bump bb
    return { pos: p.pos, stack: stackTotal - bet - ante, state: 'live' as const, bet };
  });
  const potBets = seats.reduce((a, s) => a + s.bet, 0);
  return { street: 'preflop', blinds: { sb, bb }, ante: { scheme: 'all', amount: ante },
    heroHand: 'KQo', playersLeft: 5, seats, heroPos: 'UTG', pot: potBets + ante * seats.length } as BoardState;
}

function hrcDiff(res: MultiwayNSolveResult, ref: RefFile, order: Position[]): number {
  const byKey = Object.fromEntries(res.nodes.map((n) => [n.key, n]));
  let sum = 0, cnt = 0;
  for (const s of ref.strategies) { const nd = byKey[keyOf(order, s)]; if (!nd) continue; sum += Math.abs(nd.pct - s.freqPct); cnt++; }
  return sum / cnt;
}
function selfDiff(a: MultiwayNSolveResult, b: MultiwayNSolveResult): number {
  const bm = new Map(b.nodes.map((n) => [n.key, n.pct]));
  let sum = 0, cnt = 0;
  for (const n of a.nodes) { const o = bm.get(n.key); if (o === undefined) continue; sum += Math.abs(n.pct - o); cnt++; }
  return sum / cnt;
}
async function timed(state: BoardState, opts: MultiwayNSolveOptions) {
  const t0 = Number(process.hrtime.bigint() / 1000000n);
  const res = await solveMultiway(state, opts);
  return { res, ms: Number(process.hrtime.bigint() / 1000000n) - t0 };
}

async function main(): Promise<void> {
  const ref = JSON.parse(readFileSync(REF, 'utf8')) as RefFile;
  const order = positionsForPlayersLeft(5);
  const base = buildState(ref);
  const workers = maxWorkerCap();
  const S = 80_000;
  log(`# CRN＋ウォームスタート 実効測定（5-way, samples=${S}, workers=${workers}）\n`);

  // A) コールド従来（絶対しきい値のみ）
  const A = await timed(base, { samples: S, maxIters: 800, refreshEvery: 100, workers });
  log(`A) base コールド従来      : ${(A.ms/1000).toFixed(1)}s iters=${A.res.iterations} expl=${A.res.exploitabilityPt.toFixed(3)}  HRC差=${hrcDiff(A.res, ref, order).toFixed(2)}pt`);

  // B) CRN＋plateau停止
  const B = await timed(base, { samples: S, maxIters: 800, refreshEvery: 50, workers, commonRandom: true, plateauStopFrac: 0.03 });
  log(`B) base CRN+plateau       : ${(B.ms/1000).toFixed(1)}s iters=${B.res.iterations} expl=${B.res.exploitabilityPt.toFixed(3)}  HRC差=${hrcDiff(B.res, ref, order).toFixed(2)}pt`);

  // C) 近傍点(+2bb) をコールド vs ウォーム
  const nb = buildState(ref, 2);
  const Cc = await timed(nb, { samples: S, maxIters: 800, refreshEvery: 50, workers, commonRandom: true, plateauStopFrac: 0.03 });
  log(`\nC) 近傍(+2bb) コールド     : ${(Cc.ms/1000).toFixed(1)}s iters=${Cc.res.iterations} expl=${Cc.res.exploitabilityPt.toFixed(3)}`);
  const Cw = await timed(nb, { samples: S, maxIters: 800, refreshEvery: 50, workers, commonRandom: true, plateauStopFrac: 0.03, initStrategy: B.res.strategies, initIterations: 200 });
  log(`C) 近傍(+2bb) ウォーム     : ${(Cw.ms/1000).toFixed(1)}s iters=${Cw.res.iterations} expl=${Cw.res.exploitabilityPt.toFixed(3)}`);
  log(`   ウォーム vs コールド 戦略差 = ${selfDiff(Cw.res, Cc.res).toFixed(2)}pt（小さいほど「温めても同じ答え」）`);
  log(`   速度: ウォームは コールド比 ${(Cc.ms/Cw.ms).toFixed(1)}x  （反復 ${Cc.res.iterations}→${Cw.res.iterations}）`);
}
void main();
