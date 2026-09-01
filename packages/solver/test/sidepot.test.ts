import { describe, it, expect } from 'vitest';
import {
  distributePots,
  finalStacksFromShowdown,
  expectedShowdownIcm,
  type ShowdownSetup,
} from '../src/sidepot.js';
import { icmEquities, REAL_PAYOUTS_6 } from '../src/icm.js';
import { encodeSignature, type PlacementDist } from '../src/placement.js';

const sum = (a: readonly number[]): number => a.reduce((x, y) => x + y, 0);

describe('distributePots — 手計算ケース', () => {
  it('等スタック3way・勝者総取り', () => {
    const won = distributePots([10, 10, 10], [true, true, true], [0, 1, 2]);
    expect(won).toEqual([30, 0, 0]);
    expect(sum(won)).toBe(30);
  });

  it('サイドポット: 最短スタックがメインを勝ち、カバー2人でサイドを争う', () => {
    // P0=5 all-in（最強）, P1=20, P2=20。P0 はメインのみ、サイドは P1/P2 で。
    const commits = [5, 20, 20];
    const won = distributePots(commits, [true, true, true], [0, 1, 2]);
    // メイン 5×3=15 → P0。サイド 15×2=30 → P1（P1<P2）。
    expect(won).toEqual([15, 30, 0]);
    expect(sum(won)).toBe(sum(commits));
  });

  it('サイドポット: 最短が最強でも自分の出した層までしか取れない', () => {
    const commits = [5, 20, 20];
    // P0(最短) 最強、P2 が P1 より強い。
    const won = distributePots(commits, [true, true, true], [0, 2, 1]);
    // メイン15→P0。サイド30→P2。
    expect(won).toEqual([15, 0, 30]);
    expect(sum(won)).toBe(sum(commits));
  });

  it('未コール分の返却（カバー側の余剰は動かない）', () => {
    // P0 push 20, P1 call all-in 5, P2 fold(BB=1, デッド)。
    const commits = [20, 5, 1];
    const eligible = [true, true, false];
    // P1 が勝つ。
    const won = distributePots(commits, eligible, [1, 0, 0]);
    // 層[0,1]: 拠出{0,1,2}, pot3, elig{0,1}→P1=3
    // 層[1,5]: 拠出{0,1}, pot8, elig{0,1}→P1=8
    // 層[5,20]: 拠出{0}, pot15, elig{0}→P0=15（未コール返却）
    expect(won[0]).toBeCloseTo(15, 12);
    expect(won[1]).toBeCloseTo(11, 12);
    expect(won[2]).toBeCloseTo(0, 12);
    expect(sum(won)).toBeCloseTo(sum(commits), 12);
  });

  it('タイは均等分割（2way）', () => {
    const won = distributePots([10, 10], [true, true], [0, 0]);
    expect(won).toEqual([10, 10]);
  });

  it('タイは均等分割（3way中2人が最強タイ）', () => {
    const won = distributePots([10, 10, 10], [true, true, true], [0, 0, 1]);
    expect(won).toEqual([15, 15, 0]);
    expect(sum(won)).toBe(30);
  });

  it('フォールド者のデッドマネーは勝者へ、勝てはしない', () => {
    // P0 all-in 10（勝ち）, P1 all-in 10（負け）, P2 fold(bet2)。
    const commits = [10, 10, 2];
    const won = distributePots(commits, [true, true, false], [0, 1, 0]);
    // 層[0,2]: 拠出全員 pot6 elig{0,1}→P0=6
    // 層[2,10]: 拠出{0,1} pot16 elig{0,1}→P0=16
    expect(won).toEqual([22, 0, 0]);
    expect(sum(won)).toBe(sum(commits));
  });
});

describe('finalStacksFromShowdown', () => {
  it('サイドポットの終局スタックとチップ保存', () => {
    const pre = [5, 20, 20];
    const commits = [5, 20, 20];
    const final = finalStacksFromShowdown(pre, commits, [true, true, true], [0, 1, 2]);
    expect(final).toEqual([15, 30, 0]);
    expect(sum(final)).toBe(sum(pre));
  });

  it('フォールド者は残額を保つ', () => {
    const pre = [20, 5, 10];
    const commits = [20, 5, 1];
    const final = finalStacksFromShowdown(pre, commits, [true, true, false], [1, 0, 0]);
    // P0=20-20+15=15, P1=5-5+11=11, P2=10-1+0=9
    expect(final[0]).toBeCloseTo(15, 12);
    expect(final[1]).toBeCloseTo(11, 12);
    expect(final[2]).toBeCloseTo(9, 12);
    expect(sum(final)).toBeCloseTo(sum(pre), 12);
  });
});

