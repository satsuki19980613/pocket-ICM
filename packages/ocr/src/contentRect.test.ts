import { describe, it, expect } from 'vitest';
import { mapFrac, mapProfile, isFullFrame, FULL_FRAME, detectContentBox } from './contentRect.js';
import { CHIPS_6MAX } from './frameProfile.js';
import type { Rgba } from './color.js';

/** 黒縁＋明るい内側の合成画像を作る（内側は割合矩形 [x0,y0,x1)×[y0,y1)）。 */
function framed(w: number, h: number, x0: number, y0: number, x1: number, y1: number): Rgba {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const inside = x >= x0 && x < x1 && y >= y0 && y < y1;
      const v = inside ? 200 : 0;
      const i = (y * w + x) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  return { w, h, data };
}

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

describe('detectContentBox（黒帯検出）', () => {
  it('左右ピラーボックスの内側矩形を返す（ブラウザ 16:9 相当）', () => {
    const img = framed(100, 100, 20, 0, 80, 100); // 左右に黒帯, 上下なし
    const box = detectContentBox(img);
    expect(box.x).toBeCloseTo(0.2, 2);
    expect(box.w).toBeCloseTo(0.6, 2);
    expect(box.y).toBeCloseTo(0, 2);
    expect(box.h).toBeCloseTo(1, 2);
  });

  it('上下レターボックスの内側矩形を返す', () => {
    const img = framed(100, 100, 0, 15, 100, 85);
    const box = detectContentBox(img);
    expect(box.y).toBeCloseTo(0.15, 2);
    expect(box.h).toBeCloseTo(0.7, 2);
    expect(box.x).toBeCloseTo(0, 2);
    expect(box.w).toBeCloseTo(1, 2);
  });

  it('帯が無ければ全画面（Android/実機は無影響）', () => {
    const img = framed(100, 100, 0, 0, 100, 100);
    const box = detectContentBox(img);
    expect(box.x).toBeCloseTo(0, 2);
    expect(box.y).toBeCloseTo(0, 2);
    expect(box.w).toBeCloseTo(1, 2);
    expect(box.h).toBeCloseTo(1, 2);
  });
});
