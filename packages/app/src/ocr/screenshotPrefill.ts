/**
 * スクショ → OCR プリフィル（ブラウザ・グルー）。
 * 復号（decodeImage）＋同梱テンプレ（bundledTemplates）＋純ロジック（prefill）を束ねる。
 * UI からはこの 1 関数だけを呼ぶ。
 */

import { decodeToRgba } from './decodeImage';
import { getBundledTemplates } from './bundledTemplates';
import { ocrPrefillFromRgba, type OcrPrefillResult } from './prefill';

/** 画像 Blob を復号し、同梱テンプレで OCR プリフィルを実行する。 */
export async function prefillFromScreenshot(blob: Blob): Promise<OcrPrefillResult> {
  const img = await decodeToRgba(blob);
  return ocrPrefillFromRgba(img, getBundledTemplates());
}

export type { OcrPrefillResult };
