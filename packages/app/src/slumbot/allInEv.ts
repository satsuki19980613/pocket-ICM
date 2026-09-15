/**
 * オールイン EV（SPEC §7.4.6）。
 *
 * 両者オールインで捲り合いになったハンドは、実際にめくれたカードではなく
 * 「その時点の勝率 × ポット − 出した額」を EV 収支とする。残りボードを全列挙する
 * 厳密計算（solver の exactEquityVsHands）。プリフロップの捲り合いは 1,712,304 通りで
 * 約 0.3 秒かかるので、結果画面の描画を止めない位置（setTimeout）から呼ぶ。
 */

import { exactEquityVsHands, parseCard } from '@oshihiki/solver';

import { walkActions, type HuHandRecord } from './history';
import { BOARD_COUNT, committed, potOf } from './rules';

/**
 * EV 収支（チップ）。捲り合いが無いハンドは実収支をそのまま返す。
 * 相手の手札が分からない（本来は起きない）ときも実収支に倒す。
 */
export function evWinningsOf(rec: HuHandRecord): number {
  const w = walkActions(rec.action);
  if (!w || w.allInStreet === null || !rec.botCards) return rec.winnings;
  const known = rec.board.slice(0, BOARD_COUNT[w.allInStreet] ?? 0);
  let equity: number;
  try {
    const hero: [number, number] = [parseCard(rec.heroCards[0]!), parseCard(rec.heroCards[1]!)];
    const bot: [number, number] = [parseCard(rec.botCards[0]!), parseCard(rec.botCards[1]!)];
    equity = exactEquityVsHands(hero, bot, known.map(parseCard)).equity;
  } catch {
    return rec.winnings;
  }
  const pot = potOf(w.final);
  return Math.round(equity * pot - committed(w.final, rec.heroSeat));
}

/** evWinnings が未計算なら埋めた記録を返す（計算済みならそのまま）。 */
export function withEv(rec: HuHandRecord): HuHandRecord {
  if (rec.evWinnings !== null) return rec;
  return { ...rec, evWinnings: evWinningsOf(rec) };
}
