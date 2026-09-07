import { describe, it, expect } from 'vitest';
import type { BoardState } from '@oshihiki/core';
import { positionsForPlayersLeft } from '@oshihiki/core';
import {
  OutcomeCache,
  estimateNodeEquities,
  estimateHeroStratified,
  type ShowdownNode,
} from '../src/showdownMc.js';
import { computeShowdownMc, type StratSpec } from '../src/showdownJob.js';
import { rankClassesByEquityVs } from '../src/showdownExact.js';
import { loadHuWinTieTable } from '../src/huWinTieLoader.js';
import { HAND_CLASS_ORDER, HAND_CLASS_INDEX } from '../src/huEquity.js';
import { DeterministicRng } from '../src/placement.js';
import { icmEquities, payoutsForPlayers } from '../src/icm.js';
import { finalStacksFromShowdown } from '../src/sidepot.js';
import { solveMultiway } from '../src/nwaySolver.js';

const TIMEOUT = 60_000;

/** 等スタック N-way（アンティ無し）を作る（nwaySolver.test.ts と同じパターン）。 */
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

describe('OutcomeCache — icmOf は distributePots+icmEquities の直接計算と一致し、結果をキャッシュする', () => {
  it('4席・3参加者ノードで一致 + 同一シグネチャは同一配列（キャッシュ命中）', () => {
    // 4席のうち席3はショーダウン非参加（フォールド, デッドマネー1）。
    const node: ShowdownNode = {
      preHandStacks: [20, 20, 20, 20],
      commits: [20, 20, 20, 1],
      participants: [0, 1, 2],
      payouts: payoutsForPlayers(4),
    };
    const cache = new OutcomeCache(node);
    // scParts = 参加者順の strongerCount（0=最強）。
    const scParts = [0, 1, 2];

    const v1 = cache.icmOf(scParts);
    const v2 = cache.icmOf(scParts);
    expect(v2).toBe(v1); // 同一配列参照（キャッシュ命中）

    // 直接計算（cache 内部と同じ関数を手で組み立てる）。
    const eligible = [true, true, true, false];
    const strongerCount = [0, 1, 2, 0];
    const finalStacks = finalStacksFromShowdown(node.preHandStacks, node.commits, eligible, strongerCount);
    const expected = icmEquities(finalStacks, node.payouts);
    expect(v1).toEqual(expected);
  });
});

describe('rankClassesByEquityVs — winTie 表に基づく HU equity 降順ランキング', () => {
  const table = loadHuWinTieTable();

  it('opp=フルレンジ: 先頭は AA, KK/QQ は上位3以内, 72o は下位10以内', () => {
    const full = new Float64Array(169).fill(1);
    const rank = rankClassesByEquityVs(full, table);
    expect(rank.length).toBe(169);
    expect(HAND_CLASS_ORDER[rank[0]!]).toBe('AA');

    const top3 = Array.from(rank.subarray(0, 3)).map((i) => HAND_CLASS_ORDER[i]!);
    expect(top3).toContain('KK');
    expect(top3).toContain('QQ');

    const bottom10 = Array.from(rank.subarray(159, 169)).map((i) => HAND_CLASS_ORDER[i]!);
    expect(bottom10).toContain('72o');
  });

  it('opp=AA単独レンジでも 169 個の一意な index を返す', () => {
    const aaOnly = new Float64Array(169);
    aaOnly[HAND_CLASS_INDEX['AA']!] = 1;
    const rank = rankClassesByEquityVs(aaOnly, table);
    expect(rank.length).toBe(169);
    const seen = new Set(Array.from(rank));
    expect(seen.size).toBe(169);
  });
});

describe('estimateHeroStratified — estimateNodeEquities（ノードレベル MC）との整合', () => {
  it('層化 hero パスのクラス条件付き equity は従来 MC と近い値に収束する', () => {
    const node: ShowdownNode = {
      preHandStacks: [20, 20, 20],
      commits: [20, 20, 20],
      participants: [0, 1, 2],
      payouts: payoutsForPlayers(3),
    };
    const full = new Float64Array(169).fill(1);
    const ranges = [full, full, full];
    const iAA = HAND_CLASS_INDEX['AA']!;
    const iKK = HAND_CLASS_INDEX['KK']!;
    const i72 = HAND_CLASS_INDEX['72o']!;
    const iAKs = HAND_CLASS_INDEX['AKs']!;
    const classes = Int16Array.from([iAA, iKK, i72]);

    const strat = estimateHeroStratified(node, ranges, 0, classes, 20_000, new DeterministicRng(0x1111));
    const mc = estimateNodeEquities(node, ranges, 400_000, new DeterministicRng(0x2222));

    expect(Math.abs(strat.eq[iAA]! - mc.eq[0]![iAA]!)).toBeLessThan(0.05);
    expect(Number.isNaN(strat.eq[iAKs])).toBe(true);
    expect(strat.counts[iAA]).toBe(20_000);
  });
});

