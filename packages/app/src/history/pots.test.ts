import { describe, expect, it } from 'vitest';

import { contestedPotChips, uncalledExcess } from './pots';

describe('uncalledExcess / contestedPotChips', () => {
  it('ヘッズアップ（2 要素）では常に 2×min(a,b) と一致する', () => {
    // SB がレイズしてBBが降りる（committed=[200(SB), 100(BB)]）のような非対称な例。
    expect(contestedPotChips([200, 100])).toBe(2 * Math.min(200, 100));
    expect(contestedPotChips([100, 200])).toBe(2 * Math.min(100, 200));
    // 両者ともコールし合った対称な例（上乗せ無し）。
    expect(contestedPotChips([1500, 1500])).toBe(2 * Math.min(1500, 1500));
    // 片方が 0（プリフロップの即 fold 相当）。
    expect(contestedPotChips([0, 100])).toBe(2 * Math.min(0, 100));
  });

  it('最大拠出が単独なら、2 番目に多い拠出額を超えた分が上乗せになる', () => {
    // 3 人・BTN が唯一 400 まで張り、他は 100 と 200 止まり＝上乗せは 400-200=200。
    expect(uncalledExcess([400, 100, 200])).toEqual({ seat: 0, amount: 200 });
    expect(contestedPotChips([400, 100, 200])).toBe(400 + 100 + 200 - 200); // 500
  });

  it('最大拠出が複数席で並んでいれば、互いにコールし合っているので上乗せは無い', () => {
    // 2 人が 1500 で並び、もう 1 人は 800（サイドポット構造）でも、1500 同士は
    // コールし合っているので「誰にも届いていない」上乗せは無い。
    expect(uncalledExcess([1500, 1500, 800])).toEqual({ seat: 0, amount: 0 });
    expect(contestedPotChips([1500, 1500, 800])).toBe(1500 + 1500 + 800); // 3800（Σcommitted と一致）
    // 3 人とも同額でも同じ（誰も上乗せしていない）。
    expect(uncalledExcess([2000, 2000, 2000]).amount).toBe(0);
    expect(contestedPotChips([2000, 2000, 2000])).toBe(6000);
  });

  it('空の並びは席 -1・上乗せ 0', () => {
    expect(uncalledExcess([])).toEqual({ seat: -1, amount: 0 });
    expect(contestedPotChips([])).toBe(0);
  });

  it('1 席だけ（誰も対抗していない）なら、その全額が上乗せになる', () => {
    expect(uncalledExcess([500])).toEqual({ seat: 0, amount: 500 });
    expect(contestedPotChips([500])).toBe(0);
  });
});
