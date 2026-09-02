/**
 * extract のスモークテスト（画像非依存）。実画像 end-to-end は dev harness（extractFrame）で
 * 検証（142820/142903/143020/142909 で pipeline ok＝ポジション導出・BB正規化・fold/empty 反映）。
 * ここでは空フレームで配線が例外を出さず RawReads の形（6席・preflop・chips）を返すことを固定する。
 */
import { describe, it, expect } from 'vitest';
import type { Rgba } from './color.js';
import type { Gray } from './types.js';
import type { Template } from './match.js';
import { extractRawReads, type ExtractTemplates } from './extract.js';
import { CHIPS_6MAX } from './frameProfile.js';

function blank(w: number, h: number): Rgba {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = 10; data[i * 4 + 1] = 10; data[i * 4 + 2] = 10; data[i * 4 + 3] = 255; }
  return { w, h, data };
}
const dummy: Gray = { w: 2, h: 2, data: Uint8Array.from([255, 0, 0, 255]) };
const T: ExtractTemplates = {
  digits: [{ label: '0', img: dummy }],
  ranks: [{ label: 'A', img: dummy }],
  actions: [{ label: 'レイズ', img: dummy }],
};

describe('extractRawReads (smoke)', () => {
  const reads = extractRawReads(blank(600, 300), CHIPS_6MAX, T);

  it('6 席・時計回り [TL,TC,TR,BR,BC,BL] を返す', () => {
    expect(reads.seats).toHaveLength(6);
    expect(reads.seats.map((s) => s.id)).toEqual(['TL', 'TC', 'TR', 'BR', 'BC', 'BL']);
    expect(reads.seats.filter((s) => s.isHero)).toHaveLength(1);
    expect(reads.seats.find((s) => s.isHero)!.id).toBe('BC');
  });

  it('空フレームは全席 empty・preflop・chips', () => {
    expect(reads.street.value).toBe('preflop'); // ボード 0 枚
    expect(reads.displayMode).toBe('chips');
    for (const s of reads.seats) {
      expect(s.occupancy.value).toBe('empty');
      expect(Number.isNaN(s.stack.value)).toBe(true);
      expect(s.action.value).toBe('none');
    }
  });

  it('ディスク無しなら isButton は全席 false', () => {
    expect(reads.seats.some((s) => s.isButton)).toBe(false);
  });
});

describe('CHIPS_6MAX betBb（BB表示専用ベット領域）', () => {
  const byId = Object.fromEntries(CHIPS_6MAX.seats.map((s) => [s.screen, s]));

  it('先頭 "0." が左端で切れる TC/TR/BC/BL のみ betBb を持つ（TL/BR は bet にフォールバック）', () => {
    expect(byId['TC']!.betBb).toBeDefined();
    expect(byId['TR']!.betBb).toBeDefined();
    expect(byId['BC']!.betBb).toBeDefined();
    expect(byId['BL']!.betBb).toBeDefined();
    expect(byId['TL']!.betBb).toBeUndefined();
    expect(byId['BR']!.betBb).toBeUndefined();
  });

  it('betBb は bet の左だけを広げる（右端・上下は不変）', () => {
    for (const id of ['TC', 'TR', 'BC', 'BL'] as const) {
      const { bet, betBb } = byId[id]!;
      expect(betBb!.x).toBeLessThan(bet.x); // 左へ拡張
      expect(betBb!.x + betBb!.w).toBeCloseTo(bet.x + bet.w, 6); // 右端は不変
      expect(betBb!.y).toBe(bet.y);
      expect(betBb!.h).toBe(bet.h);
    }
  });
});
