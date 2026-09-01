/**
 * マルチウェイ着順分布（SPEC §3.3 / IMPLEMENTATION_PLAN 1-4）。
 *
 * 3-way 以上のオールイン・ショーダウンでは、ペアワイズ勝率では復元できない
 * 「タイを含む全順序の確率分布」が要る。ICM はこの着順分布 × 終局スタック分布で
 * 重み付き平均する。本モジュールはその着順分布を
 *   - 小ケース: 残りボード全列挙で厳密に（テスト・検証用）
 *   - 実用: 固定シード Monte Carlo で（キャッシュ生成用）
 * 算出する。
 *
 * ## 着順のエンコード（サイドポットまで復元可能な完全表現）
 * 1 サンプルの結果を「各プレイヤーより強い手の人数」ベクトル strongerCount で表す。
 * 同点は同じ値になり、タイ群構造がそのまま出る（= サイドポット分配に必要十分）。
 * 分布は signature（strongerCount を基数 k+1 で連結した整数）→ 確率 の Map。
 *
 * ここでは着順分布そのものの生成・検証・コスト計測までを担う（M2-5）。
 * ICM への接続とサイドポット分配、3〜6人の求解本体は M3（1-5, 1-8）。
 */

import { eval7 } from './evaluator.js';

/**
 * 決定的 RNG（mulberry32, seed 固定でテスト決定性を保証）。
 *
 * mulberry32 は 32bit 単状態の小型 PRNG で、全ビットに良好なアバランチを持つ。
 * 旧実装（xorshift128+ の 32bit 変種）は高位ビットの分布が弱く、[0,1) 浮動小数や
 * 大きな法の剰余に使うとレンジ抽選が偏った（showdownMc のクラス抽選で顕在化）。
 * mulberry32 は nextInt（低位ビット）にも nextFloat（全ビット）にも安全に使える。
 */
export class DeterministicRng {
  private s: number;
  constructor(seed: number) {
    this.s = (seed >>> 0) || 0x9e3779b9;
  }
  /** [0, 2^32) の符号なし 32bit 乱数（mulberry32）。 */
  nextU32(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) >>> 0;
  }
  /** [0, n) の整数。 */
  nextInt(n: number): number {
    return this.nextU32() % n;
  }
  /** [0, 1) の浮動小数（全 32bit を使用）。 */
  nextFloat(): number {
    return this.nextU32() / 0x100000000;
  }
}

/** strongerCount ベクトル → signature 整数。 */
export function encodeSignature(strongerCount: readonly number[]): number {
  const k = strongerCount.length;
  const base = k + 1;
  let sig = 0;
  for (let i = k - 1; i >= 0; i--) sig = sig * base + strongerCount[i]!;
  return sig;
}

/** signature → strongerCount ベクトル（k 人）。 */
export function decodeSignature(sig: number, k: number): number[] {
  const base = k + 1;
  const out = new Array<number>(k);
  let s = sig;
  for (let i = 0; i < k; i++) {
    out[i] = s % base;
    s = Math.floor(s / base);
  }
  return out;
}

export type PlacementDist = Map<number, number>;

/** 各プレイヤーの 7 枚スコアから strongerCount を求める。 */
function strongerCounts(scores: number[]): number[] {
  const k = scores.length;
  const out = new Array<number>(k).fill(0);
  for (let i = 0; i < k; i++) {
    let c = 0;
    for (let j = 0; j < k; j++) if (scores[j]! > scores[i]!) c++;
    out[i] = c;
  }
  return out;
}

/** 手札（各 [c1,c2]）と既知ボードから残りデッキを作る。重複はエラー。 */
function remainingDeck(hands: readonly [number, number][], board: readonly number[]): number[] {
  const used = new Set<number>();
  for (const [a, b] of hands) {
    used.add(a);
    used.add(b);
  }
  for (const c of board) used.add(c);
  if (used.size !== hands.length * 2 + board.length) {
    throw new Error('duplicate cards among hands/board');
  }
  const deck: number[] = [];
  for (let c = 0; c < 52; c++) if (!used.has(c)) deck.push(c);
  return deck;
}

