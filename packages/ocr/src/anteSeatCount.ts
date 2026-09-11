/**
 * アンティから人数を割り出し、スタックが読めない席が「本物の席」か「空席の見間違い」かを
 * 決める（さつき決定 2026-09-11）。
 *
 * ## なぜ要るか（実測）
 * 装飾テーマ卓（Screenshot_20260910-192316.png）で、上中央の**空席**をステンドグラスの装飾の
 * せいで「人が座っている」と誤読した。その幽霊席にはスタックの数字が無いので 6 人卓として
 * 位置を割り当て、幽霊席を BB にしてしまう。最後は確認画面へ進む前の「スタックは正の数か」
 * チェックで弾かれ、利用者は「この内容では計算できません」画面に落ちた（ユーザー経路テストで確認）。
 *
 * ## 原理
 * クラブマッチのアンティは**全員が 0.25 BB を払う**（さつき確定）。アンティは座っている人数ぶん
 * ポットに入るので、ポット表示から場のベットを引けば人数が出る:
 *
 *     pot = 場のベット合計 + 人数 × 0.25
 *
 * 場のベットは行動マークから決まる:
 *   - レイズ/コール/オールインのマークが無い席 → 置いているのはブラインドだけ（SB 0.5 / BB 1 / 他 0）
 *   - マークがある席 → 読んだチップ額（オールイン額など）
 * 正解ラベル付きの BB 表示全 24 フレーム（オールイン/レイズ/コールを含む）で、この式から出した
 * 人数は 24/24 で実人数と一致した。ポット表示は 0.1 刻みの四捨五入、1 人ぶんの差は 0.25 なので
 * 丸めで取り違えることはない。
 *
 * ## 判定のしかた（割り算ではなく仮説の比較）
 * 「スタックが読めない席を**全部本物**とした場合」と「**全部空席**とした場合」の 2 通りについて、
 * 席順からブラインドの位置を決めて予想ポットを計算し、読んだポットに近い方を採る。
 * 割り算で人数を直接出すと、チップ 1 枚の読み漏らしで人数が大きく狂う（実測: 同フレームで BB の
 * 1 BB を読み漏らしており、読んだチップで割ると 9 人と出る）。仮説の比較なら、マークの無い席の
 * ベットは席順から決まるので、そもそもチップを読まずに済む。
 *
 * どちらの仮説も読んだポットと合わない、または差がつかないときは**何もしない**（＝従来どおり、
 * 読めない席は本物として残し、確認画面で注意色）。行動マークが付いている席は空席ではあり得ない
 * ので落とす候補にしない。hero 席も落とさない。
 */

import type { Position } from '@oshihiki/core';
import type { RawReads, RawSeatRead, SeatAction } from './types.js';
import { derivePositions } from './positionDerivation.js';

/** クラブマッチのアンティ（BB 換算・全員が払う）。さつき確定 2026-09-11。 */
export const ANTE_BB = 0.25;

/**
 * 予想ポットと読んだポットの許容差（BB）。ポット表示の四捨五入 0.05 に、公式表のアンティの
 * 微変動（330/660 → 170 = 0.2576、もっとゆっくり BB 300 → 70 = 0.233）を 0.25 と見なした誤差が
 * 最大 6 人で 0.1 乗る。1 人ぶんの差（0.25）より十分小さい。
 */
const POT_TOL = 0.15;
/** 2 つの仮説の当てはまりの差がこれ未満なら、どちらとも決めない。 */
const MIN_MARGIN = 0.1;

/** 判定結果（診断・照合ビュー用）。 */
export interface SeatCountCheck {
  /** 仮説の比較で決着したか（false = 何もしていない）。 */
  readonly applied: boolean;
  /** 空席に確定した席 id。 */
  readonly dropped: readonly string[];
  /** 採った仮説の人数。 */
  readonly players?: number;
  readonly note: string;
}

/** 読んだチップ額を使う行動（それ以外の席はブラインドしか置いていない）。 */
const VOLUNTARY: ReadonlySet<SeatAction> = new Set<SeatAction>(['allin', 'call', 'raise']);

function blindOf(pos: Position, sb: number, bb: number): number {
  return pos === 'SB' ? sb : pos === 'BB' ? bb : 0;
}

/** 仮説（空席にする席の集合）で予想されるポットと人数。評価できなければ null。 */
function predictPot(reads: RawReads, emptyIds: ReadonlySet<string>): { pot: number; players: number } | null {
  const derived = derivePositions(
    reads.seats.map((s) => ({
      id: s.id,
      occupied: s.occupancy.value !== 'empty' && !emptyIds.has(s.id),
      isButton: s.isButton,
      isHero: s.isHero,
    })),
  );
  if (!derived.ok) return null;
  const sb = reads.blinds.sb.value;
  const bb = reads.blinds.bb.value;
  let bets = 0;
  for (const [id, pos] of derived.byId) {
    const seat = reads.seats.find((s) => s.id === id);
    if (!seat) return null;
    if (VOLUNTARY.has(seat.action.value)) {
      const b = seat.bet.value;
      // オールイン額などが読めないと予想ポットが作れない（推測で埋めない）。
      if (!(Number.isFinite(b) && b > 0)) return null;
      bets += b;
    } else {
      bets += blindOf(pos, sb, bb);
    }
  }
  return { pot: bets + derived.playersLeft * ANTE_BB, players: derived.playersLeft };
}

/**
 * スタックが読めない席を、アンティとポットの整合で「本物」か「空席」に確定する。
 * 決着しなければ reads をそのまま返す。
 */
export function resolveStacklessSeats(reads: RawReads): { reads: RawReads; result: SeatCountCheck } {
  const skip = (note: string) => ({ reads, result: { applied: false, dropped: [], note } });
  if (reads.displayMode !== 'bb') return skip('not bb display');
  if (reads.ante.scheme !== 'all') return skip('ante is not paid by all');
  const pot = reads.pot.value;
  if (!(Number.isFinite(pot) && pot > 0)) return skip('pot unreadable');

  const candidates = reads.seats.filter(
    (s) =>
      s.occupancy.value !== 'empty' &&
      !s.isHero &&
      !Number.isFinite(s.stack.value) &&
      s.action.value === 'none', // マークがある席は本物
  );
  if (candidates.length === 0) return skip('no stackless seat');

  const dropIds = new Set(candidates.map((s) => s.id));
  const keep = predictPot(reads, new Set());
  const drop = predictPot(reads, dropIds);
  if (!keep || !drop) return skip('cannot evaluate');

  const errKeep = Math.abs(pot - keep.pot);
  const errDrop = Math.abs(pot - drop.pot);
  if (Math.min(errKeep, errDrop) > POT_TOL || Math.abs(errKeep - errDrop) < MIN_MARGIN) {
    return skip(`ambiguous (keep ${errKeep.toFixed(2)} / drop ${errDrop.toFixed(2)})`);
  }
  if (errKeep < errDrop) {
    return { reads, result: { applied: true, dropped: [], players: keep.players, note: 'stackless seats are real' } };
  }

  const conf = Math.min(0.95, 0.6 + (errKeep - errDrop));
  const seats: RawSeatRead[] = reads.seats.map((s) =>
    dropIds.has(s.id)
      ? {
          ...s,
          occupancy: { value: 'empty' as const, conf },
          action: { value: 'none' as const, conf },
          stack: { value: NaN, conf: 0 },
          bet: { value: 0, conf },
        }
      : s,
  );
  return {
    reads: { ...reads, seats },
    result: { applied: true, dropped: [...dropIds], players: drop.players, note: 'stackless seats are empty' },
  };
}
