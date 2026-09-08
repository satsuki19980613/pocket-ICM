/**
 * potAnchor（§B5）の単体テスト。合成画像に実テンプレのグリフ（数字＋"BB"）を白で描き、
 * 中央ピルの金額が BB アンカー方式で読めることを固定する。実フレームでの pot 精度は
 * scripts/_EXTRACT_RESULTS.md（27 枚＋劣化 1310 で pot 27/28, 1310 で 2.5 正読）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Rgba } from './color.js';
import { templatesFromJson } from './templates.js';
import type { Template } from './match.js';
import { readPotAnchored } from './potAnchor.js';

const A = 'packages/ocr/assets';
const digits = templatesFromJson(JSON.parse(readFileSync(`${A}/digits.json`, 'utf8')));
const letters = templatesFromJson(JSON.parse(readFileSync(`${A}/letters_bb.json`, 'utf8')));

const glyph = (ts: readonly Template[], label: string): Template =>
  ts.find((t) => t.label === label)!;

/** 暗い背景の合成フレーム（比 ~2.16）に、中央ピル帯へ白グリフ列を等間隔で描く。 */
function frameWithPot(labels: string[]): Rgba {
  const w = 1200, h = 555;
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = 20; data[i * 4 + 1] = 20; data[i * 4 + 2] = 20; data[i * 4 + 3] = 255; }
  // 中央ピル帯（DEFAULT_POT_REGION ~ x0.46 y0.305 の中）にグリフを横並び。
  let cx = Math.round(0.475 * w);
  const cy = Math.round(0.33 * h);
  for (const lb of labels) {
    const g = lb === 'B' ? glyph(letters, 'B') : glyph(digits, lb);
    const gw = g.img.w, gh = g.img.h;
    const x0 = cx, y0 = cy - Math.round(gh / 2);
    for (let y = 0; y < gh; y++)
      for (let x = 0; x < gw; x++) {
        if (g.img.data[y * gw + x]! < 128) continue; // グリフのインク部だけ白で描く
        const px = x0 + x, py = y0 + y;
        if (px < 0 || px >= w || py < 0 || py >= h) continue;
        const s = (py * w + px) * 4; data[s] = 255; data[s + 1] = 255; data[s + 2] = 255;
      }
    cx += gw + 4; // 次グリフ（小さめの間隔で数値クラスタを保つ）
  }
  return { w, h, data };
}

describe('readPotAnchored (central pill BB anchor)', () => {
  it('reads an integer pot "3 BB"', () => {
    const img = frameWithPot(['3', 'B', 'B']);
    const r = readPotAnchored(img, digits, letters, { scoreFloor: 0 });
    expect(r.value).toBeCloseTo(3, 5);
    expect(r.conf).toBeGreaterThan(0.5);
  });

  it('reads a multi-digit pot "12 BB"', () => {
    const img = frameWithPot(['1', '2', 'B', 'B']);
    const r = readPotAnchored(img, digits, letters, { scoreFloor: 0 });
    expect(r.value).toBeCloseTo(12, 5);
  });

  it('returns NaN when there is no BB suffix (chips-style number)', () => {
    const img = frameWithPot(['3', '0', '4']);
    const r = readPotAnchored(img, digits, letters, { scoreFloor: 0 });
    expect(Number.isNaN(r.value)).toBe(true);
  });
});
