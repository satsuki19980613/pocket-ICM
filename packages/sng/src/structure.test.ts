import { describe, expect, it } from 'vitest';

import { blindsAt, levelsOf } from './structure';

describe('structure', () => {
  it('levelsOf: 通常は 16 レベル・SB=BB/2', () => {
    const levels = levelsOf('normal');
    expect(levels).toHaveLength(16);
    expect(levels[0]).toEqual({ level: 1, sb: 100, bb: 200, ante: 50 });
    for (const lv of levels) expect(lv.sb).toBe(lv.bb / 2);
  });

  it('levelsOf: ゆっくり/もっとゆっくりは core の表と同じ長さ', () => {
    expect(levelsOf('slow')).toHaveLength(32);
    expect(levelsOf('veryslow')).toHaveLength(59);
  });

  it('blindsAt: レベル1と、表の途中', () => {
    expect(blindsAt('normal', 1)).toEqual({ level: 1, sb: 100, bb: 200, ante: 50 });
    expect(blindsAt('slow', 9)).toEqual({ level: 9, sb: 480, bb: 960, ante: 240 });
  });

  it('blindsAt: 表の長さを超えたら最終レベルに張り付く', () => {
    const last = levelsOf('normal').at(-1)!;
    expect(blindsAt('normal', 16)).toEqual(last);
    expect(blindsAt('normal', 17)).toEqual(last);
    expect(blindsAt('normal', 1000)).toEqual(last);
  });

  it('blindsAt: 1 未満は 1 として扱う', () => {
    expect(blindsAt('normal', 0)).toEqual(blindsAt('normal', 1));
  });
});
