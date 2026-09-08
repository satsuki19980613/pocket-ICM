/**
 * upscaleNormalize（§B2）の単体テスト（画像非依存の合成画像）。
 * 実解像度横断の実証は scripts/_SEATENUM_RESULTS.md（Android2730=恒等・iOS1792=1.26×・劣化1310=1.85×）。
 * ここでは「大きいグリフは恒等 / 小さいグリフは拡大 / 倍率は上限内」を固定する。
 */
import { describe, it, expect } from 'vitest';
import type { Rgba } from './color.js';
import { estimateGlyphScale, normalizeForAnchors, MAX_UPSCALE, TARGET_NAME_H_PX } from './upscaleNormalize.js';

const YELLOW = { r: 255, g: 200, b: 0 };

/** felt 一様背景に、指定高さの黄色名バーを複数本描く合成フレーム。 */
function frameWithNames(w: number, h: number, nameH: number, ys: number[]): Rgba {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = 30; data[i * 4 + 1] = 90; data[i * 4 + 2] = 60; data[i * 4 + 3] = 255; }
  const barW = Math.round(w * 0.08);
  const x0 = Math.round(w * 0.4);
  for (const cy of ys) {
    const y0 = Math.round(cy * h - nameH / 2);
    for (let y = y0; y < y0 + nameH; y++)
      for (let x = x0; x < x0 + barW; x++) {
        if (y < 0 || y >= h || x < 0 || x >= w) continue;
        const s = (y * w + x) * 4; data[s] = YELLOW.r; data[s + 1] = YELLOW.g; data[s + 2] = YELLOW.b;
      }
  }
  return { w, h, data };
}

describe('estimateGlyphScale', () => {
  it('returns identity (scale 1) when no yellow names present', () => {
    const data = new Uint8Array(1200 * 600 * 4).fill(0);
    for (let i = 0; i < 1200 * 600; i++) { data[i * 4] = 30; data[i * 4 + 1] = 90; data[i * 4 + 2] = 60; data[i * 4 + 3] = 255; }
    const gs = estimateGlyphScale({ w: 1200, h: 600, data });
    expect(gs.scale).toBe(1);
    expect(gs.samples).toBe(0);
  });

  it('scale is always within [1, MAX_UPSCALE]', () => {
    for (const nameH of [4, 10, 24, 40, 80]) {
      const gs = estimateGlyphScale(frameWithNames(1200, 600, nameH, [0.3, 0.5, 0.7]));
      expect(gs.scale).toBeGreaterThanOrEqual(1);
      expect(gs.scale).toBeLessThanOrEqual(MAX_UPSCALE);
    }
  });

  it('small glyphs drive scale up toward the template target', () => {
    const gs = estimateGlyphScale(frameWithNames(1200, 600, 10, [0.3, 0.5, 0.7]));
    // 10px 名前 → 目標 24px ≈ 2.4×（上限内）。
    expect(gs.medianNameH).toBeGreaterThanOrEqual(8);
    expect(gs.medianNameH).toBeLessThanOrEqual(14);
    expect(gs.scale).toBeGreaterThan(1.8);
    expect(gs.scale).toBeCloseTo(TARGET_NAME_H_PX / gs.medianNameH, 5);
  });
});

describe('normalizeForAnchors', () => {
  it('is identity for large-glyph (already-readable) input', () => {
    const img = frameWithNames(1200, 600, 30, [0.3, 0.5, 0.7]); // 30px >= target 24 → no upscale
    const out = normalizeForAnchors(img);
    expect(out.scale).toBe(1);
    expect(out.img.w).toBe(1200);
    expect(out.img.h).toBe(600);
    expect(out.img).toBe(img); // 恒等は同一参照
  });

  it('upscales small-glyph (low-res) input, preserving aspect', () => {
    const img = frameWithNames(1200, 600, 9, [0.3, 0.5, 0.7]);
    const out = normalizeForAnchors(img);
    expect(out.scale).toBeGreaterThan(1.5);
    expect(out.img.w).toBe(Math.round(1200 * out.scale));
    expect(out.img.h).toBe(Math.round(600 * out.scale));
    expect(out.img.w / out.img.h).toBeCloseTo(2, 1);
  });

  it('caps upscale at MAX_UPSCALE for extremely small glyphs', () => {
    const img = frameWithNames(1200, 600, 3, [0.3, 0.5, 0.7]);
    const out = normalizeForAnchors(img);
    expect(out.scale).toBeLessThanOrEqual(MAX_UPSCALE);
  });
});
