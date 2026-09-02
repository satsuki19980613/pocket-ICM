/**
 * 数字フィールド認識の合成テスト（画像非依存）。実画像の accuracy は dev harness
 * （scripts/verifyFrame.ts, 85/88）で担保し、ここでは白マスク・連結成分・組み立ての
 * ロジックを合成フィクスチャで固定する。
 */
import { describe, it, expect } from 'vitest';
import type { Gray } from './types.js';
import type { Rgba } from './color.js';
import type { Template } from './match.js';
import {
  whiteMask,
  binaryComponents,
  digitComponents,
  recognizeAmount,
} from './numberField.js';

/** Gray グリフ（前景=255）を作る簡易ヘルパ。 */
function glyph(rows: string[]): Gray {
  const h = rows.length, w = rows[0]!.length;
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = rows[y]![x] === '#' ? 255 : 0;
  return { w, h, data };
}

// 6x8 の合成グリフ。'0' は境界がベタ連結の中空リング（縦投影なら割れるが連結成分なら 1 個）。
const ZERO = glyph([
  '######',
  '#....#',
  '#....#',
  '#....#',
  '#....#',
  '#....#',
  '#....#',
  '######',
]);
const ONE = glyph([
  '..##..',
  '.###..',
  '..##..',
  '..##..',
  '..##..',
  '..##..',
  '..##..',
  '.####.',
]);

/** Gray 群を横に並べて白文字・暗背景の Rgba に描く（間に 2px 空ける）。任意で右端に赤い装飾ブロック。 */
function renderRow(glyphs: Gray[], opts: { redBlock?: boolean } = {}): { img: Rgba; gap: number } {
  const gap = 2, pad = 2;
  const h = Math.max(...glyphs.map((g) => g.h)) + pad * 2;
  const redW = opts.redBlock ? 10 : 0;
  const w = pad * 2 + glyphs.reduce((a, g) => a + g.w, 0) + gap * (glyphs.length - 1) + redW;
  const data = new Uint8Array(w * h * 4);
  // 暗い背景。
  for (let i = 0; i < w * h; i++) { data[i * 4] = 20; data[i * 4 + 1] = 20; data[i * 4 + 2] = 20; data[i * 4 + 3] = 255; }
  let x0 = pad;
  for (const g of glyphs) {
    for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
      if (g.data[y * g.w + x]! > 0) {
        const s = ((y + pad) * w + (x0 + x)) * 4;
        data[s] = 255; data[s + 1] = 255; data[s + 2] = 255;
      }
    }
    x0 += g.w + gap;
  }
  if (opts.redBlock) {
    for (let y = pad; y < pad + 8; y++) for (let x = w - redW; x < w; x++) {
      const s = (y * w + x) * 4; data[s] = 220; data[s + 1] = 40; data[s + 2] = 40;
    }
  }
  return { img: { w, h, data }, gap };
}

const templates: Template[] = [
  { label: '0', img: ZERO },
  { label: '1', img: ONE },
];

describe('whiteMask', () => {
  it('白文字だけを前景にし、赤い装飾は除外する', () => {
    const { img } = renderRow([ONE, ZERO], { redBlock: true });
    const mask = whiteMask(img, { x: 0, y: 0, w: img.w, h: img.h });
    // 前景画素は白グリフのみ（赤ブロックは 0）。
    let fg = 0;
    for (let i = 0; i < mask.data.length; i++) if (mask.data[i]! > 0) fg++;
    const white = countInk(ONE) + countInk(ZERO);
    expect(fg).toBe(white); // 赤は 1 画素も拾わない
  });
});

describe('binaryComponents', () => {
  it('中空の 0 を 1 成分として返す（縦投影のように割らない）', () => {
    const { img } = renderRow([ZERO]);
    const mask = whiteMask(img, { x: 0, y: 0, w: img.w, h: img.h });
    expect(binaryComponents(mask).length).toBe(1);
  });
  it('2 つのグリフを左→右で 2 成分に分ける', () => {
    const { img } = renderRow([ONE, ZERO]);
    const mask = whiteMask(img, { x: 0, y: 0, w: img.w, h: img.h });
    const cc = binaryComponents(mask);
    expect(cc.length).toBe(2);
    expect(cc[0]!.x).toBeLessThan(cc[1]!.x);
  });
});

describe('digitComponents', () => {
  it('背の低い成分（コンマ相当）を落とす', () => {
    const comma = glyph(['...', '...', '...', '...', '...', '###', '###', '###']); // 下部の低い塊(高さ3<数字8)
    const { img } = renderRow([ONE, comma, ZERO]);
    const mask = whiteMask(img, { x: 0, y: 0, w: img.w, h: img.h });
    // 連結成分は 3 個だが、数字成分は 2 個。
    expect(binaryComponents(mask).length).toBe(3);
    expect(digitComponents(mask).length).toBe(2);
  });
});

describe('recognizeAmount', () => {
  it('"10" を 10 と読み、信頼度が高い', () => {
    const { img } = renderRow([ONE, ZERO], { redBlock: true });
    const r = recognizeAmount(img, { x: 0, y: 0, w: img.w, h: img.h }, templates);
    expect(r.value).toBe(10);
    expect(r.conf).toBeGreaterThan(0.8);
  });
  it('"101" を 101 と読む', () => {
    const { img } = renderRow([ONE, ZERO, ONE]);
    const r = recognizeAmount(img, { x: 0, y: 0, w: img.w, h: img.h }, templates);
    expect(r.value).toBe(101);
  });
  it('数字が無ければ value=NaN, conf=0', () => {
    const img: Rgba = { w: 4, h: 4, data: new Uint8Array(4 * 4 * 4).fill(20) };
    const r = recognizeAmount(img, { x: 0, y: 0, w: 4, h: 4 }, templates);
    expect(Number.isNaN(r.value)).toBe(true);
    expect(r.conf).toBe(0);
  });
});

function countInk(g: Gray): number {
  let n = 0;
  for (let i = 0; i < g.data.length; i++) if (g.data[i]! > 0) n++;
  return n;
}
