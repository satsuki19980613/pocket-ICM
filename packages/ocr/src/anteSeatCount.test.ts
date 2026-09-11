/**
 * アンティによる人数の整合（`resolveStacklessSeats`）のテスト。
 *
 * 実バグの再発防止: 装飾テーマ卓の実機フレーム（Screenshot_20260910-192316.png）で、空席を装飾の
 * せいで占有と誤読した幽霊席が 6 人目になり、利用者はエラー画面に落ちた。ここではその局面を
 * 数値で再現し、「読めない席を空席として数え、アンティで整合を取る」（さつき決定 2026-09-11）が
 * 幽霊席だけを落とし、本物の席は落とさないことを固定する。
 */
import { describe, it, expect } from 'vitest';
import type { RawReads, RawSeatRead, SeatAction } from './types.js';
import { resolveStacklessSeats } from './anteSeatCount.js';

interface SeatSpec {
  readonly id: string;
  readonly stack?: number; // 省略 = 読めなかった（NaN）
  readonly bet?: number;
  readonly action?: SeatAction;
  readonly hero?: boolean;
  readonly button?: boolean;
  readonly empty?: boolean;
}

const rd = <T>(value: T, conf = 0.9) => ({ value, conf });

function seat(s: SeatSpec): RawSeatRead {
  const stack = s.stack ?? NaN;
  return {
    id: s.id,
    isHero: s.hero === true,
    isButton: s.button === true,
    occupancy: rd(s.empty ? ('empty' as const) : ('occupied' as const)),
    action: rd(s.action ?? 'none'),
    stack: rd(stack, Number.isFinite(stack) ? 0.9 : 0),
    bet: rd(s.bet ?? 0, 0.4),
  };
}

function reads(pot: number, seats: readonly SeatSpec[], extra: Partial<RawReads> = {}): RawReads {
  return {
    street: rd('preflop'),
    blinds: { sb: rd(0.5), bb: rd(1) },
    ante: { scheme: 'all', amount: rd(0.25) },
    pot: rd(pot),
    heroHand: rd('JTs'),
    seats: seats.map(seat),
    displayMode: 'bb',
    ...extra,
  };
}

/**
 * 実機 Pixel フレームの数値（席は時計回り TL,TC,TR,BR,BC,BL）。
 * TC は本当は空席だが占有と誤読されスタック未読。TR（本当の BB）の 1 BB チップは読み漏らし（0）。
 * 本当の配置: BL=BU, TL=SB, TR=BB, BR=UTG, BC=CO(hero)。ポット 2.8 = 0.5+1+0.25×5（表示は四捨五入）。
 */
const PIXEL: readonly SeatSpec[] = [
  { id: 'TL', stack: 44.3, bet: 0.5 },
  { id: 'TC' },
  { id: 'TR', stack: 6.9, bet: 0 },
  { id: 'BR', stack: 66.6 },
  { id: 'BC', stack: 10.4, hero: true },
  { id: 'BL', stack: 29.3, button: true },
];

describe('resolveStacklessSeats', () => {
  it('実機 Pixel フレーム: 幽霊席（空席の見間違い）だけを空席に確定し、5 人にする', () => {
    const { reads: out, result } = resolveStacklessSeats(reads(2.8, PIXEL));
    expect(result.applied).toBe(true);
    expect(result.dropped).toEqual(['TC']);
    expect(result.players).toBe(5);
    expect(out.seats.find((s) => s.id === 'TC')!.occupancy.value).toBe('empty');
    // ほかの席は触らない。
    expect(out.seats.find((s) => s.id === 'TR')!.occupancy.value).toBe('occupied');
  });

  it('読めない席が本物なら（ポットが 6 人分）落とさない', () => {
    // 6 人ならポットは 0.5+1+0.25×6 = 3.0。スタックが読めないだけの本物の席。
    const { reads: out, result } = resolveStacklessSeats(reads(3.0, PIXEL));
    expect(result.applied).toBe(true);
    expect(result.dropped).toEqual([]);
    expect(result.players).toBe(6);
    expect(out.seats.find((s) => s.id === 'TC')!.occupancy.value).toBe('occupied');
  });

  it('行動マークが付いている席は、スタックが読めなくても空席にしない', () => {
    const seats = PIXEL.map((s) => (s.id === 'TC' ? { ...s, action: 'fold' as const } : s));
    const { result } = resolveStacklessSeats(reads(2.8, seats));
    expect(result.applied).toBe(false);
    expect(result.dropped).toEqual([]);
  });

  it('hero 席はスタックが読めなくても空席にしない', () => {
    const seats = PIXEL.map((s) =>
      s.id === 'TC' ? { ...s, stack: 20 } : s.id === 'BC' ? { id: 'BC', hero: true } : s,
    );
    const { result } = resolveStacklessSeats(reads(3.0, seats));
    expect(result.applied).toBe(false);
  });

  it('オールインがあるときは、オールイン額を読んで判定する', () => {
    // 本当は 4 人（TL=BU がオールイン 12、TR=SB、BR=BB、BC=CO hero）。TC は幽霊席、BL は空席。
    // ポット = 12 + 0.5 + 1 + 0.25×4 = 14.5。TC を本物とすると 14.75 になり合わない。
    const seats: SeatSpec[] = [
      { id: 'TL', stack: 0, bet: 12, action: 'allin', button: true },
      { id: 'TC' },
      { id: 'TR', stack: 20, bet: 0.5 },
      { id: 'BR', stack: 20, bet: 1 },
      { id: 'BC', stack: 20, hero: true },
      { id: 'BL', empty: true },
    ];
    const { result } = resolveStacklessSeats(reads(14.5, seats));
    expect(result.dropped).toEqual(['TC']);
    expect(result.players).toBe(4);
  });

  it('オールイン額が読めなければ推測しない（何もしない）', () => {
    const seats: SeatSpec[] = [
      { id: 'TL', stack: 0, bet: NaN, action: 'allin', button: true },
      { id: 'TC' },
      { id: 'TR', stack: 20 },
      { id: 'BR', stack: 20 },
      { id: 'BC', stack: 20, hero: true },
      { id: 'BL', empty: true },
    ];
    const { reads: out, result } = resolveStacklessSeats(reads(14.5, seats));
    expect(result.applied).toBe(false);
    expect(out.seats.find((s) => s.id === 'TC')!.occupancy.value).toBe('occupied');
  });

  it('ポットがどちらの仮説とも合わない（誤読）なら何もしない', () => {
    const { result } = resolveStacklessSeats(reads(9.9, PIXEL));
    expect(result.applied).toBe(false);
    expect(result.note).toMatch(/ambiguous/);
  });

  it('チップ表示のフレームには使わない（ポットの単位が違う）', () => {
    const { result } = resolveStacklessSeats(reads(2.8, PIXEL, { displayMode: 'chips' }));
    expect(result.applied).toBe(false);
  });

  it('読めない席が無ければ何もしない', () => {
    const seats = PIXEL.map((s) => (s.id === 'TC' ? { id: 'TC', empty: true } : s));
    const { reads: out, result } = resolveStacklessSeats(reads(2.8, seats));
    expect(result.applied).toBe(false);
    expect(out.seats).toEqual(reads(2.8, seats).seats);
  });
});
