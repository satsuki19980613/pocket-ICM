/**
 * 条件確認のポット欄（純関数）。さつき決定 2026-09-11。
 *
 * 以前は「アプリが計算したポット」を「同じ入力から計算したポット」と比べていたので常に
 * 「一致」になり、しかも丸める前の値（例 2.75）をそのまま出していた。ゲームの画面は小数第 2 位を
 * 四捨五入した 2.8 なので、利用者には食い違って見えた（実機 Pixel で指摘）。
 *
 * ここでは:
 *   - スクショから読んだポットがあれば、それと**本当に照合**する。人数やスタックの読み違いで
 *     計算がずれていれば「不一致」として気づける。
 *   - 表示はゲームと同じ丸め（`roundBbDisplay`）。
 *   - 手入力（読んだポットが無い）ときは、従来どおり入力が矛盾していないことだけを示す。
 *
 * ## 何と何を比べるか
 * 確認画面の局面は**配られた時点**（全員が生存・ブラインドとアンティだけが場にある）なので、
 * そのポットは「SB + BB + 人数 × アンティ」。一方スクショの画面のポットには、オールイン・コール・
 * レイズで**上乗せされたチップ**も入っている（例: iPhone SE の 3 人卓は画面 31.3、配られた時点 2.25）。
 * そこで、読み取り結果の各席の行動とベット額から上乗せ分（ベット − その席のブラインド）を足して、
 * 画面と同じ条件の値にしてから比べる。
 *
 * ## 許容差
 * 上乗せが無い（未オープン）ときは、計算値をゲームと同じく丸めた値が画面の値と**ぴったり**
 * 一致するはず（2.75 → 2.8）。上乗せがあるときは、足したオールイン額などが画面の丸めた値
 * （±0.05）なので、その席数ぶんだけ許容する。
 */

import { formatBbDisplay, potChecksumDelta, roundBbDisplay, type BoardState } from '@oshihiki/core';
import type { OcrReadout } from '@oshihiki/ocr';

export interface PotRowView {
  /** ポット欄に出す文言。 */
  readonly text: string;
  /** 一致（true）なら通常色、それ以外は警告色。 */
  readonly ok: boolean;
}

/** 照合に使う読み取り結果の部分（ポットと各席）。 */
export type PotReadout = Pick<OcrReadout, 'pot' | 'seats'>;

/** 読んだチップ額を使う行動（それ以外の席はブラインドしか置いていない）。 */
const VOLUNTARY = new Set(['allin', 'call', 'raise']);

/** 画面の丸め（1 席ぶん）。 */
const DISPLAY_HALF_STEP = 0.05;

/**
 * @param state   確認画面の局面（ポットは buildBoardState がブラインドとアンティから計算済み）
 * @param readout スクショの読み取り結果。手入力のときは undefined。
 */
export function potRowView(state: BoardState, readout?: PotReadout): PotRowView {
  const delta = potChecksumDelta(state);
  if (delta === null || state.pot === undefined) return { text: '—', ok: false };
  // 局面そのものが矛盾している（ベット合計＋アンティとポットが合わない）。
  if (Math.abs(delta) >= 1e-9) return { text: `不一致 Δ=${delta.toFixed(2)}`, ok: false };

  const readPot = readout?.pot.value;
  if (!readout || readPot === undefined || !Number.isFinite(readPot)) {
    return { text: `一致 (${formatBbDisplay(state.pot)}bb)`, ok: true };
  }

  // 画面のポット = 配られた時点のポット + 上乗せ（ベット − その席のブラインド）。
  let raised = 0;
  let voluntarySeats = 0;
  for (const s of readout.seats) {
    if (s.occupancy.value === 'empty' || !VOLUNTARY.has(s.action.value)) continue;
    const bet = s.bet.value;
    if (!(Number.isFinite(bet) && bet > 0)) {
      return { text: `画面 ${formatBbDisplay(readPot)}bb（オールイン額が読めず照合できません）`, ok: false };
    }
    const blind = s.pos === 'SB' ? state.blinds.sb : s.pos === 'BB' ? state.blinds.bb : 0;
    raised += bet - blind;
    voluntarySeats++;
  }
  const expected = state.pot + raised;

  const ok =
    voluntarySeats === 0
      ? roundBbDisplay(expected) === roundBbDisplay(readPot)
      : Math.abs(expected - readPot) <= DISPLAY_HALF_STEP * (voluntarySeats + 1) + 1e-9;
  // 一致したときは**画面から読んだ値**を出す。上乗せ分に足したオールイン額などは画面で既に
  // 四捨五入された値なので、計算値を丸め直すと画面と 0.1 ずれることがある（実測: 3 人卓で
  // BU が 9.6 BB オールイン → 計算 2.25 + 9.6 = 11.85 → 11.9 だが、画面は 11.8）。
  return ok
    ? { text: `一致 (${formatBbDisplay(readPot)}bb)`, ok: true }
    : { text: `不一致（画面 ${formatBbDisplay(readPot)}bb / 計算 ${formatBbDisplay(expected)}bb）`, ok: false };
}
