/**
 * プロトタイプ（dev専用）: 事前計算＋補間の「端から端まで」概念実証（3人）。
 *
 * 目的（さつき承認済のPoC）:
 *  ① 3人・スタック3次元グリッド（各軸 6/10/14bb, 刻み4bb, 27点）をウォームスタートで生成。
 *  ② グリッドの隙間（各セル中心の8点）を「EV差（押しEV−降りEV）」空間でトリリニア補間し、
 *     ゼロ交差で押し/降りレンジ化（Fable指摘: ビットマスク補間ではなくEV差補間）。
 *  ③ 同じ8点を GOLD で直接解き、補間レンジ vs 直接解レンジの pt差（平均/最大）を測る（±2〜3pt目標）。
 *  ④ グリッドの保存容量を実測（生JSON / gzip）。
 *
 * これで「事前計算グリッド＋補間」でクライアントCPUをほぼ使わずGOLD精度が再現できるかが分かる。
 */
import { gzipSync } from 'node:zlib';
import type { BoardState, Position } from '@oshihiki/core';
import { positionsForPlayersLeft, comboCount, parseHandClass } from '@oshihiki/core';
import {
  solveMultiway,
  evaluateMultiwayStrategy,
  maxWorkerCap,
  type MultiwayNSolveOptions,
  type MultiwayNSolveResult,
} from '../src/nwaySolver.js';

const log = (s: string): void => void process.stderr.write(s + '\n');

// --- 盤面（3人: BU/SB/BB, blinds0.5/1, ante0.25 all）---
const SB = 0.5, BB = 1, ANTE = 0.25;
const ORDER = positionsForPlayersLeft(3); // ['BU','SB','BB']

function buildState(stacks: Record<Position, number>): BoardState {
  const seats = ORDER.map((pos) => {
    const bet = pos === 'SB' ? SB : pos === 'BB' ? BB : 0;
    const total = stacks[pos]!;
    return { pos, stack: total - bet - ANTE, state: 'live' as const, bet };
  });
  return {
    street: 'preflop', blinds: { sb: SB, bb: BB }, ante: { scheme: 'all', amount: ANTE },
    heroHand: 'KQo', playersLeft: 3, seats, heroPos: 'BU',
    pot: seats.reduce((a, s) => a + s.bet, 0) + ANTE * 3,
  } as BoardState;
}

// --- ハンドクラス（順序・コンボ数）は結果から導く ---
let LABELS: string[] = [];
let COMBOS: number[] = [];
const TOTAL_COMBOS = 1326;
function ensureLabels(res: MultiwayNSolveResult): void {
  if (LABELS.length) return;
  LABELS = Object.keys(res.nodes[0]!.freq);
  COMBOS = LABELS.map((l) => comboCount(parseHandClass(l)!.kind));
}

/** 1グリッド点の圧縮表現: nodeKey → EV差配列(169)。補間の素材。 */
type PointEvDiff = Record<string, number[]>;
function extractEvDiff(res: MultiwayNSolveResult): PointEvDiff {
  const out: PointEvDiff = {};
  for (const nd of res.nodes) out[nd.key] = LABELS.map((l) => nd.ev[l]!);
  return out;
}
/** 直接解の各ノード pct（freq加重, %）。照合の正解値。 */
function directPct(res: MultiwayNSolveResult): Record<string, number> {
  const out: Record<string, number> = {};
  for (const nd of res.nodes) out[nd.key] = nd.pct;
  return out;
}
/** EV差配列 → ゼロ交差で押しレンジ化した pct（%）。 */
function pctFromEvDiff(ev: number[]): number {
  let w = 0;
  for (let c = 0; c < ev.length; c++) if (ev[c]! >= 0) w += COMBOS[c]!;
  return (w / TOTAL_COMBOS) * 100;
}
/** 直接解の各ノード EV差配列（169）。ゼロ交差同士の照合用（土俵を揃える）。 */
function directEvDiff(res: MultiwayNSolveResult): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const nd of res.nodes) out[nd.key] = LABELS.map((l) => nd.ev[l]!);
  return out;
}

// argv: 刻み(step) を指定可能。既定は 2bb・窓[8..12]（設計値）。
const STEP = Number(process.argv[2] ?? 2);
const LO = Number(process.argv[3] ?? 8);
const HI = Number(process.argv[4] ?? 12);
const AXIS: number[] = [];
for (let v = LO; v <= HI + 1e-9; v += STEP) AXIS.push(Math.round(v * 10) / 10);
// 各セル中心（隣接グリッドの中点）を検証点にする
const TEST: number[] = [];
for (let i = 0; i < AXIS.length - 1; i++) TEST.push((AXIS[i]! + AXIS[i + 1]!) / 2);

async function timed(state: BoardState, opts: MultiwayNSolveOptions) {
  const t0 = Number(process.hrtime.bigint() / 1000000n);
  const res = await solveMultiway(state, opts);
  return { res, ms: Number(process.hrtime.bigint() / 1000000n) - t0 };
}

