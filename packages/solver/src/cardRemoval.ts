/**
 * hero カードリムーバルを反映した「アクション確率」（fold-through）補正
 * （IMPLEMENTATION_PLAN §4 / docs/NWAY_VALIDATION §3.4-1 / M5）。
 *
 * ## 背景
 * push/fold ツリーで「後方の各プレイヤーがアグレッシブ（push/call/oc）に出る確率」は、
 * これまでコンボ加重のレンジ比（card-blind な `rangeFraction`）で近似していた。
 * だが hero が特定の 2 枚（例: 先手 push の K9s）を持つと、その 2 枚は後方プレイヤーの
 * レンジから物理的に除かれる（カードリムーバル）。押し引きレンジは高カードに偏るため、
 * hero が高カードを持つほど後方のコール/オーバーコール確率は下がり、fold-through が増える。
 * この効果は**早い位置・多人数**で複利的に効き（HRC 比で先手 push が構造的に狭く出る主因,
 * docs/NWAY_VALIDATION §3.2-3.4）、EQ には出ないが無差別境界（push レンジ端）に集中する。
 *
 * ## 補正（hero クラス条件つき, 一次: hero のみ除去）
 * 後方プレイヤー j の戦略頻度を freq_j（169, コンボ内一様）とする。hero が 2 枚 {x,y} を
 * 持つ条件下の j のアグレッシブ確率は
 *
 *     p_j({x,y}) = ( Σ_{combo ∌ x,y} freq_j[class(combo)] ) / C(50,2)
 *                = ( W_j − U_j[x] − U_j[y] + freq_j[class(x,y)] ) / 1225
 *
 *   W_j = Σ_d COMBO_COUNT[d]·freq_j[d]         （card-blind 加重コンボ数）
 *   U_j[k] = Σ_d freq_j[d]·usesCard[d][k]      （カード k を含むコンボの freq 総和）
 *   1225 = C(50,2)                              （x,y を除いた残 50 枚の 2 枚組合せ）
 *
 * hero のクラス c（複数コンボ）については、その全コンボ {x,y}∈c で平均する:
 *
 *     p_j(c) = ( W_j − avgU_j(c) + freq_j[c] ) / 1225,
 *     avgU_j(c) = ( Σ_k usesCard[c][k]·U_j[k] ) / COMBO_COUNT[c]
 *
 * これは「hero のみ除去」の一次補正（前方で既に action 済みのプレイヤーのカードは
 * レンジ上で積分したまま）。docs §3.4-1 の「hero 個別カードリムーバル」に対応する。
 * ショーダウン側の equity（pcEq）は estimateNodeEquities が衝突棄却で別途厳密に扱う。
 */

import { handClassToCombos, HAND_CLASS_ORDER } from './huEquity.js';

const N_CLASSES = HAND_CLASS_ORDER.length; // 169

/** クラス c の具体コンボ（カード id ペア, lo<hi 正規化）。 */
export const CLASS_COMBOS: readonly (readonly [number, number][])[] = HAND_CLASS_ORDER.map(
  (label) =>
    handClassToCombos(label).map(([a, b]) => [Math.min(a, b), Math.max(a, b)] as [number, number]),
);

/** COMBO_COUNT[c] = クラス c のコンボ数（pair 6 / suited 4 / offsuit 12）。 */
export const COMBO_COUNT: readonly number[] = CLASS_COMBOS.map((c) => c.length);

/** x,y の両方を除いた残 50 枚から 2 枚を選ぶ組合せ数 C(50,2)。 */
export const COMBOS_AFTER_REMOVING_TWO = 1225;

/** コンボ (lo*52+hi) → クラス index（-1 は非該当）。 */
const COMBO_CLASS = new Int16Array(52 * 52).fill(-1);
for (let c = 0; c < N_CLASSES; c++) {
  for (const [lo, hi] of CLASS_COMBOS[c]!) COMBO_CLASS[lo * 52 + hi] = c;
}

/** 2 枚 (a,b) の属するハンドクラス index（非該当時 -1）。 */
export function comboClass(a: number, b: number): number {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return COMBO_CLASS[lo * 52 + hi]!;
}

/**
 * クラス c が使うカードの疎リスト。cards[c] = 使用カード id 配列、
 * cnt[c] = 対応する「そのカードを含む c-コンボ数」。avgU_j(c) の計算に使う。
 * （pair は 4 枚 ×3, suited/offsuit は 8 枚 ×1 or ×3 等、各クラス最大 8 枚）
 */
const CLASS_CARD_IDS: number[][] = [];
const CLASS_CARD_CNT: number[][] = [];
for (let c = 0; c < N_CLASSES; c++) {
  const cnt = new Map<number, number>();
  for (const [lo, hi] of CLASS_COMBOS[c]!) {
    cnt.set(lo, (cnt.get(lo) ?? 0) + 1);
    cnt.set(hi, (cnt.get(hi) ?? 0) + 1);
  }
  const ids: number[] = [];
  const cs: number[] = [];
  for (const [card, n] of cnt) {
    ids.push(card);
    cs.push(n);
  }
  CLASS_CARD_IDS.push(ids);
  CLASS_CARD_CNT.push(cs);
}

/** W_j と U_j（52）を戦略頻度から計算する。 */
export function weightAndUses(freq: Float64Array): { W: number; U: Float64Array } {
  let W = 0;
  const U = new Float64Array(52);
  for (let c = 0; c < N_CLASSES; c++) {
    const f = freq[c]!;
    if (f === 0) continue;
    W += COMBO_COUNT[c]! * f;
    for (const [lo, hi] of CLASS_COMBOS[c]!) {
      U[lo]! += f;
      U[hi]! += f;
    }
  }
  return { W, U };
}

/**
 * hero クラス条件つきアグレッシブ確率 p_j(c)（長さ 169, 0..1）。
 * out を渡すと破壊的に埋める（GC 抑制）。
 */
export function conditionalAggrProb(
  freq: Float64Array,
  W: number,
  U: Float64Array,
  out: Float64Array = new Float64Array(N_CLASSES),
): Float64Array {
  for (let c = 0; c < N_CLASSES; c++) {
    const ids = CLASS_CARD_IDS[c]!;
    const cs = CLASS_CARD_CNT[c]!;
    let sumU = 0;
    for (let t = 0; t < ids.length; t++) sumU += cs[t]! * U[ids[t]!]!;
    const avgU = sumU / COMBO_COUNT[c]!;
    let p = (W - avgU + freq[c]!) / COMBOS_AFTER_REMOVING_TWO;
    // 数値の綻び防止でクランプ（レンジ比なので [0,1]）。
    if (p < 0) p = 0;
    else if (p > 1) p = 1;
    out[c] = p;
  }
  return out;
}

/**
 * ブルートフォース参照: hero が 2 枚 {x,y} を持つ条件下の card-blind アグレッシブ確率。
 * 全 1326 コンボのうち x,y を含まないものの freq を合計し 1225 で割る（テスト用）。
 */
export function bruteConditionalAggrProbForPair(
  freq: Float64Array,
  x: number,
  y: number,
): number {
  let num = 0;
  let den = 0;
  for (let c = 0; c < N_CLASSES; c++) {
    for (const [lo, hi] of CLASS_COMBOS[c]!) {
      if (lo === x || lo === y || hi === x || hi === y) continue;
      num += freq[c]!;
      den++;
    }
  }
  return den > 0 ? num / den : 0;
}
