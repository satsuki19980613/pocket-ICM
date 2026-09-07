import { describe, it, expect } from 'vitest';
import {
  N_CLASSES3,
  N_TRIPLES3,
  PATTERNS,
  sortedTripleIndex,
  tripleIndex,
  patternIndexOf,
  permuteProbs13,
} from '../src/wintie3Index.js';

describe('wintie3Index: 基本定数', () => {
  it('N_TRIPLES3 は 169*170*171/6 = 818,805', () => {
    expect(N_CLASSES3).toBe(169);
    expect(N_TRIPLES3).toBe(818_805);
  });
  it('PATTERNS は 13 種類、各要素は長さ3で値 0..2', () => {
    expect(PATTERNS.length).toBe(13);
    for (const p of PATTERNS) {
      expect(p.length).toBe(3);
      for (const v of p) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(2);
      }
    }
  });
});

describe('sortedTripleIndex / tripleIndex: 辞書式インデックスの網羅検証', () => {
  it('全 818,805 通りのソート済み三つ組を辞書式順に列挙すると 0..818804 に一致する（全単射）', () => {
    const N = N_CLASSES3;
    let expected = 0;
    let mismatches = 0;
    for (let c1 = 0; c1 < N; c1++) {
      for (let c2 = c1; c2 < N; c2++) {
        for (let c3 = c2; c3 < N; c3++) {
          const got = sortedTripleIndex(c1, c2, c3);
          if (got !== expected) mismatches++;
          expected++;
        }
      }
    }
    expect(mismatches).toBe(0);
    expect(expected).toBe(N_TRIPLES3);
  });

  it('境界値: (0,0,0)=0, (168,168,168)=N_TRIPLES3-1', () => {
    expect(sortedTripleIndex(0, 0, 0)).toBe(0);
    expect(sortedTripleIndex(168, 168, 168)).toBe(N_TRIPLES3 - 1);
  });

  it('手計算で検算できる小さな index（c1=0 ブロック内）', () => {
    // c1=0, c2=0 の行: c3=0..168 が index 0..168。
    expect(sortedTripleIndex(0, 0, 0)).toBe(0);
    expect(sortedTripleIndex(0, 0, 1)).toBe(1);
    expect(sortedTripleIndex(0, 0, 168)).toBe(168);
    // c1=0, c2=1 の行はその直後（c3=1..168 の 168 通り）から始まる。
    expect(sortedTripleIndex(0, 1, 1)).toBe(169);
    expect(sortedTripleIndex(0, 1, 168)).toBe(169 + 167);
  });

  it('範囲外・非ソートの入力は例外', () => {
    expect(() => sortedTripleIndex(2, 1, 3)).toThrow();
    expect(() => sortedTripleIndex(0, 0, 169)).toThrow();
    expect(() => sortedTripleIndex(-1, 0, 0)).toThrow();
  });
});

describe('tripleIndex: 任意順の入力からの index/perm', () => {
  it('ソート済み入力なら perm は恒等 [0,1,2]', () => {
    const r = tripleIndex(3, 10, 50);
    expect(r.index).toBe(sortedTripleIndex(3, 10, 50));
    expect(r.perm).toEqual([0, 1, 2]);
  });

  it('全 6 通りの並び替えで index が一致し、perm が正しく元の添字を追跡する', () => {
    const [x, y, z] = [50, 3, 10]; // sorted: 3(idx1), 10(idx2), 50(idx0)
    const expectedIndex = sortedTripleIndex(3, 10, 50);
    const perms: [number, number, number][] = [
      [x, y, z],
      [x, z, y],
      [y, x, z],
      [y, z, x],
      [z, x, y],
      [z, y, x],
    ];
    for (const [a, b, c] of perms) {
      const r = tripleIndex(a, b, c);
      expect(r.index).toBe(expectedIndex);
      // perm[slot] は「ソート済みスロット slot に対応する元添字」。
      // スロット0の値は最小値(3)、スロット1は10、スロット2は50。
      const values = [a, b, c];
      expect(values[r.perm[0]]).toBe(3);
      expect(values[r.perm[1]]).toBe(10);
      expect(values[r.perm[2]]).toBe(50);
      // perm は [0,1,2] の置換になっている。
      expect([...r.perm].sort()).toEqual([0, 1, 2]);
    }
  });

  it('重複クラスがあっても index は一致し、perm は有効な置換であり続ける', () => {
    const triples: [number, number, number][] = [
      [5, 5, 9],
      [5, 9, 5],
      [9, 5, 5],
    ];
    const expectedIndex = sortedTripleIndex(5, 5, 9);
    for (const [a, b, c] of triples) {
      const r = tripleIndex(a, b, c);
      expect(r.index).toBe(expectedIndex);
      expect([...r.perm].sort()).toEqual([0, 1, 2]);
    }
  });

  it('全員同じクラスなら perm は恒等（安定ソートで元の順序が保たれる）', () => {
    const r = tripleIndex(7, 7, 7);
    expect(r.perm).toEqual([0, 1, 2]);
    expect(r.index).toBe(sortedTripleIndex(7, 7, 7));
  });
});

