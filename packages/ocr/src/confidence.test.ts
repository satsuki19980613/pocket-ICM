/**
 * ポット・チェックサムと要確認の強調（`potChecksum` / `aggregateConfidence`）のテスト。
 *
 * 行動マーク（レイズ/コール/オールイン）の無い席のベットは席順から決まるブラインド額で確定する
 * （さつき指摘 2026-09-11）。実機 Pixel フレームで BB の 1 BB チップを読み漏らし、
 *   - チェックサムが「理論 1.75 vs 画面 2.8」で不一致と誤判定し、
 *   - 確認画面の「bet 1」が注意色になっていた
 * のを再発させない。
 */
import { describe, it, expect } from 'vitest';
import type { Position } from '@oshihiki/core';
import type { RawReads, RawSeatRead, SeatAction } from './types.js';
import type { SeatFacts } from './spotReconstruction.js';
import { aggregateConfidence, potChecksum } from './confidence.js';

const rd = <T>(value: T, conf = 0.9) => ({ value, conf });

interface Spec {
  readonly id: string;
  readonly pos: Position;
  readonly bet: number;
  readonly betConf?: number;
  readonly action?: SeatAction;
}

function build(pot: number, specs: readonly Spec[]): { reads: RawReads; facts: SeatFacts[] } {
  const seats: RawSeatRead[] = specs.map((s) => ({
    id: s.id,
    isHero: false,
    isButton: false,
    occupancy: rd('occupied' as const),
    action: rd(s.action ?? 'none'),
    stack: rd(20),
    bet: rd(s.bet, s.betConf ?? 0.9),
  }));
  const reads: RawReads = {
    street: rd('preflop'),
    blinds: { sb: rd(0.5), bb: rd(1) },
    ante: { scheme: 'all', amount: rd(0.25) },
    pot: rd(pot),
    heroHand: rd('JTs'),
    seats,
    displayMode: 'bb',
  };
  const facts: SeatFacts[] = specs.map((s) => {
    const action = s.action ?? 'none';
    const blindOb = s.pos === 'SB' ? 0.5 : s.pos === 'BB' ? 1 : 0;
    return {
      id: s.id, pos: s.pos, isHero: false, action,
      folded: action === 'fold', allin: action === 'allin',
      screenStack: 20, screenBet: s.bet, blindOb,
    };
  });
  return { reads, facts };
}

// 5 人・未オープン。BB のチップを読み漏らした（0・信頼度 0.4）。本当のポットは 2.75 → 画面 2.8。
const PIXEL: Spec[] = [
  { id: 'a', pos: 'UTG', bet: 0, betConf: 0.4 },
  { id: 'b', pos: 'CO', bet: 0, betConf: 0.4 },
  { id: 'c', pos: 'BU', bet: 0, betConf: 0.4 },
  { id: 'd', pos: 'SB', bet: 0.5 },
  { id: 'e', pos: 'BB', bet: 0, betConf: 0.4 },
];

describe('potChecksum', () => {
  it('マークの無い席はブラインド額で数えるので、BB のチップを読み漏らしても一致する', () => {
    const { reads, facts } = build(2.8, PIXEL);
    const c = potChecksum(reads, facts);
    expect(c.theoretical).toBeCloseTo(2.75, 9);
    expect(c.ok).toBe(true);
  });

  it('オールインの席は読んだ額で数える', () => {
    const specs = PIXEL.map((s) => (s.pos === 'UTG' ? { ...s, bet: 12, betConf: 0.9, action: 'allin' as const } : s));
    const { reads, facts } = build(14.8, specs);
    expect(potChecksum(reads, facts).theoretical).toBeCloseTo(14.75, 9);
  });
});

describe('aggregateConfidence', () => {
  it('マークの無い席のベットは、チップの読みが怪しくても要確認にしない', () => {
    const { reads, facts } = build(2.8, PIXEL);
    const r = aggregateConfidence(reads, facts);
    expect(r.lowConfidenceFields.filter((k) => k.endsWith('.bet'))).toEqual([]);
    expect(r.lowConfidenceFields).not.toContain('pot');
  });

  it('オールイン額の読みが怪しければ、その席のベットは要確認にする', () => {
    const specs = PIXEL.map((s) => (s.pos === 'UTG' ? { ...s, bet: 12, betConf: 0.4, action: 'allin' as const } : s));
    const { reads, facts } = build(14.8, specs);
    expect(aggregateConfidence(reads, facts).lowConfidenceFields).toContain('UTG.bet');
  });

  it('チェックサムが本当に合わないときは、従来どおり全席のベットを要確認にする', () => {
    const { reads, facts } = build(9.9, PIXEL);
    const r = aggregateConfidence(reads, facts);
    expect(r.checksum.ok).toBe(false);
    expect(r.lowConfidenceFields).toContain('BB.bet');
    expect(r.lowConfidenceFields).toContain('pot');
  });
});
