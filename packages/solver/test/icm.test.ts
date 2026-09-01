import { describe, it, expect } from 'vitest';
import {
  icmEquities,
  icmEquitiesByEnumeration,
  payoutsForPlayers,
  REAL_PAYOUTS_6,
  HRC_PAYOUTS_6,
} from '../src/icm.js';

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

describe('MH-ICM: 手計算可能な小ケース', () => {
  it('HU 均等スタック [5,3] は両者 4.0', () => {
    const eq = icmEquities([10, 10], [5, 3]);
    expect(eq[0]).toBeCloseTo(4.0, 10);
    expect(eq[1]).toBeCloseTo(4.0, 10);
  });

  it('HU 不均等 [3,1] payout[5,3]: 4.5 / 3.5', () => {
    const eq = icmEquities([3, 1], [5, 3]);
    expect(eq[0]).toBeCloseTo(4.5, 10);
    expect(eq[1]).toBeCloseTo(3.5, 10);
  });

  it('3人 [2,1,1] payout[5,3,2]: A=3.8333.., B=C=3.0833..', () => {
    const eq = icmEquities([2, 1, 1], [5, 3, 2]);
    expect(eq[0]).toBeCloseTo(3.833333333, 8);
    expect(eq[1]).toBeCloseTo(3.083333333, 8);
    expect(eq[2]).toBeCloseTo(3.083333333, 8);
    expect(sum(eq)).toBeCloseTo(10, 10);
  });

  it('equity の総和は payout の総和に一致（保存則）', () => {
    const stacks = [12, 8, 5, 3, 2, 1];
    const eq = icmEquities(stacks, [...REAL_PAYOUTS_6]);
    expect(sum(eq)).toBeCloseTo(sum([...REAL_PAYOUTS_6]), 9);
  });
});

describe('DP と 720通り列挙の一致（6人厳密）', () => {
  it('matches enumeration for a 6-player uneven case', () => {
    const stacks = [17.3, 11.1, 9.4, 6.2, 3.8, 1.2];
    const payouts = [...REAL_PAYOUTS_6];
    const dp = icmEquities(stacks, payouts);
    const en = icmEquitiesByEnumeration(stacks, payouts);
    for (let i = 0; i < 6; i++) expect(dp[i]).toBeCloseTo(en[i]!, 10);
  });

  it('matches enumeration for several player counts', () => {
    const cases: number[][] = [
      [4, 1],
      [3, 2, 1],
      [10, 4, 3, 2],
      [8, 6, 4, 2, 1],
    ];
    for (const stacks of cases) {
      const payouts = payoutsForPlayers(stacks.length);
      const dp = icmEquities(stacks, payouts);
      const en = icmEquitiesByEnumeration(stacks, payouts);
      for (let i = 0; i < stacks.length; i++) expect(dp[i]).toBeCloseTo(en[i]!, 10);
    }
  });
});

describe('shift-invariance（SPEC §2.2）', () => {
  it('全 payout に定数 c を足すと全 equity が c だけシフトする', () => {
    const stacks = [12, 8, 5, 3, 2, 1];
    const base = icmEquities(stacks, [...REAL_PAYOUTS_6]);
    const c = 1;
    const shifted = icmEquities(stacks, [...HRC_PAYOUTS_6]); // = REAL + 1
    for (let i = 0; i < 6; i++) expect(shifted[i]! - base[i]!).toBeCloseTo(c, 9);
  });

  it('equity の差（EV 差の素）はシフトで不変', () => {
    const stacks = [12, 8, 5, 3, 2, 1];
    const base = icmEquities(stacks, [...REAL_PAYOUTS_6]);
    const shifted = icmEquities(stacks, [...HRC_PAYOUTS_6]);
    const dBase = base[0]! - base[1]!;
    const dShift = shifted[0]! - shifted[1]!;
    expect(dShift).toBeCloseTo(dBase, 10);
  });
});

describe('scale-invariance', () => {
  it('全スタックを定数倍しても equity は不変', () => {
    const stacks = [12, 8, 5, 3, 2, 1];
    const base = icmEquities(stacks, [...REAL_PAYOUTS_6]);
    for (const k of [0.5, 2, 100]) {
      const scaled = icmEquities(
        stacks.map((s) => s * k),
        [...REAL_PAYOUTS_6],
      );
      for (let i = 0; i < 6; i++) expect(scaled[i]).toBeCloseTo(base[i]!, 9);
    }
  });
});

describe('席入れ替え対称性', () => {
  it('スタックを並べ替えると equity も同じ並べ替えで返る', () => {
    const stacks = [12, 8, 5, 3, 2, 1];
    const payouts = [...REAL_PAYOUTS_6];
    const base = icmEquities(stacks, payouts);
    // 並べ替え perm: 席 i -> 位置 perm[i]
    const perm = [3, 0, 5, 1, 4, 2];
    const permutedStacks = new Array<number>(6);
    for (let i = 0; i < 6; i++) permutedStacks[perm[i]!] = stacks[i]!;
    const permutedEq = icmEquities(permutedStacks, payouts);
    for (let i = 0; i < 6; i++) {
      expect(permutedEq[perm[i]!]).toBeCloseTo(base[i]!, 10);
    }
  });

  it('等しいスタックのプレイヤーは等しい equity', () => {
    const eq = icmEquities([5, 5, 5, 1], payoutsForPlayers(4));
    expect(eq[0]).toBeCloseTo(eq[1]!, 12);
    expect(eq[1]).toBeCloseTo(eq[2]!, 12);
  });
});

describe('実 HRC データとの一致（EQPre, 5人）', () => {
  // さつき収集の実データ（Blinds 0.5/1/0.25 all-ante, payout シフト形 6/4/3/2/1, プール16）。
  // cases/_reference-hrc-5way-blinds05-1-025.json 参照。
  it('stacks [10,20,30,23,12] の EQPre が HRC と一致（表示丸め 0.01% 以内）', () => {
    const stacks = [10, 20, 30, 23, 12];
    const shifted = [6, 4, 3, 2, 1];
    const pool = 16;
    const hrcEQPrePct = [15.29, 21.05, 24.66, 22.28, 16.72];
    const eq = icmEquities(stacks, shifted);
    for (let i = 0; i < 5; i++) {
      const myPct = (eq[i]! / pool) * 100;
      expect(Math.abs(myPct - hrcEQPrePct[i]!)).toBeLessThan(0.01);
    }
  });
});

describe('payoutsForPlayers', () => {
  it('残り人数 n は上位 n 着の実払いを返す', () => {
    expect(payoutsForPlayers(2)).toEqual([5, 3]);
    expect(payoutsForPlayers(3)).toEqual([5, 3, 2]);
    expect(payoutsForPlayers(6)).toEqual([5, 3, 2, 1, 0, -1]);
  });
  it('範囲外は例外', () => {
    expect(() => payoutsForPlayers(7)).toThrow();
    expect(() => payoutsForPlayers(0)).toThrow();
  });
});
