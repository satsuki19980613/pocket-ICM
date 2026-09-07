/**
 * 2 人ショーダウンの**厳密**計算（MC 置き換え, env 非依存コア）。
 *
 * ## なぜ厳密にできるか
 * 2 人のオールインでは、最終スタックは「p0 勝ち / p1 勝ち / 引き分け（スプリット）」の
 * **3 通りだけ**で決まる（どのカードで勝ったかは無関係）。よって ICM は 3 回計算すれば足り、
 * あとは「クラス×クラスの勝ち率・引き分け率」表とレンジの行列積で期待値が閉じた形で出る。
 * 盤面サンプリング（MC）が不要になり、**ノイズ 0・桁違いに高速**。
 *
 * push/fold の到達確率の大半は「押した1人＋コールした1人」の 2 人ショーダウンなので、
 * ここを厳密化するだけで MC ノイズ床の主要因が消える（3 人以上の同時オールインは
 * 頻度が低いので従来どおり MC）。
 *
 * ## カードリムーバル
 * hero がクラス c を持つとき、villain がクラス c' を持てるコンボ数は衝突で減る。
 * その有効コンボ数 `validCombos[c][c']` で条件付き確率を重み付けする（MC の衝突棄却と等価）。
 */

import { icmEquities } from './icm.js';
import { finalStacksFromShowdown } from './sidepot.js';
import { HAND_CLASS_ORDER, handClassToCombos } from './huEquity.js';
import { canonicalHeroCombo } from './huTable.js';
import type { ShowdownNode } from './showdownMc.js';
import type { ShowdownMcResult } from './showdownJob.js';

const N_CLASSES = HAND_CLASS_ORDER.length; // 169
const FULL_RANGE = new Float64Array(N_CLASSES).fill(1);

/** hero クラス i vs villain クラス j の厳密な勝ち率・引き分け率（行優先 dims×dims）。 */
export interface WinTieTable {
  dims: number;
  order: string[];
  win: Float32Array;
  tie: Float32Array;
}

export function buildWinTieTable(order: string[], dims: number, win: Float32Array, tie: Float32Array): WinTieTable {
  if (win.length !== dims * dims || tie.length !== dims * dims) {
    throw new Error(`win/tie table size mismatch: ${win.length}/${tie.length} != ${dims * dims}`);
  }
  return { dims, order, win, tie };
}

/**
 * validCombos[c*169+c'] = hero がクラス c の（代表）コンボを持つとき、
 * villain が取りうるクラス c' のコンボ数（カード衝突を除く）。
 * suit 対称性より hero のどの代表コンボでも同数なので、代表 1 つで数えれば厳密。
 */
let _valid: Int32Array | null = null;
function validCombos(): Int32Array {
  if (_valid) return _valid;
  const v = new Int32Array(N_CLASSES * N_CLASSES);
  const combosOf = HAND_CLASS_ORDER.map((l) => handClassToCombos(l));
  for (let c = 0; c < N_CLASSES; c++) {
    const [h0, h1] = canonicalHeroCombo(HAND_CLASS_ORDER[c]!);
    for (let d = 0; d < N_CLASSES; d++) {
      let n = 0;
      for (const [a, b] of combosOf[d]!) if (a !== h0 && a !== h1 && b !== h0 && b !== h1) n++;
      v[c * N_CLASSES + d] = n;
    }
  }
  _valid = v;
  return v;
}

function nonEmpty(freq: Float64Array): Float64Array {
  let w = 0;
  for (let i = 0; i < N_CLASSES; i++) w += freq[i]!;
  return w > 1e-9 ? freq : FULL_RANGE;
}

/**
 * 全 169 クラスを「レンジ opp に対する HU all-in equity（勝ち + 引き分け/2, カードリムーバル込み）」の
 * 降順に並べたクラス index 列を返す。
 *
 * 3 人以上のショーダウンで overcaller（3 人目以降）の hero パスを層化するとき、評価する候補
 * クラス（上位 K）を選ぶのに使う。OC レンジは構造的にレンジ上端の閾値なので（実測: 常に
 * {AA} ⊆ OC ⊆ {AA,KK,QQ}, docs/BATON_OC.md §2b）、「最も狭い相手レンジに対する勝率」順の
 * 上位だけ評価すれば足りる。
 */
export function rankClassesByEquityVs(opp: Float64Array, table: WinTieTable): Int16Array {
  if (table.dims !== N_CLASSES) throw new Error('win/tie table dims mismatch');
  const valid = validCombos();
  const { win, tie } = table;
  const score = new Float64Array(N_CLASSES);
  for (let c = 0; c < N_CLASSES; c++) {
    let z = 0;
    let s = 0;
    const rowV = c * N_CLASSES;
    for (let d = 0; d < N_CLASSES; d++) {
      const r = opp[d]!;
      if (r <= 0) continue;
      const w = r * valid[rowV + d]!;
      if (w === 0) continue;
      z += w;
      s += w * (win[rowV + d]! + tie[rowV + d]! / 2);
    }
    score[c] = z > 0 ? s / z : 0;
  }
  const idx = Array.from({ length: N_CLASSES }, (_, i) => i);
  idx.sort((a, b) => score[b]! - score[a]! || a - b);
  return Int16Array.from(idx);
}

