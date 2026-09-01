import { describe, it, expect, beforeAll } from 'vitest';
import type { BoardState } from '@oshihiki/core';
import {
  solveThreeWay,
  evaluateThreeWayStrategy,
  type MultiwaySolveResult,
  type ThreeWayStrategies,
} from '../src/multiwaySolver.js';

/** 等スタック 3-way（アンティ無し）を作る。 */
function equalStacks(stack: number, sb = 0.5, bb = 1.0): BoardState {
  return {
    street: 'preflop',
    blinds: { sb, bb },
    ante: { scheme: 'none', amount: 0 },
    heroHand: 'KQo',
    playersLeft: 3,
    seats: [
      { pos: 'BU', stack, state: 'live', bet: 0 },
      { pos: 'SB', stack: stack - sb, state: 'live', bet: sb },
      { pos: 'BB', stack: stack - bb, state: 'live', bet: bb },
    ],
    heroPos: 'BU',
    pot: sb + bb,
  } as BoardState;
}

// テストは高速化のため控えめなサンプル/反復。定性的性質は余裕を持って成立する。
const FAST = { maxIters: 250, refreshEvery: 125, samples: 16000 } as const;
const TIMEOUT = 120_000;
const sum = (a: readonly number[]): number => a.reduce((x, y) => x + y, 0);
const keyMap = (r: MultiwaySolveResult) => Object.fromEntries(r.nodes.map((n) => [n.key, n]));

describe('solveThreeWay — 構造 / ICM 保存', () => {
  let res: MultiwaySolveResult;
  beforeAll(() => {
    res = solveThreeWay(equalStacks(10), FAST);
  }, TIMEOUT);

  it('6つの決定ノードを正規キー・アクタ・アクション種別で返す', () => {
    expect(res.nodes).toHaveLength(6);
    const byKey = keyMap(res);
    expect(byKey['BU:-,SB:-,BB:-']!.actor).toBe('BU');
    expect(byKey['BU:-,SB:-,BB:-']!.actionType).toBe('PU');
    expect(byKey['BU:P,SB:-,BB:-']!.actor).toBe('SB');
    expect(byKey['BU:P,SB:-,BB:-']!.actionType).toBe('CA');
    expect(byKey['BU:P,SB:F,BB:-']!.actionType).toBe('CA');
    expect(byKey['BU:P,SB:C,BB:-']!.actionType).toBe('OC');
    expect(byKey['BU:F,SB:-,BB:-']!.actionType).toBe('PU');
    expect(byKey['BU:F,SB:P,BB:-']!.actionType).toBe('CA');
  });

  it('各ノードは freq/ev を全169クラス持ち、hands は freq>=0.5', () => {
    for (const n of res.nodes) {
      expect(Object.keys(n.freq)).toHaveLength(169);
      expect(Object.keys(n.ev)).toHaveLength(169);
      expect(n.hands.every((h) => n.freq[h]! >= 0.5)).toBe(true);
    }
  });

  it('ICM 保存: EQPre 総和 = EQPost 総和 = payout 総和(10)', () => {
    const pre = ['BU', 'SB', 'BB'].map((p) => res.equity[p]!.pre);
    const post = ['BU', 'SB', 'BB'].map((p) => res.equity[p]!.post);
    expect(sum(pre)).toBeCloseTo(10, 6);
    expect(sum(post)).toBeCloseTo(10, 6);
  });
});

describe('solveThreeWay — 定性的性質', () => {
  it(
    'オーバーコールはコールより狭い（BB: OC < CA vs 単一 push）',
    () => {
      const res = solveThreeWay(equalStacks(10), FAST);
      const byKey = keyMap(res);
      expect(byKey['BU:P,SB:C,BB:-']!.pct).toBeLessThan(byKey['BU:P,SB:F,BB:-']!.pct);
    },
    TIMEOUT,
  );

  it(
    'スタックが浅いほど BU push は広い（単調）',
    () => {
      const shallow = solveThreeWay(equalStacks(6), FAST);
      const deep = solveThreeWay(equalStacks(15), FAST);
      const puShallow = shallow.nodes.find((n) => n.actor === 'BU')!.pct;
      const puDeep = deep.nodes.find((n) => n.actor === 'BU')!.pct;
      expect(puShallow).toBeGreaterThan(puDeep);
    },
    TIMEOUT,
  );
});

describe('solveThreeWay — scale invariance', () => {
  it(
    '10/10/10 (0.5/1) と 20/20/20 (1/2) の各ノード push/call 集合が一致',
    () => {
      const a = solveThreeWay(equalStacks(10, 0.5, 1.0), FAST);
      const b = solveThreeWay(equalStacks(20, 1.0, 2.0), FAST);
      for (let i = 0; i < a.nodes.length; i++) {
        expect(b.nodes[i]!.hands).toEqual(a.nodes[i]!.hands);
      }
    },
    TIMEOUT,
  );
});

describe('solveThreeWay — 決定性', () => {
  it(
    '同一入力・同一シードで戦略が完全一致',
    () => {
      const a = solveThreeWay(equalStacks(10), FAST);
      const b = solveThreeWay(equalStacks(10), FAST);
      expect(Array.from(b.strategies.pushA)).toEqual(Array.from(a.strategies.pushA));
      expect(Array.from(b.strategies.ocF)).toEqual(Array.from(a.strategies.ocF));
    },
    TIMEOUT,
  );
});

describe('exploitability 自己検証（1-7）', () => {
  it(
    '均衡はプール比で小さく、故意に崩すと有意に増える',
    () => {
      const state = equalStacks(10);
      const res = solveThreeWay(state, FAST);
      expect(res.exploitabilityPt).toBeLessThan(0.05);

      const ones = () => new Float64Array(169).fill(1);
      const allIn: ThreeWayStrategies = {
        pushA: ones(), callB: ones(), callC: ones(), pushD: ones(), callE: ones(), ocF: ones(),
      };
      const brokenIn = evaluateThreeWayStrategy(state, allIn, { samples: 16000 });
      expect(brokenIn.exploitabilityPt).toBeGreaterThan(0.2);
      expect(brokenIn.exploitabilityPt).toBeGreaterThan(res.exploitabilityPt * 5);

      const zeros = () => new Float64Array(169).fill(0);
      const allFold: ThreeWayStrategies = {
        pushA: zeros(), callB: zeros(), callC: zeros(), pushD: zeros(), callE: zeros(), ocF: zeros(),
      };
      const brokenFold = evaluateThreeWayStrategy(state, allFold, { samples: 16000 });
      expect(brokenFold.exploitabilityPt).toBeGreaterThan(0.1);
    },
    TIMEOUT,
  );
});

describe('solveThreeWay — 入力検証', () => {
  it('playersLeft!=3 は例外', () => {
    const hu = { ...equalStacks(10), playersLeft: 2 } as BoardState;
    expect(() => solveThreeWay(hu)).toThrow();
  });
});
