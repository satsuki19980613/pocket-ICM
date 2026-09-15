/**
 * ポット（そのストリートが始まった時点の額・チップ）を求める規則だけを置く、中立なモジュール。
 *
 * `slumbot/tenfour.ts`（`streetPots`）・`sng/tenfour.ts`（`street_pots` の組み立て）・
 * `history/huHandView.ts`・`history/sngHandView.ts` の 4 か所すべてがここを呼ぶ。
 * 依存は `slumbot/rules.ts` の定数と `@oshihiki/sng` の型だけに絞り、tenfour.ts 側や
 * ビューモデル側は一切 import しない（＝どちら向きに import しても循環にならない）。
 * bb 換算・キー名（`flop`/`turn`/`river`/`showdown` 等）は呼び出し側の役目。
 */

import type { SngHandRecord } from '@oshihiki/sng';

import { BB, SB } from '../slumbot/rules';

/** walkActions の 1 手のうち、ポット計算に要る最小限（`ActionStep` と構造的に互換）。 */
export interface PotStep {
  /** 0=preflop … 3=river */
  readonly street: number;
  /** この 1 手で新たに出した額（チップ）。 */
  readonly put: number;
}

/** Slumbot HU: そのストリート（0=preflop…3=river）が始まった時点のポット（チップ）。 */
export function huStreetPotChips(steps: readonly PotStep[], street: number): number {
  let pot = SB + BB; // 150（SB 50 + BB 100）。
  for (const st of steps) if (st.street < street) pot += st.put;
  return pot;
}

/** SIT & GO: アンティ→ブラインドの順に min(stack, 額) を出す（短いスタック対応・SNG_DESIGN.md §1）。 */
export function sngForcedOf(seat: number, rec: SngHandRecord): number {
  const stack = rec.startStacks[seat] ?? 0;
  if (stack <= 0) return 0;
  let amt = Math.min(rec.ante, stack);
  const remaining = stack - amt;
  if (seat === rec.sbSeat) amt += Math.min(rec.sb, remaining);
  else if (seat === rec.bbSeat) amt += Math.min(rec.bb, remaining);
  return amt;
}

/** SIT & GO: その席がこのハンドで拠出した総額（アンティ・ブラインド＋アクション分）。 */
export function sngCommittedOf(seat: number, rec: SngHandRecord): number {
  let amt = sngForcedOf(seat, rec);
  for (const a of rec.actions) if (a.seat === seat) amt += a.put;
  return amt;
}

/**
 * SIT & GO: そのストリート（0=preflop…3=river）が始まった時点のポット（チップ）。
 * `live` はそのハンドで生きている席（開始時スタックが 0 でない席）。
 */
export function sngStreetPotChips(rec: SngHandRecord, live: readonly number[], street: number): number {
  let pot = live.reduce((a, seat) => a + sngForcedOf(seat, rec), 0);
  for (const a of rec.actions) if (a.street < street) pot += a.put;
  return pot;
}

/** `uncalledExcess` の結果。上乗せが無ければ `amount` は 0（`seat` は拠出額が最大の席・並びが空なら -1）。 */
export interface UncalledExcess {
  readonly seat: number;
  readonly amount: number;
}

/**
 * 拠出額（`committed`・席の並び順は問わない）から「誰にもコールされなかった上乗せ」を求める。
 * 最大拠出の席が単独なら、その席の拠出額から「2 番目に多い拠出額」を引いた分が上乗せ
 * （＝コールされなかったのでそのハンドの実際のポットには入らず、席に戻る）。最大拠出が
 * 複数席で並んでいれば互いにコールし合っているので上乗せは無い（`amount` は 0）。
 *
 * HU の 2 人（`committed = [committed0, committed1]`）で試すと、必ず
 * `committed0 + committed1 - uncalledExcess(...).amount === 2 * Math.min(committed0, committed1)`
 * になる（`pots.test.ts` で固定）。サイドポットのある多人数オールインでも、最大拠出額
 * より上の「誰にも届いていない」分だけを返す、という標準ルールと同じ。
 */
export function uncalledExcess(committed: readonly number[]): UncalledExcess {
  let maxSeat = -1;
  let max = -1;
  let second = -1;
  let maxCount = 0;
  for (let seat = 0; seat < committed.length; seat += 1) {
    const c = committed[seat] ?? 0;
    if (c > max) {
      second = max;
      max = c;
      maxSeat = seat;
      maxCount = 1;
    } else if (c === max) {
      maxCount += 1;
    } else if (c > second) {
      second = c;
    }
  }
  if (maxSeat < 0 || maxCount > 1) return { seat: maxSeat, amount: 0 };
  return { seat: maxSeat, amount: max - Math.max(second, 0) };
}

/** 拠出額の配列から、実際に奪い合われた額（＝ Σcommitted − 上乗せの返還分）を求める。 */
export function contestedPotChips(committed: readonly number[]): number {
  const total = committed.reduce((a, c) => a + c, 0);
  return total - uncalledExcess(committed).amount;
}
