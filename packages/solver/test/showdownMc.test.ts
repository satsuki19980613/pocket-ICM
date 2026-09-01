import { describe, it, expect } from 'vitest';
import {
  sampleShowdownIcm,
  estimateNodeEquities,
  type ShowdownNode,
} from '../src/showdownMc.js';
import { expectedShowdownIcm, type ShowdownSetup } from '../src/sidepot.js';
import { placementDistributionExact, DeterministicRng } from '../src/placement.js';
import { parseCard } from '../src/evaluator.js';
import { REAL_PAYOUTS_6, icmEquities } from '../src/icm.js';
import { HAND_CLASS_INDEX } from '../src/huEquity.js';

const payouts3 = REAL_PAYOUTS_6.slice(0, 3); // [5,3,2]

function maxAbs(a: readonly number[], b: readonly number[]): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!));
  return m;
}

describe('sampleShowdownIcm — 厳密（着順分布経由）との一致', () => {
  it('3-way 等スタック・フロップ既知: MC が厳密 ICM に一致', () => {
    const hands: [number, number][] = [
      [parseCard('As'), parseCard('Ah')], // AA
      [parseCard('Kd'), parseCard('Kc')], // KK
      [parseCard('7h'), parseCard('2s')], // 72o
    ];
    const board = [parseCard('Qs'), parseCard('Jd'), parseCard('9c')];
    const node: ShowdownNode = {
      preHandStacks: [20, 20, 20],
      commits: [20, 20, 20],
      participants: [0, 1, 2],
      payouts: payouts3,
    };

    // 厳密: 着順分布（残り2枚全列挙）→ expectedShowdownIcm
    const dist = placementDistributionExact(hands, board);
    const setup: ShowdownSetup = {
      preHandStacks: node.preHandStacks,
      commits: node.commits,
      participants: node.participants,
      payouts: node.payouts,
    };
    const exact = expectedShowdownIcm(setup, dist);

    const rng = new DeterministicRng(0x1234abcd);
    const mc = sampleShowdownIcm(node, hands, 300_000, rng, board);

    expect(maxAbs(mc, exact)).toBeLessThan(0.01);
  });

  it('サイドポット付き 3-way: 最短スタックが強いケースでも一致', () => {
    const hands: [number, number][] = [
      [parseCard('As'), parseCard('Ah')], // AA（最短）
      [parseCard('Kd'), parseCard('Qc')], // KQo
      [parseCard('7h'), parseCard('6s')], // 76o
    ];
    const board = [parseCard('2d'), parseCard('9c'), parseCard('Jh')];
    const node: ShowdownNode = {
      preHandStacks: [6, 20, 20],
      commits: [6, 20, 20], // P0 最短 → サイドポット
      participants: [0, 1, 2],
      payouts: payouts3,
    };
    const dist = placementDistributionExact(hands, board);
    const exact = expectedShowdownIcm(
      {
        preHandStacks: node.preHandStacks,
        commits: node.commits,
        participants: node.participants,
        payouts: node.payouts,
      },
      dist,
    );
    const rng = new DeterministicRng(0x00c0ffee);
    const mc = sampleShowdownIcm(node, hands, 300_000, rng, board);
    expect(maxAbs(mc, exact)).toBeLessThan(0.01);
  });

  it('決定性: 同一シードで同一結果', () => {
    const hands: [number, number][] = [
      [parseCard('As'), parseCard('Ah')],
      [parseCard('Kd'), parseCard('Kc')],
      [parseCard('7h'), parseCard('2s')],
    ];
    const node: ShowdownNode = {
      preHandStacks: [20, 20, 20],
      commits: [20, 20, 20],
      participants: [0, 1, 2],
      payouts: payouts3,
    };
    const a = sampleShowdownIcm(node, hands, 10_000, new DeterministicRng(42));
    const b = sampleShowdownIcm(node, hands, 10_000, new DeterministicRng(42));
    expect(a).toEqual(b);
  });
});

describe('estimateNodeEquities — レンジ MC の健全性', () => {
  const node: ShowdownNode = {
    preHandStacks: [20, 20, 20],
    commits: [20, 20, 20],
    participants: [0, 1, 2],
    payouts: payouts3,
  };

  it('全員同一レンジ・等スタックなら marginal は対称、総和は payout 総和', () => {
    // 全 169 クラス頻度 1（全レンジ）
    const full = new Float64Array(169).fill(1);
    const ranges = [full, full, full];
    const rng = new DeterministicRng(0xabcdef);
    const res = estimateNodeEquities(node, ranges, 200_000, rng);
    // 対称
    expect(Math.abs(res.marginal[0]! - res.marginal[1]!)).toBeLessThan(0.02);
    expect(Math.abs(res.marginal[1]! - res.marginal[2]!)).toBeLessThan(0.02);
    // 各 marginal ≈ payout 平均（等スタック・同一レンジなら (5+3+2)/3）
    expect(res.marginal[0]).toBeCloseTo((5 + 3 + 2) / 3, 1);
  });

  it('クラス別 equity は強い手ほど高い（AA > 72o）', () => {
    const full = new Float64Array(169).fill(1);
    const rng = new DeterministicRng(0x13572468);
    const res = estimateNodeEquities(node, [full, full, full], 300_000, rng);
    const iAA = HAND_CLASS_INDEX['AA']!;
    const i72 = HAND_CLASS_INDEX['72o']!;
    // 参加者0視点で AA の条件付き equity は 72o より明確に高い
    expect(res.eq[0]![iAA]!).toBeGreaterThan(res.eq[0]![i72]! + 1.0);
  });

  it('単一クラス・レンジの marginal は sampleShowdownIcm（クラス平均）に整合', () => {
    // 3人とも単一クラス: P0=AA, P1=KK, P2=72o
    const mk = (label: string): Float64Array => {
      const r = new Float64Array(169);
      r[HAND_CLASS_INDEX[label]!] = 1;
      return r;
    };
    const ranges = [mk('AA'), mk('KK'), mk('72o')];
    const rng = new DeterministicRng(0x55aa55aa);
    const res = estimateNodeEquities(node, ranges, 200_000, rng);
    // 参照: 代表コンボでの sampleShowdownIcm（クラス内の suit 差は平均で小さい）
    const hands: [number, number][] = [
      [parseCard('As'), parseCard('Ah')],
      [parseCard('Kd'), parseCard('Kc')],
      [parseCard('7h'), parseCard('2s')],
    ];
    const ref = sampleShowdownIcm(node, hands, 200_000, new DeterministicRng(0x99));
    // marginal（レンジ平均＝この場合はクラスの組合せ平均）は代表コンボ参照と近い
    for (let p = 0; p < 3; p++) {
      const seat = node.participants[p]!;
      expect(Math.abs(res.marginal[p]! - ref[seat]!)).toBeLessThan(0.05);
    }
  });
});