/** 参加者 2 人のショーダウンで、勝者パターン別の全席 ICM 値ベクトルを作る。 */
function outcomeVectors(node: ShowdownNode): { v0: number[]; v1: number[]; vt: number[] } {
  const n = node.preHandStacks.length;
  const [p0, p1] = node.participants as readonly [number, number];
  const eligible = new Array<boolean>(n).fill(false);
  eligible[p0] = true;
  eligible[p1] = true;
  const val = (sc0: number, sc1: number): number[] => {
    const sc = new Array<number>(n).fill(0);
    sc[p0] = sc0;
    sc[p1] = sc1;
    return icmEquities(finalStacksFromShowdown(node.preHandStacks, node.commits, eligible, sc), node.payouts, node.preHandStacks);
  };
  return { v0: val(0, 1), v1: val(1, 0), vt: val(0, 0) };
}

/**
 * 2 人ショーダウンの pcEq / seatMarginal を**厳密に**計算する。
 * `computeShowdownMc` と同じ契約（pcEq[p] は hero=全169クラス条件, seatMarginal は到達レンジ平均）。
 */
export function computeShowdown2Exact(
  node: ShowdownNode,
  ranges: readonly Float64Array[],
  table: WinTieTable,
): ShowdownMcResult {
  if (node.participants.length !== 2) throw new Error('computeShowdown2Exact requires exactly 2 participants');
  if (ranges.length !== 2) throw new Error('ranges length must equal participants');
  if (table.dims !== N_CLASSES) throw new Error('win/tie table dims mismatch');

  const [p0, p1] = node.participants as readonly [number, number];
  const { v0, v1, vt } = outcomeVectors(node);
  const valid = validCombos();
  const { win, tie } = table;
  const base = [nonEmpty(ranges[0]!), nonEmpty(ranges[1]!)];

  /**
   * hero がクラス c を持つ条件で、相手レンジ oppR に対する (勝ち, 引き分け) 期待確率。
   * heroFirst=true なら表を hero 視点でそのまま引く（win[c][c']）。
   */
  const condWT = (oppR: Float64Array): { W: Float64Array; T: Float64Array } => {
    const W = new Float64Array(N_CLASSES);
    const T = new Float64Array(N_CLASSES);
    for (let c = 0; c < N_CLASSES; c++) {
      let z = 0, sw = 0, st = 0;
      const rowV = c * N_CLASSES;
      for (let d = 0; d < N_CLASSES; d++) {
        const r = oppR[d]!;
        if (r <= 0) continue;
        const w = r * valid[rowV + d]!;
        if (w === 0) continue;
        z += w;
        sw += w * win[rowV + d]!;
        st += w * tie[rowV + d]!;
      }
      if (z > 0) { W[c] = sw / z; T[c] = st / z; }
    }
    return { W, T };
  };

  // pcEq: hero は全169クラスを張るので、相手の到達レンジだけで決まる。
  const a = condWT(base[1]!); // 参加者0 が hero、相手は参加者1
  const b = condWT(base[0]!); // 参加者1 が hero、相手は参加者0
  const pc0 = new Float64Array(N_CLASSES);
  const pc1 = new Float64Array(N_CLASSES);
  for (let c = 0; c < N_CLASSES; c++) {
    const w0 = a.W[c]!, t0 = a.T[c]!;
    pc0[c] = w0 * v0[p0]! + t0 * vt[p0]! + (1 - w0 - t0) * v1[p0]!;
    const w1 = b.W[c]!, t1 = b.T[c]!;
    // 参加者1 が勝つ ＝ v1、負ける ＝ v0
    pc1[c] = w1 * v1[p1]! + t1 * vt[p1]! + (1 - w1 - t1) * v0[p1]!;
  }

  // seatMarginal: 両者の到達レンジで平均した勝ち/引き分け確率（参加者0 視点）。
  const r0 = base[0]!, r1 = base[1]!;
  const comboOf = HAND_CLASS_ORDER.map((l) => handClassToCombos(l).length);
  let Z = 0, SW = 0, ST = 0;
  for (let c = 0; c < N_CLASSES; c++) {
    const rc = r0[c]!;
    if (rc <= 0) continue;
    const hw = rc * comboOf[c]!;
    const rowV = c * N_CLASSES;
    for (let d = 0; d < N_CLASSES; d++) {
      const rd = r1[d]!;
      if (rd <= 0) continue;
      const w = hw * rd * valid[rowV + d]!;
      if (w === 0) continue;
      Z += w;
      SW += w * win[rowV + d]!;
      ST += w * tie[rowV + d]!;
    }
  }
  const Wbar = Z > 0 ? SW / Z : 0;
  const Tbar = Z > 0 ? ST / Z : 0;
  const Lbar = 1 - Wbar - Tbar;
  const nSeats = node.preHandStacks.length;
  const seatMarginal = new Array<number>(nSeats);
  for (let s = 0; s < nSeats; s++) seatMarginal[s] = Wbar * v0[s]! + Tbar * vt[s]! + Lbar * v1[s]!;

  return { pcEq: [pc0, pc1], seatMarginal };
}
