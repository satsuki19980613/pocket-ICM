/**
 * SIT & GO の 1 ハンド記録（`SngHandRecord`）→ 共通ビューモデル（`HandDetailView`）。
 *
 * `huHandView.ts`（Slumbot HU 版）と同じ位置づけ。ポジション（`positionMapOf`）・
 * 表示名（`namesFromSeats`）・純収支（`netOf`）・bb 換算（`chipsToBbSng`）は
 * `sng/tenfour.ts` の既存の純関数をそのまま使う。
 *
 * ポット（そのストリートが始まった時点の額）の規則は `sng/tenfour.ts` の `street_pots`
 * 組み立てと共通の `history/pots.ts`（`sngStreetPotChips` / `sngCommittedOf`）から取る。
 * 最終ポット（`finalPotBb`）と獲得（`wonBb`）は `won`（=チップ保存則で Σwon=Σcommits に
 * なるよう、コールされなかった上乗せも勝者の取り分に含めて計算されている。
 * `packages/sng/src/engine/showdown.ts` 参照）をそのまま合計するのではなく、HU 版と
 * 共通の `contestedPotChips` / `uncalledExcess`（`history/pots.ts`）で上乗せぶんを除く。
 * 1 か所に規則を置くことで二重実装を避けている（値が一致することは
 * `sngHandView.test.ts` の契約テストでも保証）。
 */

import type { ActionKind, SngHandRecord } from '@oshihiki/sng';

import { BOARD_COUNT } from '../slumbot/rules';
import type { SngGameLocal } from '../sng/historyStore';
import { chipsToBbSng, namesFromSeats, netOf, positionMapOf, sngConfigSummary } from '../sng/tenfour';
import {
  STREET_VIEW_LABEL,
  type HandDetailView,
  type HandPlayerView,
  type HandResultView,
  type HandStepView,
  type HandStreetView,
} from './handView';
import { contestedPotChips, sngCommittedOf, sngStreetPotChips, uncalledExcess } from './pots';

export interface SngHandViewArgs {
  readonly rec: SngHandRecord;
  readonly game: SngGameLocal | null;
  /** 分かっていれば自分の席。 */
  readonly mySeat: number | null;
  readonly handNo: number;
  readonly level: number;
  /** 自分の手札（ショーダウンで公開されていない場合の唯一の材料）。分からなければ省略可。 */
  readonly myCards?: readonly [string, string] | null;
}

const ACTION_LABEL: Record<ActionKind, string> = {
  fold: 'FOLD',
  check: 'CHECK',
  call: 'CALL',
  bet: 'BET',
  raise: 'RAISE',
  allin: 'ALL IN',
};

/** 到達したストリート数（0=プリフロップのみ…3=リバーまで）。board の枚数から。 */
function reachedStreet(board: readonly string[]): number {
  if (board.length >= 5) return 3;
  if (board.length >= 4) return 2;
  if (board.length >= 3) return 1;
  return 0;
}

export function sngHandView(args: SngHandViewArgs): HandDetailView | null {
  const { rec, game, mySeat, handNo, level, myCards } = args;
  const positions = positionMapOf(rec);
  if (!positions) return null;
  const order = [...positions.keys()]; // positionMapOf は UTG→BB の順に Map を作る。
  const names = namesFromSeats(game?.seats ?? [], rec.startStacks.length);
  const nameOf = (seat: number): string => (seat === mySeat ? 'YOU' : (names[seat] ?? `Seat ${seat}`));
  const cardsOf = (seat: number): readonly string[] | null => {
    const shown = rec.shown[seat];
    if (shown) return [...shown];
    if (seat === mySeat && myCards) return [...myCards];
    return null;
  };

  const players: HandPlayerView[] = order.map((seat) => ({
    seat,
    pos: positions.get(seat) ?? '?',
    name: nameOf(seat),
    isHero: seat === mySeat,
    netBb: chipsToBbSng(netOf(seat, rec), rec.bb),
    cards: cardsOf(seat),
  }));

  const reached = reachedStreet(rec.board);
  const streets: HandStreetView[] = [];
  for (let s = 0; s <= reached; s += 1) {
    const prevCount = s === 0 ? 0 : (BOARD_COUNT[s - 1] ?? 0);
    const count = BOARD_COUNT[s] ?? 5;
    const steps: HandStepView[] = rec.actions
      .filter((a) => a.street === s)
      .map((a) => ({
        pos: positions.get(a.seat) ?? '?',
        name: nameOf(a.seat),
        isHero: a.seat === mySeat,
        label: ACTION_LABEL[a.kind],
        amountBb: a.kind === 'fold' || a.kind === 'check' ? null : chipsToBbSng(a.betTo, rec.bb),
        allIn: a.kind === 'allin',
        auto: a.auto,
      }));
    streets.push({
      street: s,
      label: STREET_VIEW_LABEL[s]!,
      potBb: chipsToBbSng(sngStreetPotChips(rec, order, s), rec.bb),
      board: rec.board.slice(prevCount, count),
      steps,
    });
  }

  const showdown = Object.keys(rec.shown).length > 0;

  // 実際に奪い合われた額（コールされなかった上乗せは元の持ち主に戻るので数えない）。
  // `won` の合計は使わない＝ won はチップ保存則（Σwon=Σcommits）で上乗せぶんも勝者の
  // 取り分に含めて計算されているので、その合計をそのまま POT にすると HU で直した
  // 膨らみが SNG にも残ってしまう。
  const committedBySeat = order.map((seat) => sngCommittedOf(seat, rec));
  const excess = uncalledExcess(committedBySeat);
  const excessSeat = excess.seat >= 0 ? (order[excess.seat] ?? -1) : -1;
  const finalPotBb = chipsToBbSng(contestedPotChips(committedBySeat), rec.bb);

  // 「獲得」も同じ考え方で揃える: コールされなかった上乗せは**戻ってきただけ**で勝ち取った
  // 額ではないので、その席の won からは引く（画面で「獲得 70bb／POT 40bb」のような食い違いが
  // 出ないように）。勝者の顔ぶれもこの引いたあとの額で決める＝上乗せが戻っただけの席を
  // 勝者として名前を並べない（オールインにコールされ、余りが返っただけの相手が「獲得」に
  // 並んでしまうため）。通常の 1 人勝ちのハンドでは合計は finalPotBb と一致する。
  const wonOf = (seat: number): number => {
    const raw = rec.won[seat] ?? 0;
    return seat === excessSeat ? Math.max(0, raw - excess.amount) : raw;
  };
  const winnerSeats = order.filter((seat) => wonOf(seat) > 0);
  const wonBb =
    winnerSeats.length > 0 ? chipsToBbSng(winnerSeats.reduce((a, seat) => a + wonOf(seat), 0), rec.bb) : null;
  const notes = rec.eliminated.map((e) => `${nameOf(e.seat)} 脱落（${e.place}位）`);

  const result: HandResultView = {
    winners: winnerSeats.map(nameOf),
    wonBb,
    showdown,
    finalPotBb,
    notes,
  };

  return {
    key: `${rec.gameId}_${String(rec.handNo).padStart(4, '0')}`,
    title: `#${handNo} ・ Level ${level}`,
    subtitle: game ? sngConfigSummary(game.config) : null,
    heroCards: mySeat === null ? null : cardsOf(mySeat),
    players,
    streets,
    result,
  };
}
