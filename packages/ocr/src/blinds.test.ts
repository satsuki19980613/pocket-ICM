/**
 * blinds 分割の合成テスト（画像非依存）。実画像は dev harness（probeExtract）で
 * blind level 4 種 6/6 を確認済み。ここでは '/' 分割ロジックを固定する。
 */
import { describe, it, expect } from 'vitest';
import type { Gray } from './types.js';
import type { Rgba } from './color.js';
import type { Template } from './match.js';
import { readBlinds } from './blinds.js';

function glyph(rows: string[]): Gray {
  const h = rows.length, w = rows[0]!.length;
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = rows[y]![x] === '#' ? 255 : 0;
  return { w, h, data };
}

// NCC で分離する形（ラベルだけが意味を持つ）。ONE=縦帯, ZERO=中空リング, SLASH=太い斜線。
const ONE = glyph(['.###.', '.###.', '.###.', '.###.', '.###.', '.###.', '.###.', '.###.']);
const ZERO = glyph(['#####', '#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '#####']);
const SLASH = glyph(['....#', '...##', '..##.', '.##..', '.##..', '##...', '##...', '#....']);

const templates: Template[] = [
  { label: '1', img: ONE },
  { label: '0', img: ZERO },
  { label: '/', img: SLASH },
];

/** ラベル列を白文字・暗背景の Rgba に描く（間 2px）。 */
function render(glyphs: Gray[]): Rgba {
  const gap = 2, pad = 2;
  const h = Math.max(...glyphs.map((g) => g.h)) + pad * 2;
  const w = pad * 2 + glyphs.reduce((a, g) => a + g.w, 0) + gap * (glyphs.length - 1);
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = 20; data[i * 4 + 1] = 20; data[i * 4 + 2] = 20; data[i * 4 + 3] = 255; }
  let x0 = pad;
  for (const g of glyphs) {
    for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
      if (g.data[y * g.w + x]! > 0) { const s = ((y + pad) * w + (x0 + x)) * 4; data[s] = 255; data[s + 1] = 255; data[s + 2] = 255; }
    }
    x0 += g.w + gap;
  }
  return { w, h, data };
}

describe('readBlinds', () => {
  it('"10/11" を sb=10, bb=11 に分割する', () => {
    const img = render([ONE, ZERO, SLASH, ONE, ONE]);
    const r = readBlinds(img, { x: 0, y: 0, w: img.w, h: img.h }, templates);
    expect(r.sb.value).toBe(10);
    expect(r.bb.value).toBe(11);
    // conf は [0,1]（合成フィクスチャの絶対値は問わない。品質は実画像 harness で担保）。
    expect(r.sb.conf).toBeGreaterThanOrEqual(0);
    expect(r.sb.conf).toBeLessThanOrEqual(1);
  });

  it('桁数が非対称 1//10 でもスラッシュ位置で分割する', () => {
    const img = render([ONE, SLASH, ONE, ZERO]);
    const r = readBlinds(img, { x: 0, y: 0, w: img.w, h: img.h }, templates);
    expect(r.sb.value).toBe(1);
    expect(r.bb.value).toBe(10);
  });

  it('区切りが無ければ両方 conf=0', () => {
    const img = render([ONE, ZERO]);
    const r = readBlinds(img, { x: 0, y: 0, w: img.w, h: img.h }, templates);
    expect(r.sb.conf).toBe(0);
    expect(r.bb.conf).toBe(0);
  });
});
