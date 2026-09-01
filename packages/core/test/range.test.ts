import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseRange,
  parseRangeToSet,
  formatRange,
  RangeSyntaxError,
} from '../src/range.js';
import { allHandClassLabels, isHandClass } from '../src/cards.js';

describe('parseRange: 基本トークン', () => {
  it('ペア単体', () => {
    expect(parseRange('77')).toEqual(['77']);
  });

  it('ペア+ は AA まで', () => {
    expect(new Set(parseRange('TT+'))).toEqual(new Set(['TT', 'JJ', 'QQ', 'KK', 'AA']));
  });

  it('22+ は全ペア13個', () => {
    expect(parseRange('22+').length).toBe(13);
  });

  it('スーテッド/オフスート単体', () => {
    expect(parseRange('T9o')).toEqual(['T9o']);
    expect(parseRange('98s')).toEqual(['98s']);
  });

  it('A2s+ は A2s..AKs（12個）', () => {
    const r = new Set(parseRange('A2s+'));
    expect(r.size).toBe(12);
    expect(r.has('A2s')).toBe(true);
    expect(r.has('AKs')).toBe(true);
    expect(r.has('AA')).toBe(false);
  });

  it('KTo+ は KTo KJo KQo', () => {
    expect(new Set(parseRange('KTo+'))).toEqual(new Set(['KTo', 'KJo', 'KQo']));
  });

  it('ダッシュ範囲（オフスート、順不同で同じ）', () => {
    const a = new Set(parseRange('A5o-A3o'));
    const b = new Set(parseRange('A3o-A5o'));
    expect(a).toEqual(new Set(['A5o', 'A4o', 'A3o']));
    expect(a).toEqual(b);
  });

  it('ダッシュ範囲（ペア）', () => {
    expect(new Set(parseRange('99-66'))).toEqual(new Set(['66', '77', '88', '99']));
  });

  it('Ax は高カード A の非ペア全部（24個、s と o）', () => {
    const r = new Set(parseRange('Ax'));
    expect(r.size).toBe(24);
    expect(r.has('A2s')).toBe(true);
    expect(r.has('A2o')).toBe(true);
    expect(r.has('AKs')).toBe(true);
    expect(r.has('AA')).toBe(false);
  });

  it('Tx+ は高カード T 以上の非ペア全部（100個）', () => {
    expect(parseRange('Tx+').length).toBe(100);
  });

  it('Any two は全169クラス', () => {
    expect(parseRange('Any two').length).toBe(169);
    expect(parseRange('anytwo').length).toBe(169);
    expect(parseRange('100%').length).toBe(169);
  });

  it('大文字小文字を無視', () => {
    expect(new Set(parseRange('a2s+'))).toEqual(new Set(parseRange('A2s+')));
  });

  it('空白・カンマ混在の複数トークン', () => {
    const r = new Set(parseRange('88+, AJs+  AQo+'));
    expect(r.has('88')).toBe(true);
    expect(r.has('AJs')).toBe(true);
    expect(r.has('AKs')).toBe(true);
    expect(r.has('AQo')).toBe(true);
    expect(r.has('AKo')).toBe(true);
  });

  it('空文字列は空集合', () => {
    expect(parseRangeToSet('').size).toBe(0);
  });
});

describe('parseRange: 不正トークンは例外', () => {
  it('未知ランク', () => {
    expect(() => parseRange('X2s')).toThrow(RangeSyntaxError);
  });
  it('高カードが後（順序違反）', () => {
    expect(() => parseRange('2As')).toThrow(RangeSyntaxError);
  });
  it('ペアにスート指定', () => {
    expect(() => parseRange('AAs')).toThrow(RangeSyntaxError);
  });
  it('壊れたダッシュ', () => {
    expect(() => parseRange('A5o-A3o-A2o')).toThrow(RangeSyntaxError);
    expect(() => parseRange('A5o-K3o')).toThrow(RangeSyntaxError); // 高カード不一致
  });
});

describe('formatRange: 正規化圧縮', () => {
  it('AA まで連続するペアは +', () => {
    expect(formatRange(['TT', 'JJ', 'QQ', 'KK', 'AA'])).toContain('TT+');
  });

  it('AA を含まないペアの塊はダッシュ', () => {
    expect(formatRange(['66', '77', '88', '99'])).toContain('66-99');
  });

  it('高カードの1つ下まで届く非ペアは +', () => {
    expect(formatRange(parseRange('A2s+'))).toContain('A2s+');
  });

  it('未知ラベルは例外', () => {
    expect(() => formatRange(['ZZ'])).toThrow(RangeSyntaxError);
  });
});

describe('往復閉包: parseRange(formatRange(S)) === S', () => {
  const cases: string[] = [
    '77',
    'TT+',
    '22+',
    'A2s+',
    'KTo+',
    'A5o-A3o',
    '99-66',
    'Ax',
    'Tx+',
    '88+ AJs+ AQo+',
    '22+ A2s+ ATo+ K9s+ KTo+ Q9s+ QJo J9s+ T9s',
    '22+ Tx+ 92s+ 95o+ 82s+ 85o+ 72s+ 74o+ 62s+ 64o+ 52s+ 53o+ 42s+ 32s',
    'Any two',
  ];

  for (const c of cases) {
    it(`"${c}"`, () => {
      const s1 = parseRangeToSet(c);
      const formatted = formatRange(s1);
      const s2 = parseRangeToSet(formatted);
      expect(s2).toEqual(s1);
    });
  }

  it('無作為な部分集合でも往復する', () => {
    const all = allHandClassLabels();
    // 決定的擬似乱数（seed 固定）で部分集合を作る
    let seed = 123456789;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let trial = 0; trial < 50; trial++) {
      const subset = new Set(all.filter(() => rand() < 0.4));
      const round = parseRangeToSet(formatRange(subset));
      expect(round).toEqual(subset);
    }
  });
});

describe('展開後は必ず妥当な169クラス', () => {
  it('全トークン種で妥当', () => {
    for (const l of parseRange('22+ Tx+ 92s+ 95o+ A5o-A3o')) {
      expect(isHandClass(l)).toBe(true);
    }
  });
});

describe('実 HRC 参照データの全レンジ文字列を展開できる', () => {
  it('_reference-hrc-5way の strategies.range が全て展開・往復する', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const refPath = join(
      here,
      '..',
      '..',
      'harness',
      'cases',
      '_reference-hrc-5way-blinds05-1-025.json',
    );
    const ref = JSON.parse(readFileSync(refPath, 'utf8')) as {
      strategies: { range: string }[];
    };
    expect(ref.strategies.length).toBeGreaterThan(0);
    for (const s of ref.strategies) {
      const set = parseRangeToSet(s.range);
      expect(set.size).toBeGreaterThan(0);
      // 展開結果は全て妥当クラス
      for (const l of set) expect(isHandClass(l)).toBe(true);
      // 往復
      expect(parseRangeToSet(formatRange(set))).toEqual(set);
    }
  });
});
