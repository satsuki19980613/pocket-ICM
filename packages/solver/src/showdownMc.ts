/**
 * マルチウェイ all-in equity の node-level レンジ Monte Carlo
 * （IMPLEMENTATION_PLAN 1-4 の採用方針 / SPEC §3.3 / docs/MC_COST_FINDINGS.md）。
 *
 * ## 方針（findings §3）
 * ハンドクラス組ごとの着順分布キャッシュ（§3.3 字義）は 4-way 10GB/5-way 2.4TB で破綻。
 * 求解時の per-class-tuple MC も R^k 爆発で不可。**採用: ノードレベルのレンジ MC。**
 * 各ショーダウン・ノードで、参加者レンジからハンドを引き（衝突は棄却）ボードを引いて
 * 評価する試行を S 回。コストは O(S) でレンジ幅・人数タプル数に依存しない。
 *
 * 本モジュールは 2 つの粒度を提供する:
 *   1. `sampleShowdownIcm`  — 参加者ハンドを固定し、ボードのみ MC。着順分布経由の
 *      厳密計算（expectedShowdownIcm ∘ placementDistributionExact）と一致することを
 *      テストする、検証用の下位プリミティブ。
 *   2. `estimateNodeEquities` — 参加者ハンドをレンジから引く本番用。各参加者の
 *      「クラス別 all-in equity（そのクラスを持つ条件付き ICM 期待値）」を 1 パスで返す。
 *      3〜6人求解（multiwaySolver）の equity 先取り MC に使う。
 */

import { eval7 } from './evaluator.js';
import { icmEquities } from './icm.js';
import { distributePots } from './sidepot.js';
import { HAND_CLASS_ORDER, handClassToCombos } from './huEquity.js';
import { DeterministicRng } from './placement.js';

const N_CLASSES = HAND_CLASS_ORDER.length; // 169

/** クラス i の具体コンボ（カード id ペア）。 */
const CLASS_COMBOS: [number, number][][] = HAND_CLASS_ORDER.map((label) =>
  handClassToCombos(label),
);
/** コンボ (lo*52+hi) → クラス index。 */
const COMBO_CLASS = new Int16Array(52 * 52).fill(-1);
for (let i = 0; i < N_CLASSES; i++) {
  for (const [a, b] of CLASS_COMBOS[i]!) {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    COMBO_CLASS[lo * 52 + hi] = i;
  }
}
function comboClassOf(a: number, b: number): number {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return COMBO_CLASS[lo * 52 + hi]!;
}

/** ショーダウン・ノードの金額構造（席は全残存プレイヤー、長さ N）。 */
export interface ShowdownNode {
  /** 全席のハンド開始スタック（拠出前）。長さ N。 */
  preHandStacks: readonly number[];
  /** 全席の拠出総額（ブラインド・アンティ・オールイン分）。長さ N。 */
  commits: readonly number[];
  /** ショーダウン参加者（オールイン者）の席インデックス。 */
  participants: readonly number[];
  /** 着順 1..N に対する実払い payout（長さ N）。 */
  payouts: readonly number[];
}

/** 各プレイヤーの 7 枚スコアから strongerCount（自分より強い人数）を求める。 */
function strongerCounts(scores: readonly number[], k: number, out: number[]): void {
  for (let i = 0; i < k; i++) {
    let c = 0;
    for (let j = 0; j < k; j++) if (scores[j]! > scores[i]!) c++;
    out[i] = c;
  }
}

/** eligible/strongerCount バッファを組み立てて 1 ショーダウン結果の ICM を返す。 */
function icmForOutcome(
  node: ShowdownNode,
  scParts: readonly number[],
  eligible: boolean[],
  strongerCount: number[],
): number[] {
  const parts = node.participants;
  for (let j = 0; j < parts.length; j++) strongerCount[parts[j]!] = scParts[j]!;
  const won = distributePots(node.commits, eligible, strongerCount);
  const nSeats = node.preHandStacks.length;
  const finalStacks = new Array<number>(nSeats);
  for (let i = 0; i < nSeats; i++) {
    finalStacks[i] = node.preHandStacks[i]! - node.commits[i]! + won[i]!;
  }
  return icmEquities(finalStacks, node.payouts);
}

