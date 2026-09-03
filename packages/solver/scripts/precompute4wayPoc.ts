/**
 * プロトタイプ（dev専用）: 4人の「事前計算＋補間」概念実証（本生成の前の安全確認）。
 *
 * 目的（さつき承認済の推奨手順・PoC先行）:
 *  ① 4人・スタック4次元グリッド（各軸 8/12/16bb, 刻み4bb, 3⁴=81点）をウォームで生成。
 *  ② セル中心（各軸 10/14bb, 2bbオフ格子＝補間の最悪ケース, 2⁴=16点）を「EV差
 *     （押しEV−降りEV）」空間で**クアッドリニア**補間し、ゼロ交差で押し/降りレンジ化。
 *  ③ 同じ16点を GOLD で直接解き、補間戦略 vs 直接解の pt差・**超過損(exploitability)**を測る。
 *  ④ 保存容量（生JSON / gzip）を実測。
 *
 * これで「刻み4bb で 4人も補間が成立するか（超過損 <0.05pt 目標）」がフル生成(2〜4hr)の
 * 前に分かる。3人は precompute3wayPoc で 4bb 超過損 ≈0.04pt を実証済み。
 *
 * 実行: node --import tsx scripts/precompute4wayPoc.ts [step] [lo] [hi] [gridSamples]
 *   既定 step=4, lo=8, hi=16（軸 8/12/16, セル中心 10/14）, gridSamples=60000。
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

// --- 盤面（4人: CO/BU/SB/BB, blinds0.5/1, ante0.25 all）---
const SB = 0.5, BB = 1, ANTE = 0.25;
const ORDER = positionsForPlayersLeft(4); // ['CO','BU','SB','BB']
const D = ORDER.length; // 4

function buildState(stacks: number[]): BoardState {
  const seats = ORDER.map((pos, i) => {
    const bet = pos === 'SB' ? SB : pos === 'BB' ? BB : 0;
    return { pos, stack: stacks[i]! - bet - ANTE, state: 'live' as const, bet };
  });
  return {
    street: 'preflop', blinds: { sb: SB, bb: BB }, ante: { scheme: 'all', amount: ANTE },
    heroHand: 'KQo', playersLeft: 4, seats, heroPos: 'CO',
    pot: seats.reduce((a, s) => a + s.bet, 0) + ANTE * 4,
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
/** EV差配列 → ゼロ交差で押しレンジ化した pct（%）。 */
function pctFromEvDiff(ev: number[]): number {
  let w = 0;
  for (let c = 0; c < ev.length; c++) if (ev[c]! >= 0) w += COMBOS[c]!;
  return (w / TOTAL_COMBOS) * 100;
}
/** 直接解の各ノード EV差配列（169）。ゼロ交差同士の照合用。 */
function directEvDiff(res: MultiwayNSolveResult): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const nd of res.nodes) out[nd.key] = LABELS.map((l) => nd.ev[l]!);
  return out;
}

// argv: 刻み(step) / 窓[lo..hi]。既定 step4・窓[8..16]（軸3点, セル中心2点）。
const STEP = Number(process.argv[2] ?? 4);
const LO = Number(process.argv[3] ?? 8);
const HI = Number(process.argv[4] ?? 16);
const AXIS: number[] = [];
for (let v = LO; v <= HI + 1e-9; v += STEP) AXIS.push(Math.round(v * 10) / 10);
const A = AXIS.length;
// 各セル中心（隣接グリッドの中点）を検証点にする＝2bbオフ格子の最悪ケース
const TEST: number[] = [];
for (let i = 0; i < A - 1; i++) TEST.push((AXIS[i]! + AXIS[i + 1]!) / 2);

// --- D次元の平坦インデックス ---
const idxOf = (ix: number[]): number => ix.reduce((acc, v) => acc * A + v, 0);
/** D次元グリッドの全格子点をイテレート（オドメータ）。 */
function* gridPoints(): Generator<number[]> {
  const ix = new Array<number>(D).fill(0);
  while (true) {
    yield ix.slice();
    let d = D - 1;
    while (d >= 0) { if (++ix[d]! < A) break; ix[d] = 0; d--; }
    if (d < 0) return;
  }
}

/** axis 上の値 v の下側区間 index と比率（範囲外はクランプ）。 */
function seg(v: number): [number, number, number] {
  let i = 0; while (i < A - 2 && v > AXIS[i + 1]!) i++;
  const lo = AXIS[i]!, hi = AXIS[i + 1]!;
  return [i, i + 1, (v - lo) / (hi - lo)];
}

