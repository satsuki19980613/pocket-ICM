/**
 * App ↔ Web Worker の求解メッセージ契約（Phase 3-1a）。
 * ソルバー求解は UI スレッドを固めないよう Web Worker 側で実行する。
 */

import type { BoardState } from '@oshihiki/core';

export interface SolveOpts {
  maxIters?: number;
  samples?: number;
  cardRemoval?: boolean;
}

export interface SolveRequest {
  id: number;
  state: BoardState;
  opts?: SolveOpts;
}

/** 結果画面に渡す最小 DTO（構造化クローンで転送可能なプレーンオブジェクト）。 */
export interface SolveResultDto {
  playersLeft: number;
  iterations: number;
  exploitabilityPt: number;
  converged: boolean;
  /** 席（ポジション）→ EQPre/EQPost（実払い pt）。 */
  equity: Record<string, { pre: number; post: number }>;
  nodes: {
    key: string;
    actor: string;
    actionType: string;
    pct: number;
    range: string;
  }[];
}

export type SolveResponse =
  | { id: number; ok: true; result: SolveResultDto; ms: number }
  | { id: number; ok: false; error: string };
