import { describe, it, expect } from 'vitest';
import type { BoardState } from '@oshihiki/core';
import type { SolveNodeDto, SolveResultDto } from '../solverProtocol';
import { judge, makeAttempt, summarize, MIX_EPS, type DrillAttempt, type SolvedSpot } from './model';

function node(over: Partial<SolveNodeDto>): SolveNodeDto {
  return { key: 'root', actor: 'BU', actionType: 'PU', pct: 20, range: '', hands: [], heroFreq: 0, heroEv: 0, ...over };
}
function result(over: Partial<SolveResultDto>): SolveResultDto {
  return {
    playersLeft: 3,
    heroPos: 'BU',
    heroHand: 'A5s',
    iterations: 400,
    exploitabilityPt: 0.001,
    converged: true,
    equity: {},
    nodes: [],
    ...over,
  };
}
const state = { heroPos: 'BU' } as unknown as BoardState;
const spot = (r: SolveResultDto): SolvedSpot => ({ state, result: r, ms: 100 });

describe('judge', () => {
  const push = result({ nodes: [node({ actor: 'BU', actionType: 'PU', key: 'root', heroFreq: 0.9, heroEv: 0.5 })] });

  it('推奨=PUSH をPUSHで正解・EV loss 0', () => {
    const j = judge(push, 'PUSH');
    expect(j).toMatchObject({ verdict: 'PUSH', correct: true, hasDecision: true });
    expect(j.evLoss).toBe(0);
  });
  it('推奨=PUSH をFOLDで不正解・EV loss=heroEv', () => {
    const j = judge(push, 'FOLD');
    expect(j.correct).toBe(false);
    expect(j.evLoss).toBeCloseTo(0.5);
  });
  it('混合境界（|heroEv|≤MIX_EPS）はどちらでも正解', () => {
    const mix = result({ nodes: [node({ actor: 'BU', actionType: 'PU', key: 'root', heroFreq: 0.5, heroEv: MIX_EPS / 2 })] });
    expect(judge(mix, 'PUSH').correct).toBe(true);
    expect(judge(mix, 'FOLD').correct).toBe(true);
  });
  it('hero 決定ノードが無ければ hasDecision=false・correct（出題不成立の保険）', () => {
    const j = judge(result({ nodes: [node({ actor: 'SB' })] }), 'FOLD');
    expect(j.hasDecision).toBe(false);
    expect(j.correct).toBe(true);
  });
});

describe('makeAttempt', () => {
  const r = result({ heroHand: 'KQo', heroPos: 'CO', playersLeft: 4, nodes: [node({ actor: 'CO', actionType: 'PU', key: 'root', heroFreq: 0.8, heroEv: 0.6 })] });
  it('出題＋実行動から 1 手を作る（非正規化＋スナップショット）', () => {
    const a = makeAttempt(spot(r), 'FOLD', 'x');
    expect(a).toMatchObject({ id: 'x', heroHand: 'KQo', heroPos: 'CO', playersLeft: 4, action: 'FOLD', verdict: 'PUSH', correct: false });
    expect(a.evLoss).toBeCloseTo(0.6);
    expect(a.result).toBe(r);
    expect(a.state).toBe(state);
  });
});

describe('summarize', () => {
  it('正答率・EV loss 合計・外した場面（降順）を返す', () => {
    const atts = [
      { correct: true, evLoss: 0 },
      { correct: false, evLoss: 0.2 },
      { correct: false, evLoss: 0.5 },
    ] as DrillAttempt[];
    const s = summarize(atts);
    expect(s.hands).toBe(3);
    expect(s.correct).toBe(1);
    expect(s.accuracy).toBeCloseTo(1 / 3);
    expect(s.totalEvLoss).toBeCloseTo(0.7);
    expect(s.misses.map((m) => m.evLoss)).toEqual([0.5, 0.2]);
  });
  it('空セッションで accuracy=0', () => {
    expect(summarize([])).toEqual({ hands: 0, correct: 0, accuracy: 0, totalEvLoss: 0, misses: [] });
  });
});
