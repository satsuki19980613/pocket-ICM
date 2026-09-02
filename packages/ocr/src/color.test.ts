import { describe, it, expect } from 'vitest';
import { classifySuitColor, inkMeanRGB, recognizeSuit, type Rgba } from './color.js';

describe('classifySuitColor（4 色デッキ）', () => {
  it('実測平均色を正しく分類', () => {
    expect(classifySuitColor(215, 55, 63)).toBe('h'); // 赤
    expect(classifySuitColor(41, 90, 238)).toBe('d'); // 青
    expect(classifySuitColor(33, 134, 76)).toBe('c'); // 緑
    expect(classifySuitColor(16, 16, 16)).toBe('s'); // 黒
  });
  it('低彩度は黒（スペード）', () => {
    expect(classifySuitColor(120, 122, 118)).toBe('s');
    expect(classifySuitColor(30, 30, 30)).toBe('s');
  });
});

function solid(w: number, h: number, R: number, G: number, B: number): Rgba {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = R; data[i * 4 + 1] = G; data[i * 4 + 2] = B; data[i * 4 + 3] = 255;
  }
  return { w, h, data };
}

describe('inkMeanRGB', () => {
  it('白背景を除外してインク平均を出す', () => {
    // 4x1: 2 白 + 2 赤
    const data = new Uint8Array(4 * 1 * 4);
    const set = (i: number, r: number, g: number, b: number) => {
      data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255;
    };
    set(0, 255, 255, 255); set(1, 255, 255, 255); set(2, 210, 50, 60); set(3, 220, 60, 50);
    const img: Rgba = { w: 4, h: 1, data };
    const m = inkMeanRGB(img, { x: 0, y: 0, w: 4, h: 1 });
    expect(m.ink).toBe(2);
    expect(m.R).toBeCloseTo(215);
  });
});

describe('recognizeSuit', () => {
  it('青一様はダイヤ、conf 高め', () => {
    const img = solid(10, 10, 41, 90, 238);
    const r = recognizeSuit(img, { x: 0, y: 0, w: 10, h: 10 });
    expect(r.value).toBe('d');
    expect(r.conf).toBeGreaterThan(0.8);
  });
  it('黒一様はスペード', () => {
    const img = solid(10, 10, 16, 16, 16);
    const r = recognizeSuit(img, { x: 0, y: 0, w: 10, h: 10 });
    expect(r.value).toBe('s');
  });
});
