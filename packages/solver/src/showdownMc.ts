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

/**
 * ショーダウン結果（着順シグネチャ）→ 全席 ICM ベクトルのキャッシュ。
 *
 * 1 サンプルの終局スタックは「各参加者の strongerCount ベクトル」だけで決まる（どのカードで
 * 勝ったかは無関係）。その種類は 3 人 13 / 4 人 75 / 5 人 541 / 6 人 4683 通りしかないので、
 * 同じシグネチャの ICM（サイドポット分配 + Malmuth-Harville）は 1 度計算すれば使い回せる。
 * 実測で 1 サンプル 4.5µs のうち約半分がこの ICM 計算だった（厳密に同値のまま半減）。
 */
export class OutcomeCache {
  private readonly cache = new Map<number, number[]>();
  private readonly eligible: boolean[];
  private readonly strongerCount: number[];
  private readonly k: number;
  constructor(private readonly node: ShowdownNode) {
    const nSeats = node.preHandStacks.length;
    this.k = node.participants.length;
    this.eligible = new Array<boolean>(nSeats).fill(false);
    for (const p of node.participants) this.eligible[p] = true;
    this.strongerCount = new Array<number>(nSeats).fill(0);
  }
  /** scParts = 参加者順の strongerCount。返り値は共有配列（書き換え禁止）。 */
  icmOf(scParts: readonly number[]): number[] {
    const k = this.k;
    let sig = 0;
    for (let i = 0; i < k; i++) sig = sig * (k + 1) + scParts[i]!;
    const hit = this.cache.get(sig);
    if (hit) return hit;
    const node = this.node;
    const parts = node.participants;
    for (let j = 0; j < k; j++) this.strongerCount[parts[j]!] = scParts[j]!;
    const won = distributePots(node.commits, this.eligible, this.strongerCount);
    const nSeats = node.preHandStacks.length;
    const finalStacks = new Array<number>(nSeats);
    for (let i = 0; i < nSeats; i++) finalStacks[i] = node.preHandStacks[i]! - node.commits[i]! + won[i]!;
    const v = icmEquities(finalStacks, node.payouts);
    this.cache.set(sig, v);
    return v;
  }
}

/** eligible/strongerCount バッファを組み立てて 1 ショーダウン結果の ICM を返す（非キャッシュ, 検証用）。 */
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

