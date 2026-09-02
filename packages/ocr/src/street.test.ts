/**
 * street（ボード枚数）検出の合成テスト（画像非依存）。実画像は dev harness で
 * preflop=0 / turn=4 / showdown=5 を確認済み。ここでは枚数→ストリート写像を固定する。
 */
import { describe, it, expect } from 'vitest';
import type { Rgba } from './color.js';
import { countBoardCards, readStreetFromBoard } from './street.js';

/** 暗背景に n 枚の白いカード矩形（アスペクト ~0.68）を等間隔で描いた board を作る。 */
function board(n: number): Rgba {
  const w = 400, h = 120;
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = 30; data[i * 4 + 1] = 80; data[i * 4 + 2] = 60; data[i * 4 + 3] = 255; }
  const cw = 34, ch = 50, gap = 12, y0 = 35;
  let x0 = 20;
  for (let k = 0; k < n; k++) {
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const s = ((y0 + y) * w + (x0 + x)) * 4; data[s] = 240; data[s + 1] = 240; data[s + 2] = 240;
    }
    x0 += cw + gap;
  }
  return { w, h, data };
}
const full = (b: Rgba) => ({ x: 0, y: 0, w: b.w, h: b.h });

describe('countBoardCards', () => {
  it('0/3/4/5 枚を正しく数える', () => {
    expect(countBoardCards(board(0), full(board(0)))).toBe(0);
    expect(countBoardCards(board(3), full(board(3)))).toBe(3);
    expect(countBoardCards(board(4), full(board(4)))).toBe(4);
    expect(countBoardCards(board(5), full(board(5)))).toBe(5);
  });
});

describe('readStreetFromBoard', () => {
  it('0 枚は preflop（高信頼）', () => {
    const b = board(0);
    const r = readStreetFromBoard(b, full(b));
    expect(r.value).toBe('preflop');
    expect(r.conf).toBeGreaterThan(0.9);
  });
  it('3/4/5 枚は flop/turn/river', () => {
    expect(readStreetFromBoard(board(3), full(board(3))).value).toBe('flop');
    expect(readStreetFromBoard(board(4), full(board(4))).value).toBe('turn');
    expect(readStreetFromBoard(board(5), full(board(5))).value).toBe('river');
  });
  it('想定外枚数（2）は unknown・低信頼', () => {
    const b = board(2);
    const r = readStreetFromBoard(b, full(b));
    expect(r.value).toBe('unknown');
    expect(r.conf).toBeLessThan(0.5);
  });
});
