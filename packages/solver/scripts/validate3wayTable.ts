/**
 * 生成済み3人テーブル（artifacts/pf3way.*）の端から端まで検証（dev専用）。
 * バイナリ＋ランタイム（lookupPf3way）が、直接GOLD解とどれだけ一致するかを
 * 「補間戦略の exploitability 超過損」で測る。オフグリッドのランダム点で照合。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { BoardState, Position } from '@oshihiki/core';
import { positionsForPlayersLeft } from '@oshihiki/core';
import {
  buildPf3wayTable, lookupPf3way, pf3wayInRange, type Pf3wayMeta,
  solveMultiway, evaluateMultiwayStrategy, maxWorkerCap, type MultiwayNSolveOptions,
} from '../src/index.js';

const log = (s: string): void => void process.stderr.write(s + '\n');
const HERE = dirname(fileURLToPath(import.meta.url));
const ART = join(HERE, '..', 'artifacts');
const SB = 0.5, BB = 1, ANTE = 0.25;
const ORDER = positionsForPlayersLeft(3);

function buildState(st: [number, number, number]): BoardState {
  const seats = ORDER.map((pos, i) => {
    const bet = pos === 'SB' ? SB : pos === 'BB' ? BB : 0;
    return { pos, stack: st[i]! - bet - ANTE, state: 'live' as const, bet };
  });
  return {
    street: 'preflop', blinds: { sb: SB, bb: BB }, ante: { scheme: 'all', amount: ANTE },
    heroHand: 'KQo', playersLeft: 3, seats, heroPos: 'BU',
    pot: seats.reduce((a, s) => a + s.bet, 0) + ANTE * 3,
  } as BoardState;
}

async function main(): Promise<void> {
  const meta = JSON.parse(readFileSync(join(ART, 'pf3way.meta.json'), 'utf8')) as Pf3wayMeta;
  const bin = readFileSync(join(ART, 'pf3way.f32.bin'));
  const data = new Float32Array(bin.buffer, bin.byteOffset, bin.byteLength / 4);
  const table = buildPf3wayTable(meta, data);
  const workers = maxWorkerCap();
  const gold: MultiwayNSolveOptions = { samples: 120_000, maxIters: 800, refreshEvery: 60, workers, commonRandom: true, plateauStopFrac: 0.02 };
  log(`# 生成テーブル検証 (軸 ${meta.axis.join('/')}bb, ${meta.axis.length ** 3}点, samples=${meta.samples})`);
  log(`  test点(BU/SB/BB) | 範囲内 | レンジ%差 平均/最大 || expl: 直接 / テーブル (pt) | 超過損`);

  // オフグリッドのランダム点（軸中間を狙う）+ 代表点
  const rng = (() => { let s = 12345; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; })();
  const tests: [number, number, number][] = [
    [9, 9, 9], [7, 15, 11], [13, 5, 20], [17, 23, 8], [3, 12, 24],
  ];
  for (let n = 0; n < 5; n++) tests.push([2 + rng() * 23, 2 + rng() * 23, 2 + rng() * 23].map((v) => Math.round(v * 10) / 10) as [number, number, number]);

  const exD: number[] = [], exT: number[] = [];
  for (const t of tests) {
    const st = buildState(t);
    const inR = pf3wayInRange(table, st);
    const tbl = lookupPf3way(table, st);
    const direct = await solveMultiway(st, gold);
    // レンジ%差
    const dm = new Map(direct.nodes.map((x) => [x.key, x.pct]));
    let sum = 0, mx = 0, cnt = 0;
    for (const nd of tbl.nodes) { const d = Math.abs(nd.pct - (dm.get(nd.key) ?? 0)); sum += d; mx = Math.max(mx, d); cnt++; }
    // テーブル戦略の実コスト
    const evalTbl = await evaluateMultiwayStrategy(st, (key) => {
      const nd = tbl.nodes.find((x) => x.key === key)!;
      const arr = new Float64Array(meta.classOrder.length);
      for (let c = 0; c < arr.length; c++) arr[c] = nd.freq[meta.classOrder[c]!]!;
      return arr;
    }, gold);
    exD.push(direct.exploitabilityPt); exT.push(evalTbl.exploitabilityPt);
    const tt = t.map((v) => String(v).padStart(4)).join('/');
    log(`  ${tt} | ${inR ? 'yes' : 'no '}   | ${(sum / cnt).toFixed(2)}/${mx.toFixed(1)}       || ${direct.exploitabilityPt.toFixed(3)} / ${evalTbl.exploitabilityPt.toFixed(3)} | ${(evalTbl.exploitabilityPt - direct.exploitabilityPt).toFixed(3)}`);
  }
  const avg = (a: number[]): number => a.reduce((x, y) => x + y, 0) / a.length;
  log(`\n総合: 直接解 expl 平均${avg(exD).toFixed(3)}pt / テーブル expl 平均${avg(exT).toFixed(3)}pt`);
  log(`      → テーブルの最適比 超過損 = ${(avg(exT) - avg(exD)).toFixed(3)}pt（プール10ptの${(((avg(exT) - avg(exD)) / 10) * 100).toFixed(2)}%）`);
}
void main();
