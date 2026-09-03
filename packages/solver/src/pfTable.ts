/**
 * N-way push/fold / AOF 事前計算テーブルのランタイム参照＋多重線形補間（env非依存コア）。
 *
 * オフライン生成（scripts/gen*wayTable.ts）した「スタック格子 × EV差(169)」を
 * D=order.length 次元の多重線形（トリ/クアッド…リニア）で補間し、solveMultiway と
 * 同型の結果を即時に返す。クライアントCPUはほぼ不要（表引き＋数百回の乗算）。
 *
 * 次元 D は meta.order.length から決まる（3人=トリリニア, 4人=クアッドリニア）。
 * 3人（pf3wayTable.ts）はこのモジュールへの薄いエイリアス＝単一の真実。
 *
 * 適用条件: playersLeft===D, blinds/ante が生成条件に一致, 各スタックが格子範囲内。
 * 範囲外（実効>maxbb 等）は pfInRange()=false を返すので、呼び出し側で solveMultiway に
 * フォールバックする。
 */
import type { BoardState, Position, SolutionNode } from '@oshihiki/core';
import { formatRange, comboCount, parseHandClass } from '@oshihiki/core';
import { icmEquities, payoutsForPlayers } from './icm.js';
import { decodeFloat16 } from './halfFloat.js';
import type { MultiwayNSolveResult } from './nwaySolver.js';

const TOTAL_COMBOS = 1326;

/** interpExplBound 未指定テーブルの既定 exploitability 上限（3人の実証値）。 */
export const PF_DEFAULT_INTERP_EXPL_BOUND = 0.06;

export interface PfMeta {
  kind: string;
  blinds: { sb: number; bb: number };
  ante: { scheme: string; amount: number };
  order: Position[];
  axis: number[];
  nodeKeys: string[];
  nodeActors: string[];
  nodeTypes: string[];
  classOrder: string[];
  stride: number;
  floatsPerNode: number;
  samples: number;
  /** 補間戦略の検証済み exploitability 上限（validate*wayTable の実測に基づく）。未指定は既定値。 */
  interpExplBound?: number;
  /** bin の要素型。'f16'=float16(2byte, 容量半減), 既定/未指定は 'f32'。 */
  dtype?: 'f32' | 'f16';
}

/**
 * バイナリ（ArrayBuffer）を meta.dtype に従って Float32Array へ復号する。
 * f16 は読込時に一度だけ float32 へ展開（探索は従来どおり float32 で行う）。
 */
export function decodePfData(meta: PfMeta, buf: ArrayBuffer): Float32Array {
  if (meta.dtype === 'f16') return decodeFloat16(new Uint16Array(buf));
  return new Float32Array(buf);
}

export interface PfTable {
  meta: PfMeta;
  data: Float32Array;
  combos: number[]; // classOrder のコンボ数
  payouts: number[];
  dims: number; // = meta.order.length
  explBound: number;
}

export function buildPfTable(meta: PfMeta, data: Float32Array): PfTable {
  const combos = meta.classOrder.map((l) => comboCount(parseHandClass(l)!.kind));
  const dims = meta.order.length;
  return {
    meta,
    data,
    combos,
    payouts: payoutsForPlayers(dims),
    dims,
    explBound: meta.interpExplBound ?? PF_DEFAULT_INTERP_EXPL_BOUND,
  };
}

function antePaid(ante: { scheme: string; amount: number }, pos: Position): number {
  if (ante.scheme === 'none') return 0;
  if (ante.scheme === 'all') return ante.amount;
  return pos === 'BB' ? ante.amount : 0;
}

/** state から order 順の総スタック(bb)を得る（total = stack + bet + ante拠出）。 */
function totalsOf(table: PfTable, state: BoardState): number[] {
  const { order, ante } = table.meta;
  return order.map((pos) => {
    const seat = state.seats.find((s) => s.pos === pos && s.state !== 'empty');
    if (!seat) throw new Error(`pfTable: missing live seat ${pos}`);
    return seat.stack + seat.bet + antePaid(ante, pos);
  });
}

/** この state を事前計算テーブルで解けるか（D人・条件一致・範囲内）。 */
export function pfInRange(table: PfTable, state: BoardState): boolean {
  if (state.playersLeft !== table.dims) return false;
  const { blinds, ante, axis } = table.meta;
  if (state.blinds.sb !== blinds.sb || state.blinds.bb !== blinds.bb) return false;
  if (state.ante.scheme !== ante.scheme || state.ante.amount !== ante.amount) return false;
  const hi = axis[axis.length - 1]!;
  const totals = totalsOf(table, state);
  // 下限はクランプ可（超短スタックは自明でテーブル最小点に丸める）。
  // 上限超えは AOF が正しいモデルでない領域なので対象外＝フォールバックさせる。
  return totals.every((t) => t <= hi + 1e-6);
}