/**
 * 参加者ハンドを固定し、残りボードのみを MC してショーダウンの ICM 期待値を返す
 * （検証用プリミティブ）。
 *
 * @param hands   参加者の 2 枚（node.participants と同順）。
 * @param board   既知のコミュニティカード（0..5 枚）。
 * @returns 全席の期待 ICM equity（入力順、長さ N）。
 */
export function sampleShowdownIcm(
  node: ShowdownNode,
  hands: readonly [number, number][],
  samples: number,
  rng: DeterministicRng,
  board: readonly number[] = [],
): number[] {
  const k = node.participants.length;
  if (hands.length !== k) throw new Error('hands length must equal participants');

  const used = new Set<number>();
  for (const [a, b] of hands) {
    used.add(a);
    used.add(b);
  }
  for (const c of board) used.add(c);
  if (used.size !== k * 2 + board.length) throw new Error('duplicate cards among hands/board');

  const deck: number[] = [];
  for (let c = 0; c < 52; c++) if (!used.has(c)) deck.push(c);
  const need = 5 - board.length;
  if (need < 0) throw new Error('board longer than 5');

  const nSeats = node.preHandStacks.length;
  const eligible = new Array<boolean>(nSeats).fill(false);
  for (const p of node.participants) eligible[p] = true;
  const strongerCount = new Array<number>(nSeats).fill(0);

  const full = new Array<number>(5);
  for (let i = 0; i < board.length; i++) full[i] = board[i]!;
  const bufs = hands.map(([a, b]) => [a, b, 0, 0, 0, 0, 0]);
  const scores = new Array<number>(k);
  const scParts = new Array<number>(k);

  const equity = new Array<number>(nSeats).fill(0);
  const start = board.length;
  const m = deck.length;

  for (let s = 0; s < samples; s++) {
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
    strongerCounts(scores, k, scParts);
    const eq = icmForOutcome(node, scParts, eligible, strongerCount);
    for (let i = 0; i < nSeats; i++) equity[i]! += eq[i]!;
  }
  for (let i = 0; i < nSeats; i++) equity[i]! /= samples;
  return equity;
}

/** 参加者ごとのクラス別 all-in equity 見積り。 */
export interface NodeEquities {
  /**
   * eq[p] = 参加者 p の「クラス c を持つ条件付き ICM 期待値」（長さ 169）。
   * サンプルが無いクラスは参加者の周辺 ICM 期待値（marginal）で埋める。
   */
  eq: Float64Array[];
  /** marginal[p] = 参加者 p のレンジ平均 ICM 期待値（p は participants の添字）。 */
  marginal: number[];
  /**
   * seatMarginal[seat] = 全席の期待 ICM equity（長さ N）。
   * フォールド者（非参加者）の値は、参加者の着順結果分布に対する期待。
   * 逐次ツリーで「自分がこのショーダウンに参加せず降りたときの値」に使う。
   */
  seatMarginal: number[];
  /** counts[p][c] = 参加者 p がクラス c を引いた有効サンプル数。 */
  counts: Int32Array[];
}

/**
 * 参加者レンジからハンドを引いてショーダウンをサンプルし、各参加者の
 * クラス別 all-in equity を 1 パス（O(samples)）で見積もる。本番求解用。
 *
 * @param ranges 参加者ごとの 169 クラス頻度（0..1）。node.participants と同順。
 *               あるクラスの各コンボはこの頻度で採用（クラス内一様）。全 0 のレンジは不可。
 */
