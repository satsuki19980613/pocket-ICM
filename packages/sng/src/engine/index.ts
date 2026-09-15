/**
 * エンジン実装の入口。`docs/SNG_DESIGN.md` §1 のルールの組み立て（担当 A1）。
 */

import type { Engine } from '../engine';
import type { LegalActions, PublicHand, PublicTable, SngConfig, TableState, You } from '../types';

import { computeLegalActions } from './betting';
import { computeLevel } from './level';
import { apply as applyImpl, createTable as createTableImpl } from './table';
import { publicTable as publicTableImpl, you as youImpl } from './view';

export const engine: Engine = {
  createTable: createTableImpl,
  apply: applyImpl,
  legalActions(hand: PublicHand, seat: number, stack: number): LegalActions {
    return computeLegalActions(hand, seat, stack);
  },
  publicTable(state: TableState): PublicTable {
    return publicTableImpl(state);
  },
  you(state: TableState, userId: string): You {
    return youImpl(state, userId);
  },
  levelAt(config: SngConfig, startedAt: number, now: number): number {
    return computeLevel(config, startedAt, now);
  },
};