/** axis 上の値 v の下側区間 index と比率（非等間隔対応, 範囲外はクランプ）。 */
function seg(axis: number[], v: number): [number, number, number] {
  const last = axis.length - 1;
  if (v <= axis[0]!) return [0, Math.min(1, last), 0];
  if (v >= axis[last]!) return [Math.max(0, last - 1), last, 1];
  let i = 0;
  while (i < last - 1 && v > axis[i + 1]!) i++;
  const lo = axis[i]!, hi = axis[i + 1]!;
  return [i, i + 1, (v - lo) / (hi - lo)];
}

/** D次元の平坦インデックス（各軸 G 点）。 */
function flatIndex(ix: number[], G: number): number {
  let acc = 0;
  for (const v of ix) acc = acc * G + v;
  return acc;
}

/**
 * 事前計算テーブルを D 次元多重線形補間して solveMultiway 同型の結果を返す。
 * 呼び出し前に pfInRange() を確認すること（範囲外は上限クランプになる）。
 */
export function lookupPf(table: PfTable, state: BoardState): MultiwayNSolveResult {
  const { meta, data, combos, payouts, dims: D, explBound } = table;
  const { axis, order, nodeKeys, nodeActors, nodeTypes, classOrder, stride, floatsPerNode } = meta;
  const G = axis.length;
  const NC = classOrder.length;
  const nNodes = nodeKeys.length;
  const totals = totalsOf(table, state);

  // 各軸の下側/上側 index と比率
  const segs = totals.map((v) => seg(axis, v)); // [i0,i1,f] × D
  // 2^D コーナーの (flatIdx, weight)
  const corners: [number, number][] = [];
  for (let mask = 0; mask < (1 << D); mask++) {
    const ix = new Array<number>(D);
    let w = 1;
    for (let d = 0; d < D; d++) {
      const [i0, i1, f] = segs[d]!;
      if (mask & (1 << d)) { ix[d] = i1; w *= f; } else { ix[d] = i0; w *= 1 - f; }
    }
    if (w !== 0) corners.push([flatIndex(ix, G), w]);
  }

  // eqPre はスタックから厳密に再計算（丸め回避）。eqPost は補間。
  const eqPre = icmEquities(totals, payouts);
  const eqPost = new Array<number>(D).fill(0);
  const eqPostOff = nNodes * floatsPerNode;
  for (const [pIdx, w] of corners) {
    const b = pIdx * stride;
    for (let s = 0; s < D; s++) eqPost[s]! += w * data[b + eqPostOff + s]!;
  }
  const equity: Record<string, { pre: number; post: number }> = {};
  for (let s = 0; s < D; s++) equity[order[s]!] = { pre: eqPre[s]!, post: eqPost[s]! };

  const quality = { exploitability: explBound, converged: true, iterations: 0 };
  const strategies = new Map<string, Float64Array>();
  const nodes: SolutionNode[] = [];
  for (let n = 0; n < nNodes; n++) {
    const evDiff = new Float64Array(NC);
    for (const [pIdx, w] of corners) {
      const off = pIdx * stride + n * floatsPerNode;
      for (let c = 0; c < NC; c++) evDiff[c]! += w * data[off + c]!;
    }
    const freqArr = new Float64Array(NC);
    const freq: Record<string, number> = {};
    const ev: Record<string, number> = {};
    const hands: string[] = [];
    let weighted = 0;
    for (let c = 0; c < NC; c++) {
      const label = classOrder[c]!;
      const push = evDiff[c]! >= 0 ? 1 : 0; // ゼロ交差 → 純戦略
      freqArr[c] = push;
      freq[label] = push;
      ev[label] = evDiff[c]!;
      if (push >= 0.5) hands.push(label);
      weighted += combos[c]! * push;
    }
    strategies.set(nodeKeys[n]!, freqArr);
    nodes.push({
      key: nodeKeys[n]!,
      actor: nodeActors[n]! as SolutionNode['actor'],
      actionType: nodeTypes[n]! as SolutionNode['actionType'],
      pct: (weighted / TOTAL_COMBOS) * 100,
      range: formatRange(hands),
      hands,
      freq,
      ev,
      equity: equity as SolutionNode['equity'],
      quality,
    });
  }

  return {
    nodes,
    iterations: 0,
    exploitabilityPt: explBound,
    converged: true,
    equity,
    strategies,
  };
}
