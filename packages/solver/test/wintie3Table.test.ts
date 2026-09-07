import { describe, it, expect } from 'vitest';
import { MapWinTie3Table, buildWinTie3Table, buildDotWeights } from '../src/wintie3Table.js';
import { N_TRIPLES3, PATTERNS } from '../src/wintie3Index.js';

const N_PATTERNS = PATTERNS.length; // 13

/** シードつき決定的疑似乱数（テスト内だけで使う軽量 LCG）。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** lookup() が返す 13 パターン確率 + validCount から、素朴に Σ prob_n * U[permId][n] を計算する
 * 「明示的な」参照実装（dot() の最適化を経由しない）。 */
function explicitDot(
  probs: Float64Array,
  validCount: number,
  U: Float64Array,
  permId: number,
): number {
  let acc = 0;
  for (let n = 0; n < N_PATTERNS; n++) acc += probs[n]! * U[permId * N_PATTERNS + n]!;
  return validCount * acc;
}

describe('WinTie3Table.dot — permutation 方向の正しさ', () => {
  // ランダムな U（6×13 は buildDotWeights が組むので、ここではプレイヤー順パターン index
  // n に対する「目標ベクトル T」をランダムに与え、buildDotWeights で U に変換する）。
  const rng = mulberry32(0xdeadbeef);
  const T = Float64Array.from({ length: N_PATTERNS }, () => rng() * 2 - 1);
  const U = new Float64Array(6 * N_PATTERNS);
  buildDotWeights(T, U);

  function checkTable(table: { lookup: (x: number, y: number, z: number, out: Float64Array) => number; dot: (x: number, y: number, z: number, U: Float64Array, vcOut: Int32Array) => number }, label: string): void {
    it(`${label}: dot() は lookup()+explicit dot と全 6 順序・複数三つ組で一致する`, () => {
      const out = new Float64Array(N_PATTERNS);
      const vcOut = new Int32Array(1);
      const classesToTry = [0, 1, 2, 5, 10, 40, 80, 120, 168];
      let checked = 0;
      for (const a of classesToTry) {
        for (const b of classesToTry) {
          for (const c of classesToTry) {
            // 6 通りの並び (a,b,c) 全順列を試す（タイのケースも含む）。
            const perms: [number, number, number][] = [
              [a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a],
            ];
            for (const [x, y, z] of perms) {
              const validCount = table.lookup(x, y, z, out);
              // out は「プレイヤー順パターン index n」の確率（PATTERNS[n] をそのまま (x,y,z) の
              // 着順として解釈したもの）なので、permId は不要 — explicitDot は単純に
              // Σ_n out[n] * T[n] を validCount 倍すればよい（U の permId 次元を経由しない
              // 素朴な計算で dot() の結果を検算する）。
              let naive = 0;
              for (let n = 0; n < N_PATTERNS; n++) naive += out[n]! * T[n]!;
              naive *= validCount;

              const dotVal = table.dot(x, y, z, U, vcOut);
              expect(vcOut[0]).toBe(validCount);
              expect(dotVal).toBeCloseTo(naive, 6);
              checked++;
            }
          }
        }
      }
      expect(checked).toBeGreaterThan(0);
    });
  }

  // (1) MapWinTie3Table 上でのランダムエントリ（fromSortedTriples で全 9^3 通り、
  // 重複除去は Map が担う）。
  const triples: { c1: number; c2: number; c3: number; probs13: Float64Array; valid: number }[] = [];
  {
    const classes = [0, 1, 2, 5, 10, 40, 80, 120, 168];
    const rng2 = mulberry32(0x1234);
    for (const a of classes) {
      for (const b of classes) {
        for (const c of classes) {
          const sorted = [a, b, c].sort((p, q) => p - q) as [number, number, number];
          const [c1, c2, c3] = sorted;
          // ランダムだが正規化済みの 13 パターン確率を作る（合計 1）。
          const raw = Float64Array.from({ length: N_PATTERNS }, () => rng2());
          let sum = 0;
          for (let n = 0; n < N_PATTERNS; n++) sum += raw[n]!;
          const probs13 = raw.map((v) => v / sum);
          triples.push({ c1, c2, c3, probs13, valid: 100 + Math.floor(rng2() * 1000) });
        }
      }
    }
  }
  const mapTable = MapWinTie3Table.fromSortedTriples(triples);
  checkTable(mapTable, 'MapWinTie3Table');

  // (2) buildWinTie3Table 上での合成フルテーブル（小さめの合成データで十分）。
  {
    const N = 169;
    const u16 = new Uint16Array(N_TRIPLES3 * 13);
    const rng3 = mulberry32(0x9999);
    // 全三つ組を埋めるとテストが重いので、対象の classesToTry の三つ組だけ非ゼロにし、
    // 残りはゼロのまま（lookup/dot 双方が同じデータを読むので整合性検証には十分）。
    for (let idx = 0; idx < N_TRIPLES3; idx++) {
      const base = idx * 13;
      const raw = new Float64Array(12);
      let sum = 0;
      for (let n = 0; n < 12; n++) {
        raw[n] = rng3();
        sum += raw[n]!;
      }
      // 合計が 1 を超えないように正規化（13 個目は 1-sum で復元される契約）。
      const scale = sum > 0 ? (0.2 + 0.7 * rng3()) / sum : 0;
      for (let n = 0; n < 12; n++) u16[base + n] = Math.round(raw[n]! * scale * 65535);
      u16[base + 12] = Math.floor(rng3() * 1728);
    }
    void N;
    const table = buildWinTie3Table(u16, { dims: 169, nTriples: N_TRIPLES3 });
    checkTable(table, 'buildWinTie3Table (合成データ)');
  }
});
