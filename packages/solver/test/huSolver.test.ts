import { describe, it, expect, beforeAll } from 'vitest';
import type { BoardState } from '@oshihiki/core';
import { parseSolutionNode, parseRangeToSet } from '@oshihiki/core';
import {
  solveHu,
  evaluateHuStrategy,
  loadHuTable,
  icmEquities,
  HAND_CLASS_ORDER,
  type LoadedHuTable,
} from '../src/index.js';

let table: LoadedHuTable;
beforeAll(() => {
  table = loadHuTable();
});

/** 実効 Tsb/Tbb（BB換算の総スタック）と blinds/ante から HU 盤面を作る。 */
function makeHu(
  Tsb: number,
  Tbb: number,
  o: { sb?: number; bb?: number; ante?: { scheme: 'all' | 'bb' | 'none'; amount: number } } = {},
): BoardState {
  const sb = o.sb ?? 0.5;
  const bb = o.bb ?? 1.0;
  const ante = o.ante ?? { scheme: 'none' as const, amount: 0 };
  const anteSB = ante.scheme === 'all' ? ante.amount : 0;
  const anteBB = ante.scheme === 'all' ? ante.amount : ante.scheme === 'bb' ? ante.amount : 0;
  return {
    street: 'preflop',
    blinds: { sb, bb },
    ante,
    heroHand: 'A5s',
    playersLeft: 2,
    seats: [
      { pos: 'SB', stack: Tsb - sb - anteSB, state: 'live', bet: sb },
      { pos: 'BB', stack: Tbb - bb - anteBB, state: 'live', bet: bb },
    ],
    heroPos: 'SB',
  };
}

/** プール16 換算での exploitability ゲート（実払い pt）= 0.05% * 16。 */
const GATE_PT = (0.05 / 100) * 16; // 0.008

const idx = (label: string) => HAND_CLASS_ORDER.indexOf(label);

describe('HU push/fold ソルバー: 収束と exploitability（1-6, 1-7）', () => {
  it('複数スタックでゲート未満に収束する', () => {
    for (const eff of [3, 6, 10, 15, 20]) {
      const r = solveHu(makeHu(eff, eff), { table });
      expect(r.exploitabilityPt).toBeLessThan(GATE_PT);
      expect(r.converged).toBe(true);
      expect(r.nodes[0]!.quality.exploitability).toBe(r.exploitabilityPt);
    }
  });

  it('不均等スタックでも収束する', () => {
    for (const [a, b] of [
      [8, 20],
      [25, 6],
      [12, 4],
    ] as [number, number][]) {
      const r = solveHu(makeHu(a, b), { table });
      expect(r.exploitabilityPt).toBeLessThan(GATE_PT);
    }
  });

  it('アンティ有り（全員払い）でも収束する', () => {
    const r = solveHu(makeHu(10, 10, { ante: { scheme: 'all', amount: 0.25 } }), { table });
    expect(r.exploitabilityPt).toBeLessThan(GATE_PT);
    expect(r.converged).toBe(true);
  });
});

describe('解ノードの構造（§3.2）', () => {
  it('PU / CA の2ノードを正しい key・actor・actionType で返す', () => {
    const r = solveHu(makeHu(10, 10), { table });
    expect(r.nodes).toHaveLength(2);
    const pu = r.nodes[0]!;
    const ca = r.nodes[1]!;
    expect(pu.key).toBe('SB:-,BB:-');
    expect(pu.actor).toBe('SB');
    expect(pu.actionType).toBe('PU');
    expect(ca.key).toBe('SB:P,BB:-');
    expect(ca.actor).toBe('BB');
    expect(ca.actionType).toBe('CA');
  });

  it('両ノードが SolutionNode スキーマに適合する', () => {
    const r = solveHu(makeHu(10, 10), { table });
    for (const n of r.nodes) {
      const parsed = parseSolutionNode(n);
      expect(parsed.ok, parsed.issues.join('; ')).toBe(true);
    }
  });

  it('range 文字列が hands 集合と一致する', () => {
    const r = solveHu(makeHu(10, 10), { table });
    for (const n of r.nodes) {
      expect(parseRangeToSet(n.range)).toEqual(new Set(n.hands));
    }
  });
});

