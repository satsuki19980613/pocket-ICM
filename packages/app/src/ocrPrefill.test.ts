import { describe, it, expect } from 'vitest';
import type { BoardState } from '@oshihiki/core';
import { runOcrPipeline, type RawReads } from '@oshihiki/ocr';
import { boardStateToForm } from './ocrPrefill';
import { buildBoardState } from './formModel';

function mkState(): BoardState {
  return {
    street: 'preflop',
    blinds: { sb: 0.5, bb: 1 },
    ante: { scheme: 'all', amount: 0.1 },
    heroHand: 'A5s',
    playersLeft: 5,
    heroPos: 'UTG',
    pot: 2,
    seats: [
      { pos: 'BU', stack: 15, bet: 0, state: 'live' },
      { pos: 'SB', stack: 14.5, bet: 0.5, state: 'live' },
      { pos: 'BB', stack: 14, bet: 1, state: 'live' },
      { pos: 'UTG', stack: 15, bet: 0, state: 'live' },
      { pos: 'CO', stack: 15, bet: 0, state: 'live' },
    ],
  };
}

describe('boardStateToForm', () => {
  it('主要項目を写す', () => {
    const form = boardStateToForm(mkState());
    expect(form.playersLeft).toBe(5);
    expect(form.sb).toBe('0.5');
    expect(form.bb).toBe('1');
    expect(form.anteScheme).toBe('all');
    expect(form.anteAmount).toBe('0.1');
    expect(form.heroPos).toBe('UTG');
    expect(form.heroHand).toBe('A5s');
    expect(form.stacks['SB']).toBe('14.5');
    expect(form.stacks['UTG']).toBe('15');
  });

  it('round-trip: state → form → buildBoardState で主要項目一致', () => {
    const state = mkState();
    const form = boardStateToForm(state);
    const built = buildBoardState(form);
    expect(built.ok).toBe(true);
    const rebuilt = built.state!;
    expect(rebuilt.playersLeft).toBe(state.playersLeft);
    expect(rebuilt.heroPos).toBe(state.heroPos);
    expect(rebuilt.heroHand).toBe(state.heroHand);
    expect(rebuilt.blinds).toEqual(state.blinds);
    expect(rebuilt.ante).toEqual(state.ante);
    for (const pos of ['BU', 'SB', 'BB', 'UTG', 'CO'] as const) {
      const a = rebuilt.seats.find((s) => s.pos === pos)!;
      const b = state.seats.find((s) => s.pos === pos)!;
      expect(a.stack).toBeCloseTo(b.stack);
      expect(a.bet).toBeCloseTo(b.bet);
    }
  });

  it('OCR パイプライン出力からフォームを埋め、条件確認を通せる（end-to-end 純ロジック）', () => {
    const reads: RawReads = {
      street: { value: 'プリフロップ', conf: 1 },
      blinds: { sb: { value: 0.5, conf: 1 }, bb: { value: 1, conf: 1 } },
      ante: { scheme: 'none', amount: { value: 0, conf: 1 } },
      pot: { value: 1.5, conf: 1 },
      heroHand: { value: 'KQs', conf: 1 },
      seats: [
        { id: 'BU', isHero: false, isButton: true, presence: { value: 'dealt', conf: 1 }, allin: { value: false, conf: 1 }, stack: { value: 15, conf: 1 }, bet: { value: 0, conf: 1 } },
        { id: 'SB', isHero: false, isButton: false, presence: { value: 'dealt', conf: 1 }, allin: { value: false, conf: 1 }, stack: { value: 14.5, conf: 1 }, bet: { value: 0.5, conf: 1 } },
        { id: 'BB', isHero: false, isButton: false, presence: { value: 'dealt', conf: 1 }, allin: { value: false, conf: 1 }, stack: { value: 14, conf: 1 }, bet: { value: 1, conf: 1 } },
        { id: 'UTG', isHero: false, isButton: false, presence: { value: 'dealt', conf: 1 }, allin: { value: false, conf: 1 }, stack: { value: 15, conf: 1 }, bet: { value: 0, conf: 1 } },
        { id: 'CO', isHero: true, isButton: false, presence: { value: 'dealt', conf: 1 }, allin: { value: false, conf: 1 }, stack: { value: 15, conf: 1 }, bet: { value: 0, conf: 1 } },
      ],
    };
    const out = runOcrPipeline(reads);
    expect(out.ok).toBe(true);
    const form = boardStateToForm(out.state!);
    expect(form.heroPos).toBe('CO');
    expect(form.heroHand).toBe('KQs');
    const built = buildBoardState(form);
    expect(built.ok).toBe(true);
  });
});
