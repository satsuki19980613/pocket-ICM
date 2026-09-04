/**
 * Action tree の純ロジック層（M4）。
 *
 * ソルバー出力（`SolveResultDto.nodes` の平坦なノード集合）を、モック準拠の
 * 「全ポジション常時表示・行内トグル（FOLD / PU・CA・OC）」ツリーとして
 * 駆動するための純関数群。IndexedDB や DOM は持ち込まない（Node で単体テスト）。
 *
 * キーはソルバーと同一文法（`@oshihiki/core` の `normalizeKey`＝全席を行動順に
 * 並べ未行動を `-` で埋める。最初のオールイン=`P`、以降のオールイン=`C`、フォールド=`F`）。
 * 各行の active ノードはこのキーで `result.nodes` から引く＝表示とソルバー出力が常に整合する。
 */

import { normalizeKey, positionsForPlayersLeft, type ActionChar } from '@oshihiki/core';
import type { SolveNodeDto, SolveResultDto } from '../solverProtocol';

/** アグレッシブ側の表示ラベル（内部コードは PU→'P' / CA・OC→'C'）。 */
export type AggrLabel = 'PU' | 'CA' | 'OC';

export interface RowOption {
  /** 状態に書き込むアクション文字。 */
  code: ActionChar; // 'F' | 'P' | 'C'
  label: 'FOLD' | AggrLabel;
  /** アグレッシブ（オールイン系）か。true=黄ロックオン表示。 */
  aggressive: boolean;
}

export interface TreeRow {
  pos: string;
  seatIdx: number;
  /** 決定なし（BB のウォーク＝上流に誰も push していない最終席）。 */
  walk: boolean;
  /** この席で選べる選択肢（walk 行は空）。 */
  options: RowOption[];
  /** 現在この席に割り当てられているアクション。 */
  current: ActionChar;
}

/** ツリーの操作状態＝各席のアクション（行動順, 長さ=残り人数）＋選択中の行。 */
export interface TreeState {
  actions: ActionChar[];
  active: number;
}

/** 席順（行動順）。UTG…BB。 */
export function orderOf(result: SolveResultDto): string[] {
  return positionsForPlayersLeft(result.playersLeft);
}

/** key→ノードの索引。 */
export function nodeIndex(result: SolveResultDto): Map<string, SolveNodeDto> {
  return new Map(result.nodes.map((n) => [n.key, n]));
}

function priorHasPush(actions: ActionChar[], i: number): boolean {
  for (let k = 0; k < i; k++) if (actions[k] === 'P') return true;
  return false;
}
function priorCallCount(actions: ActionChar[], i: number): number {
  let c = 0;
  for (let k = 0; k < i; k++) if (actions[k] === 'C') c++;
  return c;
}

/** 席 i の（上流文脈から決まる）アグレッシブ選択肢。 */
export function aggressiveFor(actions: ActionChar[], i: number): { code: 'P' | 'C'; label: AggrLabel } {
  if (!priorHasPush(actions, i)) return { code: 'P', label: 'PU' };
  if (priorCallCount(actions, i) === 0) return { code: 'C', label: 'CA' };
  return { code: 'C', label: 'OC' };
}

/** 席 i がウォーク（決定でない）か＝最終席かつ上流に push 無し。 */
export function isWalk(order: string[], actions: ActionChar[], i: number): boolean {
  return i === order.length - 1 && !priorHasPush(actions, i);
}

/** 席 active の決定ノードのキー（上流の P/C/F を埋め、actor と下流は '-'）。 */
export function keyForActive(order: string[], actions: ActionChar[], active: number): string {
  const map: Partial<Record<string, ActionChar>> = {};
  for (let k = 0; k < active; k++) map[order[k]!] = actions[k]!;
  return normalizeKey(order.length, map);
}

/** active 行の対応ノード（ウォーク／未知キーなら null）。 */
export function activeNode(result: SolveResultDto, state: TreeState): SolveNodeDto | null {
  const order = orderOf(result);
  if (isWalk(order, state.actions, state.active)) return null;
  const key = keyForActive(order, state.actions, state.active);
  return nodeIndex(result).get(key) ?? null;
}

/**
 * 初期状態。hero の決定ノード（未開プッシュ＝上流全フォールド）を active にし、
 * hero の推奨（heroFreq≥0.5 で push）を反映。以降の席は未到達＝フォールド。
 */
export function defaultState(result: SolveResultDto): TreeState {
  const order = orderOf(result);
  const n = order.length;
  const heroIdx = Math.max(0, order.indexOf(result.heroPos));
  const actions: ActionChar[] = new Array<ActionChar>(n).fill('F');
  // hero の見出しノード（未開プッシュ）で推奨が push なら hero 席を 'P'。
  const idx = nodeIndex(result);
  const headKey = keyForActive(order, actions, heroIdx);
  const head = idx.get(headKey);
  actions[heroIdx] = head && head.heroFreq >= 0.5 ? 'P' : 'F';
  return { actions, active: heroIdx };
}

/** 席 i にアクション code を割り当て（下流は F にリセット、active=i）。 */
export function applyChoice(state: TreeState, i: number, code: ActionChar): TreeState {
  const actions = state.actions.slice();
  actions[i] = code;
  for (let k = i + 1; k < actions.length; k++) actions[k] = 'F';
  return { actions, active: i };
}

/** 表示用の行配列（全席）。 */
export function treeRows(result: SolveResultDto, state: TreeState): TreeRow[] {
  const order = orderOf(result);
  return order.map((pos, i) => {
    const walk = isWalk(order, state.actions, i);
    if (walk) return { pos, seatIdx: i, walk: true, options: [], current: state.actions[i]! };
    const aggr = aggressiveFor(state.actions, i);
    const options: RowOption[] = [
      { code: 'F', label: 'FOLD', aggressive: false },
      { code: aggr.code, label: aggr.label, aggressive: true },
    ];
    return { pos, seatIdx: i, walk: false, options, current: state.actions[i]! };
  });
}
