/**
 * root 復元で「席が場に出したチップ」をどう決めるかのテスト（さつき指摘 2026-09-11）。
 *
 * 行動マーク（レイズ/コール/オールイン）が無い席が場に置けるのはブラインドだけなので、
 * その席のチップは読まずにブラインド額で確定する。実機 Pixel フレームで BB の 1 BB チップを
 * 読み漏らし、BB のスタックが 1 少なく復元されていた（6.9 → 5.9）のを再発させない。
 */
import { describe, it, expect } from 'vitest';
import type { RawReads, RawSeatRead, SeatAction } from './types.js';
import { reconstructSpot } from './spotReconstruction.js';

interface SeatSpec {
  readonly id: string;
  readonly stack?: number;
  readonly bet?: number;
  readonly action?: SeatAction;
  readonly hero?: boolean;
  readonly button?: boolean;
  readonly empty?: boolean;
}

const rd = <T>(value: T, conf = 0.9) => ({ value, conf });

function seat(s: SeatSpec): RawSeatRead {
  return {
    id: s.id,
    isHero: s.hero === true,
    isButton: s.button === true,
    occupancy: rd(s.empty ? ('empty' as const) : ('occupied' as const)),
    action: rd(s.action ?? 'none'),
    stack: rd(s.stack ?? NaN),
    bet: rd(s.bet ?? 0, 0.4),
  };
}

function reads(pot: number, seats: readonly SeatSpec[]): RawReads {
  return {
    street: rd('preflop'),
    blinds: { sb: rd(0.5), bb: rd(1) },
    ante: { scheme: 'all', amount: rd(0.25) },
    pot: rd(pot),
    heroHand: rd('JTs'),
    seats: seats.map(seat),
    displayMode: 'bb',
  };
}

// 席は時計回り TL,TC,TR,BR,BC,BL。BL=BU → TL=SB, TR=BB, BR=UTG, BC=CO(hero)。TC は空席。
const base: SeatSpec[] = [
  { id: 'TL', stack: 44.3, bet: 0.5 },
  { id: 'TC', empty: true },
  { id: 'TR', stack: 6.9, bet: 1 },
  { id: 'BR', stack: 66.6 },
  { id: 'BC', stack: 10.4, hero: true },
  { id: 'BL', stack: 29.8, button: true },
];
const stackOf = (r: ReturnType<typeof reconstructSpot>, pos: string) => r.state!.seats.find((s) => s.pos === pos)!.stack;

describe('reconstructSpot — 場に出したチップ', () => {
  it('未行動の BB は、チップを読み漏らしてもブラインド額で復元する', () => {
    const misread = base.map((s) => (s.id === 'TR' ? { ...s, bet: 0 } : s));
    const r = reconstructSpot(reads(2.8, misread));
    expect(r.ok).toBe(true);
    // root の BB スタック = 画面の残り 6.9 + 出した 1 − ブラインド 1 = 6.9（読み漏らし前の実装は 5.9）。
    expect(stackOf(r, 'BB')).toBeCloseTo(6.9, 6);
  });

  it('読めていても結果は同じ（ブラインドどおりのチップ）', () => {
    const r = reconstructSpot(reads(2.8, base));
    expect(stackOf(r, 'BB')).toBeCloseTo(6.9, 6);
    expect(stackOf(r, 'SB')).toBeCloseTo(44.3, 6);
  });

  it('オールインの席は、読んだ額（オールイン額）で復元する', () => {
    const shove = base.map((s) => (s.id === 'BR' ? { ...s, stack: 0, bet: 12, action: 'allin' as const } : s));
    const r = reconstructSpot(reads(14.8, shove));
    expect(r.ok).toBe(true);
    expect(stackOf(r, 'UTG')).toBeCloseTo(12, 6);
  });

  it('マークが無いのにブラインドを超えるチップがあれば、従来どおり未分類のベットとして弾く', () => {
    // マークの読み落とし（本当はレイズ）を安全側に倒す検出は、読んだ額で行う。
    const raised = base.map((s) => (s.id === 'BR' ? { ...s, bet: 3 } : s));
    const r = reconstructSpot(reads(5.8, raised));
    expect(r.ok).toBe(false);
    expect(r.issues.join()).toMatch(/未分類のベット/);
  });
});
