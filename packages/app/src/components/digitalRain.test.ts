import { describe, it, expect } from 'vitest';
import { columnCount, makeColumn, stepColumn } from './DigitalRain';

/** 決定的な擬似乱数（テストを安定させる）。 */
function seq(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length]!;
}

describe('columnCount', () => {
  it('画面幅を列間隔で割り切り上げる', () => {
    expect(columnCount(375, 18)).toBe(21);
    expect(columnCount(360, 18)).toBe(20);
  });

  it('極端に狭くても最低1列（0除算・空配列を避ける）', () => {
    expect(columnCount(0, 18)).toBe(1);
    expect(columnCount(5, 18)).toBe(1);
  });
});

describe('makeColumn', () => {
  it('画面上端より上から降り始め、速度は 0.25〜1.0 に収まる', () => {
    for (const r of [0, 0.5, 0.999]) {
      const c = makeColumn(() => r);
      expect(c.y).toBeLessThanOrEqual(0);
      expect(c.speed).toBeGreaterThanOrEqual(0.25);
      // 1 行/フレームを超えると尾が飛び飛びになるので上限は 1。
      expect(c.speed).toBeLessThanOrEqual(1);
    }
  });
});

describe('stepColumn', () => {
  it('速度ぶんだけ下へ進む', () => {
    const c = stepColumn({ y: 3, speed: 0.5, hot: 0.1 }, 40, () => 0.5);
    expect(c.y).toBeCloseTo(3.5, 6);
    expect(c.speed).toBe(0.5);
    expect(c.hot).toBe(0.1);
  });

  it('画面下を抜けたら上へ戻し、速度と hot を引き直す', () => {
    const c = stepColumn({ y: 100, speed: 0.5, hot: 0.1 }, 40, seq([0.25, 0.8, 0.95]));
    expect(c.y).toBeLessThanOrEqual(0);
    expect(c.speed).toBeCloseTo(0.25 + 0.8 * 0.75, 6);
    expect(c.hot).toBe(0.95);
  });

  it('下端ちょうど付近ではまだ戻さない（尾が画面内に残るように余白を持つ）', () => {
    const c = stepColumn({ y: 40, speed: 1, hot: 0.1 }, 40, () => 0.5);
    expect(c.y).toBe(41);
  });
});
