/**
 * プロトタイプ（dev専用）: ウォームスタートの initIterations を振って
 * 「速さ × 正確さ（コールド解との一致）」の最適点を探す。
 * 事前計算は正確さが命なので、ウォームでコールドと同じ答えに収束することを確認する。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { BoardState, Position } from '@oshihiki/core';
import { positionsForPlayersLeft } from '@oshihiki/core';
import { solveMultiway, maxWorkerCap, type MultiwayNSolveOptions, type MultiwayNSolveResult } from '../src/nwaySolver.js';

const log = (s: string): void => void process.stderr.write(s + '\n');
const HERE = dirname(fileURLToPath(import.meta.url));
const REF = join(HERE, '..', '..', 'harness', 'cases', '_reference-hrc-5way-blinds05-1-025.json');
interface RefPlayer { pos: Position; stack: number; }
interface RefFile { setup: { blinds: { sb: number; bb: number }; ante: { scheme: string; amount: number } }; players: RefPlayer[]; }

function buildState(ref: RefFile, bump: number): BoardState {
  const { sb, bb } = ref.setup.blinds; const ante = ref.setup.ante.amount;
  const seats = ref.players.map((p, i) => {
    const bet = p.pos === 'SB' ? sb : p.pos === 'BB' ? bb : 0;
    const st = p.stack + (i === 0 ? bump : 0);
    return { pos: p.pos, stack: st - bet - ante, state: 'live' as const, bet };
  });
  return { street: 'preflop', blinds: { sb, bb }, ante: { scheme: 'all', amount: ante },
    heroHand: 'KQo', playersLeft: 5, seats, heroPos: 'UTG', pot: seats.reduce((a, s) => a + s.bet, 0) + ante * seats.length } as BoardState;
}
function selfDiff(a: MultiwayNSolveResult, b: MultiwayNSolveResult) {
  const bm = new Map(b.nodes.map((n) => [n.key, n.pct]));
  let sum = 0, max = 0, cnt = 0;
  for (const n of a.nodes) { const o = bm.get(n.key); if (o === undefined) continue; const d = Math.abs(n.pct - o); sum += d; max = Math.max(max, d); cnt++; }
  return { avg: sum / cnt, max };
}
async function timed(state: BoardState, opts: MultiwayNSolveOptions) {
  const t0 = Number(process.hrtime.bigint() / 1000000n);
  const res = await solveMultiway(state, opts);
  return { res, ms: Number(process.hrtime.bigint() / 1000000n) - t0 };
}

async function main(): Promise<void> {
  const ref = JSON.parse(readFileSync(REF, 'utf8')) as RefFile;
  const _order = positionsForPlayersLeft(5);
  const workers = maxWorkerCap();
  const S = 80_000;
  const common = { samples: S, maxIters: 800, refreshEvery: 50, workers, commonRandom: true, plateauStopFrac: 0.03 } as MultiwayNSolveOptions;
  log(`# ウォームスタート initIterations 探索（5-way, samples=${S}, workers=${workers}）\n`);

  // base（ウォーム元）と 近傍(+2bb) の「正解」＝コールド
  const base = await timed(buildState(ref, 0), common);
  const nbState = buildState(ref, 2);
  const cold = await timed(nbState, common);
  log(`基準: 近傍(+2bb) コールド = ${(cold.ms/1000).toFixed(1)}s iters=${cold.res.iterations} expl=${cold.res.exploitabilityPt.toFixed(3)}`);
  log(`（base解でウォームし、コールド解にどれだけ一致するか／どれだけ速いかを見る）\n`);
  log(`  initIters |  時間  | iters | expl  | vsコールド 平均/最大差 | 速度`);
  for (const I of [0, 30, 60, 120, 200]) {
    const w = await timed(nbState, { ...common, initStrategy: base.res.strategies, initIterations: I });
    const d = selfDiff(w.res, cold.res);
    log(`  ${String(I).padStart(6)}    | ${(w.ms/1000).toFixed(1).padStart(5)}s | ${String(w.res.iterations).padStart(4)}  | ${w.res.exploitabilityPt.toFixed(3)} | ${d.avg.toFixed(2)}/${d.max.toFixed(1)}pt        | ${(cold.ms/w.ms).toFixed(1)}x`);
  }
}
void main();
