import { describe, it, expect } from 'vitest';
import type { BoardState, Position } from '@oshihiki/core';
import { positionsForPlayersLeft, isCanonicalKey } from '@oshihiki/core';
import { solveMultiway, evaluateMultiwayStrategy } from '../src/nwaySolver.js';
import { solveThreeWay } from '../src/multiwaySolver.js';

/** 等スタック N-way（アンティ無し）を作る。 */
function equalStacks(n: number, stack: number, sb = 0.5, bb = 1.0): BoardState {
  const order = positionsForPlayersLeft(n);
  const seats = order.map((pos) => {
    const bet = pos === 'SB' ? sb : pos === 'BB' ? bb : 0;
    return { pos, stack: stack - bet, state: 'live' as const, bet };
  });
  return {
    street: 'preflop',
    blinds: { sb, bb },
    ante: { scheme: 'none', amount: 0 },
    heroHand: 'KQo',
    playersLeft: n,
    seats,
    heroPos: order[0]!,
    pot: sb + bb,
  } as BoardState;
}

const TIMEOUT = 180_000;
const sum = (a: readonly number[]): number => a.reduce((x, y) => x + y, 0);
const poolOf = (n: number): number => [0, 0, 8, 10, 11, 11, 10][n]!;

// 構造だけ見たいテストは最小コスト。
const TINY = { maxIters: 2, refreshEvery: 2, samples: 1500 } as const;

describe('solveMultiway — ゲーム木の構造（ノード数・キー・アクション種別）', () => {
  for (const [n, expectedCount] of [
    [3, 6],
    [4, 14],
    [5, 30],
    [6, 62],
  ] as const) {
    it(
      `${n}-way は 2^N-2=${expectedCount} 決定ノードを正規キーで返す`,
      async () => {
        const res = await solveMultiway(equalStacks(n, 10), TINY);
        expect(res.nodes).toHaveLength(expectedCount);
        // 全キーが正規形
        for (const nd of res.nodes) expect(isCanonicalKey(nd.key)).toBe(true);
        // キーは一意
        const keys = res.nodes.map((x) => x.key);
        expect(new Set(keys).size).toBe(expectedCount);
        // 先頭アクタ（未開 PU）が存在
        const order = positionsForPlayersLeft(n);
        const openKey = order.map((p) => `${p}:-`).join(',');
        const open = res.nodes.find((x) => x.key === openKey)!;
        expect(open.actor).toBe(order[0]);
        expect(open.actionType).toBe('PU');
        // アクション種別の整合: PU⟺前方に P/C 無し, CA⟺前方 1 つ, OC⟺前方 2+
        for (const nd of res.nodes) {
          const before = nd.key.split(',').slice(0, order.indexOf(nd.actor));
          const aggr = before.filter((seg) => seg.endsWith(':P') || seg.endsWith(':C')).length;
          const expType = aggr === 0 ? 'PU' : aggr === 1 ? 'CA' : 'OC';
          expect(nd.actionType).toBe(expType);
        }
        // freq/ev は全 169 クラス
        for (const nd of res.nodes) {
          expect(Object.keys(nd.freq)).toHaveLength(169);
          expect(Object.keys(nd.ev)).toHaveLength(169);
        }
      },
      TIMEOUT,
    );
  }
});

describe('solveMultiway — 相互検証: N=3 は独立実装 solveThreeWay と一致', () => {
  const CFG = { maxIters: 200, refreshEvery: 100, samples: 16000, seed: 12345 } as const;

  it(
    '6ノードのキー集合が一致し、push/call レンジ幅がプレイ範囲で近い',
    async () => {
      const state = equalStacks(3, 10);
      const gen = await solveMultiway(state, CFG);
      const three = solveThreeWay(state, CFG);

      const genByKey = Object.fromEntries(gen.nodes.map((x) => [x.key, x]));
      const threeByKey = Object.fromEntries(three.nodes.map((x) => [x.key, x]));
      expect(Object.keys(genByKey).sort()).toEqual(Object.keys(threeByKey).sort());

      // 各ノードの push/call 頻度 %（コンボ加重）が近い（独立 MC のノイズ許容）。
      for (const key of Object.keys(genByKey)) {
        const a = genByKey[key]!.pct;
        const b = threeByKey[key]!.pct;
        expect(Math.abs(a - b)).toBeLessThan(6);
      }
    },
    TIMEOUT,
  );

  it(
    'EQPre / EQPost が solveThreeWay と一致（絶対誤差 < 0.05pt）',
    async () => {
      const state = equalStacks(3, 12);
      const gen = await solveMultiway(state, CFG);
      const three = solveThreeWay(state, CFG);
      for (const p of ['BU', 'SB', 'BB'] as Position[]) {
        expect(Math.abs(gen.equity[p]!.pre - three.equity[p]!.pre)).toBeLessThan(0.05);
        expect(Math.abs(gen.equity[p]!.post - three.equity[p]!.post)).toBeLessThan(0.05);
      }
    },
    TIMEOUT,
  );
});

describe('solveMultiway — ICM 保存（EQPre 総和 = EQPost 総和 = payout 総和）', () => {
  for (const n of [4, 5, 6] as const) {
    it(
      `${n}-way: 総和が ${poolOf(n)}`,
      async () => {
        const res = await solveMultiway(equalStacks(n, 10), TINY);
        const order = positionsForPlayersLeft(n);
        const pre = order.map((p) => res.equity[p]!.pre);
        const post = order.map((p) => res.equity[p]!.post);
        expect(sum(pre)).toBeCloseTo(poolOf(n), 5);
        expect(sum(post)).toBeCloseTo(poolOf(n), 5);
      },
      TIMEOUT,
    );
  }
});

