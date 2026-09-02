/**
 * 画像の切り出しとリサンプリング（多機種対応の解像度正規化）。SPEC §6.2 拡張。
 *
 * 低解像度スマホのスクショは、そのままだと較正解像度(2730×1260)向けの認識器で
 * 細部（小数点・端の桁）を取りこぼす。そこで「コンテンツ矩形を切り出し→較正解像度へ拡大」
 * して正規化してから既存の抽出をそのまま使う（認識器の再実装を避ける）。
 */

import type { Rgba } from './color.js';
import type { FracRect } from './layout.js';

/** 割合矩形で切り出す。 */
export function cropRgba(img: Rgba, cr: FracRect): Rgba {
  const x0 = Math.max(0, Math.round(cr.x * img.w));
  const y0 = Math.max(0, Math.round(cr.y * img.h));
  const w = Math.max(1, Math.min(img.w - x0, Math.round(cr.w * img.w)));
  const h = Math.max(1, Math.min(img.h - y0, Math.round(cr.h * img.h)));
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const srow = (y0 + y) * img.w;
    for (let x = 0; x < w; x++) {
      const s = (srow + x0 + x) * 4;
      const d = (y * w + x) * 4;
      data[d] = img.data[s]!;
      data[d + 1] = img.data[s + 1]!;
      data[d + 2] = img.data[s + 2]!;
      data[d + 3] = 255;
    }
  }
  return { w, h, data };
}

/** バイリニアで dw×dh へリサンプリング。 */
export function resampleRgba(img: Rgba, dw: number, dh: number): Rgba {
  if (img.w === dw && img.h === dh) return img;
  const data = new Uint8Array(dw * dh * 4);
  const sx = img.w / dw;
  const sy = img.h / dh;
  for (let y = 0; y < dh; y++) {
    const fy = (y + 0.5) * sy - 0.5;
    const y0 = Math.floor(fy);
    const ty = fy - y0;
    const y0c = Math.max(0, Math.min(img.h - 1, y0));
    const y1c = Math.max(0, Math.min(img.h - 1, y0 + 1));
    for (let x = 0; x < dw; x++) {
      const fx = (x + 0.5) * sx - 0.5;
      const x0 = Math.floor(fx);
      const tx = fx - x0;
      const x0c = Math.max(0, Math.min(img.w - 1, x0));
      const x1c = Math.max(0, Math.min(img.w - 1, x0 + 1));
      const d = (y * dw + x) * 4;
      const i00 = (y0c * img.w + x0c) * 4;
      const i10 = (y0c * img.w + x1c) * 4;
      const i01 = (y1c * img.w + x0c) * 4;
      const i11 = (y1c * img.w + x1c) * 4;
      for (let c = 0; c < 3; c++) {
        const top = img.data[i00 + c]! + (img.data[i10 + c]! - img.data[i00 + c]!) * tx;
        const bot = img.data[i01 + c]! + (img.data[i11 + c]! - img.data[i01 + c]!) * tx;
        data[d + c] = Math.round(top + (bot - top) * ty);
      }
      data[d + 3] = 255;
    }
  }
  return { w: dw, h: dh, data };
}

/** コンテンツ矩形を切り出して較正解像度へ正規化（切り出し＋拡大）。 */
export function normalizeToCanonical(img: Rgba, cr: FracRect, canonW: number, canonH: number): Rgba {
  const cropped = cr.x === 0 && cr.y === 0 && cr.w === 1 && cr.h === 1 ? img : cropRgba(img, cr);
  return resampleRgba(cropped, canonW, canonH);
}
