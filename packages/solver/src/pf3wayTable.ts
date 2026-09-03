/**
 * 3人 push or fold / AOF 事前計算テーブルのランタイム（後方互換エイリアス）。
 *
 * 実体は次元非依存の pfTable.ts（多重線形補間）に統合済み＝単一の真実。
 * このモジュールは 3人時代の名前（Pf3way*）を維持するための薄いラッパで、
 * 既存の import（solver.worker / index / テスト）を壊さずに generic を使う。
 */
import type { BoardState } from '@oshihiki/core';
import {
  buildPfTable,
  lookupPf,
  pfInRange,
  PF_DEFAULT_INTERP_EXPL_BOUND,
  type PfMeta,
  type PfTable,
} from './pfTable.js';
import type { MultiwayNSolveResult } from './nwaySolver.js';

/** 補間法の実証済み exploitability 上限（3人: 補間 ≈0.04pt, 直接解 ≈0.014pt）。 */
export const PF3WAY_INTERP_EXPL_BOUND = PF_DEFAULT_INTERP_EXPL_BOUND;

export type Pf3wayMeta = PfMeta;
export type Pf3wayTable = PfTable;

export function buildPf3wayTable(meta: Pf3wayMeta, data: Float32Array): Pf3wayTable {
  return buildPfTable(meta, data);
}

export function pf3wayInRange(table: Pf3wayTable, state: BoardState): boolean {
  return pfInRange(table, state);
}

export function lookupPf3way(table: Pf3wayTable, state: BoardState): MultiwayNSolveResult {
  return lookupPf(table, state);
}