export function estimateNodeEquities(
  node: ShowdownNode,
  ranges: readonly Float64Array[],
  samples: number,
  rng: DeterministicRng,
): NodeEquities {
  const k = node.participants.length;
  if (ranges.length !== k) throw new Error('ranges length must equal participants');

  // 各参加者について、採用しうるコンボの累積重みテーブルを作る（クラス頻度×コンボ）。
  // combo を [a,b,classIndex,weight] で持ち、weight の累積で抽選する。
  const partCombos: { a: number; b: number; cls: number }[][] = [];
  const partCum: Float64Array[] = [];
  for (let p = 0; p < k; p++) {
    const r = ranges[p]!;
    const list: { a: number; b: number; cls: number }[] = [];
    const cum: number[] = [];
    let acc = 0;
    for (let c = 0; c < N_CLASSES; c++) {
      const w = r[c]!;
      if (w <= 0) continue;
      for (const [a, b] of CLASS_COMBOS[c]!) {
        acc += w; // クラス内コンボは等重み
        list.push({ a, b, cls: c });
        cum.push(acc);
      }
    }
    if (acc <= 0) throw new Error(`participant ${p} has empty range`);
    partCombos.push(list);
    partCum.push(Float64Array.from(cum));
  }

  const nSeats = node.preHandStacks.length;
  const eligible = new Array<boolean>(nSeats).fill(false);
  for (const p of node.participants) eligible[p] = true;
  const strongerCount = new Array<number>(nSeats).fill(0);

  const eq: Float64Array[] = Array.from({ length: k }, () => new Float64Array(N_CLASSES));
  const counts: Int32Array[] = Array.from({ length: k }, () => new Int32Array(N_CLASSES));
  const marginalSum = new Array<number>(k).fill(0);
  const seatSum = new Array<number>(nSeats).fill(0);
  let marginalCount = 0;

  const drawFrom = (p: number): { a: number; b: number; cls: number } => {
    const cum = partCum[p]!;
    const list = partCombos[p]!;
    const target = rng.nextFloat() * cum[cum.length - 1]!;
    // コンボ idx は区間 (cum[idx-1], cum[idx]] を占める。cum[idx] > target の最小 idx。
    let lo = 0;
    let hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid]! <= target) lo = mid + 1;
      else hi = mid;
    }
    return list[lo]!;
  };

  const heroCls = new Array<number>(k);
  const bufs: number[][] = Array.from({ length: k }, () => [0, 0, 0, 0, 0, 0, 0]);
  const scores = new Array<number>(k);
  const scParts = new Array<number>(k);
  const full = new Array<number>(5);
  const usedCards = new Set<number>();

  let attempts = 0;
  const maxAttempts = samples * 20 + 1000;
  let done = 0;
  while (done < samples && attempts < maxAttempts) {
    attempts++;
    usedCards.clear();
    let collision = false;
    for (let p = 0; p < k; p++) {
      const combo = drawFrom(p);
      if (usedCards.has(combo.a) || usedCards.has(combo.b)) {
        collision = true;
        break;
      }
      usedCards.add(combo.a);
      usedCards.add(combo.b);
      bufs[p]![0] = combo.a;
      bufs[p]![1] = combo.b;
      heroCls[p] = combo.cls;
    }
    if (collision) continue;

    // ボード 5 枚を残デッキから引く（衝突回避）。
    let filled = 0;
    while (filled < 5) {
      const c = rng.nextInt(52);
      if (usedCards.has(c)) continue;
      usedCards.add(c);
      full[filled++] = c;
    }
    for (let p = 0; p < k; p++) {
      for (let i = 0; i < 5; i++) bufs[p]![2 + i] = full[i]!;
      scores[p] = eval7(bufs[p]!);
    }
    strongerCounts(scores, k, scParts);
    const outcome = icmForOutcome(node, scParts, eligible, strongerCount);
    for (let p = 0; p < k; p++) {
      const seat = node.participants[p]!;
      const c = heroCls[p]!;
      eq[p]![c]! += outcome[seat]!;
      counts[p]![c]!++;
      marginalSum[p]! += outcome[seat]!;
    }
    for (let s = 0; s < nSeats; s++) seatSum[s]! += outcome[s]!;
    done++;
  }
  marginalCount = done;

  const marginal = marginalSum.map((s) => (marginalCount > 0 ? s / marginalCount : 0));
  const seatMarginal = seatSum.map((s) => (marginalCount > 0 ? s / marginalCount : 0));
  for (let p = 0; p < k; p++) {
    const e = eq[p]!;
    const cnt = counts[p]!;
    for (let c = 0; c < N_CLASSES; c++) {
      e[c] = cnt[c]! > 0 ? e[c]! / cnt[c]! : marginal[p]!;
    }
  }
  return { eq, marginal, seatMarginal, counts };
}
