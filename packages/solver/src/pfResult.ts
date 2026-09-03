/**
 * 事前計算モデル（テーブル補間 / NN 蒸留）の共通「結果組み立て」（env 非依存コア）。
 *
 * push/fold の即時求解器は、状態から「各決定ノードのクラス別 EV差（アグレッシブ−フォールド, 169）」と
 * 「席ごとの eqPost」を得るところまでを各手法（多重線形補間＝pfTable / NN 推論＝nnModel）で行い、
 * そこから先——ゼロ交差による純戦略化・レンジ記法・EQPre 再計算・quality——は完全に共通である。
 * その共通部をここに集約し、テーブルと NN で**単一の真実**を持たせる（solveMultiway の buildResult とも整合）。
 *
 * push/fold のナッシュ純戦略は「EV差 ≥ 0 ⇔ プッシュ」のゼロ交差で与えられる（無差別ハンドは
 * 境界付近で入れ替わるが EV は不変＝3〜4人テーブルで実証済み）。
 */
import type { BoardState, Position, SolutionNode } from '@oshihiki/core';
import { formatRange } from '@oshihiki/core';
import { icmEquities } from './icm.js';
import type { MultiwayNSolveResult } from './nwaySolver.js';

const TOTAL_COMBOS = 1326;

/** ante.scheme に応じた各席のアンティ拠出。 */
function antePaid(ante: { scheme: string; amount: number }, pos: Position): number {
  if (ante.scheme === 'none') return 0;
  if (ante.scheme === 'all') return ante.amount;
  return pos === 'BB' ? ante.amount : 0;
}

/**
 * state から order 順の総スタック(bb)を得る（total = stack + bet + ante拠出）。
 * pfTable（補間）と nnTable（NN 推論）が共有する入力スタックの単一の真実。
 */
export function stackTotals(order: Position[], ante: { scheme: string; amount: number }, state: BoardState): number[] {
  return order.map((pos) => {
    const seat = state.seats.find((s) => s.pos === pos && s.state !== 'empty');
    if (!seat) throw new Error(`stackTotals: missing live seat ${pos}`);
    return seat.stack + seat.bet + antePaid(ante, pos);
  });
}

/** 結果組み立ての入力（手法非依存）。evDiffByNode / eqPost を各手法が用意する。 */
export interface PfResultInput {
  order: Position[];
  nodeKeys: string[];
  nodeActors: string[];
  nodeTypes: string[];
  classOrder: string[];
  /** classOrder に対応するコンボ数（169 要素）。 */
  combos: number[];
  /** 人数 D のペイアウト（icm 用）。 */
  payouts: number[];
  /** order 順の総スタック(bb)。EQPre をここから厳密再計算する。 */
  totals: number[];
  /** ノードごとのクラス別 EV差（長さ nodeKeys.length, 各 classOrder.length）。 */
  evDiffByNode: Float64Array[];
  /** order 順の eqPost。 */
  eqPost: number[];
  /** 表示する exploitability 上限（検証済みの補間/近似バウンド）。 */
  explBound: number;
}

/**
 * EV差（ノード×クラス）＋ eqPost から solveMultiway 同型の結果を組み立てる。
 * ゼロ交差で純戦略化し、レンジ記法・pct・EQ を埋める。EQPre は totals から厳密に再計算。
 */
export function assemblePfResult(input: PfResultInput): MultiwayNSolveResult {
  const {
    order, nodeKeys, nodeActors, nodeTypes, classOrder, combos, payouts,
    totals, evDiffByNode, eqPost, explBound,
  } = input;
  const D = order.length;
  const NC = classOrder.length;
  const nNodes = nodeKeys.length;

  const eqPre = icmEquities(totals, payouts);
  const equity: Record<string, { pre: number; post: number }> = {};
  for (let s = 0; s < D; s++) equity[order[s]!] = { pre: eqPre[s]!, post: eqPost[s]! };

  const quality = { exploitability: explBound, converged: true, iterations: 0 };
  const strategies = new Map<string, Float64Array>();
  const nodes: SolutionNode[] = [];
  for (let n = 0; n < nNodes; n++) {
    const evDiff = evDiffByNode[n]!;
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
