import { describe, it, expect } from 'vitest';
import type { BoardState, Position } from '@oshihiki/core';
import { positionsForPlayersLeft, isCanonicalKey } from '@oshihiki/core';
import { solveMultiway, evaluateMultiwayStrategy, type McRunner } from '../src/nwaySolver.js';
import { solveThreeWay } from '../src/multiwaySolver.js';
import { computeShowdownMc } from '../src/showdownJob.js';
import { computeShowdown3Exact, computeShowdown3ExactDenseChunk } from '../src/showdownExact.js';
import { winTie3ArtifactExists, loadWinTie3Table } from '../src/wintie3Loader.js';

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
  // 相互検証は card-blind 経路（solveThreeWay と同じ近似）で行う。カードリムーバル補正は
  // nwaySolver 側のみに入るため、cardRemoval:false で共通の card-blind 配線を突き合わせる。
  const CFG = { maxIters: 200, refreshEvery: 100, samples: 16000, seed: 12345, cardRemoval: false } as const;

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
      // 注: レンジ表示は単調性補正（monotonizePush）でブロック粒度になるため、無差別帯の
      // ブロックが2実装で丸ごと押し/降りに転ぶと % は跳ねやすい（EV は一致＝下の EQ テストで担保）。
      // よって表示 % の許容はやや広く取る。厳密な戦略一致は strategies（生 FP 平均）で別途担保。
      for (const key of Object.keys(genByKey)) {
        const a = genByKey[key]!.pct;
        const b = threeByKey[key]!.pct;
        expect(Math.abs(a - b)).toBeLessThan(13);
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

describe('solveMultiway — cardRemoval:true 経路（M5, opt-in）', () => {
  it(
    '決定的で、ICM 保存を満たし、card-blind と（一般に）異なる戦略を返す',
    async () => {
      const state = equalStacks(4, 10);
      const CFG = { maxIters: 60, refreshEvery: 30, samples: 8000, seed: 3 } as const;
      const cr1 = await solveMultiway(state, { ...CFG, cardRemoval: true });
      const cr2 = await solveMultiway(state, { ...CFG, cardRemoval: true });
      // 決定性
      for (const [key, arr] of cr1.strategies) {
        expect(Array.from(cr2.strategies.get(key)!)).toEqual(Array.from(arr));
      }
      // ICM 保存（EQPre 総和 = EQPost 総和 = pool）
      const order = positionsForPlayersLeft(4);
      const pre = order.map((p) => cr1.equity[p]!.pre);
      const post = order.map((p) => cr1.equity[p]!.post);
      expect(sum(pre)).toBeCloseTo(poolOf(4), 5);
      expect(sum(post)).toBeCloseTo(poolOf(4), 5);
      // card-blind と少なくとも 1 ノードで戦略が異なる（補正が実際に効いている）。
      const blind = await solveMultiway(state, { ...CFG, cardRemoval: false });
      let differs = false;
      for (const [key, arr] of cr1.strategies) {
        const b = blind.strategies.get(key)!;
        for (let c = 0; c < arr.length; c++) if (Math.abs(arr[c]! - b[c]!) > 1e-6) { differs = true; break; }
        if (differs) break;
      }
      expect(differs).toBe(true);
    },
    TIMEOUT,
  );
});

describe('solveMultiway — mcRunner 注入（3-1x, ブラウザ並列の契約）', () => {
  it(
    '同一シードの mcRunner 注入は内蔵単一スレッド経路と bit 一致',
    async () => {
      const state = equalStacks(4, 10);
      const CFG = { maxIters: 40, refreshEvery: 20, samples: 6000, seed: 5 } as const;
      // 注入ランナーは各ジョブを同じ computeShowdownMc に同じ seed で流すだけ（順序保存）。
      const runner: McRunner = async (jobs) =>
        jobs.map((j) => computeShowdownMc(j.node, j.ranges, j.samples, j.seed));
      const base = await solveMultiway(state, CFG);
      const injected = await solveMultiway(state, { ...CFG, mcRunner: runner });
      expect([...injected.strategies.keys()].sort()).toEqual([...base.strategies.keys()].sort());
      for (const [key, arr] of base.strategies) {
        expect(Array.from(injected.strategies.get(key)!)).toEqual(Array.from(arr));
      }
      expect(injected.exploitabilityPt).toBe(base.exploitabilityPt);
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

describe('solveMultiway — exact3（3人ショーダウン厳密計算）の並列ディスパッチ（item 2, 実テーブル）', () => {
  const artifactOk = winTie3ArtifactExists();
  const itIf = artifactOk ? it : it.skip;

  itIf(
    'mcRunner 注入時、exact3:true ジョブを含めて内蔵単一スレッド経路と bit 一致',
    async () => {
      const winTie3 = loadWinTie3Table();
      const state = equalStacks(4, 10);
      const CFG = { maxIters: 30, refreshEvery: 15, samples: 4000, seed: 9, winTie3 } as const;
      // 注入ランナーは exact3:true のジョブを computeShowdown3Exact に、それ以外を
      // computeShowdownMc に振り分けるだけ（順序保存）。並列プール実装のミニマム契約。
      const runner: McRunner = async (jobs) =>
        jobs.map((j) =>
          j.exact3 ? computeShowdown3Exact(j.node, j.ranges, winTie3) : computeShowdownMc(j.node, j.ranges, j.samples, j.seed, j.strat),
        );
      const base = await solveMultiway(state, CFG);
      const injected = await solveMultiway(state, { ...CFG, mcRunner: runner });
      expect([...injected.strategies.keys()].sort()).toEqual([...base.strategies.keys()].sort());
      for (const [key, arr] of base.strategies) {
        expect(Array.from(injected.strategies.get(key)!)).toEqual(Array.from(arr));
      }
      expect(injected.exploitabilityPt).toBe(base.exploitabilityPt);
    },
    TIMEOUT,
  );

  itIf(
    '実 worker_threads プール（workers:2）は単一スレッド経路と一致する（exact3 は決定的なので bit 一致）',
    async () => {
      const winTie3 = loadWinTie3Table();
      const state = equalStacks(4, 10);
      const CFG = { maxIters: 30, refreshEvery: 15, samples: 4000, seed: 9, winTie3 } as const;
      const base = await solveMultiway(state, CFG);
      const parallel = await solveMultiway(state, { ...CFG, workers: 2 });
      expect([...parallel.strategies.keys()].sort()).toEqual([...base.strategies.keys()].sort());
      for (const [key, arr] of base.strategies) {
        expect(Array.from(parallel.strategies.get(key)!)).toEqual(Array.from(arr));
      }
      expect(parallel.exploitabilityPt).toBe(base.exploitabilityPt);
    },
    TIMEOUT,
  );
});

describe('solveMultiway — mcRunner の exact3 dense チャンク分割（mcRunnerParallelism, ブラウザ経路の速度構造）', () => {
  const artifactOk = winTie3ArtifactExists();
  const itIf = artifactOk ? it : it.skip;

  itIf(
    'mcRunnerParallelism>1 で exact3Chunk ジョブに分割しても workers:0 と一致（5-player, 実テーブル）',
    async () => {
      const winTie3 = loadWinTie3Table();
      const state = equalStacks(5, 10);
      const CFG = { maxIters: 20, refreshEvery: 10, samples: 4000, seed: 9, winTie3 } as const;
      // 注入ランナーは exact3Chunk ジョブ（dense 判定された集合の 'a' 範囲部分和）を
      // computeShowdown3ExactDenseChunk に、exact3:true の全体ジョブを computeShowdown3Exact に、
      // それ以外を computeShowdownMc に振り分ける（nwaySolver.refresh が merge を担当するため、
      // ランナー側は chunk をそのまま返すだけでよい）。
      const runner: McRunner = async (jobs) =>
        jobs.map((j) => {
          if (j.exact3Chunk) {
            return computeShowdown3ExactDenseChunk(j.node, j.ranges, winTie3, j.exact3Chunk.lo, j.exact3Chunk.hi);
          }
          return j.exact3
            ? computeShowdown3Exact(j.node, j.ranges, winTie3)
            : computeShowdownMc(j.node, j.ranges, j.samples, j.seed, j.strat);
        });
      const base = await solveMultiway(state, CFG);
      const injected = await solveMultiway(state, { ...CFG, mcRunner: runner, mcRunnerParallelism: 4 });
      expect([...injected.strategies.keys()].sort()).toEqual([...base.strategies.keys()].sort());
      for (const [key, arr] of base.strategies) {
        expect(Array.from(injected.strategies.get(key)!)).toEqual(Array.from(arr));
      }
      expect(injected.exploitabilityPt).toBe(base.exploitabilityPt);
    },
    TIMEOUT,
  );
});

describe('solveMultiway — refreshSchedule（item 3）', () => {
  it(
    "既定 'fixed' は refreshSchedule を明示しない場合と同一結果（後方互換）",
    async () => {
      const state = equalStacks(4, 10);
      const CFG = { maxIters: 60, refreshEvery: 20, samples: 4000, seed: 3 } as const;
      const a = await solveMultiway(state, CFG);
      const b = await solveMultiway(state, { ...CFG, refreshSchedule: 'fixed' });
      expect(a.iterations).toBe(b.iterations);
      expect(a.exploitabilityPt).toBe(b.exploitabilityPt);
      for (const [key, arr] of a.strategies) {
        expect(Array.from(b.strategies.get(key)!)).toEqual(Array.from(arr));
      }
    },
    TIMEOUT,
  );

  it(
    "'geometric' は最大反復まで正常に完走し、有限の exploitability を返す",
    async () => {
      const state = equalStacks(4, 10);
      const res = await solveMultiway(state, { maxIters: 60, refreshEvery: 10, samples: 3000, seed: 11, refreshSchedule: 'geometric' });
      expect(res.iterations).toBeGreaterThan(0);
      expect(Number.isFinite(res.exploitabilityPt)).toBe(true);
      expect(res.exploitabilityPt).toBeGreaterThanOrEqual(0);
    },
    TIMEOUT,
  );
});
