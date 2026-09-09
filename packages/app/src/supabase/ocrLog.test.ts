import { describe, it, expect } from 'vitest';
import type { BoardState } from '@oshihiki/core';
import { diffStates } from './ocrLog';

function state(over: Partial<BoardState> = {}): BoardState {
  return {
    street: 'preflop',
    blinds: { sb: 0.5, bb: 1 },
    ante: { scheme: 'none', amount: 0 },
    heroHand: 'AKs',
    playersLeft: 3,
    heroPos: 'BU',
    seats: [
      { pos: 'BU', stack: 20, state: 'live', bet: 0 },
      { pos: 'SB', stack: 19.5, state: 'live', bet: 0.5 },
      { pos: 'BB', stack: 19, state: 'live', bet: 1 },
    ],
    pot: 1.5,
    ...over,
  } as BoardState;
}

describe('diffStates', () => {
  it('完全一致なら全フィールド空（seats も空配列）', () => {
    const a = state();
    const b = state();
    expect(diffStates(a, b)).toEqual({ seats: [] });
  });

  it('スタックの修正を席ごとに拾う', () => {
    const a = state();
    const b = state({ seats: [
      { pos: 'BU', stack: 22, state: 'live', bet: 0 },
      { pos: 'SB', stack: 19.5, state: 'live', bet: 0.5 },
      { pos: 'BB', stack: 19, state: 'live', bet: 1 },
    ] });
    const diff = diffStates(a, b);
    expect(diff.seats).toEqual([{ pos: 'BU', field: 'stack', from: 20, to: 22 }]);
  });

  it('ベットの修正を拾う（ベットが増えれば通常スタックも減るので両方拾う）', () => {
    const a = state();
    const b = state({ seats: [
      { pos: 'BU', stack: 20, state: 'live', bet: 0 },
      { pos: 'SB', stack: 19.5, state: 'live', bet: 0.5 },
      { pos: 'BB', stack: 18, state: 'live', bet: 2 },
    ] });
    const diff = diffStates(a, b);
    expect(diff.seats).toEqual(
      expect.arrayContaining([
        { pos: 'BB', field: 'bet', from: 1, to: 2 },
        { pos: 'BB', field: 'stack', from: 19, to: 18 },
      ]),
    );
    expect(diff.seats).toHaveLength(2);
  });

  it('席の状態（在席/フォールド等）の修正を拾う', () => {
    const a = state();
    const b = state({ seats: [
      { pos: 'BU', stack: 20, state: 'fold', bet: 0 },
      { pos: 'SB', stack: 19.5, state: 'live', bet: 0.5 },
      { pos: 'BB', stack: 19, state: 'live', bet: 1 },
    ] });
    const diff = diffStates(a, b);
    expect(diff.seats).toEqual([{ pos: 'BU', field: 'state', from: 'live', to: 'fold' }]);
  });

  it('人数（席の増減=occupancy）の修正を拾う（新設席は state に加えスタックも0→実値で拾う）', () => {
    const a = state();
    const b = state({
      playersLeft: 4,
      seats: [
        ...a.seats,
        { pos: 'UTG', stack: 18, state: 'live', bet: 0 },
      ],
    });
    const diff = diffStates(a, b);
    expect(diff.playersLeft).toEqual({ from: 3, to: 4 });
    expect(diff.seats).toEqual(
      expect.arrayContaining([
        { pos: 'UTG', field: 'state', from: 'empty', to: 'live' },
        { pos: 'UTG', field: 'stack', from: 0, to: 18 },
      ]),
    );
    expect(diff.seats).toHaveLength(2);
  });

  it('hero ポジション・ハンドの修正を拾う', () => {
    const a = state();
    const b = state({ heroPos: 'SB', heroHand: 'AKo' });
    const diff = diffStates(a, b);
    expect(diff.heroPos).toEqual({ from: 'BU', to: 'SB' });
    expect(diff.heroHand).toEqual({ from: 'AKs', to: 'AKo' });
  });

  it('ブラインド・アンティの修正を拾う', () => {
    const a = state();
    const b = state({ blinds: { sb: 1, bb: 2 }, ante: { scheme: 'bb', amount: 2 } });
    const diff = diffStates(a, b);
    expect(diff.blinds).toEqual({ sb: { from: 0.5, to: 1 }, bb: { from: 1, to: 2 } });
    expect(diff.ante).toEqual({ scheme: { from: 'none', to: 'bb' }, amount: { from: 0, to: 2 } });
  });

  it('複数種の差分を同時に取りこぼさない', () => {
    const a = state();
    const b = state({
      heroHand: 'QQ',
      blinds: { sb: 0.5, bb: 1 },
      seats: [
        { pos: 'BU', stack: 21, state: 'live', bet: 0 },
        { pos: 'SB', stack: 19.5, state: 'fold', bet: 0.5 },
        { pos: 'BB', stack: 19, state: 'live', bet: 1 },
      ],
    });
    const diff = diffStates(a, b);
    expect(diff.heroHand).toEqual({ from: 'AKs', to: 'QQ' });
    expect(diff.seats).toEqual(
      expect.arrayContaining([
        { pos: 'BU', field: 'stack', from: 20, to: 21 },
        { pos: 'SB', field: 'state', from: 'live', to: 'fold' },
      ]),
    );
    expect(diff.seats).toHaveLength(2);
  });
});
