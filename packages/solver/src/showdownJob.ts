/**
 * ショーダウン集合 A 1 個分の MC 計算（M4 / nwaySolver から切り出し）。
 *
 * 単一スレッドの求解ループと worker（nwayWorker）の双方から呼ぶ純粋関数。
 * 与えられた ShowdownNode・参加者到達レンジ・サンプル数・シードから、
 *   - pcEq[p]      = 参加者 p のクラス別 all-in equity（169, hero=full 条件）
 *   - seatMarginal = 全席の周辺 ICM equity（到達レンジで平均, 長さ N）
 * を返す。両パスで同一シード → 同一結果（並列化しても解が変わらない）。
 */

import { estimateNodeEquities, type ShowdownNode } from './showdownMc.js';
import { DeterministicRng } from './placement.js';
import { HAND_CLASS_ORDER } from './huEquity.js';

const N_CLASSES = HAND_CLASS_ORDER.length; // 169
const FULL_RANGE = new Float64Array(N_CLASSES).fill(1);

export interface ShowdownMcResult {
  /** 参加者ごと（node.participants と同順）のクラス別 all-in equity。 */
  pcEq: Float64Array[];
  /** 全席の周辺 ICM equity（長さ = preHandStacks.length）。 */
  seatMarginal: number[];
}

/** レンジが空なら全レンジで代用（MC を成立させるため）。 */
function nonEmpty(freq: Float64Array): Float64Array {
  let w = 0;
  for (let i = 0; i < N_CLASSES; i++) w += freq[i]!;
  return w > 1e-9 ? freq : FULL_RANGE;
}

/** 32bit 整数ミックス（seed 派生用, 決定的, パス順非依存）。 */
function mix2(a: number, b: number): number {
  let h = (a ^ 0x9e3779b1) >>> 0;
  h = (Math.imul(h ^ b, 0x85ebca6b) + 0x165667b1) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * ショーダウン A の pcEq / seatMarginal を見積もる。
 *
 * hero のクラス別 equity は「hero=full, 他=到達レンジ」で 1 参加者ずつ 1 パス
 * （BR がレンジ外クラスの逸脱 EV も要求するため hero は全 169 クラスを張る）。
 * seatMarginal は「全員=到達レンジ」の 1 パスから取る。計 (k+1) パス。
 *
 * @param ranges 参加者ごとの到達レンジ（node.participants と同順, 空可→FULL 代用）。
 * @param seed   この A・この epoch に固有の基底シード（パスごとに派生）。
 */
export function computeShowdownMc(
  node: ShowdownNode,
  ranges: readonly Float64Array[],
  samples: number,
  seed: number,
): ShowdownMcResult {
  const k = node.participants.length;
  if (ranges.length !== k) throw new Error('computeShowdownMc: ranges length must equal participants');
  const base = ranges.map(nonEmpty);

  const pcEq: Float64Array[] = [];
  for (let h = 0; h < k; h++) {
    const r = base.slice();
    r[h] = FULL_RANGE;
    const rng = new DeterministicRng(mix2(seed, h + 1));
    const { eq } = estimateNodeEquities(node, r, samples, rng);
    pcEq.push(eq[h]!);
  }

  const rngS = new DeterministicRng(mix2(seed, 0xbeef));
  const { seatMarginal } = estimateNodeEquities(node, base, samples, rngS);

  return { pcEq, seatMarginal };
}
