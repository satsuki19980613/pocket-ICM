/**
 * 3人 push or fold / AOF 事前計算テーブルのランタイム参照＋補間（env非依存コア）。
 *
 * オフライン生成（scripts/gen3wayTable.ts）した「スタック格子 × EV差(169)」を
 * トリリニア補間し、solveMultiway と同型の結果を即時に返す。クライアントCPUは
 * ほぼ不要（表引き＋数百回の乗算）。PoC（scripts/precompute3wayPoc.ts）で
 * 補間戦略の最適比 超過損 ≈0.04pt（プール比0.4%）を実証済み。
 *
 * 適用条件: playersLeft===3, blinds/ante が生成条件に一致, 各スタックが格子範囲内。
 * 範囲外（実効>maxbb 等）は inRange()=false を返すので、呼び出し側で solveMultiway に
 * フォールバックする。
 */
import type { BoardState, Position, SolutionNode } from '@oshihiki/core';
import { formatRange, comboCount, parseHandClass } from '@oshihiki/core';
import { icmEquities, payoutsForPlayers } from './icm.js';
import type { MultiwayNSolveResult } from './nwaySolver.js';

const TOTAL_COMBOS = 1326;

export interface Pf3wayMeta {
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
}

export interface Pf3wayTable {
  meta: Pf3wayMeta;
  data: Float32Array;
  combos: number[]; // classOrder のコンボ数
  payouts: number[];
}

/** 補間法そのものの実証済み exploitability 上限（PoC: 補間 ≈0.055pt, 直接解 ≈0.014pt）。 */
export const PF3WAY_INTERP_EXPL_BOUND = 0.06;

export function buildPf3wayTable(meta: Pf3wayMeta, data: Float32Array): Pf3wayTable {
  const combos = meta.classOrder.map((l) => comboCount(parseHandClass(l)!.kind));
  return { meta, data, combos, payouts: payoutsForPlayers(3) };
}

function antePaid(ante: { scheme: string; amount: number }, pos: Position): number {
  if (ante.scheme === 'none') return 0;
  if (ante.scheme === 'all') return ante.amount;
  return pos === 'BB' ? ante.amount : 0;
}

/** state から order 順の総スタック(bb)を得る（total = stack + bet + ante拠出）。 */
function totalsOf(table: Pf3wayTable, state: BoardState): number[] {
  const { order, ante } = table.meta;
  return order.map((pos) => {
    const seat = state.seats.find((s) => s.pos === pos && s.state !== 'empty');
    if (!seat) throw new Error(`pf3way: missing live seat ${pos}`);
    return seat.stack + seat.bet + antePaid(ante, pos);
  });
}

/** この state を事前計算テーブルで解けるか（3人・条件一致・範囲内）。 */
export function pf3wayInRange(table: Pf3wayTable, state: BoardState): boolean {
  if (state.playersLeft !== 3) return false;
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

/**
 * 事前計算テーブルをトリリニア補間して solveMultiway 同型の結果を返す。
 * 呼び出し前に pf3wayInRange() を確認すること（範囲外は上限クランプになる）。
 */
export function lookupPf3way(table: Pf3wayTable, state: BoardState): MultiwayNSolveResult {
  const { meta, data, combos, payouts } = table;
  const { axis, order, nodeKeys, nodeActors, nodeTypes, classOrder, stride, floatsPerNode } = meta;
  const G = axis.length;
  const NC = classOrder.length;
  const nNodes = nodeKeys.length;
  const totals = totalsOf(table, state);

  const [ix0, ix1, fx] = seg(axis, totals[0]!);
  const [iy0, iy1, fy] = seg(axis, totals[1]!);
  const [iz0, iz1, fz] = seg(axis, totals[2]!);
  const corners: [number, number][] = [];
  for (const [ci, wi] of [[ix0, 1 - fx], [ix1, fx]] as [number, number][])
    for (const [cj, wj] of [[iy0, 1 - fy], [iy1, fy]] as [number, number][])
      for (const [ck, wk] of [[iz0, 1 - fz], [iz1, fz]] as [number, number][])
        corners.push([(ci * G + cj) * G + ck, wi * wj * wk]);

  // eqPre はスタックから厳密に再計算（丸め回避）。eqPost は補間。
  const eqPre = icmEquities(totals, payouts);
  const eqPost = new Array<number>(3).fill(0);
  const eqPostOff = nNodes * floatsPerNode;
  for (const [pIdx, w] of corners) {
    if (w === 0) continue;
    const b = pIdx * stride;
    for (let s = 0; s < 3; s++) eqPost[s]! += w * data[b + eqPostOff + s]!;
  }
  const equity: Record<string, { pre: number; post: number }> = {};
  for (let s = 0; s < 3; s++) equity[order[s]!] = { pre: eqPre[s]!, post: eqPost[s]! };

  const quality = { exploitability: PF3WAY_INTERP_EXPL_BOUND, converged: true, iterations: 0 };
  const strategies = new Map<string, Float64Array>();
  const nodes: SolutionNode[] = [];
  for (let n = 0; n < nNodes; n++) {
    const evDiff = new Float64Array(NC);
    for (const [pIdx, w] of corners) {
      if (w === 0) continue;
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
    exploitabilityPt: PF3WAY_INTERP_EXPL_BOUND,
    converged: true,
    equity,
    strategies,
  };
}
