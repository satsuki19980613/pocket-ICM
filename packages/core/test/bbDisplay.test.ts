/**
 * ポーカーチェイスの BB 表示の丸め（小数第 2 位を四捨五入）のテスト。
 * 期待値はすべて実機・公式 Web 版の画面で観測した組（チップ表示 ÷ BB → BB 表示）。
 */
import { describe, it, expect } from 'vitest';
import { formatBbDisplay, roundBbDisplay } from '../src/bbDisplay.js';

describe('roundBbDisplay', () => {
  it('実測: x.25 は x.3 に上がる（偶数丸めではない）', () => {
    expect(roundBbDisplay(5850 / 200)).toBe(29.3);
    expect(roundBbDisplay(6250 / 200)).toBe(31.3);
    expect(roundBbDisplay(12050 / 200)).toBe(60.3);
  });

  it('実測: x.75 は上がる／切り捨てではない', () => {
    expect(roundBbDisplay(5950 / 200)).toBe(29.8);
    expect(roundBbDisplay(5750 / 200)).toBe(28.8);
    expect(roundBbDisplay(0.5 + 1 + 0.25 * 5)).toBe(2.8); // Pixel 実機のポット
  });

  it('実測: 切り上げではない（3.0455 → 3.0）', () => {
    expect(roundBbDisplay(0.5 + 1 + (170 / 660) * 6)).toBe(3);
    expect(roundBbDisplay(0.5 + 1 + (100 / 390) * 2)).toBe(2);
  });

  it('足し算で生じる浮動小数の誤差で丸めを誤らない', () => {
    // 1.2 + 0.15 は 1.3499999999999999 になり、素朴な Math.round(x*10)/10 だと 1.3 に落ちる。
    expect(1.2 + 0.15).toBeLessThan(1.35);
    expect(Math.round((1.2 + 0.15) * 10) / 10).toBe(1.3);
    expect(roundBbDisplay(1.2 + 0.15)).toBe(1.4);
    expect(roundBbDisplay(0.7 + 0.35)).toBe(1.1); // 1.0499999999999998
    expect(roundBbDisplay(0.6 + 0.95)).toBe(1.6); // 1.5499999999999998
  });

  it('境界のすぐ下は上げない（二重丸めしない）', () => {
    expect(roundBbDisplay(2.7496)).toBe(2.7);
    expect(roundBbDisplay(2.74999)).toBe(2.7);
  });

  it('非有限値はそのまま返す', () => {
    expect(roundBbDisplay(NaN)).toBeNaN();
  });
});

describe('formatBbDisplay', () => {
  it('画面と同じく末尾の .0 を付けない', () => {
    expect(formatBbDisplay(3)).toBe('3');
    expect(formatBbDisplay(2.75)).toBe('2.8');
    expect(formatBbDisplay(29)).toBe('29');
  });
});
