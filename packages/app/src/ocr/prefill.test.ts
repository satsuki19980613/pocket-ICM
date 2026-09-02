import { describe, it, expect } from 'vitest';
import type { ExtractTemplates, Rgba } from '@oshihiki/ocr';
import { ocrPrefillFromRgba } from './prefill';

/** bestMatch は空テンプレで throw するので、各種 1 グリフだけ与える。 */
const glyph = (label: string) => ({ label, img: { w: 1, h: 1, data: Uint8Array.from([255]) } });
const templates: ExtractTemplates = {
  digits: [glyph('0')],
  ranks: [glyph('A')],
  actions: [glyph('レイズ')],
  letters: [glyph('B')],
};

/** 全ゼロ（黒一色）の Rgba。占有・数字・カードいずれも検出されない。 */
function blackRgba(w: number, h: number): Rgba {
  return { w, h, data: new Uint8Array(w * h * 4) };
}

describe('ocrPrefillFromRgba', () => {
  it('黒一色フレームは対象外として ok=false・issues を返す（例外を投げない）', () => {
    const res = ocrPrefillFromRgba(blackRgba(800, 370), templates);
    expect(res.ok).toBe(false);
    expect(Array.isArray(res.issues)).toBe(true);
    expect(res.issues.length).toBeGreaterThan(0);
    expect(res.form).toBeUndefined();
    expect(Array.isArray(res.lowConfidenceFields)).toBe(true);
  });

  it('結果は常に issues / lowConfidenceFields を配列で持つ（契約）', () => {
    const res = ocrPrefillFromRgba(blackRgba(400, 185), templates);
    expect(res).toHaveProperty('ok');
    expect(res.issues).toBeInstanceOf(Array);
    expect(res.lowConfidenceFields).toBeInstanceOf(Array);
  });
});