describe('保存則と EQPre の一致（1-9）', () => {
  it('EQPre は icmEquities([Tsb,Tbb],[5,3]) に一致（和=8）', () => {
    const r = solveHu(makeHu(13, 7), { table }); // Tsb=13, Tbb=7
    const [preSb, preBb] = icmEquities([13, 7], [5, 3]);
    expect(r.eqPre.sb).toBeCloseTo(preSb!, 10);
    expect(r.eqPre.bb).toBeCloseTo(preBb!, 10);
    expect(r.eqPre.sb + r.eqPre.bb).toBeCloseTo(8, 10);
  });

  it('EQPost の和も 8（チップ保存）', () => {
    for (const eff of [5, 10, 18]) {
      const r = solveHu(makeHu(eff, eff), { table });
      expect(r.eqPost.sb + r.eqPost.bb).toBeCloseTo(8, 6);
    }
  });

  it('ノードの equity にも pre/post が入り和が 8', () => {
    const r = solveHu(makeHu(10, 12), { table });
    const e = r.nodes[0]!.equity;
    expect(e.SB!.pre + e.BB!.pre).toBeCloseTo(8, 9);
    expect(e.SB!.post + e.BB!.post).toBeCloseTo(8, 6);
  });
});

describe('戦略の定性的性質', () => {
  it('AA は常に push かつ常に call', () => {
    const r = solveHu(makeHu(15, 15), { table });
    expect(r.pushProb[idx('AA')]!).toBeGreaterThan(0.99);
    expect(r.callProb[idx('AA')]!).toBeGreaterThan(0.99);
  });

  it('72o は 15bb では push しない', () => {
    const r = solveHu(makeHu(15, 15), { table });
    expect(r.pushProb[idx('72o')]!).toBeLessThan(0.5);
  });

  it('スタックが浅いほど push レンジは広い（単調）', () => {
    let prev = 101;
    for (const eff of [4, 8, 12, 18]) {
      const r = solveHu(makeHu(eff, eff), { table });
      expect(r.nodes[0]!.pct).toBeLessThan(prev);
      prev = r.nodes[0]!.pct;
    }
  });

  it('2bb は push ほぼ any-two・BB call 100%', () => {
    const r = solveHu(makeHu(2, 2), { table });
    expect(r.nodes[0]!.pct).toBeGreaterThan(85);
    expect(r.nodes[1]!.pct).toBeGreaterThan(99);
  });
});

describe('scale-invariance（全スタック・ブラインド定数倍で解不変）', () => {
  it('10/10 (0.5/1) と 20/20 (1/2) の push・call 集合が一致', () => {
    const base = solveHu(makeHu(10, 10, { sb: 0.5, bb: 1 }), { table });
    const scaled = solveHu(makeHu(20, 20, { sb: 1, bb: 2 }), { table });
    expect(new Set(scaled.nodes[0]!.hands)).toEqual(new Set(base.nodes[0]!.hands));
    expect(new Set(scaled.nodes[1]!.hands)).toEqual(new Set(base.nodes[1]!.hands));
  });
});

describe('exploitability 自己検証（1-7: 崩した戦略で正値）', () => {
  it('均衡戦略の exploitability はゲート未満、崩すと有意に増える', () => {
    const r = solveHu(makeHu(12, 12), { table });
    const N = HAND_CLASS_ORDER.length;

    // 均衡の再評価は solver の値に一致
    const atEq = evaluateHuStrategy(makeHu(12, 12), r.pushProb, r.callProb, { table });
    expect(atEq.exploitabilityPt).toBeCloseTo(r.exploitabilityPt, 9);
    expect(atEq.exploitabilityPt).toBeLessThan(GATE_PT);

    // 崩し1: BB が一切コールしない → SB が any-two push で大きく搾取できる
    const noCall = new Float64Array(N).fill(0);
    const brokenBB = evaluateHuStrategy(makeHu(12, 12), r.pushProb, noCall, { table });
    expect(brokenBB.brGainSbPt).toBeGreaterThan(0.05);
    expect(brokenBB.exploitabilityPt).toBeGreaterThan(10 * GATE_PT);

    // 崩し2: SB が any-two で push（オーバープッシュ）→ BB が搾取できる（gate 超過）
    const allPush = new Float64Array(N).fill(1);
    const brokenSB = evaluateHuStrategy(makeHu(12, 12), allPush, r.callProb, { table });
    expect(brokenSB.brGainBbPt).toBeGreaterThan(0.01);
    expect(brokenSB.exploitabilityPt).toBeGreaterThan(2 * GATE_PT);
  });
});

describe('独立検証: 既知の equal-stack Nash push/fold チャートと整合', () => {
  // HU の ICM equity は終局スタックにアフィン → この均衡は chip-EV の Nash push/fold と一致する。
  // 公開されている equal-stack Nash（HRC 等）の概略値と広めのバンドで突き合わせる。
  it('10bb 均等で push≈58%, call≈37% 帯に入る', () => {
    const r = solveHu(makeHu(10, 10), { table });
    expect(r.nodes[0]!.pct).toBeGreaterThan(52);
    expect(r.nodes[0]!.pct).toBeLessThan(64);
    expect(r.nodes[1]!.pct).toBeGreaterThan(32);
    expect(r.nodes[1]!.pct).toBeLessThan(43);
  });
});
