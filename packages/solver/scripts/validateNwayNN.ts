/**
 * 学習済み N人 NN モデル（artifacts/nn{N}way.model.*）の端から端まで検証（dev専用）。
 *
 * NN 推論（lookupNn）が直接 GOLD 解とどれだけ一致するかを「NN 戦略の exploitability 超過損」
 * で測る。テーブル検証（validate4wayTable）と同基準＝合格ゲート = 超過損 < 0.05pt（プール比）。
 * オフグリッド（学習格子の隙間）のランダム点で照合し、末尾に推奨 interpExplBound を出す。
 *
 * 実行: node --import tsx scripts/validateNwayNN.ts <players> [nTests]
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { BoardState } from '@oshihiki/core';
import { positionsForPlayersLeft } from '@oshihiki/core';
import {
  buildNnTable, lookupNn, nnInRange, type NnMeta,
  solveMultiway, evaluateMultiwayStrategy, maxWorkerCap, type MultiwayNSolveOptions,
} from '../src/index.js';

const log = (s: string): void => void process.stderr.write(s + '\n');
const HERE = dirname(fileURLToPath(import.meta.url));
const ART = join(HERE, '..', 'artifacts');
const SB = 0.5, BB = 1, ANTE = 0.25;

async function main(): Promise<void> {
  const N = Number(process.argv[2] ?? 5);
  const nTests = Number(process.argv[3] ?? 12);
  const TAG = `nn${N}way`;
  const ORDER = positionsForPlayersLeft(N);
  const D = ORDER.length;

  const meta = JSON.parse(readFileSync(join(ART, `${TAG}.model.meta.json`), 'utf8')) as NnMeta;
  const bin = readFileSync(join(ART, `${TAG}.model.bin`));
  const ab = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
  const table = buildNnTable(meta, ab);

  const buildState = (st: number[]): BoardState => {
    const seats = ORDER.map((pos, i) => {
      const bet = pos === 'SB' ? SB : pos === 'BB' ? BB : 0;
      return { pos, stack: st[i]! - bet - ANTE, state: 'live' as const, bet };
    });
    return {
      street: 'preflop', blinds: { sb: SB, bb: BB }, ante: { scheme: 'all', amount: ANTE },
      heroHand: 'KQo', playersLeft: D, seats, heroPos: ORDER[0]!,
      pot: seats.reduce((a, s) => a + s.bet, 0) + ANTE * D,
    } as BoardState;
  };

  const workers = maxWorkerCap();
  const gold: MultiwayNSolveOptions = { samples: 120_000, maxIters: 800, refreshEvery: 60, workers, commonRandom: true, plateauStopFrac: 0.02 };
  const poolPt = table.payouts.reduce((a, b) => a + b, 0);
  const hi = meta.axis[meta.axis.length - 1]!;
  log(`# ${N}人 NN モデル検証 (軸 ${meta.axis.join('/')}bb, 学習点${meta.axis.length ** D}, rows=${(meta as unknown as { trainRows?: number }).trainRows ?? '?'}, pool=${poolPt.toFixed(1)}pt)`);
  log(`  test点(${ORDER.join('/')}) | 範囲内 | レンジ%差 平均/最大 || expl: 直接 / NN (pt) | 超過損`);

  // オフグリッドのランダム点（学習格子の隙間を狙う）
  const rng = (() => { let s = 6789; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; })();
  const tests: number[][] = [];
  for (let n = 0; n < nTests; n++) {
    tests.push(Array.from({ length: D }, () => Math.round((2 + rng() * (hi - 2)) * 10) / 10));
  }

  const exD: number[] = [], exN: number[] = [];
  for (const t of tests) {
    const st = buildState(t);
    const inR = nnInRange(table, st);
    const nn = lookupNn(table, st);
    const direct = await solveMultiway(st, gold);
    const dm = new Map(direct.nodes.map((x) => [x.key, x.pct]));
    let sum = 0, mx = 0, cnt = 0;
    for (const nd of nn.nodes) { const d = Math.abs(nd.pct - (dm.get(nd.key) ?? 0)); sum += d; mx = Math.max(mx, d); cnt++; }
    const evalNn = await evaluateMultiwayStrategy(st, (key) => {
      const nd = nn.nodes.find((x) => x.key === key)!;
      const arr = new Float64Array(meta.classOrder.length);
      for (let c = 0; c < arr.length; c++) arr[c] = nd.freq[meta.classOrder[c]!]!;
      return arr;
    }, gold);
    exD.push(direct.exploitabilityPt); exN.push(evalNn.exploitabilityPt);
    const tt = t.map((v) => String(v).padStart(4)).join('/');
    log(`  ${tt} | ${inR ? 'yes' : 'no '}   | ${(sum / cnt).toFixed(2)}/${mx.toFixed(1)}   || ${direct.exploitabilityPt.toFixed(3)} / ${evalNn.exploitabilityPt.toFixed(3)} | ${(evalNn.exploitabilityPt - direct.exploitabilityPt).toFixed(3)}`);
  }
  const avg = (a: number[]): number => a.reduce((x, y) => x + y, 0) / a.length;
  const maxN = Math.max(...exN);
  const excess = avg(exN) - avg(exD);
  log(`\n総合: 直接解 expl 平均${avg(exD).toFixed(3)}pt / NN expl 平均${avg(exN).toFixed(3)}pt（最大${maxN.toFixed(3)}）`);
  log(`      → NN の最適比 超過損 = ${excess.toFixed(3)}pt（プール${poolPt.toFixed(0)}ptの${((excess / poolPt) * 100).toFixed(2)}%）`);
  log(`      合格ゲート: 超過損 < 0.05pt → ${excess < 0.05 ? 'PASS ✅' : 'FAIL ❌'}`);
  log(`推奨 interpExplBound（NN expl 最大の切り上げ, 表示用の保守的上限）= ${(Math.ceil(maxN * 100) / 100).toFixed(2)}`);
}
void main();
