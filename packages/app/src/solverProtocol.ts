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

export interface SolveNodeDto {
  key: string;
  actor: string;
  actionType: string;
  /** コンボ加重の push/call/oc 頻度 %（純化前の集合の広さ）。 */
  pct: number;
  /** 純化後（freq≥50%）のレンジ表記。 */
  range: string;
  /** 純化後にレンジ入りするハンドクラス集合。 */
  hands: string[];
  /** hero ハンドのこのノードでの頻度（0..1）。 */
  heroFreq: number;
  /** hero ハンドの EV（アグレッシブ − フォールド, 実払い pt）。 */
  heroEv: number;
}

/** 結果画面に渡す DTO（構造化クローンで転送可能なプレーンオブジェクト）。 */
export interface SolveResultDto {
  playersLeft: number;
  heroPos: string;
  heroHand: string;
  iterations: number;
  exploitabilityPt: number;
  converged: boolean;
  /** 席（ポジション）→ EQPre/EQPost（実払い pt）。 */
  equity: Record<string, { pre: number; post: number }>;
  nodes: SolveNodeDto[];
}

export type SolveResponse =
  | { id: number; ok: true; result: SolveResultDto; ms: number }
  | { id: number; ok: false; error: string };
