/**
 * D（ディーラー）ボタン検出。SPEC §6.3 #2 / position 導出の位置アンカー。
 *
 * D ボタンは金縁の丸ディスク。ポジション（D/SB/BB…）は毎ハンド回転するので、画面席は
 * 固定でも「どの席に D が載るか」を毎フレーム読む必要がある。テーブル領域で金色マスクの
 * 連結成分を取り、最大のリング状ブロブ（ディスク）の中心を各席のアンカーに最近傍で割り当てる。
 *
 * 実画像検証（dev harness）: D 位置既知の 6-max chips フレームで席割り当てが一致。
 * 金色 UI（下部操作ボタン等）はテーブル領域外なので除外され、盤上の小さな金ドットより
 * ディスクが十分大きい（area≈1000 vs ≤700）ため最大ブロブで拾える。
 */

import type { Read, Rect } from './types.js';
import type { Rgba } from './color.js';
import { connectedComponents } from './detect.js';

/** フレーム割合の点（各成分 [0,1]）。 */
export interface FracPoint {
  readonly x: number;
  readonly y: number;
}

export interface GoldDiscOptions {
  /** 金色判定: min(R)、min(G)、max(B)、R-B の下限。既定は実画像較正値。 */
  readonly minR?: number;
  readonly minG?: number;
  readonly maxB?: number;
  readonly minRB?: number;
  /** ディスク最小面積（テーブル領域画素比）。既定 0.0003（実測ディスク area≈1000/テーブル≈2.1M）。 */
  readonly minAreaFrac?: number;
  /** 許容アスペクト w/h。既定 [0.7, 1.5]。 */
  readonly aspectRange?: [number, number];
  /** ディスクとみなす席アンカーへの最大距離（フレーム割合）。既定 0.08。 */
  readonly maxAnchorDist?: number;
}

export interface DiscResult {
  /** フレーム全体に対する割合座標の中心。 */
  readonly cx: number;
  readonly cy: number;
  readonly area: number;
}

/**
 * テーブル領域内の「ディスク状（アスペクト≈1・面積下限以上）」の金ブロブ候補を全て返す。
 * 中央のキャラ絵の金装飾・プレートの金枠など、D ディスクより大きい金ブロブが混じるため、
 * 「最大」で選ぶと誤検出する。呼び出し側（detectButtonSeat）が席アンカー最近傍で D を選ぶ。
 */
export function goldDiscCandidates(img: Rgba, tableRect: Rect, opts: GoldDiscOptions = {}): DiscResult[] {
  const minR = opts.minR ?? 170;
  const minG = opts.minG ?? 110;
  const maxB = opts.maxB ?? 120;
  const minRB = opts.minRB ?? 70;
  const [aLo, aHi] = opts.aspectRange ?? [0.7, 1.5];
  const x0 = Math.max(0, Math.floor(tableRect.x));
  const y0 = Math.max(0, Math.floor(tableRect.y));
  // 整数ピクセル寸法にする（connectedComponents は整数 stride 前提）。
  const x1 = Math.min(img.w, Math.round(tableRect.x + tableRect.w));
  const y1 = Math.min(img.h, Math.round(tableRect.y + tableRect.h));
  const w = Math.max(0, x1 - x0), h = Math.max(0, y1 - y0);
  if (w === 0 || h === 0) return [];
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = ((y0 + y) * img.w + (x0 + x)) * 4;
      const R = img.data[s]!, G = img.data[s + 1]!, B = img.data[s + 2]!;
      mask[y * w + x] = R > minR && G > minG && B < maxB && R - B > minRB ? 1 : 0;
    }
  const minArea = (opts.minAreaFrac ?? 0.0003) * w * h;
  const out: DiscResult[] = [];
  for (const c of connectedComponents(mask, w, h, 8)) {
    if (c.area < minArea) continue;
    const aspect = c.w / c.h;
    if (aspect < aLo || aspect > aHi) continue;
    out.push({ cx: (x0 + c.x + c.w / 2) / img.w, cy: (y0 + c.y + c.h / 2) / img.h, area: c.area });
  }
  return out;
}

/** テーブル領域内の最大ゴールドディスクの中心（フレーム割合）。見つからなければ null。（後方互換） */
export function goldDiscCenter(img: Rgba, tableRect: Rect, opts: GoldDiscOptions = {}): DiscResult | null {
  let best: DiscResult | null = null;
  for (const c of goldDiscCandidates(img, tableRect, opts)) {
    if (best === null || c.area > best.area) best = c;
  }
  return best;
}

/**
 * ディスク中心（割合）を席アンカー（割合）に最近傍割り当て → 席 index の `Read<number>`。
 * conf は「最近傍距離が十分小さく、2 位と差がある」ほど高い。ディスク未検出は value=-1, conf=0。
 */
export function detectButtonSeat(
  img: Rgba,
  tableRect: Rect,
  seatAnchors: readonly FracPoint[],
  opts: GoldDiscOptions = {},
): Read<number> {
  const cands = goldDiscCandidates(img, tableRect, opts);
  if (cands.length === 0 || seatAnchors.length === 0) return { value: -1, conf: 0 };
  const maxDist = opts.maxAnchorDist ?? 0.08;

  // D ディスクは席プレート（≈アンカー）の上に載る。中央のキャラ絵の金装飾やプレートの
  // 金枠はどのアンカーからも遠い。よって「席アンカーに最も近いディスク状ブロブ」を D とする
  // （最大面積ではなく、アンカー最近傍で選ぶ）。同点近傍は面積が大きい方（本物のディスク）。
  let best: { seat: number; dist: number; area: number } | null = null;
  for (const c of cands) {
    let ni = 0, nd = Infinity;
    for (let i = 0; i < seatAnchors.length; i++) {
      const d = Math.hypot(seatAnchors[i]!.x - c.cx, seatAnchors[i]!.y - c.cy);
      if (d < nd) { nd = d; ni = i; }
    }
    if (best === null || nd < best.dist - 1e-6 || (Math.abs(nd - best.dist) <= 1e-6 && c.area > best.area)) {
      best = { seat: ni, dist: nd, area: c.area };
    }
  }
  if (best === null || best.dist > maxDist) return { value: -1, conf: 0 };
  const conf = Math.max(0, Math.min(1, 1 - best.dist / maxDist));
  return { value: best.seat, conf };
}
