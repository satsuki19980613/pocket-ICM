/**
 * Solver インターフェース。照合ハーネスはこの契約に対して動く。
 * 実ソルバー（packages/solver）は後続マイルストーンでこれを実装する。
 */

import type { BoardState, SolutionNode } from '@oshihiki/core';

export type Solver = (input: BoardState) => SolutionNode[] | Promise<SolutionNode[]>;

/**
 * 空実装ソルバー。M1-1 の完了条件（空実装に対して全件不一致を正しく報告する）
 * を検証するためのもの。常にノードを返さない。
 */
export const stubSolver: Solver = () => [];
