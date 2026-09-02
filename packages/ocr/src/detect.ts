/**
 * 白い札（カード）矩形の検出（画像非依存の純ロジック）。
 *
 * カードは白背景の矩形で、内部にランク・スート・顔絵の暗い画素を持つ。明度マスクの
 * 連結成分を取り、面積・アスペクト・充填率でカード矩形を拾う。ハンド一覧はスクロール
 * するため固定座標が使えず（accuracy 検証で判明）、検出→正規化してから角を切ることで
 * 独立キャプチャでも安定したテンプレ/認識にする。
 *
 * 合成画像で連結成分・矩形抽出を完全に検証できる。実画像のしきい値は較正で詰める。
 */

import type { Gray, Rect } from './types.js';

/** 明度 >= threshold を前景(1)とするマスク。 */
export function brightMask(g: Gray, threshold: number): Uint8Array {
  const m = new Uint8Array(g.w * g.h);
  for (let i = 0; i < m.length; i++) m[i] = g.data[i]! >= threshold ? 1 : 0;
  return m;
}

/** 二値マスクの膨張（Chebyshev 半径 r）。前景=1。 */
export function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return mask.slice();
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let on = 0;
      for (let dy = -r; dy <= r && !on; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          if (mask[ny * w + nx] === 1) { on = 1; break; }
        }
      }
      out[y * w + x] = on;
    }
  return out;
}

/** 二値マスクの収縮（Chebyshev 半径 r）。 */
export function erode(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return mask.slice();
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let all = 1;
      for (let dy = -r; dy <= r && all; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue; // 範囲外は無視（端を保つ）
        for (let dx = -r; dx <= r; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          if (mask[ny * w + nx] !== 1) { all = 0; break; }
        }
      }
      out[y * w + x] = all;
    }
  return out;
}

/** クロージング（膨張→収縮）: 細い断裂を橋渡ししつつ全体サイズを保つ。 */
export function close(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  return erode(dilate(mask, w, h, r), w, h, r);
}

export interface Component {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** 成分の前景画素数。 */
  readonly area: number;
}

/**
 * 連結成分（既定 4 近傍）のバウンディングボックスと面積を返す。
 * mask は 0/1、行優先、長さ w*h。反復スタックで深い再帰を避ける。
 */
export function connectedComponents(
  mask: Uint8Array,
  w: number,
  h: number,
  connectivity: 4 | 8 = 4,
): Component[] {
  const seen = new Uint8Array(w * h);
  const out: Component[] = [];
  const stack: number[] = [];
  const neigh4 = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  const neigh8 = [...neigh4, [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const neigh = connectivity === 8 ? neigh8 : neigh4;

  for (let start = 0; start < mask.length; start++) {
    if (mask[start] !== 1 || seen[start]) continue;
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    let minX = w;
    let minY = h;
    let maxX = -1;
    let maxY = -1;
    let area = 0;
    while (stack.length > 0) {
      const p = stack.pop()!;
      const px = p % w;
      const py = (p - px) / w;
      area++;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
      for (const [dx, dy] of neigh) {
        const nx = px + dx!;
        const ny = py + dy!;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const np = ny * w + nx;
        if (mask[np] === 1 && !seen[np]) {
          seen[np] = 1;
          stack.push(np);
        }
      }
    }
    out.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, area });
  }
  return out;
}

export interface FindCardOptions {
  /** 明度しきい値（0..255）。既定 190。 */
  threshold?: number;
  /** 最小面積（画像面積比）。既定 0.01。 */
  minAreaFrac?: number;
  /** カードの w/h の許容範囲。既定 [0.45, 0.95]。 */
  aspectRange?: [number, number];
  /** 充填率 area/(w*h) の下限（顔絵・pip で欠けるので低め）。既定 0.35。 */
  minFill?: number;
  connectivity?: 4 | 8;
  /** クロージング半径（絵札の白枠の断裂を橋渡し）。既定 0（無効）。 */
  closeRadius?: number;
}

/**
 * 白札矩形を検出して左→右（同列は上→下）に整列して返す。
 */
export function findCardRects(g: Gray, opts: FindCardOptions = {}): Rect[] {
  const threshold = opts.threshold ?? 190;
  const minAreaFrac = opts.minAreaFrac ?? 0.01;
  const [aLo, aHi] = opts.aspectRange ?? [0.45, 0.95];
  const minFill = opts.minFill ?? 0.35;
  const conn = opts.connectivity ?? 4;

  let mask = brightMask(g, threshold);
  if (opts.closeRadius && opts.closeRadius > 0) mask = close(mask, g.w, g.h, opts.closeRadius);
  const comps = connectedComponents(mask, g.w, g.h, conn);
  const minArea = minAreaFrac * g.w * g.h;

  const rects = comps
    .filter((c) => {
      if (c.area < minArea) return false;
      const aspect = c.w / c.h;
      if (aspect < aLo || aspect > aHi) return false;
      const fill = c.area / (c.w * c.h);
      if (fill < minFill) return false;
      return true;
    })
    .map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h }));

  // 左→右、次いで上→下。行内順序が安定する。
  rects.sort((p, q) => (Math.abs(p.y - q.y) > p.h * 0.5 ? p.y - q.y : p.x - q.x));
  return rects;
}

/**
 * 検出矩形から実カードだけを面積上位 n 枚選び、左→右に整列して返す。
 * 絵札（Q/J 等）は内部の白領域から小さなスプリアス矩形（例 25×49）が aspect/fill を
 * すり抜けて混じることがあり、素朴に先頭 n 個を採ると誤選択して認識が壊れる。
 * 実カードは常に最大面積なので、面積で上位 n を採ってから x 順に並べ直す。
 */
export function largestCardRects(rects: readonly Rect[], n: number): Rect[] {
  if (rects.length <= n) return [...rects];
  return [...rects]
    .sort((a, b) => b.w * b.h - a.w * a.h)
    .slice(0, n)
    .sort((a, b) => a.x - b.x);
}

/**
 * カード矩形の左上「角」（ランク＋スート）を正規化して切り出す。
 * 検出した矩形の左上から幅・高さの割合で取り、absolute 座標のズレを排除する。
 */
export function cornerOf(card: Rect, wFrac = 0.5, hFrac = 0.42): Rect {
  return {
    x: card.x,
    y: card.y,
    w: Math.max(1, Math.round(card.w * wFrac)),
    h: Math.max(1, Math.round(card.h * hFrac)),
  };
}
