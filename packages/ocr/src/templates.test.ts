import { describe, it, expect } from 'vitest';
import { templatesFromJson } from './templates.js';

describe('templatesFromJson', () => {
  it('object 形 { templates: { label: {w,h,data} } } を Template[] に変換', () => {
    const out = templatesFromJson({
      templates: {
        '0': { w: 2, h: 1, data: [10, 20] },
        '/': { w: 1, h: 2, data: [30, 40] },
      },
    });
    expect(out).toHaveLength(2);
    const byLabel = Object.fromEntries(out.map((t) => [t.label, t]));
    expect(byLabel['0']!.img.w).toBe(2);
    expect(byLabel['0']!.img.data).toBeInstanceOf(Uint8Array);
    expect(Array.from(byLabel['0']!.img.data)).toEqual([10, 20]);
    expect(byLabel['/']!.img.h).toBe(2);
  });

  it('array 形 { templates: [{label,w,h,data}] } を Template[] に変換', () => {
    const out = templatesFromJson({
      templates: [
        { label: 'レイズ', w: 1, h: 1, data: [255] },
        { label: 'B', w: 1, h: 1, data: [0] },
      ],
    });
    expect(out.map((t) => t.label)).toEqual(['レイズ', 'B']);
    expect(out[0]!.img.data).toBeInstanceOf(Uint8Array);
    expect(Array.from(out[1]!.img.data)).toEqual([0]);
  });

  it('array 形で label 欠落は投げる', () => {
    expect(() =>
      templatesFromJson({ templates: [{ w: 1, h: 1, data: [1] } as never] }),
    ).toThrow(/label/);
  });
});
