/**
 * N人 push/fold NN 蒸留モデルのランタイム参照（env 非依存コア）。
 *
 * 学習（scripts/trainNwayNN.ts）した MLP 重みを読み、状態のスタック(bb)を入力に前進計算して
 * 「各決定ノードのクラス別 EV差(169)＋席ごと eqPost」を得る。そこから先（ゼロ交差→純戦略・
 * レンジ化・EQPre 再計算）は pfResult に集約された共通部を使う＝テーブル補間と単一の真実。
 *
 * 5〜6人はテーブル格子が容量不可（170MB+）なので NN で代替する。クライアント CPU は
 * 小型 MLP の前進計算数 ms（テーブル同様に遅延 fetch → キャッシュ後は即時）。
 *
 * 適用条件は pfInRange と同型: playersLeft===D, blinds/ante 一致, 各スタックが学習レンジ内。
 * 範囲外（実効>maxbb 等）は nnInRange()=false → 呼び出し側で solveMultiway にフォールバック。
 */
import type { BoardState, Position } from '@oshihiki/core';
import { comboCount, parseHandClass } from '@oshihiki/core';
import { payoutsForPlayers } from './icm.js';
import { decodeFloat16 } from './halfFloat.js';
import type { MultiwayNSolveResult } from './nwaySolver.js';
import { assemblePfResult, stackTotals } from './pfResult.js';
import type { Activation, DenseLayer, MlpModel } from './nn/mlp.js';
import { mlpForward } from './nn/mlp.js';

/** interpExplBound 未指定モデルの既定 exploitability 上限。 */
export const NN_DEFAULT_EXPL_BOUND = 0.06;

export interface NnLayerShape {
  inDim: number;
  outDim: number;
  activation: Activation;
}

export interface NnMeta {
  kind: string;
  players: number;
  order: Position[];
  axis: number[];
  blinds: { sb: number; bb: number };
  ante: { scheme: string; amount: number };
  nodeKeys: string[];
  nodeActors: string[];
  nodeTypes: string[];
  classOrder: string[];
  inDim: number;
  outDim: number;
  floatsPerNode: number;
  layerShapes: NnLayerShape[];
  /** norm セクションの f32 要素数（inDim*2 + outDim*2）。 */
  normFloats: number;
  /** 重みセクションの要素数（全層 weight+bias の合計）。 */
  weightCount: number;
  weightDtype: 'f16';
  /** 検証済み exploitability 上限（validateNwayNN の実測後に設定, 未指定は既定）。 */
  interpExplBound?: number;
}

export interface NnTable {
  meta: NnMeta;
  model: MlpModel;
  combos: number[];
  payouts: number[];
  dims: number; // = meta.order.length
  explBound: number;
}

/**
 * モデルの単一 bin（[norm f32][weights f16]）を MlpModel へ復号する。
 * norm セクション: inputNorm.mean(inDim), inputNorm.std(inDim), outputNorm.mean(outDim), outputNorm.std(outDim)。
 * weights セクション: layerShapes 順に weight(outDim*inDim), bias(outDim)。
 */
export function decodeNnModel(meta: NnMeta, buf: ArrayBuffer): MlpModel {
  const { inDim, outDim, normFloats, weightCount, layerShapes } = meta;
  if (normFloats !== inDim * 2 + outDim * 2) {
    throw new Error(`nnTable: normFloats ${normFloats} != ${inDim * 2 + outDim * 2}`);
  }
  const norm = new Float32Array(buf, 0, normFloats);
  let p = 0;
  const inMean = norm.subarray(p, (p += inDim));
  const inStd = norm.subarray(p, (p += inDim));
  const outMean = norm.subarray(p, (p += outDim));
  const outStd = norm.subarray(p, (p += outDim));

  const wBytesOffset = normFloats * 4;
  const wf16 = new Uint16Array(buf, wBytesOffset, weightCount);
  const w = decodeFloat16(wf16);

  const layers: DenseLayer[] = [];
  let q = 0;
  for (const s of layerShapes) {
    const wLen = s.outDim * s.inDim;
    const weight = w.slice(q, q + wLen); q += wLen;
    const bias = w.slice(q, q + s.outDim); q += s.outDim;
    layers.push({ inDim: s.inDim, outDim: s.outDim, weight, bias, activation: s.activation });
  }
  if (q !== weightCount) throw new Error(`nnTable: weight cursor ${q} != weightCount ${weightCount}`);

  return {
    layers,
    // subarray は buf を参照。Float32Array へコピーして所有権を持たせる（buf GC 後も安全）。
    inputNorm: { mean: Float32Array.from(inMean), std: Float32Array.from(inStd) },
    outputNorm: { mean: Float32Array.from(outMean), std: Float32Array.from(outStd) },
  };
}

export function buildNnTable(meta: NnMeta, buf: ArrayBuffer): NnTable {
  const model = decodeNnModel(meta, buf);
  const combos = meta.classOrder.map((l) => comboCount(parseHandClass(l)!.kind));
  const dims = meta.order.length;
  return {
    meta,
    model,
    combos,
    payouts: payoutsForPlayers(dims),
    dims,
    explBound: meta.interpExplBound ?? NN_DEFAULT_EXPL_BOUND,
  };
}

/** この state を NN モデルで解けるか（D人・条件一致・学習レンジ内）。 */
export function nnInRange(table: NnTable, state: BoardState): boolean {
  if (state.playersLeft !== table.dims) return false;
  const { blinds, ante, axis } = table.meta;
  if (state.blinds.sb !== blinds.sb || state.blinds.bb !== blinds.bb) return false;
  if (state.ante.scheme !== ante.scheme || state.ante.amount !== ante.amount) return false;
  const hi = axis[axis.length - 1]!;
  const totals = stackTotals(table.meta.order, ante, state);
  // 下限はクランプ可（超短スタックは自明）。上限超えは AOF が妥当でない領域＝フォールバック。
  return totals.every((t) => t <= hi + 1e-6);
}

/**
 * NN モデルを前進計算し、solveMultiway 同型の結果を返す。
 * 呼び出し前に nnInRange() を確認すること（範囲外は学習外挿になる）。
 */
export function lookupNn(table: NnTable, state: BoardState): MultiwayNSolveResult {
  const { meta, model, combos, payouts, dims: D, explBound } = table;
  const { order, nodeKeys, nodeActors, nodeTypes, classOrder, floatsPerNode } = meta;
  const NC = classOrder.length;
  const nNodes = nodeKeys.length;

  const totals = stackTotals(order, meta.ante, state);
  // 学習は格子範囲で行うため、範囲下限へクランプしてから前進（外挿を避ける）。
  const hi = meta.axis[meta.axis.length - 1]!;
  const lo = meta.axis[0]!;
  const input = Float32Array.from(totals, (t) => Math.min(hi, Math.max(lo, t)));

  const out = mlpForward(model, input); // 長さ outDim = nNodes*floatsPerNode + D

  const evDiffByNode: Float64Array[] = [];
  for (let n = 0; n < nNodes; n++) {
    const evDiff = new Float64Array(NC);
    const off = n * floatsPerNode;
    for (let c = 0; c < NC; c++) evDiff[c] = out[off + c]!;
    evDiffByNode.push(evDiff);
  }
  const eqPostOff = nNodes * floatsPerNode;
  const eqPost = new Array<number>(D);
  for (let s = 0; s < D; s++) eqPost[s] = out[eqPostOff + s]!;

  return assemblePfResult({
    order, nodeKeys, nodeActors, nodeTypes, classOrder,
    combos, payouts, totals, evDiffByNode, eqPost, explBound,
  });
}
