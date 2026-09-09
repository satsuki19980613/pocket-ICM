/**
 * OCR 出力の外出し（照合ビューのデータ源・SPEC §5.2.3 / §12.2 / BETA_PLAN WP-A2）。
 *
 * `RawReads`（画像層の生読み取り）は pipeline 内部の入力形であり、UI（元画像 × OCR
 * 出力の照合モーダル）やサーバ保存（`ocr_reads.raw_reads`）にそのまま渡すには
 * 都合が悪い（Position 未導出・issue コード未分類・低信頼キーが分散している）。
 *
 * `buildReadout` は RawReads と pipeline が計算した付帯情報（pos 対応表・issues 等）を
 * 受け取り、UI が直接描ける固定スキーマ `OcrReadout` にまとめる**純関数**。
 * - 値の丸め・書式整形はしない（BB 表記や % 化は UI/`ocrReadoutView.ts` の責務）。
 * - `reads` を破壊しない（返す `Read<T>` はすべて入力の参照をそのまま使う）。
 * - gate 失敗・表示モード棄却・復元失敗など**どの経路でも呼べる**（失敗画像こそ
 *   照合ビューで見たいため、pos が未導出なら単に付けない）。
 */

import type { AnteScheme, DisplayMode, Occupancy, RawReads, RawSeatRead, Read, SeatAction } from './types.js';
import { classifyIssueCodes } from './issueCodes.js';

/** 信頼度付きの読み取り値（UI 向け固定スキーマ）。中身は `Read<T>` と同一。 */
export type ReadV<T> = Read<T>;

/** 席の低信頼キー。 */
export type SeatLowKey = 'occupancy' | 'action' | 'stack' | 'bet';

export interface OcrSeatReadout {
  /** 物理席 id（RawSeatRead.id と同一）。 */
  readonly id: string;
  /** 導出できた場合のみ（UTG/HJ/CO/BTN/SB/BB）。導出前・導出失敗時は無し（席 ID 表示は UI 側）。 */
  readonly pos?: string;
  readonly isHero: boolean;
  readonly isButton: boolean;
  readonly occupancy: ReadV<Occupancy>;
  readonly action: ReadV<SeatAction>;
  readonly stack: ReadV<number>;
  readonly bet: ReadV<number>;
  /** この席の低信頼キー（この席の conf < threshold の項目一覧）。 */
  readonly low: SeatLowKey[];
}

/** 総チップ保存チェック（`chipConsistency.ts`）の要約（照合ビュー表示用）。 */
export interface ReadoutChipCheck {
  readonly applied: boolean;
  readonly note?: string;
  readonly correctedSeatId?: string;
}

export interface OcrReadout {
  readonly street: ReadV<string>;
  readonly displayMode?: DisplayMode;
  readonly blinds: { readonly sb: ReadV<number>; readonly bb: ReadV<number> };
  readonly ante: { readonly scheme: AnteScheme; readonly amount: ReadV<number> };
  readonly blindChips?: { readonly sb: number; readonly bb: number; readonly ante: number; readonly level: number };
  readonly pot: ReadV<number>;
  readonly heroHand: ReadV<string>;
  /** 時計回り（RawReads.seats の順を保つ）。 */
  readonly seats: readonly OcrSeatReadout[];
  /** 低信頼しきい値（既定 0.8）。 */
  readonly threshold: number;
  /** "UTG.stack" 等（pipeline の値と同一。conf<threshold or チェックサム不一致由来）。 */
  readonly lowConfidenceFields: string[];
  /** gate/対象外/復元失敗などの issue メッセージ（成功時は空）。 */
  readonly issues: string[];
  /** issues を安定コードへ分類したもの（SPEC §12.2）。 */
  readonly issueCodes: string[];
  readonly chipCheck?: ReadoutChipCheck;
}

/** 低信頼しきい値の既定値（confidence.ts の既定と一致）。 */
const DEFAULT_THRESHOLD = 0.8;

export interface BuildReadoutExtra {
  /** 物理席 id → ポジション文字列。position 導出に成功した経路でのみ渡す。 */
  readonly posById?: ReadonlyMap<string, string>;
  /** 低信頼しきい値。既定 0.8。 */
  readonly threshold?: number;
  /** pipeline が返した issue メッセージ（gate/対象外/復元失敗等）。 */
  readonly issues?: readonly string[];
  /** pipeline が返した lowConfidenceFields（Position keyed）。 */
  readonly lowConfidenceFields?: readonly string[];
  /** 総チップ保存チェックの結果要約。 */
  readonly chipCheck?: ReadoutChipCheck;
  /** ポット・チェックサムが不一致だったか（§6.3）。issueCodes に checksum_mismatch を足すためだけに使う。 */
  readonly checksumOk?: boolean;
}

function seatLow(s: RawSeatRead, threshold: number): SeatLowKey[] {
  const low: SeatLowKey[] = [];
  if (s.occupancy.conf < threshold) low.push('occupancy');
  if (s.action.conf < threshold) low.push('action');
  if (s.stack.conf < threshold) low.push('stack');
  if (s.bet.conf < threshold) low.push('bet');
  return low;
}

function buildSeat(s: RawSeatRead, threshold: number, posById?: ReadonlyMap<string, string>): OcrSeatReadout {
  const pos = posById?.get(s.id);
  return {
    id: s.id,
    ...(pos !== undefined ? { pos } : {}),
    isHero: s.isHero,
    isButton: s.isButton,
    occupancy: s.occupancy,
    action: s.action,
    stack: s.stack,
    bet: s.bet,
    low: seatLow(s, threshold),
  };
}

/**
 * RawReads → OcrReadout（照合ビュー・サーバ保存用の固定スキーマ）。純関数・reads は不変。
 */
export function buildReadout(reads: RawReads, extra: BuildReadoutExtra = {}): OcrReadout {
  const threshold = extra.threshold ?? DEFAULT_THRESHOLD;
  const issues = extra.issues ? [...extra.issues] : [];

  const seats = reads.seats.map((s) => buildSeat(s, threshold, extra.posById));

  return {
    street: reads.street,
    ...(reads.displayMode !== undefined ? { displayMode: reads.displayMode } : {}),
    blinds: { sb: reads.blinds.sb, bb: reads.blinds.bb },
    ante: { scheme: reads.ante.scheme, amount: reads.ante.amount },
    ...(reads.blindChips !== undefined ? { blindChips: reads.blindChips } : {}),
    pot: reads.pot,
    heroHand: reads.heroHand,
    seats,
    threshold,
    lowConfidenceFields: extra.lowConfidenceFields ? [...extra.lowConfidenceFields] : [],
    issues,
    issueCodes: classifyIssueCodes(issues, { checksumOk: extra.checksumOk }),
    ...(extra.chipCheck !== undefined ? { chipCheck: extra.chipCheck } : {}),
  };
}
