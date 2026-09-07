/**
 * seatPresence の単体テスト（画像非依存の合成画像）。
 * 実画像での分離は scripts/accuracy.ts（Android GT の empty 30・occupied 102, iPhone GT 12）で検証。
 * ここでは「一様領域は present=false / ストロークのある領域は present=true」を固定する。
 */
import { describe, it, expect } from 'vitest';
import type { Rgba } from './color.js';
import type { Rect } from './types.js';
import { edgeDensity, detectSeatPresence, detectYellowName, isYellowNamePixel, nameBandFromStack } from './seatPresence.js';
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

describe('isYellowNamePixel', () => {
  it('実測レンジの黄色は true', () => {
    expect(isYellowNamePixel(240, 220, 20)).toBe(true); // 明るい黄
    expect(isYellowNamePixel(160, 145, 30)).toBe(true); // やや暗い黄
  });
  it('白/felt/青は false', () => {
    expect(isYellowNamePixel(240, 240, 240)).toBe(false); // 白（数字）: B が高い
    expect(isYellowNamePixel(30, 90, 60)).toBe(false); // 緑 felt
    expect(isYellowNamePixel(40, 60, 200)).toBe(false); // 青
  });
});

describe('detectYellowName', () => {
  // スタック矩形を上部に置き、その真下の名前帯に合成の黄色テキスト塊を描く。
  const stack: Rect = { x: 40, y: 10, w: 60, h: 20 };

  /** 一様 felt の画像。 */
  function felt(w: number, h: number): Rgba {
    const data = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) { data[i * 4] = 30; data[i * 4 + 1] = 90; data[i * 4 + 2] = 60; data[i * 4 + 3] = 255; }
    return { w, h, data };
  }

  it('empty 席相当（黄色なし）→ present=false, yellowRows=0', () => {
    const img = felt(180, 90);
    const y = detectYellowName(img, stack);
    expect(y.present).toBe(false);
    expect(y.yellowRows).toBe(0);
    expect(y.yellowFrac).toBe(0);
  });

  it('スタック直下・同一中心に黄色名の塊 → present=true', () => {
    const img = felt(180, 90);
    const band = nameBandFromStack(stack);
    // 名前塊: 帯の中央付近に複数行×十分な幅の黄色ブロックを描く（連続塊）。
    const bx = band.x + Math.floor(band.w * 0.3);
    const bw = Math.floor(band.w * 0.4);
    for (let y = band.y + 2; y < band.y + band.h - 2; y++)
      for (let x = bx; x < bx + bw; x++) {
        const s = (y * img.w + x) * 4;
        img.data[s] = 240; img.data[s + 1] = 220; img.data[s + 2] = 20;
      }
    const y = detectYellowName(img, stack);
    expect(y.present).toBe(true);
    expect(y.yellowRows).toBeGreaterThanOrEqual(4);
    expect(y.yellowFrac).toBeGreaterThan(0);
  });

  it('黄色が単一行のノイズだけ → present=false（連続塊でない）', () => {
    const img = felt(180, 90);
    const band = nameBandFromStack(stack);
    const yRow = band.y + 3;
    for (let x = band.x + 5; x < band.x + band.w - 5; x++) {
      const s = (yRow * img.w + x) * 4;
      img.data[s] = 240; img.data[s + 1] = 220; img.data[s + 2] = 20;
    }
    const y = detectYellowName(img, stack);
    expect(y.present).toBe(false); // 1 行のみ < minRows(4)
  });
});
