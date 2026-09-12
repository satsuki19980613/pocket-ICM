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
import type { BoardState, Position } from '@oshihiki/core';
import { comboCount, parseHandClass } from '@oshihiki/core';
import { payoutsForPlayers } from './icm.js';
import { decodeFloat16 } from './halfFloat.js';
import type { MultiwayNSolveResult } from './nwaySolver.js';
import { assemblePfResult, stackTotals } from './pfResult.js';

/** interpExplBound 未指定テーブルの既定 exploitability 上限（3人の実証値）。 */
export const PF_DEFAULT_INTERP_EXPL_BOUND = 0.06;

/**
 * アンティ量(bb)の一致許容。実ゲームは全レベルで概ね 0.25bb だが、チップ額の丸めで
 * レベルにより 0.25〜約0.255 とわずかに揺れる（例: 550/1100, ante280 → 280/1100=0.2545）。
 * 押し引きレンジへの影響は無視できるため、テーブルのアンティに近ければ同一条件として扱う。
 */
export const PF_ANTE_TOL = 0.03;

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

/** state から order 順の総スタック(bb)を得る（stackTotals＝nnTable と共有）。 */
function totalsOf(table: PfTable, state: BoardState): number[] {
  return stackTotals(table.meta.order, table.meta.ante, state);
}

/** この state を事前計算テーブルで解けるか（D人・条件一致・範囲内）。 */
/**
 * この state をテーブルでどう扱えるか。
 *  - 'in'       : 補間で即時に解ける（**全席が上限25bb以下**・条件一致）。
 *  - 'heroDeep' : **hero 自身が上限超**＝push/fold（AOF）が最適でない深さ → 対象外表示すべき。
 *  - 'off'      : 人数/ブラインド/アンティ方式が不一致、または**相手に25bb超の深い席**がある
 *                → 汎用ソルバー（厳密 MC）へ。
 *
 * 方針（さつき決定 2026-09-04・再決定）: 深い相手を25bbにクランプする近似はズレが大きい
 * （実測 SB 68%↔11%）ため**採用しない**。相手が深い局面は厳密 MC で解く（HRC一致・遅い）。
 * テーブル即時は「全席25bb以下」の時だけ。hero 自身が25bb超は AOF 前提が崩れるので対象外。
 * アンティは 0.25 近傍を許容（実ゲームのチップ丸め対策, PF_ANTE_TOL）。
 */
export type PfCoverage = 'in' | 'heroDeep' | 'off';

export function pfCoverage(table: PfTable, state: BoardState): PfCoverage {
  const { blinds, ante, axis, order } = table.meta;
  if (state.playersLeft !== table.dims) return 'off';
  if (state.blinds.sb !== blinds.sb || state.blinds.bb !== blinds.bb) return 'off';
  if (state.ante.scheme !== ante.scheme || Math.abs(state.ante.amount - ante.amount) > PF_ANTE_TOL) {
    return 'off';
  }
  const hi = axis[axis.length - 1]!;
  const totals = totalsOf(table, state); // order 順
  const heroIdx = order.indexOf(state.heroPos);
  // **hero が深い判定はモード非依存**（「概ね 25bb 超では AOF が最適でない」はペイアウト構造と
  // 無関係な一般則で、表の有無の話ではない）。モード判定を先に置いていたため、同じ盤面でも
  // クラブなら「対象外」と出るのにランクへ切り替えると黙って数値を返す、という非対称が出ていた
  // （2026-09-12 の実機フィクスチャ検証で発見）。判定順を入れ替えて解消する。
  if (heroIdx >= 0 && totals[heroIdx]! > hi + 1e-6) return 'heroDeep';
  // 事前計算表は**クラブマッチのペイアウトを焼き込んで**生成している（buildPfTable の payouts）。
  // 他モードは EV 差そのものが別物になるため表を使わず、厳密 MC へ回す。
  if ((state.gameMode ?? 'club') !== 'club') return 'off';
  // 相手に上限超の深い席があればテーブル不可＝厳密 MC へ（クランプしない）。
  if (totals.some((t) => t > hi + 1e-6)) return 'off';
  return 'in';
}

/** 補間で即時に解ける（全席が上限以下・条件一致）。下限未満はクランプ許容。 */
export function pfInRange(table: PfTable, state: BoardState): boolean {
  return pfCoverage(table, state) === 'in';
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

  // 各ノードのクラス別 EV差と席ごとの eqPost を多重線形補間で得る（eqPre は totals から厳密再計算）。
  const eqPost = new Array<number>(D).fill(0);
  const eqPostOff = nNodes * floatsPerNode;
  for (const [pIdx, w] of corners) {
    const b = pIdx * stride;
    for (let s = 0; s < D; s++) eqPost[s]! += w * data[b + eqPostOff + s]!;
  }
  const evDiffByNode: Float64Array[] = [];
  for (let n = 0; n < nNodes; n++) {
    const evDiff = new Float64Array(NC);
    for (const [pIdx, w] of corners) {
      const off = pIdx * stride + n * floatsPerNode;
      for (let c = 0; c < NC; c++) evDiff[c]! += w * data[off + c]!;
    }
    evDiffByNode.push(evDiff);
  }

  // ゼロ交差→純戦略・レンジ化・EQ 埋めは pfResult に集約（NN 蒸留と単一の真実）。
  return assemblePfResult({
    order, nodeKeys, nodeActors, nodeTypes, classOrder,
    combos, payouts, totals, evDiffByNode, eqPost, explBound,
  });
}
