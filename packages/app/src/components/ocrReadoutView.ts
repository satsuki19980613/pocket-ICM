/**
 * OcrReadout → 表示用の行データへの変換（純関数, SPEC §5.2.3 / BETA_PLAN WP-B1）。
 *
 * `ImageModal`（元画像 × OCR 出力の照合ビュー）から算術・判定ロジックを追い出すための層。
 * ここでは:
 *   - 信頼度（0〜1）の % 化・CHECK（低信頼）判定
 *   - BB 換算値の桁揃え表示（小数第1位固定）
 *   - アクション/状態/ストリートの日本語ラベル化（用語は push/fold・AOF に統一し「押し引き」は使わない）
 *   - bet===0 の非表示（`betText: null`）
 *   - 総チップ保存チェック（chipConsistency）の補足文言
 * だけを行う。UI（ImageModal）はこの結果をそのまま並べるだけにする。
 *
 * 低信頼判定は `readout.seats[].low`（buildReadout が既に conf<threshold で計算済み）を
 * 単一の真実として使い、ここで conf を再比較しない（二重実装によるズレを避ける）。
 * ヘッダ側の値（street/pot/heroHand）は seat 用の low 配列が無いので、ここで
 * `conf < readout.threshold` を直接比較する。
 */

import { classifyStreet, type OcrReadout, type OcrSeatReadout, type Occupancy, type SeatAction } from '@oshihiki/ocr';

/** ストリート表示ラベル（`classifyStreet` の正規化結果ベース）。 */
const STREET_LABELS: Record<string, string> = {
  preflop: 'プリフロップ',
  flop: 'フロップ',
  turn: 'ターン',
  river: 'リバー',
  unknown: '不明',
};

/** アクション表示ラベル（日本語）。 */
const ACTION_LABELS: Record<SeatAction, string> = {
  fold: 'フォールド',
  call: 'コール',
  raise: 'レイズ',
  allin: 'オールイン',
  check: 'チェック',
  none: 'なし',
};

/** 占有状態の表示ラベル。 */
const OCCUPANCY_LABELS: Record<Occupancy, string> = {
  occupied: '配牌あり',
  empty: '空席',
};

/** 信頼度（0〜1）を "86%" 表記へ丸める。 */
export function formatConfPct(conf: number): string {
  return `${Math.round(conf * 100)}%`;
}

/** conf < threshold なら CHECK 強調対象。 */
export function isLowConf(conf: number, threshold: number): boolean {
  return conf < threshold;
}

/** BB 換算値の表示（小数第1位固定＝桁揃え）。 */
export function formatBb(n: number): string {
  return `${n.toFixed(1)}bb`;
}

/**
 * ブラインド・アンティの表示（最大小数2桁・末尾の0は落とす）。
 * チップ表示のフレームでは正規化の割り算で `0.25757575757575757` のような長い小数が
 * そのまま入ってくるため、読み手が画像と見比べられる桁に丸める。
 */
export function formatAmount(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return String(Math.round(n * 100) / 100);
}

/** アクション → 日本語ラベル。 */
export function actionLabel(a: SeatAction): string {
  return ACTION_LABELS[a];
}

/** 占有状態 → 日本語ラベル。 */
export function occupancyLabel(o: Occupancy): string {
  return OCCUPANCY_LABELS[o];
}

/** ストリート生値（"プリフロップ" / "preflop" 等の表記ゆれ）→ 表示ラベル。 */
export function streetLabel(raw: string): string {
  return STREET_LABELS[classifyStreet(raw)] ?? raw;
}

export interface ReadoutHeaderItem {
  readonly label: string;
  readonly value: string;
  /** 単一の Read 値に基づく項目のみ（複合項目＝ブラインド行は無し）。 */
  readonly confPct?: string;
  readonly low: boolean;
}

/**
 * ヘッダ情報（ストリート/表示モード/ブラインド・アンティ/ポット/heroハンド/画像サイズ）。
 * `imageSize` は `OcrReadout` に含まれない（`OcrPrefillResult.imageSize` 由来）ので別引数で受ける。
 */
