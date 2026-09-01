import { describe, it, expect } from 'vitest';
import type { Gray } from './types.js';
import { fromRGBA, crop, resize, meanStd, otsuThreshold, binarize } from './raster.js';
import { ncc, bestMatch, matchConfidence, type Template } from './match.js';
import { segmentGlyphs, recognizeDigitString, recognizeNumber, parseAmount } from './digits.js';
import { heroHandFromCards, recognizeHeroHand, parseCardCode, allCardCodes } from './cards.js';

/** '#'=dark(0), その他=light(255)。 */
function gray(rows: string[]): Gray {
  const h = rows.length;
  const w = rows[0]!.length;
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) data[y * w + x] = rows[y]![x] === '#' ? 0 : 255;
  }
  return { w, h, data };
}

/** 5x7 の合成グリフ: 枠を dark、内部 4 セルに d の下位ビットを立てる。 */
function digitTemplate(label: string, code: number): Template {
  const w = 5;
  const h = 7;
  const data = new Uint8Array(w * h).fill(255);
  const set = (x: number, y: number) => {
    data[y * w + x] = 0;
  };
  for (let x = 0; x < w; x++) {
    set(x, 0);
    set(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    set(0, y);
    set(w - 1, y);
  }
  // 内部セル(x=1..3, y=1..5) k=0..14。code の下位ビットで数字、上位で記号を区別。
  const interior: Array<[number, number]> = [];
  for (let y = 1; y <= 5; y++) for (let x = 1; x <= 3; x++) interior.push([x, y]);
  for (let k = 0; k < interior.length; k++) {
    if ((code >> k) & 1) set(interior[k]![0], interior[k]![1]);
  }
  return { label, img: { w, h, data } };
}

function digitTemplates(): Template[] {
  const t: Template[] = [];
  for (let d = 0; d <= 9; d++) t.push(digitTemplate(String(d), d | 0x10)); // bit4 常時→0と衝突回避
  t.push(digitTemplate('.', 0x200)); // 記号は高位ビットで内部の別セル
  return t;
}

/** テンプレ列を 2px の light gap で横連結してストリップを作る。 */
function strip(labels: string[], templates: Template[]): Gray {
  const glyphs = labels.map((l) => templates.find((t) => t.label === l)!.img);
  const h = glyphs[0]!.h;
  const gap = 2;
  const w = glyphs.reduce((a, g) => a + g.w, 0) + gap * (glyphs.length - 1);
  const data = new Uint8Array(w * h).fill(255);
  let x0 = 0;
  for (const g of glyphs) {
    for (let y = 0; y < h; y++)
      for (let x = 0; x < g.w; x++) data[y * w + (x0 + x)] = g.data[y * g.w + x]!;
    x0 += g.w + gap;
  }
  return { w, h, data };
}

describe('raster', () => {
  it('fromRGBA: 白と黒', () => {
    const rgba = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]);
    const g = fromRGBA(rgba, 2, 1);
    expect(g.data[0]).toBe(255);
    expect(g.data[1]).toBe(0);
  });

  it('crop: 範囲内を切り出す', () => {
    const g = gray(['##..', '..##']);
    const c = crop(g, { x: 2, y: 0, w: 2, h: 2 });
    expect(c.w).toBe(2);
    expect(c.h).toBe(2);
    expect([...c.data]).toEqual([255, 255, 0, 0]);
  });

  it('resize: 定数画像は定数のまま', () => {
    const g: Gray = { w: 3, h: 3, data: new Uint8Array(9).fill(128) };
    const r = resize(g, 6, 6);
    expect(r.w).toBe(6);
    expect([...r.data].every((v) => v === 128)).toBe(true);
  });

  it('otsu + binarize: 二峰性を分離', () => {
    const g = gray(['##..', '##..']);
    const t = otsuThreshold(g);
    const b = binarize(g, t, true);
    // dark(#) が前景=255
    expect(b.data[0]).toBe(255);
    expect(b.data[2]).toBe(0);
  });

  it('meanStd: 定数は std 0', () => {
    const g: Gray = { w: 2, h: 2, data: new Uint8Array([10, 10, 10, 10]) };
    expect(meanStd(g).std).toBe(0);
  });
});

