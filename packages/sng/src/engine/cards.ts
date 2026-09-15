/**
 * デッキ・カード表記（"Ah" 形式）。rank `AKQJT98765432`・suit `shdc`。
 */

import type { Rng } from '../engine';

const RANKS = 'AKQJT98765432';
const SUITS = 'shdc';

/** 52 枚の新しいデッキ（シャッフル前・rank 降順×suit 順）。 */
export function freshDeck(): string[] {
  const deck: string[] = [];
  for (const r of RANKS) for (const s of SUITS) deck.push(`${r}${s}`);
  return deck;
}

/** Fisher–Yates。rng() は [0,1) の一様乱数。 */
export function shuffle<T>(arr: readonly T[], rng: Rng): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}
