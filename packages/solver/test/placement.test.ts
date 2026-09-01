import { describe, it, expect } from 'vitest';
import { parseCard } from '../src/evaluator.js';
import {
  DeterministicRng,
  encodeSignature,
  decodeSignature,
  placementDistributionExact,
  placementDistributionMC,
  distTotalVariation,
  distMaxAbsDiff,
  type PlacementDist,
} from '../src/index.js';
import { exactEquityVsHands } from '../src/huEquity.js';

const H = (a: string, b: string): [number, number] => [parseCard(a), parseCard(b)];

describe('signature エンコード', () => {
  it('encode/decode 往復（k=3）', () => {
    for (const v of [
      [0, 1, 2],
      [0, 0, 0],
      [2, 0, 1],
      [1, 1, 0],
    ]) {
      expect(decodeSignature(encodeSignature(v), 3)).toEqual(v);
    }
  });
});

describe('RNG 決定性', () => {
  it('同一シードは同一列', () => {
    const a = new DeterministicRng(42);
    const b = new DeterministicRng(42);
    for (let i = 0; i < 100; i++) expect(a.nextU32()).toBe(b.nextU32());
  });
  it('異なるシードは異なる列', () => {
    const a = new DeterministicRng(1);
    const b = new DeterministicRng(2);
    let same = 0;
    for (let i = 0; i < 100; i++) if (a.nextU32() === b.nextU32()) same++;
    expect(same).toBeLessThan(5);
  });
});

describe('HU 整合: 着順分布が厳密 equity を再現', () => {
  it('AKs vs QQ の勝/分/負が exactEquityVsHands と一致', () => {
    const hero = H('Ah', 'Kh');
    const vill = H('Qs', 'Qd');
    const dist = placementDistributionExact([hero, vill]);
    // k=2: strongerCount = [0,1]=hero勝, [1,0]=hero負, [0,0]=分
    let heroWin = 0;
    let tie = 0;
    let heroLose = 0;
    for (const [sig, p] of dist) {
      const [h, v] = decodeSignature(sig, 2);
      if (h === 0 && v === 1) heroWin += p;
      else if (h === 1 && v === 0) heroLose += p;
      else tie += p;
    }
    const ref = exactEquityVsHands(hero, vill);
    expect(heroWin).toBeCloseTo(ref.win / ref.total, 10);
    expect(tie).toBeCloseTo(ref.tie / ref.total, 10);
    expect(heroLose).toBeCloseTo(ref.lose / ref.total, 10);
    // equity = win + tie/2
    expect(heroWin + tie / 2).toBeCloseTo(ref.equity, 10);
  });
});

describe('3-way 着順分布: 厳密列挙と MC の一致（固定シード）', () => {
  // 決定的な参照分布（残りボード全列挙）。
  const hands: [number, number][] = [H('Ah', 'As'), H('Kh', 'Ks'), H('Qh', 'Qs')];
  let exact: PlacementDist;
  it('厳密分布が確率和 1・確率順序が妥当', () => {
    exact = placementDistributionExact(hands);
    let sum = 0;
    for (const p of exact.values()) sum += p;
    expect(sum).toBeCloseTo(1, 10);
    // AA が単独 1 位（strongerCount=[0,1,2]）になる確率は最大クラス
    const soleAA = exact.get(encodeSignature([0, 1, 2])) ?? 0;
    expect(soleAA).toBeGreaterThan(0.5);
  });

  it('MC(固定シード) が厳密分布に近い（TV < 0.01）', () => {
    const ref = placementDistributionExact(hands);
    const mc = placementDistributionMC(hands, 300000, new DeterministicRng(12345));
    expect(distTotalVariation(ref, mc)).toBeLessThan(0.01);
    expect(distMaxAbsDiff(ref, mc)).toBeLessThan(0.006);
  });

  it('MC は同一シードで完全再現（決定性）', () => {
    const a = placementDistributionMC(hands, 5000, new DeterministicRng(777));
    const b = placementDistributionMC(hands, 5000, new DeterministicRng(777));
    expect(distMaxAbsDiff(a, b)).toBe(0);
  });
});
