/**
 * ICM equity — Malmuth-Harville（IMPLEMENTATION_PLAN 1-2 / SPEC §2.2, §3.3）。
 *
 * 実払いペイアウト（クラブマッチなら `+5,+3,+2,+1,0,-1`）を「直接」payout 重みとして使う。
 * ペイアウトは**ゲームモードで変わる**（@oshihiki/core の GAME_MODE_SPECS）。
 * MH は着順確率 × payout の線形結合であり、payout の符号に制約はない。
 * シフト変換は不要（HRC 照合時の換算のみ）。
 *
 * モデル（top-down）:
 *   P(着順 o=[p1,p2,...,pn]) = Π_k  s_{p_k} / (S - Σ_{j<k} s_{p_j})
 *   equity_i = Σ_o P(o) · payout[i の着順]
 *
 * 実装は残存集合に対する部分集合 DP（O(2^n · n)）。n≤6 では 64 マスク。
 * 参照用に着順列挙（720通り）版も持ち、両者一致をテストする。
 */

import { gameModeSpec, type GameMode } from '@oshihiki/core';

/** 6-max クラブマッチの実払いペイアウト（1位→6位）。SPEC §2.1。他モードは GAME_MODE_SPECS 参照。 */
export const REAL_PAYOUTS_6 = [5, 3, 2, 1, 0, -1] as const;

/** HRC 入力形（シフト後）。SPEC §2.2。照合時の換算にのみ使う。 */
export const HRC_PAYOUTS_6 = [6, 4, 3, 2, 1, 0] as const;

/**
 * 残り人数 n の実払いペイアウト。既に飛んだプレイヤーが下位を確定しているため、
 * 残る n 人は上位 n 着（クラブマッチなら +5,+3,...）を争う。
 * @param mode ゲームモード。省略時はクラブマッチ（v3 以前の記録・既存の呼び出しと同じ挙動）。
 */
export function payoutsForPlayers(n: number, mode?: GameMode): number[] {
  const full = gameModeSpec(mode).payouts;
  if (!Number.isInteger(n) || n < 1 || n > full.length) {
    throw new RangeError(`players must be 1..${full.length}, got ${n}`);
  }
  return full.slice(0, n);
}

function popcount(x: number): number {
  let c = 0;
  while (x) {
    x &= x - 1;
    c++;
  }
  return c;
}

/**
 * Malmuth-Harville ICM equity。部分集合 DP による厳密計算。
 * @param stacks  各プレイヤーのチップ量（正）。
 * @param payouts 着順 1..n に対する payout。長さは stacks と一致。
 * @param tieBreak 同一ハンドで複数人が飛んだ（stack=0）ときの順位付けキー（通常はハンド開始時の
 *                 スタック）。**大きい方が上位**（トーナメントの標準ルール。HRC も同じ）。
 *                 省略時は均等割り（旧挙動）。同値なら均等割り。
 *                 例: SB 2bb と CO 3bb が同時に飛ぶと CO が 5 位・SB が 6 位。均等割り（各 −0.5pt）
 *                 では SB のコールが 0.5pt 甘くなり、HRC と大きくずれる（2026-09-07 照合で発見）。
 * @returns 各プレイヤーの期待 payout（入力順）。
 */
export function icmEquities(
  stacks: readonly number[],
  payouts: readonly number[],
  tieBreak?: readonly number[],
): number[] {
  const n = stacks.length;
  if (payouts.length !== n) {
    throw new Error(`payouts length (${payouts.length}) must equal stacks length (${n})`);
  }
  if (n === 0) return [];
  for (const s of stacks) {
    if (!(s >= 0) || !Number.isFinite(s)) throw new Error(`invalid stack: ${s}`);
  }
  if (n > 20) throw new RangeError('icmEquities: n too large for subset DP');

  const full = (1 << n) - 1;
  const reach = new Float64Array(1 << n);
  reach[full] = 1;
  const equity = new Array<number>(n).fill(0);

  // 部分集合を popcount 降順で処理（superset が先に確定している必要があるため）。
  const masksByPop: number[][] = Array.from({ length: n + 1 }, () => []);
  for (let mask = 1; mask <= full; mask++) {
    masksByPop[popcount(mask)]!.push(mask);
  }

  for (let pop = n; pop >= 1; pop--) {
    const place = n - pop + 1; // この集合から選ばれる者の着順（1-based）
    const payoutForPlace = payouts[place - 1]!;
    for (const mask of masksByPop[pop]!) {
      const r = reach[mask]!;
      if (r === 0) continue;
      // 残存集合のスタック総和
      let sum = 0;
      for (let i = 0; i < n; i++) if (mask & (1 << i)) sum += stacks[i]!;
      if (sum <= 0) {
        // 残りが全員 0 スタック＝同一ハンドで同時に飛んだ集合。tieBreak（ハンド開始時スタック）
        // が最大の者がこの着順を取る（同値は均等割り）。tieBreak 省略時は全員均等割り。
        const members: number[] = [];
        for (let i = 0; i < n; i++) if (mask & (1 << i)) members.push(i);
        let top = members;
        if (tieBreak) {
          let best = Number.NEGATIVE_INFINITY;
          for (const m of members) if (tieBreak[m]! > best) best = tieBreak[m]!;
          top = members.filter((m) => tieBreak[m]! === best);
        }
        const p = 1 / top.length;
        for (const w of top) {
          equity[w]! += r * p * payoutForPlace;
          reach[mask & ~(1 << w)]! += r * p;
        }
        continue;
      }
      for (let w = 0; w < n; w++) {
        if (!(mask & (1 << w))) continue;
        const p = stacks[w]! / sum;
        if (p === 0) continue;
        equity[w]! += r * p * payoutForPlace;
        reach[mask & ~(1 << w)]! += r * p;
      }
    }
  }

  return equity;
}

/**
 * 参照実装: 着順を全列挙して equity を求める（O(n·n!)）。
 * n=6 で 720 通り。DP との一致テストに使う。
 */
export function icmEquitiesByEnumeration(
  stacks: readonly number[],
  payouts: readonly number[],
): number[] {
  const n = stacks.length;
  if (payouts.length !== n) {
    throw new Error(`payouts length (${payouts.length}) must equal stacks length (${n})`);
  }
  const equity = new Array<number>(n).fill(0);
  const order: number[] = [];
  const used = new Array<boolean>(n).fill(false);

  const recurse = (depth: number, prob: number, remainingSum: number): void => {
    if (depth === n) {
      for (let place = 0; place < n; place++) {
        equity[order[place]!]! += prob * payouts[place]!;
      }
      return;
    }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      const s = stacks[i]!;
      const p = remainingSum > 0 ? s / remainingSum : 1 / (n - depth);
      if (p === 0) continue;
      used[i] = true;
      order.push(i);
      recurse(depth + 1, prob * p, remainingSum - s);
      order.pop();
      used[i] = false;
    }
  };

  const total = stacks.reduce((a, b) => a + b, 0);
  recurse(0, 1, total);
  return equity;
}
