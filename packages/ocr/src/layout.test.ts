import { describe, it, expect } from 'vitest';
import { toPx, resolveRegions, validateProfile, type LayoutProfile, type FracRect } from './layout.js';

function seatRegion(base: number): {
  stack: FracRect;
  bet: FracRect;
  button: FracRect;
  presence: FracRect;
} {
  const r = (dx: number): FracRect => ({ x: base + dx, y: 0.4, w: 0.05, h: 0.05 });
  return { stack: r(0), bet: r(0.05), button: r(0.1), presence: r(0.15) };
}

function profile(seats: number): LayoutProfile {
  return {
    name: 'test',
    aspect: 16 / 9,
    streetLabel: { x: 0.02, y: 0.02, w: 0.2, h: 0.05 },
    blindsLabel: { x: 0.02, y: 0.08, w: 0.2, h: 0.05 },
    pot: { x: 0.45, y: 0.4, w: 0.1, h: 0.06 },
    heroCard1: { x: 0.45, y: 0.8, w: 0.04, h: 0.1 },
    heroCard2: { x: 0.51, y: 0.8, w: 0.04, h: 0.1 },
    physicalSeats: Array.from({ length: seats }, (_, i) => seatRegion(0.05 + i * 0.13)),
  };
}

describe('toPx', () => {
  it('割合 → ピクセル', () => {
    const r = toPx({ x: 0.5, y: 0.25, w: 0.25, h: 0.5 }, 1920, 1080);
    expect(r).toEqual({ x: 960, y: 270, w: 480, h: 540 });
  });
  it('フレーム外はクランプ', () => {
    const r = toPx({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 }, 100, 100);
    expect(r.x).toBe(90);
    expect(r.w).toBe(10);
    expect(r.x + r.w).toBeLessThanOrEqual(100);
  });
});

describe('resolveRegions', () => {
  it('全席を解決し、座標はフレーム内', () => {
    const res = resolveRegions(profile(5), 1280, 720);
    expect(res.seats.length).toBe(5);
    for (const s of res.seats) {
      for (const rect of [s.stack, s.bet, s.button, s.presence]) {
        expect(rect.x).toBeGreaterThanOrEqual(0);
        expect(rect.x + rect.w).toBeLessThanOrEqual(1280);
        expect(rect.y + rect.h).toBeLessThanOrEqual(720);
      }
    }
  });
});

describe('validateProfile', () => {
  it('健全なプロファイルは issues なし', () => {
    expect(validateProfile(profile(6))).toEqual([]);
  });
  it('フレーム外の矩形を検出', () => {
    const p = profile(3);
    const bad: LayoutProfile = { ...p, pot: { x: 0.9, y: 0.9, w: 0.5, h: 0.5 } };
    expect(validateProfile(bad).join()).toMatch(/pot/);
  });
  it('席数レンジ外を検出', () => {
    const p = profile(2);
    const bad: LayoutProfile = { ...p, physicalSeats: [] };
    expect(validateProfile(bad).join()).toMatch(/physicalSeats/);
  });
});
