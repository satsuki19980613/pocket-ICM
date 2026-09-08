/**
 * 拡大正規化フロントエンド（アンカー方式パイプラインの必須前段, OCR_PHASE2 §B2）。
 *
 * 目的: 低解像度フレーム（実測 1310×536）は stack の "N.N BB" グリフが ~11–13px しかなく、
 * digits テンプレ（DIGIT_NORM_H=32 基準）ではセグメント不能 → NaN になる。そこで
 * **アンカーで測った内容駆動スケール**でグリフを作業解像度へ拡大してからアンカー処理する
 * （固定倍率でなく画面のグリフ実寸に合わせる）。既に十分大きい入力は恒等（Android 2730 は無変換）。
 *
 * スケール源: 黄色プレイヤー名ボックスの**中央値高さ**（席名は全機種で在席席に必ず出る安定
 * アンカー, seatPresence 参照）。名前が取れない場合は恒等（拡大しても情報は増えない）。
 * 過拡大は無駄かつ JPEG ボケは回復しないので上限を設ける（既定 4×）。
 *
 * 本モジュールは本番未接続（Phase 2 の基盤）。フラクショナル座標は拡大で不変なので、
 * 拡大は席列挙の幾何を変えず、下流のグリフ読み（B4）と微弱な黄色名の画素数を底上げする。
 */

import type { Rgba } from './color.js';
import { resampleRgba } from './resize.js';
import { isYellowNamePixel } from './seatPresence.js';

/** 作業解像度での目標グリフ（名前）高さ [px]。Android 2730 の名前高 ~25px に合わせる（≒恒等）。 */
export const TARGET_NAME_H_PX = 24;
/** 拡大倍率の上限。 */
export const MAX_UPSCALE = 4;
/** これ未満のスケールは恒等扱い（僅かな拡大は無駄）。 */
const IDENTITY_BELOW = 1.05;

export interface GlyphScale {
  /** 画面グリフをテンプレ基準へ合わせる推奨倍率（>=1、名前が取れなければ 1）。 */
  readonly scale: number;
  /** 推定に使った黄色名ボックスの中央値高さ [px]（0 = 名前検出なし）。 */
  readonly medianNameH: number;
  /** 推定に使った名前ボックス数。 */
  readonly samples: number;
}

/**
 * 黄色名ボックスの中央値高さから、テンプレ基準へ合わせるグリフスケールを推定する。
 * 画面全体を走査して黄色名の水平連結塊（語）の高さを集め、その中央値で TARGET に合わせる。
 * 名前が 1 つも取れなければ scale=1（恒等）。
 */
export function estimateGlyphScale(img: Rgba): GlyphScale {
  const heights = yellowWordHeights(img);
  if (heights.length === 0) return { scale: 1, medianNameH: 0, samples: 0 };
  heights.sort((a, b) => a - b);
  const med = heights[Math.floor(heights.length / 2)]!;
  if (med <= 0) return { scale: 1, medianNameH: 0, samples: heights.length };
  const raw = TARGET_NAME_H_PX / med;
  const scale = Math.max(1, Math.min(MAX_UPSCALE, raw));
  return { scale, medianNameH: med, samples: heights.length };
}

export interface Normalized {
  readonly img: Rgba;
  /** 入力に対して適用した倍率（1 = 恒等）。 */
  readonly scale: number;
}

/**
 * アンカー処理前の拡大正規化。グリフが小さいときだけ双一次で拡大し、十分大きければ恒等。
 * 返り値はアンカー幾何が不変（フラクショナル）な拡大済み画像とスケール。
 */
export function normalizeForAnchors(img: Rgba): Normalized {
  const { scale } = estimateGlyphScale(img);
  if (scale < IDENTITY_BELOW) return { img, scale: 1 };
  const dw = Math.round(img.w * scale);
  const dh = Math.round(img.h * scale);
  return { img: resampleRgba(img, dw, dh), scale };
}

/**
 * 画面全体の黄色名画素を水平に連結（語）した塊の高さ [px] を集める。
 * 名前は横書き連続テキスト＝水平ランで語塊にまとまる。バナー/UI の孤立黄色や飾りは
 * 面積・高さで大枠のみ残す（中央値を取るのでロバスト）。
 */
function yellowWordHeights(img: Rgba): number[] {
  const { w, h, data } = img;
  // 行ごとに黄色画素を横方向に閉じて語塊にし、縦にも連結して外接高さを得る（軽量ラベリング）。
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      if (isYellowNamePixel(data[s]!, data[s + 1]!, data[s + 2]!)) mask[y * w + x] = 1;
    }
  const r = Math.max(2, Math.round(w * 0.012));
  const dil = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let run = 0;
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) run = r;
      if (run > 0) { dil[y * w + x] = 1; run--; }
    }
    for (let x = w - 1; x >= 0; x--) if (mask[y * w + x]) for (let k = 1; k <= r && x + k < w; k++) dil[y * w + x + k] = 1;
  }
  const seen = new Uint8Array(w * h);
  const st: number[] = [];
  const out: number[] = [];
  const minInk = Math.max(20, Math.round(w * h * 0.00003));
  for (let i = 0; i < w * h; i++) {
    if (!dil[i] || seen[i]) continue;
    st.length = 0; st.push(i); seen[i] = 1;
    let y0 = h, y1 = -1, ink = 0;
    while (st.length) {
      const p = st.pop()!; const px = p % w, py = (p / w) | 0;
      if (mask[p]) ink++;
      if (py < y0) y0 = py; if (py > y1) y1 = py;
      const nb = [p - 1, p + 1, p - w, p + w];
      for (const q of nb) {
        if (q < 0 || q >= w * h || !dil[q] || seen[q]) continue;
        if (Math.abs((q % w) - px) > 1) continue;
        seen[q] = 1; st.push(q);
      }
    }
    // 名前らしい塊のみ（極小ノイズ・巨大 UI ブロックは除外して中央値を安定化）。
    const bh = y1 - y0 + 1;
    if (ink >= minInk && bh >= h * 0.01 && bh <= h * 0.06) out.push(bh);
  }
  return out;
}
