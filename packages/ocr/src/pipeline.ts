/**
 * OCR 検証パイプライン（画像非依存の中核, Plan 2-2/2-4/2-6/2-7/2-8）。
 *
 * 画像層が生成した RawReads を受け取り、
 *   1. ストリート gate（preflop 以外を弾く）
 *   2. ポジション導出（D ボタン＋生存席）＋ root spot 復元
 *   3. 対象外検出（リンプ/レイズ/3bet/ウォーク）
 *   4. core の zod / 意味論検証
 *   5. 信頼度集約＋ポット・チェックサム
 * を通し、solver 入力となる BoardState と、条件確認画面用の強調情報を返す。
 *
 * 実画像からの RawReads 生成（座標・テンプレ）は後続。ここまでは合成 RawReads で
 * 完全に検証できる。
 */

import type { BoardState } from '@oshihiki/core';
import { parseBoardState, checkBoardStateSemantics } from '@oshihiki/core';
import type { RawReads } from './types.js';
import { streetGate } from './gate.js';
import { reconstructSpot } from './spotReconstruction.js';
import { aggregateConfidence, type ChecksumResult } from './confidence.js';
import { applyChipConsistency, type ChipConsistencyResult } from './chipConsistency.js';

export interface OcrValidation {
  readonly ok: boolean;
  /** 対象外・エラー（§6.5/6.6）。空なら成功。 */
  readonly issues: string[];
  /** 成功時の root spot（solver 入力）。 */
  readonly state?: BoardState;
  /** 条件確認画面で強調する項目キー。 */
  readonly lowConfidenceFields: string[];
  /** ポット・チェックサム結果（gate 失敗時は undefined）。 */
  readonly checksum?: ChecksumResult;
  /** 総チップ保存チェック結果（クラブマッチ・レベル確定時のみ applied）。 */
  readonly chipCheck?: ChipConsistencyResult;
  /** チェックサム/整合性で補正・強調した席（診断用）。 */
  readonly correctedSeatId?: string;
}

export interface OcrPipelineOptions {
  /** 信頼度しきい値（未満で強調）。既定 0.8。 */
  readonly confidenceThreshold?: number;
  /** チェックサム許容差（bb）。既定 0.5。 */
  readonly checksumTol?: number;
}

export function runOcrPipeline(reads: RawReads, opts: OcrPipelineOptions = {}): OcrValidation {
  const gate = streetGate(reads.street);
  if (!gate.ok) {
    return { ok: false, issues: gate.issues, lowConfidenceFields: [] };
  }

  // 総チップ保存チェック（クラブマッチ）: 未読 1 席の復元／最低信頼席での差分調整。
  // blindChips が無ければ no-op（reads 不変＝従来挙動・回帰ゼロ）。復元/調整した席は下流で
  // reconstruct され、低信頼フラグで確認画面に強調される。
  const { reads: cReads, result: chipCheck } = applyChipConsistency(reads);
  reads = cReads;

  const recon = reconstructSpot(reads);
  if (!recon.ok || !recon.state || !recon.facts) {
    return { ok: false, issues: recon.issues, lowConfidenceFields: [] };
  }

  // core の構造・意味論検証（保険）。
  const parsed = parseBoardState(recon.state);
  if (!parsed.ok || !parsed.value) {
    return { ok: false, issues: parsed.issues, lowConfidenceFields: [] };
  }
  const sem = checkBoardStateSemantics(parsed.value);
  if (!sem.ok) {
    return { ok: false, issues: sem.issues, lowConfidenceFields: [] };
  }

  const facts = [...recon.facts.values()];
  const conf = aggregateConfidence(reads, facts, {
    ...(opts.confidenceThreshold !== undefined ? { threshold: opts.confidenceThreshold } : {}),
    ...(opts.checksumTol !== undefined ? { checksumTol: opts.checksumTol } : {}),
  });

  // 補正した席は確認画面で必ず強調（復元/調整＝要目視）。生スロット id を Position キーへ変換。
  const correctedPos = chipCheck.correctedSeatId
    ? facts.find((f) => f.id === chipCheck.correctedSeatId)?.pos
    : undefined;
  const low = correctedPos
    ? [...new Set([...conf.lowConfidenceFields, `${correctedPos}.stack`])].sort()
    : conf.lowConfidenceFields;

  return {
    ok: true,
    issues: [],
    state: parsed.value,
    lowConfidenceFields: low,
    checksum: conf.checksum,
    chipCheck,
    ...(correctedPos ? { correctedSeatId: correctedPos } : {}),
  };
}
