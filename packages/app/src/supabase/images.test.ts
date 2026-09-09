import { describe, it, expect } from 'vitest';
import { extForMime, fitWithin } from './images';

describe('fitWithin', () => {
  it('すでに上限以内なら元のサイズのまま', () => {
    expect(fitWithin(800, 600, 1600)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(1600, 1600, 1600)).toEqual({ width: 1600, height: 1600 });
  });

  it('横長: 長辺（幅）を上限に合わせ、アスペクト比を維持する', () => {
    // 3200x1800 → 長辺(幅)を1600に。高さは 1800*(1600/3200)=900。
    expect(fitWithin(3200, 1800, 1600)).toEqual({ width: 1600, height: 900 });
  });

  it('縦長: 長辺（高さ）を上限に合わせ、アスペクト比を維持する', () => {
    // 1200x2400 → 長辺(高さ)を1600に。幅は 1200*(1600/2400)=800。
    expect(fitWithin(1200, 2400, 1600)).toEqual({ width: 800, height: 1600 });
  });

  it('正方形は両辺とも上限に縮む', () => {
    expect(fitWithin(2000, 2000, 1600)).toEqual({ width: 1600, height: 1600 });
  });

  it('結果は最低でも1px（極端な入力でも0にならない）', () => {
    const r = fitWithin(1, 100000, 1600);
    expect(r.width).toBeGreaterThanOrEqual(1);
    expect(r.height).toBe(1600);
  });
});

describe('extForMime', () => {
  it('image/jpeg → jpg, image/png → png, それ以外(image/webp含む) → webp', () => {
    expect(extForMime('image/jpeg')).toBe('jpg');
    expect(extForMime('image/png')).toBe('png');
    expect(extForMime('image/webp')).toBe('webp');
    expect(extForMime('application/octet-stream')).toBe('webp');
  });
});
