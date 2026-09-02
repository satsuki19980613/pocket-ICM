import { describe, it, expect } from 'vitest';
import { generateSpot, mulberry32, DEFAULT_FILTER } from './generate';

describe('generateSpot', () => {
  it('決定的（seed 固定で再現）', () => {
    const a = generateSpot(mulberry32(1));
    const b = generateSpot(mulberry32(1));
    expect(a).toEqual(b);
  });

  it('100 局面すべて妥当（人数一致・hero≠BB・スタック正・ブラインド投函）', () => {
    const rng = mulberry32(12345);
    for (let i = 0; i < 100; i++) {
      const s = generateSpot(rng);
      expect(DEFAULT_FILTER.counts).toContain(s.playersLeft);
      expect(s.seats.length).toBe(s.playersLeft);
      expect(s.heroPos).not.toBe('BB');
      // hero 席が存在する
      expect(s.seats.some((seat) => seat.pos === s.heroPos)).toBe(true);
      for (const seat of s.seats) expect(seat.stack).toBeGreaterThan(0);
      // ブラインドが投函されている
      expect(s.seats.find((seat) => seat.pos === 'SB')?.bet).toBe(0.5);
      expect(s.seats.find((seat) => seat.pos === 'BB')?.bet).toBe(1);
    }
  });

  it('counts フィルタを尊重する（HU 限定）', () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 30; i++) {
      const s = generateSpot(rng, { ...DEFAULT_FILTER, counts: [2] });
      expect(s.playersLeft).toBe(2);
      expect(s.heroPos).toBe('SB'); // HU 未開は SB のみ（BB はウォーク）
    }
  });
});
