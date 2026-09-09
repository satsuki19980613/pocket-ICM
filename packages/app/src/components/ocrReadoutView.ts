/**
 * OcrReadout → 表示用の行データへの変換（純関数, SPEC §5.2.3 / BETA_PLAN WP-B1）。
 *
 * `ImageModal`（元画像 × OCR 出力の照合ビュー）から算術・判定ロジックを追い出すための層。
 * ここでは:
 *   - BB 換算値の桁揃え表示（小数第1位固定）
 *   - bet===0 の非表示（`betText: null`）
 *   - 空席（occupancy===empty）行の除外
 *   - 総チップ保存チェック（chipConsistency）の補足文言
 * だけを行う。UI（ImageModal）はこの結果をそのまま並べるだけにする。
 *
 * 照合に必要な最小限（ポジション・スタック・bet）だけを表示する方針のため、ヘッダ表
 * （ストリート/表示モード/ブラインド/ポット/heroハンド/画像サイズ）と occupancy/action の
 * テキスト・信頼度（conf）の % 表記はここでは作らない（Director 指摘：情報過多）。
 * 低信頼の CHECK 強調（stackLow/betLow）だけは、% を出さずとも「怪しい値」の目印として
 * 引き続き有用なので残す。低信頼判定は `readout.seats[].low`（buildReadout が既に
 * conf<threshold で計算済み）を単一の真実として使い、ここで conf を再比較しない
 * （二重実装によるズレを避ける）。
 */

import type { OcrReadout, OcrSeatReadout } from '@oshihiki/ocr';

/** BB 換算値の表示（小数第1位固定＝桁揃え）。 */
export function formatBb(n: number): string {
  return `${n.toFixed(1)}bb`;
}

export interface ReadoutSeatRow {
  readonly id: string;
  /** 導出済みならポジション、無ければ席 ID（SPEC §5.2.3）。 */
  readonly posLabel: string;
  readonly isHero: boolean;
  readonly isButton: boolean;
  readonly stackText: string;
  /** 低信頼の CHECK 強調用（% 数値は出さないが、疑わしい値の目印としてクラス付与に使う）。 */
  readonly stackLow: boolean;
  /** bet===0 は非表示（SPEC 表内「0 は非表示」）。 */
  readonly betText: string | null;
  readonly betLow: boolean;
}

/** 1 席分の OcrSeatReadout → 表示行。低信頼判定は `seat.low` をそのまま使う。 */
export function buildSeatRow(seat: OcrSeatReadout): ReadoutSeatRow {
  const low = new Set(seat.low);
  return {
    id: seat.id,
    posLabel: seat.pos ?? seat.id,
    isHero: seat.isHero,
    isButton: seat.isButton,
    stackText: formatBb(seat.stack.value),
    stackLow: low.has('stack'),
    betText: seat.bet.value === 0 ? null : formatBb(seat.bet.value),
    betLow: low.has('bet'),
  };
}

/**
 * 表示対象の席（空席を除外）。
 *
 * 空席（occupancy==='empty'）の行は照合の邪魔になるため出さない。ただし hero 席だけは
 * occupancy が empty 判定（誤読）でも必ず残す。1 画像内で hero がどれか分からないと
 * そもそも照合できず、「hero 行が消える」方が「空席と誤読された理由が分からない」より
 * 事故として大きいため。
 */
function visibleSeats(readout: OcrReadout): readonly OcrSeatReadout[] {
  return readout.seats.filter((s) => s.isHero || s.occupancy.value !== 'empty');
}

/** 総チップ保存チェック（chipConsistency）の要約文言。適用されていなければ null。 */
export function buildChipCheckNote(readout: OcrReadout): string | null {
  const cc = readout.chipCheck;
  if (!cc || !cc.applied) return null;
  const seatPart = cc.correctedSeatId ? `（補正席: ${cc.correctedSeatId}）` : '';
  const notePart = cc.note ? `: ${cc.note}` : '';
  return `総チップ保存チェックで補正しました${seatPart}${notePart}`;
}

export interface OcrReadoutView {
  readonly seats: readonly ReadoutSeatRow[];
  readonly issues: readonly string[];
  readonly chipCheckNote: string | null;
}

/** `OcrReadout` → 照合ビュー表示用データ一式。UI はこれをそのまま描画するだけにする。 */
export function buildOcrReadoutView(readout: OcrReadout): OcrReadoutView {
  return {
    seats: visibleSeats(readout).map(buildSeatRow),
    issues: readout.issues,
    chipCheckNote: buildChipCheckNote(readout),
  };
}