export function buildHeaderItems(readout: OcrReadout, imageSize?: { w: number; h: number }): ReadoutHeaderItem[] {
  const items: ReadoutHeaderItem[] = [];
  const threshold = readout.threshold;

  items.push({
    label: 'ストリート',
    value: streetLabel(readout.street.value),
    confPct: formatConfPct(readout.street.conf),
    low: isLowConf(readout.street.conf, threshold),
  });

  if (readout.displayMode) {
    items.push({ label: '表示モード', value: readout.displayMode === 'bb' ? 'BB表示' : 'チップ表示', low: false });
  }

  const anteText =
    readout.ante.scheme === 'none'
      ? 'なし'
      : `${formatAmount(readout.ante.amount.value)}bb (${readout.ante.scheme})`;
  let blindsValue =
    `${formatAmount(readout.blinds.sb.value)} / ${formatAmount(readout.blinds.bb.value)}　ante ${anteText}`;
  if (readout.blindChips) blindsValue += `　Lv.${readout.blindChips.level}`;
  const blindsLow =
    isLowConf(readout.blinds.sb.conf, threshold) ||
    isLowConf(readout.blinds.bb.conf, threshold) ||
    (readout.ante.scheme !== 'none' && isLowConf(readout.ante.amount.conf, threshold));
  items.push({ label: 'ブラインド', value: blindsValue, low: blindsLow });

  items.push({
    label: 'ポット',
    value: formatBb(readout.pot.value),
    confPct: formatConfPct(readout.pot.conf),
    low: isLowConf(readout.pot.conf, threshold),
  });

  items.push({
    label: 'heroハンド',
    value: readout.heroHand.value,
    confPct: formatConfPct(readout.heroHand.conf),
    low: isLowConf(readout.heroHand.conf, threshold),
  });

  if (imageSize) {
    items.push({ label: '画像サイズ', value: `${imageSize.w}×${imageSize.h}`, low: false });
  }

  return items;
}

export interface ReadoutSeatRow {
  readonly id: string;
  /** 導出済みならポジション、無ければ席 ID（SPEC §5.2.3）。 */
  readonly posLabel: string;
  readonly isHero: boolean;
  readonly isButton: boolean;
  readonly occupancyText: string;
  readonly occupancyConfPct: string;
  readonly occupancyLow: boolean;
  readonly actionText: string;
  readonly actionConfPct: string;
  readonly actionLow: boolean;
  readonly stackText: string;
  readonly stackConfPct: string;
  readonly stackLow: boolean;
  /** bet===0 は非表示（SPEC 表内「0 は非表示」）。 */
  readonly betText: string | null;
  readonly betConfPct: string;
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
    occupancyText: occupancyLabel(seat.occupancy.value),
    occupancyConfPct: formatConfPct(seat.occupancy.conf),
    occupancyLow: low.has('occupancy'),
    actionText: actionLabel(seat.action.value),
    actionConfPct: formatConfPct(seat.action.conf),
    actionLow: low.has('action'),
    stackText: formatBb(seat.stack.value),
    stackConfPct: formatConfPct(seat.stack.conf),
    stackLow: low.has('stack'),
    betText: seat.bet.value === 0 ? null : formatBb(seat.bet.value),
    betConfPct: formatConfPct(seat.bet.conf),
    betLow: low.has('bet'),
  };
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
  readonly header: readonly ReadoutHeaderItem[];
  readonly seats: readonly ReadoutSeatRow[];
  readonly issues: readonly string[];
  readonly chipCheckNote: string | null;
}

/** `OcrReadout` → 照合ビュー表示用データ一式。UI はこれをそのまま描画するだけにする。 */
export function buildOcrReadoutView(
  readout: OcrReadout,
  opts: { imageSize?: { w: number; h: number } } = {},
): OcrReadoutView {
  return {
    header: buildHeaderItems(readout, opts.imageSize),
    seats: readout.seats.map(buildSeatRow),
    issues: readout.issues,
    chipCheckNote: buildChipCheckNote(readout),
  };
}
