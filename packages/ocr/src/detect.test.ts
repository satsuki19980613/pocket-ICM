import { describe, it, expect } from 'vitest';
import type { Gray } from './types.js';
import { brightMask, connectedComponents, findCardRects, cornerOf, dilate, close, largestCardRects } from './detect.js';

function blank(w: number, h: number, fill = 0): Gray {
  return { w, h, data: new Uint8Array(w * h).fill(fill) };
}
function paint(g: Gray, x0: number, y0: number, w: number, h: number, val: number): void {
  for (let y = y0; y < y0 + h; y++)
    for (let x = x0; x < x0 + w; x++) g.data[y * g.w + x] = val;
}

describe('brightMask', () => {
  it('しきい値で前景を作る', () => {
    const g: Gray = { w: 3, h: 1, data: new Uint8Array([100, 200, 255]) };
    expect([...brightMask(g, 190)]).toEqual([0, 1, 1]);
  });
});

describe('connectedComponents', () => {
  it('分離した2矩形を2成分として返す', () => {
    const g = blank(30, 20);
    paint(g, 2, 3, 8, 12, 255);
    paint(g, 18, 3, 8, 12, 255);
    const comps = connectedComponents(brightMask(g, 190), g.w, g.h);
    expect(comps.length).toBe(2);
    const byX = comps.sort((a, b) => a.x - b.x);
    expect({ x: byX[0]!.x, y: byX[0]!.y, w: byX[0]!.w, h: byX[0]!.h }).toEqual({ x: 2, y: 3, w: 8, h: 12 });
  });

  it('内部の穴（pip）があっても1成分・bbox は全体', () => {
    const g = blank(20, 20);
    paint(g, 4, 4, 10, 12, 255);
    paint(g, 7, 8, 3, 3, 0); // 内部の暗い穴
    const comps = connectedComponents(brightMask(g, 190), g.w, g.h);
    expect(comps.length).toBe(1);
    expect(comps[0]!.w).toBe(10);
    expect(comps[0]!.h).toBe(12);
    expect(comps[0]!.area).toBe(10 * 12 - 3 * 3);
  });
});

describe('findCardRects', () => {
  it('カード様の白矩形を検出し左→右に整列', () => {
    const g = blank(80, 40);
    // aspect 10/16=0.625 の白札を2枚（穴つき）
    paint(g, 5, 5, 10, 16, 255);
    paint(g, 8, 10, 2, 2, 0);
    paint(g, 40, 5, 10, 16, 255);
    paint(g, 43, 10, 2, 2, 0);
    // 面積不足のノイズと、細長い（非カード）矩形は除外されるべき
    paint(g, 25, 30, 2, 2, 255); // ノイズ
    paint(g, 60, 2, 18, 3, 255); // 横長（aspect 6, 範囲外）
    const rects = findCardRects(g, { minAreaFrac: 0.02 });
    expect(rects.length).toBe(2);
    expect(rects[0]!.x).toBe(5);
    expect(rects[1]!.x).toBe(40);
    for (const r of rects) {
      expect(r.w).toBe(10);
      expect(r.h).toBe(16);
    }
  });
});

describe('dilate / close', () => {
  it('dilate は前景を広げる', () => {
    const m = new Uint8Array([0, 0, 0, 0, 1, 0, 0, 0, 0]);
    const d = dilate(m, 3, 3, 1);
    expect([...d]).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1]);
  });
  it('close は分断された前景を橋渡しする（bbox は保つ）', () => {
    // 5x1 の前景で中央 1px を欠く → close(1) で連結
    const w = 5, h = 1;
    const m = new Uint8Array([1, 1, 0, 1, 1]);
    const c = close(m, w, h, 1);
    const comps = connectedComponents(c, w, h);
    expect(comps.length).toBe(1);
    expect(comps[0]!.w).toBe(5);
  });
  it('findCardRects: closeRadius で分断した白枠を1枚として拾う', () => {
    const g = blank(40, 40);
    // カード様の白枠（中央に大きな穴＝顔絵）で、穴が右枠に接触して白を分断
    paint(g, 5, 5, 14, 22, 255);
    paint(g, 9, 9, 10, 12, 0); // 右枠(x=19)に接触する穴
    const noClose = findCardRects(g, { minAreaFrac: 0.02, minFill: 0.1 });
    const withClose = findCardRects(g, { minAreaFrac: 0.02, minFill: 0.1, closeRadius: 2 });
    // クロージングで全体 bbox の1枚として安定して拾える
    expect(withClose.length).toBe(1);
    expect(withClose[0]!.w).toBe(14);
    expect(withClose[0]!.h).toBe(22);
    void noClose;
  });
});

describe('largestCardRects', () => {
  const R = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

  it('面積上位 2 枚を採り x 順に整列（絵札スプリアス矩形を除外）', () => {
    // 実カード2枚（大）＋絵札内部のスプリアス（小, 左寄り）。
    const spur = R(5, 30, 25, 49); // 絵札内部の小矩形（左端寄り）
    const left = R(20, 0, 120, 170);
    const right = R(160, 0, 120, 170);
    const out = largestCardRects([spur, left, right], 2);
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.x)).toEqual([20, 160]); // spur は除外, 左→右
  });

  it('n 以下ならそのまま返す', () => {
    const rs = [R(0, 0, 10, 10), R(20, 0, 10, 10)];
    expect(largestCardRects(rs, 2)).toHaveLength(2);
    expect(largestCardRects([rs[0]!], 2)).toHaveLength(1);
  });
});

describe('cornerOf', () => {
  it('矩形の左上を割合で切る', () => {
    const c = cornerOf({ x: 100, y: 50, w: 40, h: 60 }, 0.5, 0.4);
    expect(c).toEqual({ x: 100, y: 50, w: 20, h: 24 });
  });
});
