/**
 * float16 コーデックの単体テスト。事前計算テーブルの量子化に使うため、
 * 符号保存（=押し引き判定）と往復精度・特殊値を固定する。
 */
import { describe, it, expect } from 'vitest';
import { floatToHalfBits, halfBitsToFloat, encodeFloat16, decodeFloat16 } from '../src/halfFloat.js';

const rt = (x: number): number => halfBitsToFloat(floatToHalfBits(x));

describe('halfFloat コーデック', () => {
  it('代表値を相対誤差 <1e-3 で往復', () => {
    for (const x of [0, 1, -1, 0.5, -0.5, 2, 100, -100, 0.001, -0.001, 12.34, -7.89, 0.0625]) {
      const y = rt(x);
      if (x === 0) expect(y).toBe(0);
      else expect(Math.abs(y - x) / Math.abs(x)).toBeLessThan(1e-3);
    }
  });

  it('符号を完全に保存する（ゼロ交差＝押し引き判定の保存）', () => {
    // ゼロ近傍の小さな EV差でも符号が反転しないこと（float16 の非正規化数で表現可能）。
    for (const x of [1e-4, -1e-4, 3e-5, -3e-5, 1e-3, -1e-3, 0.02, -0.02]) {
      expect(Math.sign(rt(x))).toBe(Math.sign(x));
    }
  });

  it('特殊値: ±0 / ±Inf / NaN', () => {
    expect(rt(0)).toBe(0);
    expect(1 / rt(-0)).toBe(-Infinity); // 負のゼロ保存
    expect(rt(Infinity)).toBe(Infinity);
    expect(rt(-Infinity)).toBe(-Infinity);
    expect(Number.isNaN(rt(NaN))).toBe(true);
  });

  it('過大値は Inf に飽和（half の最大 ~65504 超）', () => {
    expect(rt(70000)).toBe(Infinity);
    expect(rt(-70000)).toBe(-Infinity);
    // half 最大付近は有限
    expect(Number.isFinite(rt(60000))).toBe(true);
  });

  it('配列 encode→decode が符号一致率100%（ランダム EV差レンジ）', () => {
    const n = 5000;
    const src = new Float32Array(n);
    let seed = 42;
    const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < n; i++) src[i] = (rnd() - 0.5) * 4; // [-2, 2] pt 相当
    const back = decodeFloat16(encodeFloat16(src));
    let signKept = 0;
    for (let i = 0; i < n; i++) if (Math.sign(src[i]!) === Math.sign(back[i]!)) signKept++;
    expect(signKept).toBe(n);
  });
});
