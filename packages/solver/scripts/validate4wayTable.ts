/**
 * 生成済み4人テーブル（artifacts/pf4way.*）の端から端まで検証（dev専用）。
 * バイナリ＋汎用ランタイム（lookupPf）が、直接GOLD解とどれだけ一致するかを
 * 「補間戦略の exploitability 超過損」で測る。オフグリッドのランダム点で照合。
 * 末尾に interpExplBound の推奨値（テーブル expl 平均の切り上げ）を出す。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { BoardState } from '@oshihiki/core';
import { positionsForPlayersLeft } from '@oshihiki/core';
import {
  buildPfTable, decodePfData, lookupPf, pfInRange, type PfMeta,
  solveMultiway, evaluateMultiwayStrategy, maxWorkerCap, type MultiwayNSolveOptions,
} from '../src/index.js';

const log = (s: string): void => void process.stderr.write(s + '\n');
const HERE = dirname(fileURLToPath(import.meta.url));
const ART = join(HERE, '..', 'artifacts');
const SB = 0.5, BB = 1, ANTE = 0.25;
const ORDER = positionsForPlayersLeft(4); // ['CO','BU','SB','BB']
const D = ORDER.length;

function buildState(st: number[]): BoardState {
  const seats = ORDER.map((pos, i) => {
    const bet = pos === 'SB' ? SB : pos === 'BB' ? BB : 0;
    return { pos, stack: st[i]! - bet - ANTE, state: 'live' as const, bet };
  });
  return {
    street: 'preflop', blinds: { sb: SB, bb: BB }, ante: { scheme: 'all', amount: ANTE },
    heroHand: 'KQo', playersLeft: 4, seats, heroPos: 'CO',
    pot: seats.reduce((a, s) => a + s.bet, 0) + ANTE * D,
  } as BoardState;
}

async function main(): Promise<void> {
  const meta = JSON.parse(readFileSync(join(ART, 'pf4way.meta.json'), 'utf8')) as PfMeta;
  // dtype に応じて f32/f16 の bin を読む（f16 は decodePfData で float32 へ復号）。
  const binName = meta.dtype === 'f16' ? 'pf4way.f16.bin' : 'pf4way.f32.bin';
  const bin = readFileSync(join(ART, binName));
  const ab = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
  const table = buildPfTable(meta, decodePfData(meta, ab));
  const workers = maxWorkerCap();
  const gold: MultiwayNSolveOptions = { samples: 120_000, maxIters: 800, refreshEvery: 60, workers, commonRandom: true, plateauStopFrac: 0.02 };
  const poolPt = table.payouts.reduce((a, b) => a + b, 0);
  log(`# 生成テーブル検証 (軸 ${meta.axis.join('/')}bb, ${meta.axis.length ** D}点, samples=${meta.samples}, pool=${poolPt.toFixed(1)}pt)`);
  log(`  test点(CO/BU/SB/BB) | 範囲内 | レンジ%差 平均/最大 || expl: 直接 / テーブル (pt) | 超過損`);

  // オフグリッドのランダム点（軸中間を狙う）+ 代表点
  const rng = (() => { let s = 12345; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; })();
  const tests: number[][] = [
    [9, 9, 9, 9], [7, 15, 11, 5], [13, 5, 20, 8], [17, 23, 8, 12], [3, 12, 24, 16],
    [8, 8, 8, 8], [11, 14, 6, 19],
  ];
  for (let n = 0; n < 5; n++) {
    tests.push(Array.from({ length: D }, () => Math.round((2 + rng() * 23) * 10) / 10));
  }

  const exD: number[] = [], exT: number[] = [];
  for (const t of tests) {
    const st = buildState(t);
    const inR = pfInRange(table, st);
    const tbl = lookupPf(table, st);
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
    log(`  ${tt} | ${inR ? 'yes' : 'no '}   | ${(sum / cnt).toFixed(2)}/${mx.toFixed(1)}   || ${direct.exploitabilityPt.toFixed(3)} / ${evalTbl.exploitabilityPt.toFixed(3)} | ${(evalTbl.exploitabilityPt - direct.exploitabilityPt).toFixed(3)}`);
  }
  const avg = (a: number[]): number => a.reduce((x, y) => x + y, 0) / a.length;
  const maxT = Math.max(...exT);
  log(`\n総合: 直接解 expl 平均${avg(exD).toFixed(3)}pt / テーブル expl 平均${avg(exT).toFixed(3)}pt（最大${maxT.toFixed(3)}）`);
  log(`      → テーブルの最適比 超過損 = ${(avg(exT) - avg(exD)).toFixed(3)}pt（プール${poolPt.toFixed(0)}ptの${(((avg(exT) - avg(exD)) / poolPt) * 100).toFixed(2)}%）`);
  log(`推奨 interpExplBound（テーブル expl 最大の切り上げ, 表示用の保守的上限）= ${(Math.ceil(maxT * 100) / 100).toFixed(2)}`);
}
void main();