describe('match (NCC)', () => {
  it('同一パッチは 1', () => {
    const g = gray(['#.#', '.#.', '#.#']);
    expect(ncc(g, g)).toBeCloseTo(1, 6);
  });
  it('反転パッチは -1', () => {
    const a = gray(['#.', '.#']);
    const b = gray(['.#', '#.']);
    expect(ncc(a, b)).toBeCloseTo(-1, 6);
  });
  it('平坦パッチは 0', () => {
    const a: Gray = { w: 2, h: 2, data: new Uint8Array([5, 5, 5, 5]) };
    const b = gray(['#.', '.#']);
    expect(ncc(a, b)).toBe(0);
  });
  it('bestMatch: 正しいラベルと高信頼', () => {
    const templates = digitTemplates();
    const cand = templates.find((t) => t.label === '7')!.img;
    const m = bestMatch(cand, templates);
    expect(m.label).toBe('7');
    expect(m.score).toBeCloseTo(1, 6);
    expect(matchConfidence(m)).toBeGreaterThan(0.85);
  });
});

describe('digits', () => {
  it('segmentGlyphs: グリフ数を数える', () => {
    const templates = digitTemplates();
    const s = strip(['1', '2', '5'], templates);
    const t = otsuThreshold(s);
    const b = binarize(s, t, true);
    const rects = segmentGlyphs(b);
    expect(rects.length).toBe(3);
  });

  it('recognizeDigitString: "12.5" を復元', () => {
    const templates = digitTemplates();
    const s = strip(['1', '2', '.', '5'], templates);
    const r = recognizeDigitString(s, templates);
    expect(r.value).toBe('12.5');
    expect(r.conf).toBeGreaterThan(0.85);
  });

  it('recognizeNumber: 数値化', () => {
    const templates = digitTemplates();
    const s = strip(['3', '0'], templates);
    const r = recognizeNumber(s, templates);
    expect(r.value).toBe(30);
  });

  it('parseAmount: 単位や記号を除去', () => {
    expect(parseAmount('15bb')).toBe(15);
    expect(parseAmount('0.5')).toBe(0.5);
    expect(parseAmount('abc')).toBeNull();
  });
});

describe('cards — ハンドクラス組み立て', () => {
  it('スート一致は s', () => {
    expect(heroHandFromCards('Ah', '5h')).toBe('A5s');
  });
  it('スート不一致は o', () => {
    expect(heroHandFromCards('Ah', '5d')).toBe('A5o');
  });
  it('同ランクはペア', () => {
    expect(heroHandFromCards('Ad', 'Ah')).toBe('AA');
    expect(heroHandFromCards('Th', 'Ts')).toBe('TT');
  });
  it('順不同でも高ランク先', () => {
    expect(heroHandFromCards('5h', 'Ah')).toBe('A5s');
  });
  it('不正コードや同一カードは null', () => {
    expect(heroHandFromCards('Xh', '5h')).toBeNull();
    expect(heroHandFromCards('Ah', 'Ah')).toBeNull();
  });
  it('parseCardCode', () => {
    expect(parseCardCode('Td')).toEqual({ rank: 'T', suit: 'd' });
    expect(parseCardCode('1x')).toBeNull();
  });
  it('allCardCodes は 52 枚', () => {
    const codes = allCardCodes();
    expect(codes.length).toBe(52);
    expect(new Set(codes).size).toBe(52);
  });

  it('recognizeHeroHand: テンプレから A5s を組み立て', () => {
    const templates: Template[] = [
      { label: 'Ah', img: gray(['#..#', '.##.', '#..#', '.##.']) },
      { label: '5h', img: gray(['####', '#..#', '#..#', '####']) },
      { label: '5d', img: gray(['.##.', '#..#', '#..#', '.##.']) },
      { label: 'Kc', img: gray(['#..#', '#..#', '#..#', '#..#']) },
    ];
    const ah = templates[0]!.img;
    const fivehearts = templates[1]!.img;
    const r = recognizeHeroHand(ah, fivehearts, templates);
    expect(r.value).toBe('A5s');
    expect(r.conf).toBeGreaterThan(0.85);
  });
});
