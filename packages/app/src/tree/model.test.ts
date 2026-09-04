import { describe, it, expect } from 'vitest';
import { solveMultiway } from '@oshihiki/solver';
import type { BoardState } from '@oshihiki/core';
import { buildBoardState, defaultForm } from '../formModel';
import type { SolveNodeDto, SolveResultDto } from '../solverProtocol';
import { headlineNode } from '../records/model';
import {
  activeNode,
  aggressiveFor,
  applyChoice,
  defaultState,
  isWalk,
  keyForActive,
  orderOf,
  treeRows,
  type TreeState,
} from './model';

/** 実ソルバー出力を DTO 化（worker の toDto と同型）。 */
async function solveDto(n: number, heroPos: string): Promise<{ state: BoardState; dto: SolveResultDto }> {
  const form = { ...defaultForm(n), heroPos: heroPos as never };
  const built = buildBoardState(form);
  if (!built.ok || !built.state) throw new Error(`build failed: ${built.issues.join(', ')}`);
  const state = built.state;
  // 決定的に（workers:0 の単一スレッド経路, 反復控えめ）。
  const r = (await solveMultiway(state, { workers: 0, maxIters: 200, samples: 4000 })) as unknown as {
    nodes: { key: string; actor: string; actionType: string; pct: number; range: string; hands: string[]; freq: Record<string, number>; ev: Record<string, number> }[];
    iterations: number;
    exploitabilityPt: number;
    converged: boolean;
    equity: Record<string, { pre: number; post: number }>;
  };
  const nodes: SolveNodeDto[] = r.nodes.map((nd) => ({
    key: nd.key,
    actor: nd.actor,
    actionType: nd.actionType,
    pct: nd.pct,
    range: nd.range,
    hands: nd.hands,
    heroFreq: nd.freq[state.heroHand] ?? 0,
    heroEv: nd.ev[state.heroHand] ?? 0,
  }));
  return {
    state,
    dto: {
      playersLeft: n,
      heroPos: state.heroPos,
      heroHand: state.heroHand,
      iterations: r.iterations,
      exploitabilityPt: r.exploitabilityPt,
      converged: r.converged,
      equity: r.equity,
      nodes,
    },
  };
}

/** 全ての到達可能状態を BFS で列挙（各行の各選択肢を再帰的に押す）。 */
function reachableActiveKeys(dto: SolveResultDto): Set<string> {
  const order = orderOf(dto);
  const seen = new Set<string>();
  const visited = new Set<string>();
  const walk = (st: TreeState): void => {
    const sig = st.actions.join('') + '@' + st.active;
    if (visited.has(sig)) return;
    visited.add(sig);
    if (!isWalk(order, st.actions, st.active)) seen.add(keyForActive(order, st.actions, st.active));
    // 各行のトグルを試す。
    const rows = treeRows(dto, st);
    for (const row of rows) {
      if (row.walk) continue;
      for (const opt of row.options) {
        walk(applyChoice(st, row.seatIdx, opt.code));
      }
    }
  };
  walk(defaultState(dto));
  return seen;
}

describe('Action tree モデル（実ソルバー出力と整合）', () => {
  it('3-way: 既定状態の active ノード = 見出しノード', async () => {
    const { dto } = await solveDto(3, 'BU');
    const node = activeNode(dto, defaultState(dto));
    expect(node).not.toBeNull();
    expect(node!.key).toBe(headlineNode(dto)!.key);
  }, 30_000);

  it('3-way: ツリーで到達できる active キーは全て実ノードに存在する', async () => {
    const { dto } = await solveDto(3, 'BU');
    const idx = new Set(dto.nodes.map((n) => n.key));
    for (const key of reachableActiveKeys(dto)) {
      expect(idx.has(key), `未知キー: ${key}`).toBe(true);
    }
  }, 30_000);

  it('3-way: 決定ノード（ウォーク以外）は全てツリーから到達できる', async () => {
    const { dto } = await solveDto(3, 'BU');
    const reachable = reachableActiveKeys(dto);
    for (const n of dto.nodes) {
      expect(reachable.has(n.key), `到達不能ノード: ${n.key} (${n.actor}/${n.actionType})`).toBe(true);
    }
  }, 30_000);

  it('4-way: 全決定ノードが双方向に整合（到達 ⇔ 実在）', async () => {
    const { dto } = await solveDto(4, 'CO');
    const idx = new Set(dto.nodes.map((n) => n.key));
    const reachable = reachableActiveKeys(dto);
    expect([...reachable].sort()).toEqual([...idx].sort());
  }, 60_000);

  it('aggressiveFor: 上流の文脈で PU→CA→OC を切り替える', () => {
    expect(aggressiveFor(['-', '-', '-'], 0)).toEqual({ code: 'P', label: 'PU' });
    expect(aggressiveFor(['P', '-', '-'], 1)).toEqual({ code: 'C', label: 'CA' });
    expect(aggressiveFor(['P', 'C', '-'], 2)).toEqual({ code: 'C', label: 'OC' });
    expect(aggressiveFor(['F', 'P', '-'], 2)).toEqual({ code: 'C', label: 'CA' });
  });
});
