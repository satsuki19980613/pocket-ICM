/**
 * bbAmount の合成テスト（画像非依存）。実画像は dev harness（probeBbFull / extractFrame）で
 * hero 45/45・4 フレーム全席 24/24・モード判定 hero 101/101 を確認済み。
 * ここでは「末尾 BB を落とす」「小数点を残す」「末尾 2 tall が B なら bb」ロジックを固定する。
 */
import { describe, it, expect } from 'vitest';
import type { Gray } from './types.js';
import type { Rgba } from './color.js';
import type { Template } from './match.js';
import { readAmountBb, stackEndsWithBb, detectDisplayMode } from './bbAmount.js';

/** パターンを 1 セル k×k px に拡大して Gray 化（実画像比率に合わせ数字を大きく）。 */
function glyph(rows: string[], k = 4): Gray {
  const ph = rows.length, pw = rows[0]!.length;
  const w = pw * k, h = ph * k;
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = rows[(y / k) | 0]![(x / k) | 0] === '#' ? 255 : 0;
  return { w, h, data };
}

// NCC で分離する形（ラベルだけが意味を持つ）。数字は h32、小数点は h6（実画像比率）。
const TWO = glyph(['#####', '....#', '....#', '#####', '#....', '#....', '#....', '#####']); // 2 形（分散あり）
const ZERO = glyph(['#####', '#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '#####']); // 中空
const BEE = glyph(['#####', '#...#', '#...#', '#####', '#...#', '#...#', '#####', '#####']); // B 形（連結）
const DOT: Gray = { w: 6, h: 6, data: new Uint8Array(36).fill(255) }; // 小数点（背が低い）
const DOT4: Gray = { w: 5, h: 4, data: new Uint8Array(20).fill(255) }; // 薄い小数点（folded/暗プレート, h=4, area=20）

const digits: Template[] = [{ label: '2', img: TWO }, { label: '0', img: ZERO }];
const letters: Template[] = [{ label: 'B', img: BEE }];

/** ラベル列を白文字・暗背景の Rgba に描く。tall はベースライン揃え、DOT は下寄せ。 */
function render(glyphs: Gray[]): Rgba {
  const gap = 3, pad = 3;
  const H = Math.max(...glyphs.map((g) => g.h));
  const h = H + pad * 2;
  const w = pad * 2 + glyphs.reduce((a, g) => a + g.w, 0) + gap * (glyphs.length - 1);
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = 20; data[i * 4 + 1] = 20; data[i * 4 + 2] = 20; data[i * 4 + 3] = 255; }
  let x0 = pad;
  for (const g of glyphs) {
    const y0 = pad + (H - g.h); // 下端を揃える（小数点は下に来る）
    for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
      if (g.data[y * g.w + x]! > 0) { const s = ((y0 + y) * w + (x0 + x)) * 4; data[s] = 255; data[s + 1] = 255; data[s + 2] = 255; }
    }
    x0 += g.w + gap;
  }
  return { w, h, data };
}
const full = (img: Rgba) => ({ x: 0, y: 0, w: img.w, h: img.h });

describe('readAmountBb', () => {
  it('"20.2 BB" → 20.2（末尾 BB を落とし小数点を残す）', () => {
    const img = render([TWO, ZERO, DOT, TWO, BEE, BEE]);
    const r = readAmountBb(img, full(img), digits, { minCh: 100 });
    expect(r.value).toBeCloseTo(20.2, 5);
    expect(r.conf).toBeGreaterThan(0);
  });

  it('"20 BB"（整数, 小数点なし）→ 20', () => {
    const img = render([TWO, ZERO, BEE, BEE]);
    const r = readAmountBb(img, full(img), digits, { minCh: 100 });
    expect(r.value).toBe(20);
  });

  it('薄い小数点（h=4）でも小数を残す（71.3→713 の欠落回帰防止）', () => {
    // folded/暗プレートで小数点が h=4 まで痩せても '.' として拾う（h 下限 4）。
    const img = render([TWO, ZERO, DOT4, TWO, BEE, BEE]);
    const r = readAmountBb(img, full(img), digits, { minCh: 100 });
    expect(r.value).toBeCloseTo(20.2, 5);
  });

  it('数字 1 個 ＋ BB 未満（tall < 3）は NaN', () => {
    const img = render([TWO, BEE]); // tall 2 個のみ
    const r = readAmountBb(img, full(img), digits, { minCh: 100 });
    expect(Number.isNaN(r.value)).toBe(true);
    expect(r.conf).toBe(0);
  });

  it('BB の右に装飾 tall（手番シェブロン等）があっても letters アンカーで正読（実 iPhone TR 回帰防止）', () => {
    // "20.2 BB" の右に装飾の tall 成分（ZERO で代用）。旧「末尾 tall 2 個＝BB」だと装飾を
    // 落として BB を数字 "0" として採用し誤読した。letters を渡すと右端の B ペアを BB と判定し、
    // それ以降（装飾）を数値スパンから除外できる。
    const img = render([TWO, ZERO, DOT, TWO, BEE, BEE, ZERO]);
    const withLetters = readAmountBb(img, full(img), digits, { minCh: 100 }, letters);
    expect(withLetters.value).toBeCloseTo(20.2, 5);
  });
});

describe('stackEndsWithBb / detectDisplayMode', () => {
  it('末尾 2 tall が B,B なら bb 判定', () => {
    const img = render([TWO, ZERO, DOT, TWO, BEE, BEE]);
    expect(stackEndsWithBb(img, full(img), digits, letters, { minCh: 100 })).toBe(true);
    expect(detectDisplayMode(img, [full(img)], digits, letters, { minCh: 100 })).toBe('bb');
  });

  it('数字で終わる（BB 無し）なら chips 判定', () => {
    const img = render([TWO, ZERO, ZERO]); // "200"
    expect(stackEndsWithBb(img, full(img), digits, letters, { minCh: 100 })).toBe(false);
    expect(detectDisplayMode(img, [full(img)], digits, letters, { minCh: 100 })).toBe('chips');
  });

  it('読めない席（成分不足）は飛ばして次席で判定', () => {
    const bb = render([TWO, ZERO, DOT, TWO, BEE, BEE]);
    const blank = { x: 0, y: 0, w: 3, h: 3 }; // pad 内の背景のみ＝0 成分
    // 1 席目 blank をスキップして 2 席目（全体）で bb。
    expect(detectDisplayMode(bb, [blank, full(bb)], digits, letters, { minCh: 100 })).toBe('bb');
  });
});