/** D次元多重線形補間: 格子 grid[flatIdx]→EV差 から座標 xs(D個) を補間。 */
function interpEvDiff(grid: Map<number, PointEvDiff>, xs: number[]): PointEvDiff {
  const segs = xs.map(seg); // [i0,i1,f] × D
  // 2^D コーナーの (flatIdx, weight)
  const corners: { idx: number; w: number }[] = [];
  for (let mask = 0; mask < (1 << D); mask++) {
    const ix = new Array<number>(D);
    let w = 1;
    for (let d = 0; d < D; d++) {
      const [i0, i1, f] = segs[d]!;
      if (mask & (1 << d)) { ix[d] = i1; w *= f; } else { ix[d] = i0; w *= 1 - f; }
    }
    if (w !== 0) corners.push({ idx: idxOf(ix), w });
  }
  const nodeKeys = Object.keys(grid.get(corners[0]!.idx)!);
  const out: PointEvDiff = {};
  for (const nk of nodeKeys) {
    const acc = new Array<number>(LABELS.length).fill(0);
    for (const c of corners) {
      const ev = grid.get(c.idx)![nk]!;
      for (let t = 0; t < acc.length; t++) acc[t]! += c.w * ev[t]!;
    }
    out[nk] = acc;
  }
  return out;
}