describe('computeShowdownMc — StratSpec 層化経路', () => {
  const table = loadHuWinTieTable();
  const node: ShowdownNode = {
    preHandStacks: [20, 20, 20],
    commits: [20, 20, 20],
    participants: [0, 1, 2],
    payouts: payoutsForPlayers(3),
  };
  const full = new Float64Array(169).fill(1);
  const ranges = [full, full, full];
  const cand2 = rankClassesByEquityVs(full, table).subarray(0, 24);
  const strat: StratSpec = { cand: [undefined, undefined, cand2], mOc: 40, mLow: 3, sMarg: 500 };

  it('同一シードは決定的（bit 一致）', () => {
    const r1 = computeShowdownMc(node, ranges, 100, 12345, strat);
    const r2 = computeShowdownMc(node, ranges, 100, 12345, strat);
    for (let p = 0; p < 3; p++) expect(Array.from(r1.pcEq[p]!)).toEqual(Array.from(r2.pcEq[p]!));
    expect(r1.seatMarginal).toEqual(r2.seatMarginal);
  });

  it('参加者2（overcaller）: 候補外クラスは候補内最小値で埋まり, AA>=72o, seatMarginal は payout 保存', () => {
    const r = computeShowdownMc(node, ranges, 100, 777, strat);
    const pc2 = r.pcEq[2]!;

    let mn = Number.POSITIVE_INFINITY;
    const candSet = new Set(Array.from(cand2));
    for (const c of cand2) mn = Math.min(mn, pc2[c]!);
    for (let c = 0; c < 169; c++) {
      if (!candSet.has(c)) expect(pc2[c]).toBe(mn);
    }

    const iAA = HAND_CLASS_INDEX['AA']!;
    const i72 = HAND_CLASS_INDEX['72o']!;
    expect(pc2[iAA]!).toBeGreaterThanOrEqual(pc2[i72]!);

    expect(r.seatMarginal.length).toBe(3);
    const sum = r.seatMarginal.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(payoutsForPlayers(3).reduce((a, b) => a + b, 0), 5);
  });
});

describe('solveMultiway — maxActive（同時オールイン上限）opt-in', () => {
  const state = equalStacks(4, 10);
  const order = positionsForPlayersLeft(4);
  const winTie = loadHuWinTieTable();
  const BASE = { maxIters: 60, refreshEvery: 30, samples: 4000, seed: 3, workers: 0, winTie } as const;

  /** ノードキーで actor より前方に並ぶ ':P'/':C' セグメント数（=同時オールイン人数）。 */
  function aggrBefore(order: readonly string[], key: string, actor: string): number {
    const idx = order.indexOf(actor);
    const before = key.split(',').slice(0, idx);
    return before.filter((seg) => seg.endsWith(':P') || seg.endsWith(':C')).length;
  }

  it(
    '既定 maxActive=3: 前方3人以上オールインのノードは pct=0 / hands=[]（ICM 保存も確認）',
    async () => {
      const res = await solveMultiway(state, BASE);
      let sawTruncated = false;
      for (const nd of res.nodes) {
        if (aggrBefore(order, nd.key, nd.actor) >= 3) {
          sawTruncated = true;
          expect(nd.pct).toBe(0);
          expect(nd.hands.length).toBe(0);
        }
      }
      expect(sawTruncated).toBe(true);

      const sumPost = order.reduce((s, p) => s + res.equity[p]!.post, 0);
      expect(sumPost).toBeCloseTo(5 + 3 + 2 + 1, 5);
    },
    TIMEOUT,
  );

  it(
    'maxActive:99 は前方3人以上オールインのノードも解禁され、求解が完了する',
    async () => {
      const res = await solveMultiway(state, { ...BASE, maxActive: 99 });
      const has3plus = res.nodes.some((nd) => aggrBefore(order, nd.key, nd.actor) >= 3);
      expect(has3plus).toBe(true);
    },
    TIMEOUT,
  );

  it(
    'stratifiedMc:false でも winTie 経路で解け、ノードキー集合は stratifiedMc:true と同じ',
    async () => {
      const resTrue = await solveMultiway(state, { ...BASE, stratifiedMc: true });
      const resFalse = await solveMultiway(state, { ...BASE, stratifiedMc: false });
      expect(resFalse.nodes.map((n) => n.key).sort()).toEqual(resTrue.nodes.map((n) => n.key).sort());
    },
    TIMEOUT,
  );
});
