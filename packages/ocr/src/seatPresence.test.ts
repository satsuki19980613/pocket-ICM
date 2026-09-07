/**
 * seatPresence の単体テスト（画像非依存の合成画像）。
 * 実画像での分離は scripts/accuracy.ts（Android GT の empty 30・occupied 102, iPhone GT 12）で検証。
 * ここでは「一様領域は present=false / ストロークのある領域は present=true」を固定する。
 */
import { describe, it, expect } from 'vitest';
import type { Rgba } from './color.js';
import type { Rect } from './types.js';
import { edgeDensity, detectSeatPresence } from './seatPresence.js';
import { grayFromRgba } from './numberField.js';

function uniform(w: number, h: number, r = 30, g = 90, b = 60): Rgba {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255; }
  return { w, h, data };
}
/** 一様な felt に白の縦ストライプ（数字ストローク相当）を載せる。 */
function withStrokes(w: number, h: number, period = 4): Rgba {
  const img = uniform(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (x % period === 0) { const s = (y * w + x) * 4; img.data[s] = 240; img.data[s + 1] = 240; img.data[s + 2] = 240; }
  return img;
}
const full = (img: Rgba): Rect => ({ x: 0, y: 0, w: img.w, h: img.h });

describe('edgeDensity', () => {
  it('一様領域は≈0', () => {
    expect(edgeDensity(grayFromRgba(uniform(40, 20), full(uniform(40, 20))))).toBeLessThan(0.005);
  });
  it('ストローク領域は高い', () => {
    const img = withStrokes(40, 20);
    expect(edgeDensity(grayFromRgba(img, full(img)))).toBeGreaterThan(0.2);
  });
});

describe('detectSeatPresence', () => {
  // stackRect / plateRect は同一 img 上の矩形。左半分をスタック、右半分をプレートに見立てる。
  const stackRect: Rect = { x: 0, y: 0, w: 60, h: 24 };
  const plateRect: Rect = { x: 60, y: 0, w: 60, h: 24 };

  it('一様な felt（empty 席相当）は present=false', () => {
    const img = uniform(120, 24);
    const p = detectSeatPresence(img, stackRect, plateRect);
    expect(p.present).toBe(false);
    expect(p.stackEdge).toBeLessThan(0.04);
    expect(p.plateEdge).toBeLessThan(0.06);
  });

  it('スタックにストロークがある（occupied だが数字が NaN でも）→ present=true', () => {
    const img = withStrokes(120, 24); // 全面ストローク（スタック矩形にストローク＝占有）
    const p = detectSeatPresence(img, stackRect, plateRect);
    expect(p.present).toBe(true);
    expect(p.stackEdge).toBeGreaterThanOrEqual(0.04);
  });
});
