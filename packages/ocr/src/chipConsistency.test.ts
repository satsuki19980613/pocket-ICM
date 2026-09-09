import { describe, it, expect } from 'vitest';
import { applyChipConsistency } from './chipConsistency.js';
import type { RawReads, RawSeatRead, Occupancy, SeatAction } from './types.js';

function seat(id: string, stack: number, conf = 0.9, occ: Occupancy = 'occupied', bet = 0, act: SeatAction = 'none'): RawSeatRead {
  return {
    id,
    isHero: id === 'BC',
    isButton: false,
    occupancy: { value: occ, conf: 0.9 },
    action: { value: act, conf: 0.9 },
    stack: { value: stack, conf },
    bet: { value: bet, conf: 0.9 },
  };
}

interface StackSpec { id: string; v: number; c?: number; bet?: number; act?: SeatAction }

/** bb960/ante240（別スピード・level=0）・5席のクラブマッチ RawReads。deadPot=2.75, totalTheory=93.75。 */
function reads(stacks: StackSpec[], withLevel = true, pot = 2.75): RawReads {
  return {
    street: { value: 'preflop', conf: 0.9 },
    blinds: { sb: { value: 0.5, conf: 0.9 }, bb: { value: 1, conf: 0.9 } },
    ante: { scheme: 'all', amount: { value: 0.25, conf: 0.9 } },
    pot: { value: pot, conf: 0.9 },
    heroHand: { value: '54o', conf: 0.9 },
    seats: stacks.map((s) => seat(s.id, s.v, s.c, 'occupied', s.bet ?? 0, s.act ?? 'none')),
    displayMode: 'bb',
    ...(withLevel ? { blindChips: { sb: 480, bb: 960, ante: 240, level: 0 } } : {}),
  };
}

const FIVE = ['UTG', 'CO', 'BU', 'SB', 'BB'];