describe('expectedShowdownIcm — ショーダウン→スタック分布→ICM', () => {
  const payouts3 = REAL_PAYOUTS_6.slice(0, 3); // 3人 = 上位3着 [5,3,2]

  it('単一結果の分布は finalStacks の ICM に一致', () => {
    const setup: ShowdownSetup = {
      preHandStacks: [10, 10, 10],
      commits: [10, 10, 10],
      participants: [0, 1, 2],
      payouts: payouts3,
    };
    // strongerCount = [0,1,2] を signature に
    const sig = encodeSignature([0, 1, 2]);
    const dist: PlacementDist = new Map([[sig, 1]]);
    const eq = expectedShowdownIcm(setup, dist);
    const direct = icmEquities([30, 0, 0], payouts3);
    expect(eq[0]).toBeCloseTo(direct[0]!, 12);
    expect(eq[1]).toBeCloseTo(direct[1]!, 12);
    expect(eq[2]).toBeCloseTo(direct[2]!, 12);
  });

  it('2結果の手動混合を線形に平均', () => {
    const setup: ShowdownSetup = {
      preHandStacks: [10, 10, 10],
      commits: [10, 10, 10],
      participants: [0, 1, 2],
      payouts: payouts3,
    };
    const sigA = encodeSignature([0, 1, 2]); // P0 総取り
    const sigB = encodeSignature([2, 1, 0]); // P2 総取り
    const dist: PlacementDist = new Map([
      [sigA, 0.25],
      [sigB, 0.75],
    ]);
    const eq = expectedShowdownIcm(setup, dist);
    const eqA = icmEquities([30, 0, 0], payouts3);
    const eqB = icmEquities([0, 0, 30], payouts3);
    for (let i = 0; i < 3; i++) {
      expect(eq[i]).toBeCloseTo(0.25 * eqA[i]! + 0.75 * eqB[i]!, 12);
    }
  });

  it('equity 総和は payout 総和に等しい（ICM 不変量）', () => {
    const setup: ShowdownSetup = {
      preHandStacks: [7, 13, 20],
      commits: [7, 13, 13], // P0 最短 → サイドポット発生
      participants: [0, 1, 2],
      payouts: payouts3,
    };
    // 全タイ群を含む適当な分布
    const dist: PlacementDist = new Map([
      [encodeSignature([0, 1, 2]), 0.4],
      [encodeSignature([1, 0, 2]), 0.3],
      [encodeSignature([0, 0, 2]), 0.2], // P0,P1 タイ
      [encodeSignature([0, 1, 1]), 0.1], // P1,P2 タイ
    ]);
    const eq = expectedShowdownIcm(setup, dist);
    // P2 は最短 P0 のサイド外なので pre 維持分を含むが、ICM 総和は payout 総和。
    expect(sum(eq)).toBeCloseTo(sum(payouts3), 10);
  });

  it('対称な設定では equity も対称', () => {
    const setup: ShowdownSetup = {
      preHandStacks: [10, 10, 10],
      commits: [10, 10, 10],
      participants: [0, 1, 2],
      payouts: payouts3,
    };
    // P0/P1 を入れ替えても不変な分布（各自が総取りする確率が等しい）
    const dist: PlacementDist = new Map([
      [encodeSignature([0, 1, 2]), 1 / 3],
      [encodeSignature([1, 0, 2]), 1 / 3],
      [encodeSignature([1, 2, 0]), 1 / 3],
    ]);
    const eq = expectedShowdownIcm(setup, dist);
    // P0 と P1 は分布上対称ではない（この分布は非対称）。代わりに全対称分布で検証:
    const symDist: PlacementDist = new Map();
    const perms = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    for (const p of perms) symDist.set(encodeSignature(p), 1 / 6);
    const symEq = expectedShowdownIcm(setup, symDist);
    expect(symEq[0]).toBeCloseTo(symEq[1]!, 12);
    expect(symEq[1]).toBeCloseTo(symEq[2]!, 12);
    // 非対称分布は少なくとも合計不変
    expect(sum(eq)).toBeCloseTo(sum(payouts3), 10);
  });
});
