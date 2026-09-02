import { describe, it, expect } from 'vitest';
import { mapFrac, mapProfile, isFullFrame, FULL_FRAME } from './contentRect.js';
import { CHIPS_6MAX } from './frameProfile.js';

describe('contentRect mapping', () => {
  it('isFullFrame は全画面だけ真', () => {
    expect(isFullFrame(FULL_FRAME)).toBe(true);
    expect(isFullFrame({ x: 0.03, y: 0.015, w: 0.9, h: 0.9 })).toBe(false);
  });

  it('mapFrac は矩形を cr の中へアフィン写像する', () => {
    const cr = { x: 0.03, y: 0.015, w: 0.9, h: 0.9 };
    const r = mapFrac({ x: 0.5, y: 0.4, w: 0.1, h: 0.2 }, cr);
    expect(r.x).toBeCloseTo(0.48);
    expect(r.y).toBeCloseTo(0.375);
    expect(r.w).toBeCloseTo(0.09);
    expect(r.h).toBeCloseTo(0.18);
  });

  it('全画面 cr は恒等（同一参照を返す＝Android 無影響）', () => {
    expect(mapProfile(CHIPS_6MAX, FULL_FRAME)).toBe(CHIPS_6MAX);
  });

  it('mapProfile は全領域と席を写像する（席数・isHero は保持）', () => {
    const cr = { x: 0.03, y: 0.015, w: 0.9, h: 0.9 };
    const p = mapProfile(CHIPS_6MAX, cr);
    expect(p.seats.length).toBe(CHIPS_6MAX.seats.length);
    // 先頭席 stack が cr へ写像されている
    const s0 = CHIPS_6MAX.seats[0]!;
    expect(p.seats[0]!.stack.x).toBeCloseTo(cr.x + s0.stack.x * cr.w);
    expect(p.seats[0]!.stack.w).toBeCloseTo(s0.stack.w * cr.w);
    expect(p.seats[0]!.isHero).toBe(s0.isHero);
    // hero 席が保たれる
    expect(p.seats.filter((s) => s.isHero).length).toBe(1);
    // blinds 等トップレベル領域も写像
    expect(p.blindsNum.x).toBeCloseTo(cr.x + CHIPS_6MAX.blindsNum.x * cr.w);
  });
});
