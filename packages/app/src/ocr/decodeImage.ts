/**
 * スクショ（File/Blob）→ Rgba 復号（ブラウザ専用）。
 *
 * OCR パイプラインは Rgba（{w,h,data}）を入力に取る。dev では Node の PNG コーデックで
 * 復号するが、アプリでは端末内の Canvas で復号する（SPEC §8: 端末ローカル完結）。
 * ここはブラウザ API（createImageBitmap / Canvas）に依存するので、純ロジック側
 * （prefill.ts の ocrPrefillFromRgba）とは分離してテスト境界を保つ。
 */

import type { Rgba } from '@oshihiki/ocr';

/** 画像 Blob（PNG/JPEG など）を Canvas で復号して Rgba に変換する。 */
export async function decodeToRgba(blob: Blob): Promise<Rgba> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('2D Canvas コンテキストを取得できませんでした');
    ctx.drawImage(bitmap, 0, 0);
    const id = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    // ImageData.data は Uint8ClampedArray（Rgba.data が受け付ける）。
    return { w: id.width, h: id.height, data: id.data };
  } finally {
    bitmap.close();
  }
}