/** 参加者レンジからコンボを引く累積重みテーブル（クラス頻度 × クラス内等重み）。 */
interface ComboDrawer {
  list: { a: number; b: number; cls: number }[];
  cum: Float64Array;
}
function makeDrawer(r: Float64Array, p: number): ComboDrawer {
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
  return { list, cum: Float64Array.from(cum) };
}
function drawCombo(d: ComboDrawer, rng: DeterministicRng): { a: number; b: number; cls: number } {
  const cum = d.cum;
  const target = rng.nextFloat() * cum[cum.length - 1]!;
  // コンボ idx は区間 (cum[idx-1], cum[idx]] を占める。cum[idx] > target の最小 idx。
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid]! <= target) lo = mid + 1;
    else hi = mid;
  }
  return d.list[lo]!;
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
  const drawers = ranges.map((r, p) => makeDrawer(r, p));
  const nSeats = node.preHandStacks.length;
  const cache = new OutcomeCache(node);

  const eq: Float64Array[] = Array.from({ length: k }, () => new Float64Array(N_CLASSES));
  const counts: Int32Array[] = Array.from({ length: k }, () => new Int32Array(N_CLASSES));
  const marginalSum = new Array<number>(k).fill(0);
  const seatSum = new Array<number>(nSeats).fill(0);

  const heroCls = new Array<number>(k);
  const bufs: number[][] = Array.from({ length: k }, () => [0, 0, 0, 0, 0, 0, 0]);
  const scores = new Array<number>(k);
  const scParts = new Array<number>(k);
  // 使用カード集合はビットマスク（0..31 / 32..51）。Set より大幅に速い。
  let uLo = 0;
  let uHi = 0;

  let attempts = 0;
  const maxAttempts = samples * 20 + 1000;
  let done = 0;
  while (done < samples && attempts < maxAttempts) {
    attempts++;
    uLo = 0;
    uHi = 0;
    let collision = false;
    for (let p = 0; p < k; p++) {
      const combo = drawCombo(drawers[p]!, rng);
      const a = combo.a;
      const b = combo.b;
      const ha = a < 32 ? (uLo >>> a) & 1 : (uHi >>> (a - 32)) & 1;
      const hb = b < 32 ? (uLo >>> b) & 1 : (uHi >>> (b - 32)) & 1;
      if (ha | hb) {
        collision = true;
        break;
      }
      if (a < 32) uLo |= 1 << a;
      else uHi |= 1 << (a - 32);
      if (b < 32) uLo |= 1 << b;
      else uHi |= 1 << (b - 32);
      bufs[p]![0] = a;
      bufs[p]![1] = b;
      heroCls[p] = combo.cls;
    }
    if (collision) continue;

    // ボード 5 枚を残デッキから引く（衝突回避）。
    let filled = 0;
    while (filled < 5) {
      const c = rng.nextInt(52);
      if (c < 32) {
        if ((uLo >>> c) & 1) continue;
        uLo |= 1 << c;
      } else {
        if ((uHi >>> (c - 32)) & 1) continue;
        uHi |= 1 << (c - 32);
      }
      for (let p = 0; p < k; p++) bufs[p]![2 + filled] = c;
      filled++;
    }
    for (let p = 0; p < k; p++) scores[p] = eval7(bufs[p]!);
    strongerCounts(scores, k, scParts);
    const outcome = cache.icmOf(scParts);
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
  const marginalCount = done;

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

/**
 * 層化 hero パス: hero（参加者 heroIdx）のクラスを `classes` に**固定・均等配分**して、
 * 各クラスちょうど `perClass` 本サンプルし、クラス条件付き ICM 期待値を返す。
 *
 * ## なぜ層化か（docs/BATON_OC.md §2f, §8）
 * 従来（estimateNodeEquities）は hero クラスをコンボ数比例で引くため AA には全サンプルの
 * 0.45% しか当たらない。一方 OC（オーバーコール）の可否を決めるのは AA/KK/QQ などレンジ
 * 上端のごく少数のクラスで、それ以外の 140 余りは必ず降りる。eq[c] はクラス条件付き平均
 * なので、抽選分布をどう変えても各クラスの推定は**不偏**。よって候補クラスだけに本数を
 * 集中させれば、同じ精度を桁違いに少ない本数で得られる。
 *
 * `classes` に無いクラスは NaN のまま返す（呼び出し側が埋める。**候補中の最小値**で埋めること。
 * レンジ平均で埋めると弱いクラスが過大評価され OC が崩壊する＝実測済み）。
 *
 * hero の具体コンボはクラス内で一様に引く（suit 構成の偏りを避ける）。他参加者は到達
 * レンジから引き、カード衝突は棄却（カードリムーバルは MC の衝突棄却で厳密）。
 */
export function estimateHeroStratified(
  node: ShowdownNode,
  ranges: readonly Float64Array[],
  heroIdx: number,
  classes: ArrayLike<number>,
  perClass: number,
  rng: DeterministicRng,
  cache: OutcomeCache = new OutcomeCache(node),
): { eq: Float64Array; counts: Int32Array } {
  const k = node.participants.length;
  if (ranges.length !== k) throw new Error('ranges length must equal participants');
  if (heroIdx < 0 || heroIdx >= k) throw new Error('heroIdx out of range');
  const drawers = ranges.map((r, p) => (p === heroIdx ? null : makeDrawer(r, p)));
  const seat = node.participants[heroIdx]!;
  const bufs: number[][] = Array.from({ length: k }, () => [0, 0, 0, 0, 0, 0, 0]);
  const scores = new Array<number>(k);
  const scParts = new Array<number>(k);
  const eq = new Float64Array(N_CLASSES).fill(NaN);
  const counts = new Int32Array(N_CLASSES);

  for (let ci = 0; ci < classes.length; ci++) {
    const c = classes[ci]!;
    const combos = CLASS_COMBOS[c]!;
    let sum = 0;
    let got = 0;
    let tries = 0;
    const maxTries = perClass * 30 + 30;
    while (got < perClass && tries < maxTries) {
      tries++;
      const [ha, hb] = combos[rng.nextInt(combos.length)]!;
      let uLo = 0;
      let uHi = 0;
      if (ha < 32) uLo |= 1 << ha;
      else uHi |= 1 << (ha - 32);
      if (hb < 32) uLo |= 1 << hb;
      else uHi |= 1 << (hb - 32);
      bufs[heroIdx]![0] = ha;
      bufs[heroIdx]![1] = hb;
      let collision = false;
      for (let p = 0; p < k; p++) {
        if (p === heroIdx) continue;
        const combo = drawCombo(drawers[p]!, rng);
        const a = combo.a;
        const b = combo.b;
        const xa = a < 32 ? (uLo >>> a) & 1 : (uHi >>> (a - 32)) & 1;
        const xb = b < 32 ? (uLo >>> b) & 1 : (uHi >>> (b - 32)) & 1;
        if (xa | xb) {
          collision = true;
          break;
        }
        if (a < 32) uLo |= 1 << a;
        else uHi |= 1 << (a - 32);
        if (b < 32) uLo |= 1 << b;
        else uHi |= 1 << (b - 32);
        bufs[p]![0] = a;
        bufs[p]![1] = b;
      }
      if (collision) continue;
      let filled = 0;
      while (filled < 5) {
        const x = rng.nextInt(52);
        if (x < 32) {
          if ((uLo >>> x) & 1) continue;
          uLo |= 1 << x;
        } else {
          if ((uHi >>> (x - 32)) & 1) continue;
          uHi |= 1 << (x - 32);
        }
        for (let p = 0; p < k; p++) bufs[p]![2 + filled] = x;
        filled++;
      }
      for (let p = 0; p < k; p++) scores[p] = eval7(bufs[p]!);
      strongerCounts(scores, k, scParts);
      sum += cache.icmOf(scParts)[seat]!;
      got++;
    }
    if (got > 0) {
      eq[c] = sum / got;
      counts[c] = got;
    }
  }
  return { eq, counts };
}
