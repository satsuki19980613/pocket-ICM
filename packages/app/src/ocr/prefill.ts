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
 *
 * SPEC §5.2.3（WP-A2）: 元画像モーダルは「元画像 × OCR 出力」の照合ビューとして、
 * 失敗した画像でも読めた分を見せる。そのため `readout` は displayMode が chips で
 * 早期棄却したときも含め、**全経路で返す**（既存4フィールドの意味・型は不変）。
 */

import type { GameMode } from '@oshihiki/core';
import {
  extractAnchored,
  extractRawReadsAuto,
  runOcrPipeline,
  pickSeatAnchorGrid,
  buildReadout,
  CHIPS_6MAX,
  IOS_6MAX,
  FULL_FRAME,
  type RawReads,
  type ExtractTemplates,
  type ExtractOptions,
  type Rgba,
  type OcrReadout,
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
  /** 元画像 × OCR 出力の照合ビュー用データ（SPEC §5.2.3）。chips 棄却時も含め常に返す。 */
  readonly readout?: OcrReadout;
  /** issues を安定コードへ分類したもの（readout.issueCodes と同一・SPEC §12.2）。 */
  readonly issueCodes?: string[];
  /** 元画像の寸法（照合ビューのヘッダ表示用）。 */
  readonly imageSize?: { w: number; h: number };
  /**
   * 選んだゲームモードの総チップと場のチップ総量が大きく食い違う＝**モード取り違えの疑い**。
   * 棄却はせず確認画面で警告するだけ（さつき決定 2026-09-12）。
   */
  readonly modeMismatch?: boolean;
  /**
   * **未読 1 席のスタックを、選んだゲームの総チップから復元した**。復元値はゲーム選択に直接
   * 依存する（選択が違うとこの席だけ大きくずれる）ので、確認画面で値の確認を促す。
   */
  readonly stackRecovered?: boolean;
  /**
   * スタックを読めないまま残った席（ポジション）。**2 席以上は保存則でも埋められない**ので
   * 仮値 0bb が入る。確認画面で明示的に修正を促す（さつき指示 2026-09-12）。
   */
  readonly unresolvedStacks?: string[];
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
  gameMode: GameMode = 'club',
): OcrPrefillResult {
  // 抽出はアンカー方式に一本化（解像度・アスペクト非依存・docs/OCR_PHASE2.md）。固定座標プロファイル
  // ＋`img.w>=2400` の機種二値分岐は、較正解像度から外れた実機（例 1310×536）で全席ズレて棄却/誤読
  // する破綻があり、ランドマーク（黄色名→直上BB／中央"Pot :"／Dボタン→リング位相）からの相対読みで
  // 置換した。全27枚で旧固定座標とスタック±0.05一致・棄却も一致し、旧では読めない劣化フレームを救う
  // ことを実測（§B9 基準①②③）。旧固定座標経路は **crash 安全網**として throw 時のみ使う（挙動不変）。
  let reads: RawReads;
  try {
    // 機種別の静的アンカーグリッド（アスペクト帯で選択）。既知の破綻帯（超ワイド ~2.44）のみ
    // 検出重心をグリッド座標で確定し、それ以外は undefined＝現行の検出のまま（回帰ゼロ）。
    const seatAnchors = pickSeatAnchorGrid(img.w / img.h);
    reads = extractAnchored(img, templates, seatAnchors ? { seatAnchors } : {});
  } catch {
    const isAndroid = img.w >= 2400;
    reads = isAndroid
      ? extractRawReadsAuto(img, CHIPS_6MAX, templates, { ...DEFAULT_OPTS, ...opts }).reads
      : extractRawReadsAuto(img, IOS_6MAX, templates, { ...DEFAULT_OPTS, ...opts, contentRect: FULL_FRAME }).reads;
  }
  const imageSize = { w: img.w, h: img.h };
  // 取り込み条件＝BB 表示のみ（SPEC §5.2）。チップ総額表示は早期に棄却して手入力へ誘導する。
  // pipeline を通していないので posById 等は無いが、読めた分（席の生読み取り）は照合ビューに出す。
  if (reads.displayMode !== 'bb') {
    const readout = buildReadout(reads, { issues: [CHIPS_MODE_ISSUE] });
    return {
      ok: false,
      issues: [CHIPS_MODE_ISSUE],
      lowConfidenceFields: [],
      readout,
      issueCodes: readout.issueCodes,
      imageSize,
    };
  }
  const res = runOcrPipeline(reads, { gameMode });
  if (!res.ok || !res.state) {
    return {
      ok: false,
      issues: res.issues,
      lowConfidenceFields: res.lowConfidenceFields,
      readout: res.readout,
      issueCodes: res.readout.issueCodes,
      imageSize,
    };
  }
  return {
    ok: true,
    form: boardStateToForm(res.state),
    ...(res.chipCheck?.modeMismatch ? { modeMismatch: true } : {}),
    ...(res.chipCheck?.modeDependentRecovery ? { stackRecovered: true } : {}),
    ...(res.unresolvedStacks.length > 0 ? { unresolvedStacks: res.unresolvedStacks } : {}),
    issues: res.issues,
    lowConfidenceFields: res.lowConfidenceFields,
    readout: res.readout,
    issueCodes: res.readout.issueCodes,
    imageSize,
  };
}
