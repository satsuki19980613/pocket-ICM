/**
 * ポジションと、残り人数ごとのプリフロップ行動順。
 *
 * SPEC §6.4: 席位置とポジションは一致しない。D ボタンと生存席から
 * ポジションを「計算」する。本モジュールはボタン基準の正規ポジション集合と、
 * プリフロップの行動順（先に行動する側 → BB が最後）を定義する。
 *
 * ヘッズアップでは SB がボタン（SPEC §6.4）。プリフロップは SB が先に行動する。
 */

export const POSITIONS = ['UTG', 'HJ', 'CO', 'BU', 'SB', 'BB'] as const;
export type Position = (typeof POSITIONS)[number];

/**
 * 残り人数 n（2..6）に対する、プリフロップ行動順のポジション列。
 * 先頭が最初に行動する席、末尾（BB）が最後。
 *
 * 2: [SB, BB]            HU。SB=ボタンで先に行動
 * 3: [BU, SB, BB]        ボタンが先に行動
 * 4: [CO, BU, SB, BB]
 * 5: [UTG, CO, BU, SB, BB]
 * 6: [UTG, HJ, CO, BU, SB, BB]
 */
export function positionsForPlayersLeft(n: number): Position[] {
  switch (n) {
    case 2:
      return ['SB', 'BB'];
    case 3:
      return ['BU', 'SB', 'BB'];
    case 4:
      return ['CO', 'BU', 'SB', 'BB'];
    case 5:
      return ['UTG', 'CO', 'BU', 'SB', 'BB'];
    case 6:
      return ['UTG', 'HJ', 'CO', 'BU', 'SB', 'BB'];
    default:
      throw new RangeError(`playersLeft must be 2..6, got ${n}`);
  }
}

export function isValidPlayersLeft(n: number): boolean {
  return Number.isInteger(n) && n >= 2 && n <= 6;
}

/** 与えられたポジション集合が、残り人数 n の正規集合と一致するか。 */
export function positionsMatchPlayersLeft(positions: readonly string[], n: number): boolean {
  if (!isValidPlayersLeft(n)) return false;
  const expected = positionsForPlayersLeft(n);
  if (positions.length !== expected.length) return false;
  const a = [...positions].sort();
  const b = [...expected].sort();
  return a.every((p, i) => p === b[i]);
}
