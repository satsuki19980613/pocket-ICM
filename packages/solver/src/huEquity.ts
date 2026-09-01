/**
 * HU（ヘッズアップ）all-in equity — 厳密全列挙（IMPLEMENTATION_PLAN 1-3）。
 *
 * 2 枚 vs 2 枚のオールインについて、残りボードを全列挙して
 * 勝ち/分け/負けを数え、equity = (win + tie/2) / total を返す。
 *
 * 169×169 テーブルはクラス代表コンボで厳密平均して生成する（genHuEquityTable）。
 */

import { allHandClassLabels, parseHandClass } from '@oshihiki/core';
import { eval7, makeCard } from './evaluator.js';

const RANK_TO_VALUE: Record<string, number> = {
  A: 14,
  K: 13,
  Q: 12,
  J: 11,
  T: 10,
  '9': 9,
  '8': 8,
  '7': 7,
  '6': 6,
  '5': 5,
  '4': 4,
  '3': 3,
  '2': 2,
};

/** 169 ハンドクラスの決定的順序（core と共有）。 */
export const HAND_CLASS_ORDER: string[] = allHandClassLabels();
export const HAND_CLASS_INDEX: Record<string, number> = Object.fromEntries(
  HAND_CLASS_ORDER.map((h, i) => [h, i]),
);

/**
 * ハンドクラス表記 → 具体 2 枚コンボ（カード id ペア）の全列挙。
 * ペア=6, スーテッド=4, オフスート=12。
 */
export function handClassToCombos(label: string): [number, number][] {
  const hc = parseHandClass(label);
  if (!hc) throw new Error(`invalid hand class: ${label}`);
  const hi = RANK_TO_VALUE[hc.hi]!;
  const lo = RANK_TO_VALUE[hc.lo]!;
  const combos: [number, number][] = [];

  if (hc.kind === 'pair') {
    for (let s1 = 0; s1 < 4; s1++) {
      for (let s2 = s1 + 1; s2 < 4; s2++) {
        combos.push([makeCard(hi, s1), makeCard(hi, s2)]);
      }
    }
  } else if (hc.kind === 's') {
    for (let s = 0; s < 4; s++) {
      combos.push([makeCard(hi, s), makeCard(lo, s)]);
    }
  } else {
    // offsuit
    for (let s1 = 0; s1 < 4; s1++) {
      for (let s2 = 0; s2 < 4; s2++) {
        if (s1 === s2) continue;
        combos.push([makeCard(hi, s1), makeCard(lo, s2)]);
      }
    }
  }
  return combos;
}

export interface EquityResult {
  win: number;
  tie: number;
  lose: number;
  total: number;
  /** (win + tie/2) / total */
  equity: number;
}

/**
 * 特定の 2 枚 vs 2 枚（＋任意の既知ボード）の厳密 equity。
 * 残りボードを全列挙する。プリフロップなら board=[] で C(48,5)=1,712,304 通り。
 */
export function exactEquityVsHands(
  hero: readonly [number, number],
  villain: readonly [number, number],
  board: readonly number[] = [],
): EquityResult {
  const known = new Set<number>([...hero, ...villain, ...board]);
  if (known.size !== 4 + board.length) {
    throw new Error('duplicate cards among hero/villain/board');
  }
  const deck: number[] = [];
  for (let c = 0; c < 52; c++) if (!known.has(c)) deck.push(c);

  const need = 5 - board.length;
  if (need < 0) throw new Error('board longer than 5');

  const fullBoard = new Array<number>(5);
  for (let i = 0; i < board.length; i++) fullBoard[i] = board[i]!;

  const heroBuf = [hero[0], hero[1], 0, 0, 0, 0, 0];
  const villBuf = [villain[0], villain[1], 0, 0, 0, 0, 0];

  let win = 0;
  let tie = 0;
  let lose = 0;
  let total = 0;

  const evalAndCount = (): void => {
    for (let i = 0; i < 5; i++) {
      heroBuf[2 + i] = fullBoard[i]!;
      villBuf[2 + i] = fullBoard[i]!;
    }
    const hs = eval7(heroBuf);
    const vs = eval7(villBuf);
    if (hs > vs) win++;
    else if (hs < vs) lose++;
    else tie++;
    total++;
  };

  const start = board.length;
  const recurse = (deckStart: number, depth: number): void => {
    if (depth === need) {
      evalAndCount();
      return;
    }
    const remainingSlots = need - depth;
    const limit = deck.length - remainingSlots;
    for (let i = deckStart; i <= limit; i++) {
      fullBoard[start + depth] = deck[i]!;
      recurse(i + 1, depth + 1);
    }
  };
  recurse(0, 0);

  return { win, tie, lose, total, equity: (win + tie / 2) / total };
}

/**
 * クラス vs クラスの厳密 equity（A 視点）。
 * 両クラスの全コンボ対（カード衝突するものを除く）で board を全列挙し、
 * 各コンボ対を等重みで平均する。厳密だが重い（テーブル生成でのみ使う）。
 */
export function classVsClassEquityExact(clsA: string, clsB: string): number {
  const combosA = handClassToCombos(clsA);
  const combosB = handClassToCombos(clsB);
  let sumEquity = 0;
  let count = 0;
  for (const a of combosA) {
    for (const b of combosB) {
      if (a[0] === b[0] || a[0] === b[1] || a[1] === b[0] || a[1] === b[1]) continue;
      const r = exactEquityVsHands(a, b);
      sumEquity += r.equity;
      count++;
    }
  }
  if (count === 0) return NaN;
  return sumEquity / count;
}
