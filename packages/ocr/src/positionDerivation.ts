/**
 * D ボタン ＋ 生存席 → ポジション導出（SPEC §6.4 / Plan 2-4）。
 *
 * 席位置とポジションは一致しない。ボタンからプレイの進行方向（時計回り）に
 * 生存席を辿り、ポジションを割り当てる。empty 席（不在・接続切れ）は数えず飛ばす。
 * ヘッズアップ（生存 2 人）では SB がボタン。
 *
 * このモジュールは画像に一切依存しない純ロジックであり、golden dataset 無しで
 * 全パターンを検証できる（2-4 の完了条件）。
 */

import type { Position } from '@oshihiki/core';
import type { PhysicalSeat } from './types.js';

/**
 * 生存人数 n（2..6）に対する「ボタン席から時計回り」のポジション列。
 * 先頭がボタン席、以降プレイ進行方向。positionsForPlayersLeft（行動順）とは別で、
 * こちらは物理席の並び順に対応する。
 *
 *   2: [SB, BB]                 HU。ボタン＝SB
 *   3: [BU, SB, BB]
 *   4: [BU, SB, BB, CO]
 *   5: [BU, SB, BB, UTG, CO]
 *   6: [BU, SB, BB, UTG, HJ, CO]
 */
export function clockwiseFromButton(n: number): Position[] {
  switch (n) {
    case 2:
      return ['SB', 'BB'];
    case 3:
      return ['BU', 'SB', 'BB'];
    case 4:
      return ['BU', 'SB', 'BB', 'CO'];
    case 5:
      return ['BU', 'SB', 'BB', 'UTG', 'CO'];
    case 6:
      return ['BU', 'SB', 'BB', 'UTG', 'HJ', 'CO'];
    default:
      throw new RangeError(`playersLeft must be 2..6, got ${n}`);
  }
}

export interface DerivedPositions {
  /** 生存席 id → ポジション。empty 席は含まれない。 */
  readonly byId: ReadonlyMap<string, Position>;
  /** hero のポジション。 */
  readonly heroPos: Position;
  /** 生存人数（empty を除いた数）。 */
  readonly playersLeft: number;
}

export interface DeriveError {
  readonly ok: false;
  readonly issues: string[];
}
export type DeriveResult = ({ ok: true } & DerivedPositions) | DeriveError;

/**
 * 物理席リング（時計回り）→ ポジション導出。
 *
 * @param ring 画面席を時計回りに並べた配列。長さは席総数（empty 含む, 2..6）。
 * @returns 成功時は席 id→Position と heroPos、失敗時は issues。
 */
export function derivePositions(ring: readonly PhysicalSeat[]): DeriveResult {
  const issues: string[] = [];

  if (ring.length < 2 || ring.length > 6) {
    return { ok: false, issues: [`席数は 2..6。got ${ring.length}`] };
  }

  const buttonIdx = ring.findIndex((s) => s.isButton);
  if (buttonIdx < 0) issues.push('D ボタンが検出できていません');
  if (ring.filter((s) => s.isButton).length > 1) issues.push('D ボタンが複数席にあります');

  if (buttonIdx >= 0 && !ring[buttonIdx]!.occupied) {
    issues.push('D ボタン席が empty（不在）です');
  }

  const heroCount = ring.filter((s) => s.isHero).length;
  if (heroCount !== 1) issues.push(`hero 席は 1 つである必要があります（got ${heroCount}）`);

  const occupied = ring.filter((s) => s.occupied);
  const n = occupied.length;
  if (n < 2 || n > 6) issues.push(`生存席数は 2..6。got ${n}`);

  if (issues.length > 0) return { ok: false, issues };

  const order = clockwiseFromButton(n);

  // ボタン席から時計回りに 1 周し、occupied な席へ順にポジションを割り当てる。
  const byId = new Map<string, Position>();
  let assigned = 0;
  let heroPos: Position | undefined;
  for (let step = 0; step < ring.length; step++) {
    const seat = ring[(buttonIdx + step) % ring.length]!;
    if (!seat.occupied) continue;
    const pos = order[assigned]!;
    byId.set(seat.id, pos);
    if (seat.isHero) heroPos = pos;
    assigned++;
  }

  if (heroPos === undefined) {
    return { ok: false, issues: ['hero が生存席の中に見つかりません'] };
  }

  return { ok: true, byId, heroPos, playersLeft: n };
}
