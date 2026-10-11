/** 13×13 ハンドグリッド（標準表記）。上三角=suited, 対角=pair, 下三角=offsuit。 */

export const RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'] as const;

/** グリッドのセル (row, col) → ハンドクラス表記（例 AA / AKs / AKo）。 */
export function handLabel(row: number, col: number): string {
  const hi = RANKS[Math.min(row, col)]!;
  const lo = RANKS[Math.max(row, col)]!;
  if (row === col) return `${hi}${hi}`;
  return row < col ? `${hi}${lo}s` : `${hi}${lo}o`;
}

/** グリッドのセル (row, col) → セルの種類（CSS クラス名にそのまま使う）。 */
export function cellKind(row: number, col: number): 'pair' | 'suited' | 'offsuit' {
  if (row === col) return 'pair';
  return row < col ? 'suited' : 'offsuit';
}