/** trilinear: 軸グリッドAXIS上の点群 corner(ix,iy,iz)→EV差 から (x,y,z) を補間。 */
function interpEvDiff(
  grid: Map<string, PointEvDiff>, keyOf: (i: number, j: number, k: number) => string,
  x: number, y: number, z: number,
): PointEvDiff {
  const seg = (v: number): [number, number, number] => {
    // AXIS内の下側区間インデックスと比率
    let i = 0; while (i < AXIS.length - 2 && v > AXIS[i + 1]!) i++;
    const lo = AXIS[i]!, hi = AXIS[i + 1]!;
    return [i, i + 1, (v - lo) / (hi - lo)];
  };
  const [ix0, ix1, fx] = seg(x), [iy0, iy1, fy] = seg(y), [iz0, iz1, fz] = seg(z);
  const corners: { i: number; j: number; k: number; w: number }[] = [];
  for (const [ci, wi] of [[ix0, 1 - fx], [ix1, fx]] as const)
    for (const [cj, wj] of [[iy0, 1 - fy], [iy1, fy]] as const)
      for (const [ck, wk] of [[iz0, 1 - fz], [iz1, fz]] as const)
        corners.push({ i: ci, j: cj, k: ck, w: wi * wj * wk });
  const out: PointEvDiff = {};
  const nodeKeys = Object.keys(grid.get(keyOf(ix0, iy0, iz0))!);
  for (const nk of nodeKeys) {
    const acc = new Array<number>(LABELS.length).fill(0);
    for (const c of corners) {
      if (c.w === 0) continue;
      const ev = grid.get(keyOf(c.i, c.j, c.k))![nk]!;
      for (let t = 0; t < acc.length; t++) acc[t]! += c.w * ev[t]!;
    }
    out[nk] = acc;
  }
  return out;
}