async function main(): Promise<void> {
  const workers = maxWorkerCap();
  const S = Number(process.argv[5] ?? 60_000);
  const SREF = 120_000; // 正解（直接解）はノイズ低減のため高サンプル
  const gold: MultiwayNSolveOptions = { samples: S, maxIters: 800, refreshEvery: 60, workers, commonRandom: true, plateauStopFrac: 0.02 };
  const goldRef: MultiwayNSolveOptions = { ...gold, samples: SREF };
  const nGrid = A ** D, nTest = TEST.length ** D;
  log(`# 4人 事前計算＋補間 概念実証（grid samples=${S} / ref samples=${SREF}, workers=${workers}）`);
  log(`# グリッド: 各軸 ${AXIS.join('/')}bb（刻み${STEP}, ${nGrid}点） / 補間検証: 各セル中心 ${TEST.join('/')}bb（${nTest}点）\n`);

  // --- ① グリッド生成（ウォームスネーク相当: 直前点で温める）---
  const grid = new Map<number, PointEvDiff>();
  let warm: Map<string, Float64Array> | undefined;
  let gtMs = 0, gtCount = 0, gtIters = 0;
  const t0 = Date.now();
  log(`グリッド生成中（${nGrid}点）...`);
  for (const ix of gridPoints()) {
    const st = buildState(ix.map((i) => AXIS[i]!));
    const opts: MultiwayNSolveOptions = warm ? { ...gold, initStrategy: warm, initIterations: 120 } : gold;
    const s0 = Date.now();
    const res = await solveMultiway(st, opts);
    gtMs += Date.now() - s0;
    ensureLabels(res);
    grid.set(idxOf(ix), extractEvDiff(res));
    warm = res.strategies;
    gtCount++; gtIters += res.iterations;
    if (gtCount % 20 === 0 || gtCount === nGrid) {
      const eta = (gtMs / gtCount) * (nGrid - gtCount) / 1000;
      log(`  ${gtCount}/${nGrid}（平均${(gtMs / gtCount / 1000).toFixed(2)}s/点, 残り約${(eta / 60).toFixed(1)}分）`);
    }
  }
  log(`  生成完了: ${gtCount}点 / 合計${(gtMs / 1000).toFixed(1)}s / 平均${(gtMs / gtCount / 1000).toFixed(2)}s・${Math.round(gtIters / gtCount)}反復\n`);

  // --- ④ 保存容量（生JSON / gzip）---
  const serial: Record<string, PointEvDiff> = {};
  for (const [k, v] of grid) serial[k] = v;
  const rawJson = JSON.stringify(serial);
  const rawBytes = Buffer.byteLength(rawJson, 'utf8');
  const gzBytes = gzipSync(Buffer.from(rawJson)).length;
  log(`保存容量(${nGrid}点, EV差169×14ノード): 生JSON ${(rawBytes / 1024).toFixed(1)}KB / gzip ${(gzBytes / 1024).toFixed(1)}KB\n`);

  // --- ②③ 補間 vs 直接解 照合（各セル中心）---
  const nearestKey = (v: number): number => {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < A; i++) { const d = Math.abs(AXIS[i]! - v); if (d < bd) { bd = d; bi = i; } }
    return bi;
  };
  log(`補間 vs 直接解 照合（各セル中心, ${nTest}点）:`);
  log(`  test点(CO/BU/SB/BB) | レンジ%差 平均/最大 | ノイズ床 平均/最大 || expl(pt): 直接 / 補間 / 最寄り`);
  const bAvg: number[] = [], nAvg: number[] = [], exD: number[] = [], exI: number[] = [], exN: number[] = [];
  let bMax = 0, nMax = 0, tcount = 0;
  // D次元 TEST の全組み合わせ（オドメータ）
  const tix = new Array<number>(D).fill(0);
  const nT = TEST.length;
  outer: while (true) {
    const xs = tix.map((t) => TEST[t]!);
    const interp = interpEvDiff(grid, xs);
    const st = buildState(xs);
    const res = await solveMultiway(st, goldRef); // 直接GOLD（正解, seed既定）
    const res2 = await solveMultiway(st, { ...goldRef, seed: 12345 }); // ノイズ床（別seed）
    const dev = directEvDiff(res), dev2 = directEvDiff(res2);
    let bSum = 0, bM = 0, nSum = 0, nM = 0, cnt = 0;
    for (const nd of res.nodes) {
      const ip = pctFromEvDiff(interp[nd.key]!);
      const dB = Math.abs(ip - pctFromEvDiff(dev[nd.key]!)); bSum += dB; bM = Math.max(bM, dB);
      const dN = Math.abs(pctFromEvDiff(dev[nd.key]!) - pctFromEvDiff(dev2[nd.key]!)); nSum += dN; nM = Math.max(nM, dN);
      cnt++;
    }
    // 補間戦略の実コスト（純戦略 push=EV差>=0）を評価
    const interpProduce = (key: string): Float64Array => {
      const ev = interp[key]; const arr = new Float64Array(LABELS.length);
      if (ev) for (let c = 0; c < arr.length; c++) arr[c] = ev[c]! >= 0 ? 1 : 0;
      return arr;
    };
    const evalInterp = await evaluateMultiwayStrategy(st, interpProduce, goldRef);
    // 最寄りグリッド点の戦略（補間なし）
    const nn = grid.get(idxOf(xs.map(nearestKey)))!;
    const nnProduce = (key: string): Float64Array => {
      const ev = nn[key]; const arr = new Float64Array(LABELS.length);
      if (ev) for (let c = 0; c < arr.length; c++) arr[c] = ev[c]! >= 0 ? 1 : 0;
      return arr;
    };
    const evalNN = await evaluateMultiwayStrategy(st, nnProduce, goldRef);
    bAvg.push(bSum / cnt); nAvg.push(nSum / cnt); bMax = Math.max(bMax, bM); nMax = Math.max(nMax, nM);
    exD.push(res.exploitabilityPt); exI.push(evalInterp.exploitabilityPt); exN.push(evalNN.exploitabilityPt);
    tcount++;
    log(`  ${xs.map((v) => String(v).padStart(4)).join('/')} | ${(bSum / cnt).toFixed(2)}/${bM.toFixed(1)}  | ${(nSum / cnt).toFixed(2)}/${nM.toFixed(1)}  || ${res.exploitabilityPt.toFixed(3)} / ${evalInterp.exploitabilityPt.toFixed(3)} / ${evalNN.exploitabilityPt.toFixed(3)}  [${tcount}/${nTest}]`);

    // オドメータ更新
    let d = D - 1;
    while (d >= 0) { if (++tix[d]! < nT) break; tix[d] = 0; d--; }
    if (d < 0) break outer;
  }
  const avg = (a: number[]): number => a.reduce((x, y) => x + y, 0) / a.length;
  log(`\n=== 結論（4人・刻み${STEP}bb・窓[${LO}..${HI}]）===`);
  log(`レンジ%差 : 平均${avg(bAvg).toFixed(2)}pt / 最大${bMax.toFixed(1)}pt`);
  log(`ノイズ床  : 平均${avg(nAvg).toFixed(2)}pt / 最大${nMax.toFixed(1)}pt ← %指標の下限。補間誤差がこれに近ければ実質ノイズ`);
  log(`実コスト(超過損, 最適比):`);
  log(`  補間     = ${(avg(exI) - avg(exD)).toFixed(3)}pt  （直接解 expl ${avg(exD).toFixed(3)} → 補間 ${avg(exI).toFixed(3)}）← <0.05pt なら 4bb でフル生成 OK`);
  log(`  最寄り点 = ${(avg(exN) - avg(exD)).toFixed(3)}pt  （補間なし ${avg(exN).toFixed(3)}）← 補間がこれより小さければ補間が効いている`);
  log(`\n総所要 ${((Date.now() - t0) / 1000 / 60).toFixed(1)}分`);
}
void main();
