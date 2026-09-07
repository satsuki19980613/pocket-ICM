/**
 * OCR プリフィル（純ロジック）: Rgba → BoardForm 候補。
 *
 * 経路: rgba → extractRawReads(CHIPS_6MAX) → runOcrPipeline → BoardState
 *       → boardStateToForm（既存アダプタ）。
 * ブラウザ API に非依存（Rgba 入力）なので Node でテスト可能。復号・テンプレ
 * 読み込みは screenshotPrefill.ts（ブラウザ・グルー）が受け持つ。
 *
 * SPEC §6.1: OCR は手入力フォームを埋めるプリフィルであり、結果は必ず条件確認
 * 画面を経由して全項目修正可能。読取失敗・対象外フレームは issues として返し、
 * 手入力継続に委ねる（lowConfidenceFields は確認画面の強調に使う）。
 */

import {
  extractRawReadsAuto,
  runOcrPipeline,
  CHIPS_6MAX,
  type ExtractTemplates,
  type ExtractOptions,
  type Rgba,
} from '@oshihiki/ocr';
import { boardStateToForm } from '../ocrPrefill';
import type { BoardForm } from '../formModel';

export interface OcrPrefillResult {
  /** pipeline が有効な root 局面を復元できたか。 */
  readonly ok: boolean;
  /** 成功時のプリフィル・フォーム（empty 席は除外済み）。 */
  readonly form?: BoardForm;
  /** 失敗理由・警告（gate/復元/検証のメッセージ）。 */
  readonly issues: string[];
  /** 低信頼フィールド（"UTG.stack" 等, 確認画面の強調用）。 */
  readonly lowConfidenceFields: string[];
}

/** ベット読みの minCh は chips プロファイルの確定値（extractFrame と同一）。 */
const DEFAULT_OPTS: ExtractOptions = { betMinCh: 125 };

/**
 * 取り込み対象外（チップ総額表示）のメッセージ。SPEC §5.2（さつき決定 2026-09-07）:
 * スタックが BB 表示のスクショだけ取り込み可、チップ総額表示は手入力に回す。
 */
export const CHIPS_MODE_ISSUE =
  'このスクショはチップ表示です。スタックが BB 表示（例: 20.2 BB）の画面を取り込んでください（チップ表示は手入力をご利用ください）。';

/** Rgba → OCR プリフィル結果（6-max BB 表示プロファイル）。 */
export function ocrPrefillFromRgba(
  img: Rgba,
  templates: ExtractTemplates,
  opts: ExtractOptions = {},
): OcrPrefillResult {
  // コンテンツ矩形を自動検出→較正解像度へ拡大してから抽出（多機種対応）。
  // Android 2730×1260 は全画面判定＝恒等で従来どおり。低解像度スマホは内寄せ/縮小を吸収。
  const { reads } = extractRawReadsAuto(img, CHIPS_6MAX, templates, { ...DEFAULT_OPTS, ...opts });
  // 取り込み条件＝BB 表示のみ（SPEC §5.2）。チップ総額表示は早期に棄却して手入力へ誘導する。
  if (reads.displayMode !== 'bb') {
    return { ok: false, issues: [CHIPS_MODE_ISSUE], lowConfidenceFields: [] };
  }
  const res = runOcrPipeline(reads);
  if (!res.ok || !res.state) {
    return { ok: false, issues: res.issues, lowConfidenceFields: res.lowConfidenceFields };
  }
  return {
    ok: true,
    form: boardStateToForm(res.state),
    issues: res.issues,
    lowConfidenceFields: res.lowConfidenceFields,
  };
}