async function main(): Promise<void> {
  const workers = maxWorkerCap();
  const S = 60_000;
  const SREF = 120_000; // 正解（直接解）はノイズ低減のため高サンプル
  // GOLD相当（3人は6ノードと軽い。CRN+plateauで安定収束）
  const gold: MultiwayNSolveOptions = { samples: S, maxIters: 800, refreshEvery: 60, workers, commonRandom: true, plateauStopFrac: 0.02 };
  const goldRef: MultiwayNSolveOptions = { ...gold, samples: SREF };
  const nGrid = AXIS.length ** 3, nTest = TEST.length ** 3;
  log(`# 3人 事前計算＋補間 概念実証（grid samples=${S} / ref samples=${SREF}, workers=${workers}）`);
  log(`# グリッド: 各軸 ${AXIS.join('/')}bb（刻み${STEP}, ${nGrid}点） / 補間検証: 各セル中心（${nTest}点）\n`);

  const keyOf = (i: number, j: number, k: number): string => `${i},${j},${k}`;
  const grid = new Map<string, PointEvDiff>();

  // --- ① グリッド生成（ウォームスタート: 直前に解いた点の戦略で温める）---
  let warm: Map<string, Float64Array> | undefined;
  let gtMs = 0, gtCount = 0, gtIters = 0;
  log(`グリッド生成中...`);
  for (let i = 0; i < AXIS.length; i++)
    for (let j = 0; j < AXIS.length; j++)
      for (let k = 0; k < AXIS.length; k++) {
        const st = buildState({ BU: AXIS[i]!, SB: AXIS[j]!, BB: AXIS[k]! } as Record<Position, number>);
        const opts: MultiwayNSolveOptions = warm ? { ...gold, initStrategy: warm, initIterations: 120 } : gold;
        const { res, ms } = await timed(st, opts);
        ensureLabels(res);
        grid.set(keyOf(i, j, k), extractEvDiff(res));
        warm = res.strategies;
        gtMs += ms; gtCount++; gtIters += res.iterations;
      }
  log(`  生成完了: ${gtCount}点 / 合計${(gtMs / 1000).toFixed(1)}s / 平均${(gtMs / gtCount / 1000).toFixed(2)}s・${Math.round(gtIters / gtCount)}反復\n`);

  // --- ④ 保存容量（生JSON / gzip）---
  const serial: Record<string, PointEvDiff> = {};
  for (const [k, v] of grid) serial[k] = v;
  const rawJson = JSON.stringify(serial);
  const rawBytes = Buffer.byteLength(rawJson, 'utf8');
  const gzBytes = gzipSync(Buffer.from(rawJson)).length;
  log(`保存容量(${nGrid}点, EV差169×6ノード): 生JSON ${(rawBytes / 1024).toFixed(1)}KB / gzip ${(gzBytes / 1024).toFixed(1)}KB\n`);

  // --- ②③ 補間 vs 直接解 照合 ---
  // 指標B : 補間ゼロ交差% vs 直接解ゼロ交差%（レンジ%の差, 参考）
  // ノイズ床: 同一スポットをシード違い2回で直接解し zero-cross% の揺れ（%指標の下限ノイズ）
  // 実コスト: 「補間で作った戦略」の exploitability(pt) vs 直接解の exploitability(pt)
  //          ＝事前計算＋補間レンジを使うと最適から何pt損するか（本質指標）
  const nearestKey = (v: number): number => {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < AXIS.length; i++) { const d = Math.abs(AXIS[i]! - v); if (d < bd) { bd = d; bi = i; } }
    return bi;
  };
  log(`補間 vs 直接解 照合（各セル中心）:`);
  log(`  test点(BU/SB/BB) | レンジ%差 平均/最大 | ノイズ床 平均/最大 || expl(pt): 直接 / 補間 / 最寄り`);
  const bAvg: number[] = [], nAvg: number[] = [], exD: number[] = [], exI: number[] = [], exN: number[] = [];
  let bMax = 0, nMax = 0;
  for (const x of TEST) for (const y of TEST) for (const z of TEST) {
    const interp = interpEvDiff(grid, keyOf, x, y, z);
    const st = buildState({ BU: x, SB: y, BB: z } as Record<Position, number>);
    const res = (await solveMultiway(st, goldRef)); // 直接GOLD（正解, seed既定）
    const res2 = (await solveMultiway(st, { ...goldRef, seed: 12345 })); // ノイズ床用（別seed）
    const dev = directEvDiff(res), dev2 = directEvDiff(res2);
    let bSum = 0, bM = 0, nSum = 0, nM = 0, cnt = 0;
    for (const nd of res.nodes) {
      const ip = pctFromEvDiff(interp[nd.key]!);
      const dB = Math.abs(ip - pctFromEvDiff(dev[nd.key]!)); bSum += dB; bM = Math.max(bM, dB);
      const dN = Math.abs(pctFromEvDiff(dev[nd.key]!) - pctFromEvDiff(dev2[nd.key]!)); nSum += dN; nM = Math.max(nM, dN);
      cnt++;
    }
    // 補間戦略の実コスト: EV差>=0 を push(1) とする純戦略を評価
    const interpProduce = (key: string): Float64Array => {
      const ev = interp[key]; const arr = new Float64Array(LABELS.length);
      if (ev) for (let c = 0; c < arr.length; c++) arr[c] = ev[c]! >= 0 ? 1 : 0;
      return arr;
    };
    const evalInterp = await evaluateMultiwayStrategy(st, interpProduce, goldRef);
    // 最寄りグリッド点の戦略（補間なし）
    const nn = grid.get(keyOf(nearestKey(x), nearestKey(y), nearestKey(z)))!;
    const nnProduce = (key: string): Float64Array => {
      const ev = nn[key]; const arr = new Float64Array(LABELS.length);
      if (ev) for (let c = 0; c < arr.length; c++) arr[c] = ev[c]! >= 0 ? 1 : 0;
      return arr;
    };
    const evalNN = await evaluateMultiwayStrategy(st, nnProduce, goldRef);
    bAvg.push(bSum / cnt); nAvg.push(nSum / cnt); bMax = Math.max(bMax, bM); nMax = Math.max(nMax, nM);
    exD.push(res.exploitabilityPt); exI.push(evalInterp.exploitabilityPt); exN.push(evalNN.exploitabilityPt);
    log(`  ${String(x).padStart(4)}/${String(y).padStart(4)}/${String(z).padStart(4)} | ${(bSum / cnt).toFixed(2)}/${bM.toFixed(1)}       | ${(nSum / cnt).toFixed(2)}/${nM.toFixed(1)}       || ${res.exploitabilityPt.toFixed(3)} / ${evalInterp.exploitabilityPt.toFixed(3)} / ${evalNN.exploitabilityPt.toFixed(3)}`);
  }
  const avg = (a: number[]): number => a.reduce((x, y) => x + y, 0) / a.length;
  log(`\nレンジ%差 : 平均${avg(bAvg).toFixed(2)}pt / 最大${bMax.toFixed(1)}pt`);
  log(`ノイズ床  : 平均${avg(nAvg).toFixed(2)}pt / 最大${nMax.toFixed(1)}pt ← %指標の下限。補間誤差がこれに近ければ実質ノイズ`);
  log(`実コスト(超過損, 最適比):`);
  log(`  補間     = ${(avg(exI) - avg(exD)).toFixed(3)}pt  （直接解 expl ${avg(exD).toFixed(3)} → 補間 ${avg(exI).toFixed(3)}）`);
  log(`  最寄り点 = ${(avg(exN) - avg(exD)).toFixed(3)}pt  （補間なし ${avg(exN).toFixed(3)}）← 補間がこれより小さければ補間が効いている`);
}
void main();