/**
 * 着順分布の厳密全列挙（残りボードを全通り）。小ケース検証用。
 * k=3, board=[] で C(46,5)=1,370,754 通り。
 */
export function placementDistributionExact(
  hands: readonly [number, number][],
  board: readonly number[] = [],
): PlacementDist {
  const k = hands.length;
  const deck = remainingDeck(hands, board);
  const need = 5 - board.length;
  if (need < 0) throw new Error('board longer than 5');

  const full = new Array<number>(5);
  for (let i = 0; i < board.length; i++) full[i] = board[i]!;
  const bufs = hands.map(([a, b]) => [a, b, 0, 0, 0, 0, 0]);
  const scores = new Array<number>(k);
  const dist: PlacementDist = new Map();
  let total = 0;

  const evalOne = (): void => {
    for (let p = 0; p < k; p++) {
      for (let i = 0; i < 5; i++) bufs[p]![2 + i] = full[i]!;
      scores[p] = eval7(bufs[p]!);
    }
    const sig = encodeSignature(strongerCounts(scores));
    dist.set(sig, (dist.get(sig) ?? 0) + 1);
    total++;
  };

  const start = board.length;
  const recurse = (deckStart: number, depth: number): void => {
    if (depth === need) {
      evalOne();
      return;
    }
    const remainingSlots = need - depth;
    const limit = deck.length - remainingSlots;
    for (let i = deckStart; i <= limit; i++) {
      full[start + depth] = deck[i]!;
      recurse(i + 1, depth + 1);
    }
  };
  recurse(0, 0);

  for (const [sig, c] of dist) dist.set(sig, c / total);
  return dist;
}

/**
 * 着順分布の Monte Carlo 推定（固定シード）。ボードを部分 Fisher-Yates で無作為抽出。
 */
export function placementDistributionMC(
  hands: readonly [number, number][],
  samples: number,
  rng: DeterministicRng,
  board: readonly number[] = [],
): PlacementDist {
  const k = hands.length;
  const deck = remainingDeck(hands, board);
  const need = 5 - board.length;
  if (need < 0) throw new Error('board longer than 5');

  const full = new Array<number>(5);
  for (let i = 0; i < board.length; i++) full[i] = board[i]!;
  const bufs = hands.map(([a, b]) => [a, b, 0, 0, 0, 0, 0]);
  const scores = new Array<number>(k);
  const dist: PlacementDist = new Map();

  const start = board.length;
  const m = deck.length;
  for (let s = 0; s < samples; s++) {
    // 部分 Fisher-Yates で need 枚を抽出（deck 末尾を破壊しないようスワップを元に戻す）。
    for (let i = 0; i < need; i++) {
      const j = i + rng.nextInt(m - i);
      const tmp = deck[i]!;
      deck[i] = deck[j]!;
      deck[j] = tmp;
      full[start + i] = deck[i]!;
    }
    for (let p = 0; p < k; p++) {
      for (let i = 0; i < 5; i++) bufs[p]![2 + i] = full[i]!;
      scores[p] = eval7(bufs[p]!);
    }
    const sig = encodeSignature(strongerCounts(scores));
    dist.set(sig, (dist.get(sig) ?? 0) + 1);
  }
  for (const [sig, c] of dist) dist.set(sig, c / samples);
  return dist;
}

/** 2 分布の最大絶対差（全 signature の和集合上）。 */
export function distMaxAbsDiff(a: PlacementDist, b: PlacementDist): number {
  let maxd = 0;
  const keys = new Set<number>([...a.keys(), ...b.keys()]);
  for (const k of keys) maxd = Math.max(maxd, Math.abs((a.get(k) ?? 0) - (b.get(k) ?? 0)));
  return maxd;
}

/** 2 分布の全変動距離（total variation = 0.5·Σ|Δ|）。 */
export function distTotalVariation(a: PlacementDist, b: PlacementDist): number {
  let s = 0;
  const keys = new Set<number>([...a.keys(), ...b.keys()]);
  for (const k of keys) s += Math.abs((a.get(k) ?? 0) - (b.get(k) ?? 0));
  return s / 2;
}
