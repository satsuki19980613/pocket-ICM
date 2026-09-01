import { describe, it, expect } from 'vitest';
import {
  CLASS_COMBOS,
  COMBO_COUNT,
  comboClass,
  weightAndUses,
  conditionalAggrProb,
  bruteConditionalAggrProbForPair,
  COMBOS_AFTER_REMOVING_TWO,
} from '../src/cardRemoval.js';
import { DeterministicRng } from '../src/placement.js';
import { HAND_CLASS_ORDER } from '../src/huEquity.js';

const N = 169;

/** シードから 0..1 のクラス頻度を作る（0/1 も混ぜる）。 */
function randomFreq(seed: number): Float64Array {
  const rng = new DeterministicRng(seed);
  const f = new Float64Array(N);
  for (let c = 0; c < N; c++) {
    const u = rng.nextFloat();
    // 一部を厳密 0/1 にして境界を突く。
    f[c] = u < 0.15 ? 0 : u > 0.85 ? 1 : u;
  }
  return f;
}

describe('cardRemoval — 静的テーブルの健全性', () => {
  it('コンボ総数 = 1326、クラス数 169、コンボ数は 6/4/12 のいずれか', () => {
    expect(CLASS_COMBOS).toHaveLength(N);
    let total = 0;
    for (let c = 0; c < N; c++) {
      total += COMBO_COUNT[c]!;
      expect([6, 4, 12]).toContain(COMBO_COUNT[c]!);
    }
    expect(total).toBe(1326);
    expect(COMBOS_AFTER_REMOVING_TWO).toBe(1225);
  });

  it('comboClass は各コンボを自クラスへ写す（往復一致）', () => {
    for (let c = 0; c < N; c++) {
      for (const [a, b] of CLASS_COMBOS[c]!) {
        expect(comboClass(a, b)).toBe(c);
        expect(comboClass(b, a)).toBe(c);
      }
    }
  });
});

describe('cardRemoval — conditionalAggrProb が全コンボのブルートフォース平均と一致', () => {
  for (const seed of [1, 42, 7777, 20260901]) {
    it(`seed=${seed}: 各クラス c で解析式 == 平均(ブルート per-pair)`, () => {
      const freq = randomFreq(seed);
      const { W, U } = weightAndUses(freq);
      const analytic = conditionalAggrProb(freq, W, U);

      for (let c = 0; c < N; c++) {
        // クラス c の全コンボ {x,y} に対する per-pair ブルートの平均。
        let acc = 0;
        for (const [x, y] of CLASS_COMBOS[c]!) {
          acc += bruteConditionalAggrProbForPair(freq, x, y);
        }
        const brute = acc / COMBO_COUNT[c]!;
        expect(analytic[c]!).toBeCloseTo(brute, 12);
      }
    });
  }

  it('全 push レンジ（freq=1）では card-blind 比 = 1（除去後も全員 push）', () => {
    const freq = new Float64Array(N).fill(1);
    const { W, U } = weightAndUses(freq);
    const p = conditionalAggrProb(freq, W, U);
    for (let c = 0; c < N; c++) expect(p[c]!).toBeCloseTo(1, 12);
  });

  it('全 fold（freq=0）では 0', () => {
    const freq = new Float64Array(N).fill(0);
    const { W, U } = weightAndUses(freq);
    const p = conditionalAggrProb(freq, W, U);
    for (let c = 0; c < N; c++) expect(p[c]!).toBe(0);
  });
});

describe('cardRemoval — 定性: hero が相手レンジと札を共有すると相手のアグレッシブ確率が下がる', () => {
  const classIdx = (label: string): number => {
    const i = HAND_CLASS_ORDER.indexOf(label);
    if (i < 0) throw new Error(`no such class ${label}`);
    return i;
  };

  it('相手レンジ=AA のみ のとき、p(AA) << p(72o)（hero が A を共有すると相手 AA が減る）', () => {
    const freq = new Float64Array(N);
    freq[classIdx('AA')] = 1;
    const { W, U } = weightAndUses(freq);
    const p = conditionalAggrProb(freq, W, U);
    // hero=AA は相手の AA コンボ 6→1 に削る → 1/1225。hero=72o は無干渉 → 6/1225。
    expect(p[classIdx('AA')]!).toBeCloseTo(1 / 1225, 12);
    expect(p[classIdx('72o')]!).toBeCloseTo(6 / 1225, 12);
    expect(p[classIdx('AA')]!).toBeLessThan(p[classIdx('72o')]!);
  });

  it('相手レンジ=AKs のみ のとき、hero が A や K を持つクラスは 72o より低い', () => {
    const freq = new Float64Array(N);
    freq[classIdx('AKs')] = 1;
    const { W, U } = weightAndUses(freq);
    const p = conditionalAggrProb(freq, W, U);
    const pJunk = p[classIdx('72o')]!; // A も K も持たない
    expect(p[classIdx('AA')]!).toBeLessThan(pJunk);
    expect(p[classIdx('KK')]!).toBeLessThan(pJunk);
    expect(p[classIdx('AKo')]!).toBeLessThan(pJunk);
  });
});
