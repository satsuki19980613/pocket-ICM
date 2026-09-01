/**
 * HU 169×169 all-in equity テーブルの厳密生成（IMPLEMENTATION_PLAN 1-3）。
 *
 * 厳密性を保ったまま計算量を削るための2つの正当な削減:
 *   1. hero を各クラスの単一代表コンボに固定できる（全 suit 対称性より、
 *      クラス平均は hero 代表を1つ選び villain 全コンボを平均したものに等しい）。
 *   2. villain コンボは「hero の suit を固定する残余対称群」で軌道にまとめられる。
 *      同一軌道のコンボは equity が等しいので、代表を1回だけ盤面全列挙し、
 *      軌道サイズで重み付けする。
 *   3. HU の equity は零和: equity(A vs B) + equity(B vs A) = 1。上三角のみ計算。
 *
 * これらはいずれも厳密（近似なし）。
 */

import { exactEquityVsHands, handClassToCombos, HAND_CLASS_ORDER } from './huEquity.js';
import { makeCard, cardRank, cardSuit } from './evaluator.js';
import { parseHandClass } from '@oshihiki/core';

const RANK_TO_VALUE: Record<string, number> = {
  A: 14, K: 13, Q: 12, J: 11, T: 10, '9': 9, '8': 8, '7': 7, '6': 6, '5': 5, '4': 4, '3': 3, '2': 2,
};

/** クラスの単一代表 hero コンボ（決定的）。 */
export function canonicalHeroCombo(label: string): [number, number] {
  const hc = parseHandClass(label);
  if (!hc) throw new Error(`invalid hand class: ${label}`);
  const hi = RANK_TO_VALUE[hc.hi]!;
  const lo = RANK_TO_VALUE[hc.lo]!;
  if (hc.kind === 'pair') return [makeCard(hi, 0), makeCard(hi, 1)];
  if (hc.kind === 's') return [makeCard(hi, 0), makeCard(lo, 0)];
  return [makeCard(hi, 0), makeCard(lo, 1)]; // offsuit
}

interface VillainGroup {
  rep: [number, number];
  weight: number;
}

/**
 * hero を固定したとき、villain クラスのコンボを残余 suit 対称で軌道にまとめる。
 * 返り値: 代表コンボ群（重み付き）と、有効コンボ総数。
 */
export function villainGroups(
  heroCombo: readonly [number, number],
  villainClass: string,
): { groups: VillainGroup[]; totalValid: number } {
  const heroSuits = new Set<number>([cardSuit(heroCombo[0]), cardSuit(heroCombo[1])]);
  const freeSuits: number[] = [0, 1, 2, 3].filter((s) => !heroSuits.has(s));

  const heroCardSet = new Set<number>([heroCombo[0], heroCombo[1]]);
  const groups = new Map<string, VillainGroup>();
  let totalValid = 0;

  for (const vc of handClassToCombos(villainClass)) {
    if (heroCardSet.has(vc[0]) || heroCardSet.has(vc[1])) continue; // hero とカード衝突
    totalValid++;

    // 2 枚を (rank 降順, suit 昇順) で正規順に並べる
    let a = vc[0];
    let b = vc[1];
    const ra = cardRank(a);
    const rb = cardRank(b);
    if (ra < rb || (ra === rb && cardSuit(a) > cardSuit(b))) {
      const t = a;
      a = b;
      b = t;
    }

    // free suit を出現順に正規ラベルへ写像
    const freeMap = new Map<number, number>();
    let nextFree = 0;
    const relabel = (suit: number): string => {
      if (heroSuits.has(suit)) return `U${suit}`;
      if (!freeMap.has(suit)) {
        freeMap.set(suit, nextFree++);
      }
      return `F${freeMap.get(suit)}`;
    };
    const keyA = `${cardRank(a)}${relabel(cardSuit(a))}`;
    const keyB = `${cardRank(b)}${relabel(cardSuit(b))}`;
    const key = `${keyA}|${keyB}`;

    const g = groups.get(key);
    if (g) g.weight++;
    else groups.set(key, { rep: [a, b], weight: 1 });
  }

  return { groups: [...groups.values()], totalValid };
}

/**
 * クラス vs クラスの厳密 equity（hero 視点）。suit 正規化で削減。
 * classVsClassEquityExact と一致する（近似なし）。
 */
export function classEquityCanonical(heroClass: string, villainClass: string): number {
  const hero = canonicalHeroCombo(heroClass);
  const { groups, totalValid } = villainGroups(hero, villainClass);
  if (totalValid === 0) return NaN;
  let sum = 0;
  for (const g of groups) {
    const r = exactEquityVsHands(hero, g.rep);
    sum += r.equity * g.weight;
  }
  return sum / totalValid;
}

export interface HuTableProgress {
  (done: number, total: number, label: string): void;
}

export interface HuTable {
  order: string[];
  /** equity[i*169 + j] = クラス i（hero）が クラス j（villain）に対して持つ equity */
  equity: Float64Array;
}

/**
 * 169×169 全体を厳密生成する。零和性より上三角のみ評価し、
 * 対角は自明でないので個別評価する（A vs A は 0.5 とは限らない → 実は 0.5）。
 */
export function generateHuTable(onProgress?: HuTableProgress): HuTable {
  const order = HAND_CLASS_ORDER;
  const n = order.length; // 169
  const equity = new Float64Array(n * n);

  // 上三角 + 対角。対角は零和対称より 0.5。
  const totalPairs = (n * (n + 1)) / 2;
  let done = 0;

  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let eij: number;
      if (i === j) {
        eij = 0.5; // 同一クラス同士は零和対称で 0.5
      } else {
        eij = classEquityCanonical(order[i]!, order[j]!);
      }
      equity[i * n + j] = eij;
      equity[j * n + i] = 1 - eij; // 零和性
      done++;
      if (onProgress && (done % 200 === 0 || done === totalPairs)) {
        onProgress(done, totalPairs, `${order[i]} vs ${order[j]}`);
      }
    }
  }

  return { order, equity };
}
