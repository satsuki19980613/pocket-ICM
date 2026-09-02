/**
 * カード裏状態（active/folded）の合成テスト（画像非依存）。実画像は dev harness
 * （probeCardState）で 142820/142844 の active/folded 8/8 を確認済み（142844 は実物照合で
 * エージェント誤ラベルを訂正）。ここでは明るい青→active / 暗い青→folded / 紫→非active を固定する。
 */
import { describe, it, expect } from 'vitest';
import type { Rgba } from './color.js';
import type { Rect } from './types.js';
import { blueFractions, isActiveHand } from './cardState.js';

/** 単色で塗った領域。 */
function solid(r: number, g: number, b: number): Rgba {
  const w = 40, h = 40;
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255; }
  return { w, h, data };
}
const full = (b: Rgba): Rect => ({ x: 0, y: 0, w: b.w, h: b.h });

describe('blueFractions', () => {
  it('明るい青は strong も bright も高い', () => {
    const b = solid(60, 90, 200);
    const fr = blueFractions(b, full(b));
    expect(fr.strong).toBeGreaterThan(0.9);
    expect(fr.bright).toBeGreaterThan(0.9);
  });
  it('暗い紺は strong 高・bright 低', () => {
    const b = solid(20, 40, 110);
    const fr = blueFractions(b, full(b));
    expect(fr.strong).toBeGreaterThan(0.9);
    expect(fr.bright).toBe(0);
  });
  it('紫（B≈R）は strong 低', () => {
    const b = solid(100, 45, 130);
    expect(blueFractions(b, full(b)).strong).toBe(0);
  });
});

describe('isActiveHand', () => {
  it('明るい青カード → active', () => {
    const b = solid(60, 90, 200);
    expect(isActiveHand(b, full(b)).value).toBe(true);
  });
  it('暗い紺カード（フォールド）→ 非active', () => {
    const b = solid(20, 40, 110);
    expect(isActiveHand(b, full(b)).value).toBe(false);
  });
  it('紫背景（カード無し）→ 非active', () => {
    const b = solid(100, 45, 130);
    expect(isActiveHand(b, full(b)).value).toBe(false);
  });
});