describe('chipConsistency', () => {
  it('一致（合計=91.0）はそのまま consistent', () => {
    const r = reads([
      { id: 'UTG', v: 11.5 }, { id: 'CO', v: 31.9 }, { id: 'BU', v: 22.3 },
      { id: 'SB', v: 14.4 }, { id: 'BB', v: 10.9 },
    ]);
    const { reads: out, result } = applyChipConsistency(r);
    expect(result.mode).toBe('consistent');
    expect(result.totalBbTheory).toBeCloseTo(93.75, 2);
    expect(out.seats.map((s) => s.stack.value)).toEqual([11.5, 31.9, 22.3, 14.4, 10.9]);
  });

  it('0.5低い誤読を最低信頼席で+0.5調整', () => {
    // SB を 13.9（正 14.4）・SB の conf を最低に。合計 90.5 → 理論 91.0 に 0.5 不足。
    const r = reads([
      { id: 'UTG', v: 11.5, c: 0.9 }, { id: 'CO', v: 31.9, c: 0.9 }, { id: 'BU', v: 22.3, c: 0.9 },
      { id: 'SB', v: 13.9, c: 0.3 }, { id: 'BB', v: 10.9, c: 0.9 },
    ]);
    const { reads: out, result } = applyChipConsistency(r);
    expect(result.mode).toBe('adjust');
    expect(result.correctedSeatId).toBe('SB');
    const sb = out.seats.find((s) => s.id === 'SB')!;
    expect(sb.stack.value).toBeCloseTo(14.4, 2);
    expect(sb.stack.conf).toBeLessThanOrEqual(0.5);
  });

  it('1席NaNは保存則から復元', () => {
    // BB を NaN に。他4席合計 80.1 + deadPot 2.75 = 82.85 → 復元 BB = 93.75-82.85 = 10.9。
    const r = reads([
      { id: 'UTG', v: 11.5 }, { id: 'CO', v: 31.9 }, { id: 'BU', v: 22.3 },
      { id: 'SB', v: 14.4 }, { id: 'BB', v: NaN },
    ]);
    const { reads: out, result } = applyChipConsistency(r);
    expect(result.mode).toBe('recover');
    expect(result.correctedSeatId).toBe('BB');
    const bb = out.seats.find((s) => s.id === 'BB')!;
    expect(bb.stack.value).toBeCloseTo(10.9, 2);
    expect(bb.stack.conf).toBeLessThan(0.5);
  });

  it('blindChips無し（非クラブマッチ扱い）は無効・不変', () => {
    const r = reads([{ id: 'UTG', v: 11.5 }, { id: 'BB', v: 10.9 }], false);
    const { reads: out, result } = applyChipConsistency(r);
    expect(result.mode).toBe('disabled');
    expect(result.applied).toBe(false);
    expect(out).toBe(r);
  });

  it('差が大きすぎる（モード不一致疑い）は触らない', () => {
    // 合計を大きくずらす → large-delta-skip。
    const r = reads([
      { id: 'UTG', v: 5 }, { id: 'CO', v: 5 }, { id: 'BU', v: 5 },
      { id: 'SB', v: 5, c: 0.3 }, { id: 'BB', v: 5 },
    ]);
    const { reads: out, result } = applyChipConsistency(r);
    expect(result.mode).toBe('large-delta-skip');
    expect(out.seats.map((s) => s.stack.value)).toEqual([5, 5, 5, 5, 5]);
  });

  // ---- Phase 4: オールイン ----
  // 5席・レベル9（anteBb=0.25, antePot=5×0.25=1.25）。CO オールイン bet=20, SB=0.5, BB=1.0。
  //   betSum=21.5, computedPot = 1.25+21.5 = 22.75。
  const allinFive = (pot: number, coBet = 20): RawReads =>
    reads([
      { id: 'UTG', v: 11.5 }, { id: 'CO', v: 0, c: 0.95, bet: coBet, act: 'allin' }, { id: 'BU', v: 22.3 },
      { id: 'SB', v: 14.4, bet: 0.5 }, { id: 'BB', v: 10.9, bet: 1.0 },
    ], true, pot);

  it('オールイン: 計算ポット＝OCR ポット → allin-consistent・計算値採用', () => {
    const r = allinFive(22.75);
    const { reads: out, result } = applyChipConsistency(r);
    expect(result.mode).toBe('allin-consistent');
    expect(result.applied).toBe(true);
    expect(result.potComputed).toBeCloseTo(22.75, 2);
    expect(out.pot.value).toBeCloseTo(22.75, 2); // 計算値をポットに採用
    // オールイン席スタック(0)・他スタックは触らない。
    expect(out.seats.map((s) => s.stack.value)).toEqual([11.5, 0, 22.3, 14.4, 10.9]);
  });

  it('オールイン: OCR ポット欠測 → 計算値で採用（allin-pot-computed）', () => {
    const r = allinFive(NaN);
    const { reads: out, result } = applyChipConsistency(r);
    expect(result.mode).toBe('allin-pot-computed');
    expect(out.pot.value).toBeCloseTo(22.75, 2);
  });

  it('オールイン: オールイン席のベット未読 → allin-unread-skip（不変）', () => {
    const r = allinFive(22.75, 0); // CO の bet=0（未読）
    const { reads: out, result } = applyChipConsistency(r);
    expect(result.mode).toBe('allin-unread-skip');
    expect(result.applied).toBe(false);
    expect(out).toBe(r);
  });

  it('オールイン: 計算ポット≪OCR ポット → ベット読み落とし疑いで OCR 保持', () => {
    const r = allinFive(30); // OCR が 30、計算は 22.75
    const { reads: out, result } = applyChipConsistency(r);
    expect(result.mode).toBe('allin-bet-underread');
    expect(result.applied).toBe(false);
    expect(out.pot.value).toBe(30); // OCR ポットを保持（過補正回避）
  });

  it('オールイン: 総チップ保存が成立すれば conserved フラグ true', () => {
    // stackSum を 71.0 に（+betSum21.5+antePot1.25 = 93.75 = theory）。
    const r = reads([
      { id: 'UTG', v: 11.5 }, { id: 'CO', v: 0, c: 0.95, bet: 20, act: 'allin' }, { id: 'BU', v: 22.3 },
      { id: 'SB', v: 14.4, bet: 0.5 }, { id: 'BB', v: 22.8, bet: 1.0 },
    ], true, 22.75);
    const { result } = applyChipConsistency(r);
    expect(result.conserved).toBe(true);
    expect(result.totalBbRead).toBeCloseTo(93.75, 2);
  });

  void FIVE;
});
