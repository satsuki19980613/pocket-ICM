/**
 * グレースケール・ラスタ操作（画像非依存の基盤）。
 *
 * ブラウザからは ImageData（RGBA）で入ってくるが、以降の処理は 8bit グレースケール
 * （Gray）で統一する。座標系・テンプレは実スクショで較正するが、ここの演算は
 * 合成配列で完全に検証できる。
 */

import type { Gray, Rect } from './types.js';

/** RGBA（ImageData 相当）→ グレースケール。輝度は Rec.601。 */
export function fromRGBA(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): Gray {
  if (rgba.length < w * h * 4) throw new RangeError('RGBA buffer too small');
  const data = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = rgba[i * 4]!;
    const g = rgba[i * 4 + 1]!;
    const b = rgba[i * 4 + 2]!;
    // 0.299R + 0.587G + 0.114B
    data[i] = (r * 77 + g * 150 + b * 29) >> 8;
  }
  return { w, h, data };
}

/** 矩形で切り出す。範囲は画像内にクランプする。 */
export function crop(img: Gray, rect: Rect): Gray {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(img.w, Math.floor(rect.x + rect.w));
  const y1 = Math.min(img.h, Math.floor(rect.y + rect.h));
  const w = Math.max(0, x1 - x0);
  const h = Math.max(0, y1 - y0);
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const srcRow = (y0 + y) * img.w + x0;
    const dstRow = y * w;
    for (let x = 0; x < w; x++) data[dstRow + x] = img.data[srcRow + x]!;
  }
  return { w, h, data };
}

/**
 * 双一次補間で任意サイズへリサンプル。機種差の解像度・アスペクト正規化に使う
 * （テンプレートマッチ前に候補をテンプレサイズへ揃える）。
 */
export function resize(img: Gray, w: number, h: number): Gray {
  if (w <= 0 || h <= 0) throw new RangeError('resize target must be positive');
  const out = new Uint8Array(w * h);
  if (img.w === 0 || img.h === 0) return { w, h, data: out };
  const sx = img.w / w;
  const sy = img.h / h;
  for (let y = 0; y < h; y++) {
    const fy = Math.min(img.h - 1, (y + 0.5) * sy - 0.5);
    const y0 = Math.max(0, Math.floor(fy));
    const y1 = Math.min(img.h - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(img.w - 1, (x + 0.5) * sx - 0.5);
      const x0 = Math.max(0, Math.floor(fx));
      const x1 = Math.min(img.w - 1, x0 + 1);
      const wx = fx - x0;
      const p00 = img.data[y0 * img.w + x0]!;
      const p01 = img.data[y0 * img.w + x1]!;
      const p10 = img.data[y1 * img.w + x0]!;
      const p11 = img.data[y1 * img.w + x1]!;
      const top = p00 + (p01 - p00) * wx;
      const bot = p10 + (p11 - p10) * wx;
      out[y * w + x] = Math.round(top + (bot - top) * wy);
    }
  }
  return { w, h, data: out };
}

/** 平均・標準偏差。NCC の正規化に使う。 */
export function meanStd(img: Gray): { mean: number; std: number } {
  const n = img.data.length;
  if (n === 0) return { mean: 0, std: 0 };
  let sum = 0;
  for (let i = 0; i < n; i++) sum += img.data[i]!;
  const mean = sum / n;
  let v = 0;
  for (let i = 0; i < n; i++) {
    const d = img.data[i]! - mean;
    v += d * d;
  }
  return { mean, std: Math.sqrt(v / n) };
}

/** Otsu の判別分析法で 2 値化しきい値を求める（0..255）。 */
export function otsuThreshold(img: Gray): number {
  const hist = new Array<number>(256).fill(0);
  for (let i = 0; i < img.data.length; i++) hist[img.data[i]!]!++;
  const total = img.data.length;
  if (total === 0) return 127;
  let sumAll = 0;
  for (let t = 0; t < 256; t++) sumAll += t * hist[t]!;
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let bestVar = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]!;
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t]!;
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) {
      bestVar = between;
      best = t;
    }
  }
  return best;
}

/** しきい値で 2 値化（前景=255, 背景=0）。dark=true なら暗いほうを前景にする。 */
export function binarize(img: Gray, threshold: number, darkForeground = true): Gray {
  const data = new Uint8Array(img.data.length);
  for (let i = 0; i < img.data.length; i++) {
    const on = darkForeground ? img.data[i]! <= threshold : img.data[i]! > threshold;
    data[i] = on ? 255 : 0;
  }
  return { w: img.w, h: img.h, data };
}