describe('patternIndexOf: 全 27 通り中 13 通りだけが有効', () => {
  it('PATTERNS に列挙された全パターンで自分自身の index が返る', () => {
    for (let n = 0; n < PATTERNS.length; n++) {
      const [p0, p1, p2] = PATTERNS[n]!;
      expect(patternIndexOf(p0, p1, p2)).toBe(n);
    }
  });
  it('PATTERNS に無い組み合わせ（例: [0,2,2] のような矛盾した dense ranking）は例外', () => {
    // [0,2,2] は「1位が1人、3位が2人」で 2 位が存在しない不正な dense ranking。
    expect(() => patternIndexOf(0, 2, 2)).toThrow();
  });
});

describe('permuteProbs13: パターン確率のプレイヤー順への並べ替え', () => {
  it('恒等 perm では並べ替えなし', () => {
    const probs = PATTERNS.map((_, i) => i / 100);
    const out = permuteProbs13(probs, [0, 1, 2]);
    expect(out).toEqual(probs);
  });

  it('確率の総和は並べ替えても保存される', () => {
    const probs = [0.5, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.03, 0.03, 0.03, 0.03, 0.02, 0.06];
    expect(probs.length).toBe(13);
    const sum = probs.reduce((a, b) => a + b, 0);
    for (const perm of allPerms3()) {
      const out = permuteProbs13(probs, perm);
      const outSum = out.reduce((a, b) => a + b, 0);
      expect(outSum).toBeCloseTo(sum, 10);
    }
  });

  it('具体例: tripleIndex(5,2,8) の perm=[1,0,2] で「スロット0が単独1位」が'
    + '「プレイヤー1(値2)が単独1位」に正しく写像される', () => {
    const { perm } = tripleIndex(5, 2, 8); // sorted: 2(idx1),5(idx0),8(idx2) → perm=[1,0,2]
    expect(perm).toEqual([1, 0, 2]);
    // PATTERNS[0] = [0,1,2]（スロット0が1位・スロット1が2位・スロット2が3位）に
    // 確率 1 を集中させたストレージ分布を用意する。
    const stored = new Array(13).fill(0);
    stored[patternIndexOf(0, 1, 2)] = 1;
    const out = permuteProbs13(stored, perm);
    // スロット0の持ち主はプレイヤー1（値2）→ プレイヤー1が1位。
    // スロット1の持ち主はプレイヤー0（値5）→ プレイヤー0が2位。
    // スロット2の持ち主はプレイヤー2（値8）→ プレイヤー2が3位。
    const expectedM = patternIndexOf(1, 0, 2); // [player0の順位, player1の順位, player2の順位]
    expect(out[expectedM]).toBe(1);
    const total = out.reduce((a, b) => a + b, 0);
    expect(total).toBe(1);
  });

  it('全タイ [0,0,0] はどの perm でも不変', () => {
    const stored = new Array(13).fill(0);
    stored[patternIndexOf(0, 0, 0)] = 1;
    for (const perm of allPerms3()) {
      const out = permuteProbs13(stored, perm);
      expect(out[patternIndexOf(0, 0, 0)]).toBe(1);
    }
  });

  it('不正な長さの配列は例外', () => {
    expect(() => permuteProbs13([1, 2, 3], [0, 1, 2])).toThrow();
  });
});

/** [0,1,2] の全 6 通りの置換を列挙するテスト用ヘルパー。 */
function allPerms3(): [number, number, number][] {
  const idxs = [0, 1, 2];
  const out: [number, number, number][] = [];
  for (const a of idxs) {
    for (const b of idxs) {
      if (b === a) continue;
      for (const c of idxs) {
        if (c === a || c === b) continue;
        out.push([a, b, c]);
      }
    }
  }
  return out;
}
