import { describe, it, expect } from 'vitest';
import type { Rect } from './types.js';
import type { Rgba } from './color.js';
import { cornerOf } from './detect.js';
import type { Template } from './match.js';
import { recognizeCardColor, recognizeHeroHandColor, rankGlyph } from './cards.js';

/** 白地のカード画像に、左上ランク角へ指定色のパターンを描く合成カード。 */
function synthCard(
  w: number,
  h: number,
  ink: [number, number, number],
  pattern: (x: number, y: number) => boolean,
): Rgba {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = 255; data[i * 4 + 1] = 255; data[i * 4 + 2] = 255; data[i * 4 + 3] = 255;
  }
  const rank = cornerOf({ x: 0, y: 0, w, h }, 0.5, 0.42);
  for (let y = rank.y; y < rank.y + rank.h; y++)
    for (let x = rank.x; x < rank.x + rank.w; x++) {
      if (pattern(x - rank.x, y - rank.y)) {
        const i = (y * w + x) * 4;
        data[i] = ink[0]; data[i + 1] = ink[1]; data[i + 2] = ink[2];
      }
    }
  return { w, h, data };
}

/** 認識と同じ rankGlyph で正規化してテンプレを作る（単一の真実）。 */
function rankTemplateFrom(img: Rgba, card: Rect, label: string): Template {
  return { label, img: rankGlyph(img, card) };
}

// 2 つの異なるパターン。rankGlyph=bandTight は暗成分の外接矩形にタイト化する（内部の明色は残す）
// ので、正規化後も質感が残るよう **内部に穴のある単一連結成分** にする（リング vs プラス）。
const inBox = (x: number, y: number) => x < 20 && y < 26;
const patA = (x: number, y: number) => inBox(x, y) && (x < 3 || x >= 17 || y < 3 || y >= 23); // リング（枠）
const patB = (x: number, y: number) => inBox(x, y) && ((x >= 8 && x < 12) || (y >= 11 && y < 15)); // プラス（十字）

describe('recognizeCardColor', () => {
  it('青インクのパターン → ランク＋ダイヤ', () => {
    const card: Rect = { x: 0, y: 0, w: 40, h: 60 };
    const img = synthCard(40, 60, [41, 90, 238], patA); // 青
    const tpl = rankTemplateFrom(img, card, '7');
    const tplOther = rankTemplateFrom(synthCard(40, 60, [16, 16, 16], patB), card, 'K');
    const r = recognizeCardColor(img, card, [tpl, tplOther]);
    expect(r.value).toBe('7d');
    expect(r.conf).toBeGreaterThan(0.8);
  });

  it('描画 "10" は core の T に正規化される', () => {
    const card: Rect = { x: 0, y: 0, w: 40, h: 60 };
    const img = synthCard(40, 60, [215, 55, 63], patA); // 赤
    const tpl = rankTemplateFrom(img, card, '10');
    const r = recognizeCardColor(img, card, [tpl]);
    expect(r.value).toBe('Th'); // 10♥ → Th
  });
});

describe('recognizeHeroHandColor', () => {
  it('2 枚 → ハンドクラス（スーテッド）', () => {
    const card1: Rect = { x: 0, y: 0, w: 40, h: 60 };
    // 同一画像内に 2 枚を並べる
    const img: Rgba = { w: 80, h: 60, data: new Uint8Array(80 * 60 * 4) };
    for (let i = 0; i < 80 * 60; i++) { img.data[i * 4] = 255; img.data[i * 4 + 1] = 255; img.data[i * 4 + 2] = 255; img.data[i * 4 + 3] = 255; }
    // card1: 赤(ハート) patA, card2: 赤(ハート) patB → 両方ハート＝スーテッド
    const paint = (ox: number, ink: [number, number, number], pat: (x: number, y: number) => boolean) => {
      const c = cornerOf({ x: ox, y: 0, w: 40, h: 60 }, 0.5, 0.42);
      for (let y = c.y; y < c.y + c.h; y++)
        for (let x = c.x; x < c.x + c.w; x++)
          if (pat(x - c.x, y - c.y)) { const i = (y * 80 + x) * 4; img.data[i] = ink[0]; img.data[i + 1] = ink[1]; img.data[i + 2] = ink[2]; }
    };
    paint(0, [215, 55, 63], patA);
    paint(40, [215, 55, 63], patB);
    const c1: Rect = { x: 0, y: 0, w: 40, h: 60 };
    const c2: Rect = { x: 40, y: 0, w: 40, h: 60 };
    const tplA = rankTemplateFrom(img, c1, 'A');
    const tplK = rankTemplateFrom(img, c2, 'K');
    const r = recognizeHeroHandColor(img, c1, c2, [tplA, tplK]);
    expect(r.value).toBe('AKs');
  });
});
