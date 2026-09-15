/** クライアントへ見せる形（秘密を落とす）。 */

import type { PublicHand, PublicTable, TableState, You } from '../types';

export function toPublicHand(hand: TableState['hand']): PublicHand | null {
  if (hand === null) return null;
  const { deck: _deck, hole, ...rest } = hand;
  const shown: Record<number, readonly [string, string]> = {};
  for (const seat of hand.revealed) {
    const h = hole[seat];
    if (h) shown[seat] = h;
  }
  return { ...rest, shown };
}

export function publicTable(state: TableState): PublicTable {
  const { hand: _hand, wake: _wake, ...rest } = state;
  return { ...rest, hand: toPublicHand(state.hand) };
}

export function you(state: TableState, userId: string): You {
  const player = state.players.find((p) => p.userId === userId);
  const seat = player ? player.seat : null;
  let hole: readonly [string, string] | null = null;
  if (seat !== null && state.hand !== null) {
    hole = state.hand.hole[seat] ?? null;
  }
  return { userId, seat, hole };
}
