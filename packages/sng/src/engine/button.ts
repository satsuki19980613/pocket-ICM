/**
 * デッドボタン規則（docs/SNG_DESIGN.md §1）。
 *
 *   bb = nextLive(prevBb)
 *   sb = prevBb（飛んでいれば dead・SB 無し）
 *   btn = prevSb（飛んでいれば dead）
 *   生存 2 人（HU）なら btn = sb
 *
 * 「飛んでいる」= その席の PlayerState.status が 'out'（脱落済み）。sitout / left はまだ
 * 「生存」扱い（席とボタン計算に残る。手番が来れば自動処理されるだけ）。
 */

import type { PlayerState } from '../types';

export function isLive(p: PlayerState): boolean {
  return p.status !== 'out';
}

/** from の次（from を含まない）で最初に live な席。全員 out なら例外。 */
export function nextLive(players: readonly PlayerState[], from: number): number {
  const n = players.length;
  for (let i = 1; i <= n; i++) {
    const seat = (from + i) % n;
    if (isLive(players[seat]!)) return seat;
  }
  throw new Error('nextLive: no live seat');
}

export interface ButtonAssignment {
  readonly btn: number;
  readonly sbSeat: number | null;
  readonly bbSeat: number;
}

/**
 * このハンドの btn/sb/bb を決める。
 * @param forcedBtn 初回ハンドだけ渡す（満席時に乱択した席）。
 */
export function computeButtonForHand(
  players: readonly PlayerState[],
  prevSbSeat: number | null,
  prevBbSeat: number | null,
  forcedBtn?: number,
): ButtonAssignment {
  const n = players.length;
  const liveSeats: number[] = [];
  for (let s = 0; s < n; s++) if (isLive(players[s]!)) liveSeats.push(s);

  if (liveSeats.length === 2) {
    // HU: btn = sb。もう一方が bb。
    if (forcedBtn !== undefined) {
      const sbSeat = forcedBtn;
      const bbSeat = liveSeats.find((s) => s !== sbSeat)!;
      return { btn: sbSeat, sbSeat, bbSeat };
    }
    const bbSeat = nextLive(players, prevBbSeat ?? -1);
    const sbSeat = liveSeats.find((s) => s !== bbSeat)!;
    return { btn: sbSeat, sbSeat, bbSeat };
  }

  if (forcedBtn !== undefined) {
    const btn = forcedBtn;
    const sbSeat = nextLive(players, btn);
    const bbSeat = nextLive(players, sbSeat);
    return { btn, sbSeat, bbSeat };
  }

  const bbSeat = nextLive(players, prevBbSeat!);
  const sbCandidate = prevBbSeat!;
  const sbSeat = isLive(players[sbCandidate]!) ? sbCandidate : null;
  const btn = prevSbSeat!;
  return { btn, sbSeat, bbSeat };
}