describe('solveMultiway — scale invariance（4-way, ×2 は power-of-two で bit 一致）', () => {
  it(
    '10 (0.5/1) と 20 (1/2) の各ノード push/call 集合が完全一致',
    async () => {
      const a = await solveMultiway(equalStacks(4, 10, 0.5, 1.0), { ...TINY, samples: 8000 });
      const b = await solveMultiway(equalStacks(4, 20, 1.0, 2.0), { ...TINY, samples: 8000 });
      const aByKey = Object.fromEntries(a.nodes.map((x) => [x.key, x.hands]));
      const bByKey = Object.fromEntries(b.nodes.map((x) => [x.key, x.hands]));
      for (const key of Object.keys(aByKey)) expect(bByKey[key]).toEqual(aByKey[key]);
    },
    TIMEOUT,
  );
});

describe('solveMultiway — 決定性', () => {
  it(
    '同一入力・同一シードで戦略が完全一致（4-way）',
    async () => {
      const a = await solveMultiway(equalStacks(4, 10), { ...TINY, samples: 6000, seed: 7 });
      const b = await solveMultiway(equalStacks(4, 10), { ...TINY, samples: 6000, seed: 7 });
      for (const [key, arr] of a.strategies) {
        expect(Array.from(b.strategies.get(key)!)).toEqual(Array.from(arr));
      }
    },
    TIMEOUT,
  );
});

describe('solveMultiway — 定性: 浅いほど先手 push は広い（4-way CO）', () => {
  it(
    'CO(未開) push %: stack 6 > stack 16',
    async () => {
      const CFG = { maxIters: 150, refreshEvery: 75, samples: 12000 } as const;
      const shallow = await solveMultiway(equalStacks(4, 6), CFG);
      const deep = await solveMultiway(equalStacks(4, 16), CFG);
      const co = (r: Awaited<ReturnType<typeof solveMultiway>>) =>
        r.nodes.find((x) => x.actor === 'CO' && x.actionType === 'PU')!.pct;
      expect(co(shallow)).toBeGreaterThan(co(deep));
    },
    TIMEOUT,
  );
});

describe('exploitability 自己検証（1-7 / 4-way）', () => {
  it(
    '均衡はプール比で小さく、全 all-in / 全 fold は有意に大きい',
    async () => {
      const state = equalStacks(4, 10);
      const CFG = { maxIters: 200, refreshEvery: 100, samples: 12000 } as const;
      const res = await solveMultiway(state, CFG);
      expect(res.exploitabilityPt).toBeLessThan(0.1);

      const ones = () => new Float64Array(169).fill(1);
      const allIn = await evaluateMultiwayStrategy(state, () => ones(), { samples: 12000 });
      expect(allIn.exploitabilityPt).toBeGreaterThan(res.exploitabilityPt * 3);
      expect(allIn.exploitabilityPt).toBeGreaterThan(0.15);

      const zeros = () => new Float64Array(169).fill(0);
      const allFold = await evaluateMultiwayStrategy(state, () => zeros(), { samples: 12000 });
      expect(allFold.exploitabilityPt).toBeGreaterThan(0.1);
    },
    TIMEOUT,
  );
});

describe('solveMultiway — 実 HRC 5-way 照合（EQPre / IMPLEMENTATION_PLAN §4.2）', () => {
  // packages/harness/cases/_reference-hrc-5way-blinds05-1-025.json のセットアップ。
  // UTG/CO/BU/SB/BB = 10/20/30/23/12bb, blinds 0.5/1, ante all 0.25。
  // HRC はシフト形 payout [6,4,3,2,1]/プール16。自作は実払い [5,3,2,1,0]。
  // 全 payout の +1 シフトは各席 equity を +1 する → pct = (real+1)/16*100。
  function hrc5wayState(): BoardState {
    const stacks: Record<string, number> = { UTG: 10, CO: 20, BU: 30, SB: 23, BB: 12 };
    const order = positionsForPlayersLeft(5);
    const seats = order.map((pos) => {
      const bet = pos === 'SB' ? 0.5 : pos === 'BB' ? 1.0 : 0;
      return { pos, stack: stacks[pos]! - bet - 0.25, state: 'live' as const, bet };
    });
    return {
      street: 'preflop',
      blinds: { sb: 0.5, bb: 1.0 },
      ante: { scheme: 'all', amount: 0.25 },
      heroHand: 'KQo',
      playersLeft: 5,
      seats,
      heroPos: 'UTG',
      pot: 0.5 + 1.0 + 0.25 * 5,
    } as BoardState;
  }

  it(
    'EQPre がシフト換算で HRC 値と一致（|差| < 0.02pt-%）',
    async () => {
      // EQPre は純 ICM で収束に依存しないため最小コストで良い。
      const res = await solveMultiway(hrc5wayState(), { ...TINY, samples: 1000 });
      const hrc: Record<string, number> = { UTG: 15.29, CO: 21.05, BU: 24.66, SB: 22.28, BB: 16.72 };
      for (const [pos, expPct] of Object.entries(hrc)) {
        const mine = ((res.equity[pos]!.pre + 1) / 16) * 100;
        expect(Math.abs(mine - expPct)).toBeLessThan(0.02);
      }
    },
    TIMEOUT,
  );
});

describe('solveMultiway — 入力検証', () => {
  it('playersLeft<3 / >6 は例外', async () => {
    await expect(solveMultiway({ ...equalStacks(3, 10), playersLeft: 2 } as BoardState)).rejects.toThrow();
    await expect(solveMultiway({ ...equalStacks(6, 10), playersLeft: 7 } as BoardState)).rejects.toThrow();
  });
});
