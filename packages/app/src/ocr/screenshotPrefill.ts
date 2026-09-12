/**
 * スクショ → OCR プリフィル（ブラウザ・グルー）。
 * 復号（decodeImage）＋同梱テンプレ（bundledTemplates）＋純ロジック（prefill）を束ねる。
 * UI からはこの 1 関数だけを呼ぶ。
 */

import type { GameMode } from '@oshihiki/core';
import { decodeToRgba } from './decodeImage';
import { getBundledTemplates } from './bundledTemplates';
import { ocrPrefillFromRgba, type OcrPrefillResult } from './prefill';

/**
 * 画像 Blob を復号し、同梱テンプレで OCR プリフィルを実行する。
 * `gameMode` は利用者がスクショ選択画面で選んだモード。総チップ保存チェックの基準に使うため
 * **OCR より前に決まっている必要がある**（だからゲーム選択ボタンは入力画面側に置く）。
 */
export async function prefillFromScreenshot(blob: Blob, gameMode: GameMode = 'club'): Promise<OcrPrefillResult> {
  const img = await decodeToRgba(blob);
  return ocrPrefillFromRgba(img, getBundledTemplates(), {}, gameMode);
}

export type { OcrPrefillResult };
