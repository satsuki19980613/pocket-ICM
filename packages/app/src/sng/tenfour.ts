/**
 * SIT & GO ハンド記録 → tenfour_watcher 形式（1 ハンド 1 JSON）への変換
 * （docs/SNG_DESIGN.md §5、Slumbot 版 `slumbot/tenfour.ts` と同じ位置づけ）。
 *
 * Slumbot 版と同じく**変換の定義だけ**を持つ（画面からの書き出し機能は無い）。カード・
 * タイムスタンプの変換や命名規則は Slumbot 版をそのまま流用し、SIT & GO 固有の差分
 * （複数人・可変ブラインド・デッドボタン）だけをここに書く。
 *
 * ## ポジションの決め方
 *
 * tenfour の語彙は 6 人 UTG/HJ/CO/BTN/SB/BB（`@oshihiki/core` の `positionsForPlayersLeft`
 * と同じ並び。core は BTN を `BU` と呼ぶのでここで読み替える）。**このハンドで生きている
 * 席の数**（`startStacks` が 0 でない席）を n として、bbSeat を最後尾に回した席順（＝UTG
 * が先頭、BB が末尾になる並び）へ `positionsForPlayersLeft(n)` を割り当てる。
 *
 * デッドボタン（`sbSeat === null`）のハンドは、SB を打つ生存者がいない＝本来の SB の
 * 「枠」が空いているだけで、UTG 側の枠が 1 つ減るわけではない。素直に
 * `positionsForPlayersLeft(n)` を使うと BTN の次（本来 SB の枠）に生存者が来て
 * 「SB」のラベルが付いてしまうので、**枠が 1 つ多い `positionsForPlayersLeft(n + 1)` から
 * SB を抜いた列**を使う（さつき承認のポジション語彙・2026-09-15）。
 *
 * ## 金額
 *
 * すべて「そのハンドの bb」（`record.bb`）で割った値。`street_pots` はそのストリートが
 * 始まった時点のポット（アンティ・ブラインド込み）で、規則そのものは `history/pots.ts`
 * の `sngStreetPotChips` / `sngCommittedOf`（`history/sngHandView.ts` と共通）に置く。
 * アクション文字列に含まれないアンティ・ブラインドの拠出は `sngForcedOf` で復元する
 * （`SngHandRecord` は圧縮のため拠出額を明示的には持たない。docs/SNG_DESIGN.md §4）。
 *
 * ## 表示名・試合の見出し
 *
 * `SngTenfourMeta.names` や `SngHistoryView` の対戦相手名は `sng_games.seats` が唯一の
 * 材料（`sng_hands` / `sng_hole_cards` は自分の分しか分からない）。`namesFromSeats` は
 * その組み立て（席番号 0..n−1 の表示名の列。無ければ `Seat n`）を担う純関数（呼び出し側は
 * `useSngHands` の `games` から該当 gameId の `seats` を渡す）。`sngConfigSummary` は
 * 試合の見出し（人数・開始bb・構造・上昇間隔・モード）を `SngConfig` から組み立てる。
 */

import { gameModeLabel, positionsForPlayersLeft } from '@oshihiki/core';
import type { ActionKind, SngConfig, SngHandRecord, Speed } from '@oshihiki/sng';

import { sngCommittedOf, sngStreetPotChips } from '../history/pots';
import {
  tenfourParsedAt,
  tenfourTimestamp,
  toTenfourCard,
  type TenfourAction,
  type TenfourCard,
  type TenfourPlayer,
} from '../slumbot/tenfour';

const STREETS = ['preflop', 'flop', 'turn', 'river'] as const;

export interface SngTenfourHand {
  readonly source_file: string;
  readonly parsed_at: string;
  readonly hand_id: string;
  readonly timestamp: string;
  readonly hero_name: string;
  readonly hero_position: string;
  readonly hero_cards: readonly TenfourCard[];
  readonly players: readonly TenfourPlayer[];
  readonly board: Record<string, readonly TenfourCard[]>;
  readonly actions: readonly TenfourAction[];
  readonly street_pots: Record<string, number>;
  readonly result_winner: string;
  readonly result_won_bb: number | null;
  readonly raw_ocr: Record<string, string>;
  readonly parse_errors: readonly string[];
  // ---- tenfour には無い追加情報 ----
  readonly source: 'sng';
  /** 席順のハンド開始時スタック（bb 換算・飛んでいる席は 0）。 */
  readonly stacks_bb: readonly number[];
  readonly level: number;
  readonly ante_bb: number;
  /** ゲーム ID（`sng_games.id`）。 */
  readonly sng_id: string;
  readonly hand_no: number;
}

export interface SngTenfourMeta {
  readonly mySeat: number;
  readonly myCards: readonly [string, string] | null;
  /** 席順の表示名（開始時の人数ぶん）。 */
  readonly names: readonly string[];
  readonly playersAtStart: number;
}

const UNKNOWN: TenfourCard = { rank: '?', suit: '?' };

function pairCards(pair: readonly [string, string] | undefined): TenfourCard[] {
  return [toTenfourCard(pair?.[0]), toTenfourCard(pair?.[1])];
}

/** そのハンドで生きている席（開始時スタックが 0 でない）を席番号の昇順で。 */
function liveSeats(startStacks: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < startStacks.length; i += 1) if ((startStacks[i] ?? 0) > 0) out.push(i);
  return out;
}

/** bbSeat を末尾に回した生存席の並び（先頭が UTG 相当、末尾が BB）。 */
function actingOrder(live: readonly number[], bbSeat: number): number[] {
  const k = live.indexOf(bbSeat);
  if (k < 0) return [...live];
  return [...live.slice(k + 1), ...live.slice(0, k + 1)];
}

/** core の `BU` を tenfour の語彙 `BTN` に読み替える。 */
function relabel(p: string): string {
  return p === 'BU' ? 'BTN' : p;
}

/** 生存席の並びに対応するポジション名の列（デッドボタンは SB を抜く）。 */
function tenfourPositions(n: number, deadSb: boolean): string[] {
  if (!deadSb) return positionsForPlayersLeft(n).map(relabel);
  return positionsForPlayersLeft(n + 1)
    .map(relabel)
    .filter((p) => p !== 'SB');
}

/** その席のこのハンドの純収支（チップ）。SngHistoryView の一覧表示にも使う。 */
export function netOf(seat: number, rec: SngHandRecord): number {
  return (rec.won[seat] ?? 0) - sngCommittedOf(seat, rec);
}

/** チップ → そのハンドの bb（小数第 2 位で四捨五入）。 */
export function chipsToBbSng(chips: number, bb: number): number {
  return Math.round((chips / bb) * 100) / 100;
}

/** ブラインド構造（`Speed`）の表示名。`SngLobby` の作成パネルと同じ語彙。 */
export const SNG_SPEED_LABEL: Record<Speed, string> = { normal: '通常', slow: 'ゆっくり', veryslow: 'もっとゆっくり' };

/**
 * 席番号 0..n−1 の表示名の列（`sng_games.seats` から。無ければ `Seat n`）。
 * `SngTenfourMeta.names` にも、`SngHistoryView` の対戦相手名にもこれを使う
 * （唯一の材料が `seats` なので組み立ては共通）。
 */
export function namesFromSeats(seats: readonly { readonly seat: number; readonly name: string }[], n: number): string[] {
  const out: string[] = [];
  for (let seat = 0; seat < n; seat += 1) {
    out.push(seats.find((s) => s.seat === seat)?.name ?? `Seat ${seat}`);
  }
  return out;
}

/** 試合の見出し（人数・開始bb・構造・上昇間隔・モード）。`SngHistoryView` の試合見出しに使う。 */
export function sngConfigSummary(config: SngConfig): string {
  return `${config.players}人 ・ ${config.startBb}bb開始 ・ ${SNG_SPEED_LABEL[config.speed]} ・ ${config.levelMin}分上昇 ・ ${gameModeLabel(config.mode)}`;
}

/**
 * 生存席 → ポジション名（tenfour の語彙。BTN/SB/BB 等）。並びが作れなければ null
 * （想定外の人数など）。SngHistoryView がハンド詳細の席ラベルに使う。
 */
export function positionMapOf(rec: SngHandRecord): Map<number, string> | null {
  const live = liveSeats(rec.startStacks);
  if (live.length < 2) return null;
  const order = actingOrder(live, rec.bbSeat);
  try {
    const positions = tenfourPositions(order.length, rec.sbSeat === null);
    if (positions.length !== order.length) return null;
    return new Map(order.map((seat, i) => [seat, positions[i]!]));
  } catch {
    return null;
  }
}

const ACTION_LABEL: Record<ActionKind, string> = {
  fold: 'Fold',
  check: 'Check',
  call: 'Call',
  bet: 'Bet',
  raise: 'Raise',
  allin: 'All-in',
};

/** 到達したストリート数（0=プリフロップのみ … 3=リバーまで）。board の枚数から。 */
function reachedStreet(board: readonly string[]): number {
  if (board.length >= 5) return 3;
  if (board.length >= 4) return 2;
  if (board.length >= 3) return 1;
  return 0;
}

export function toTenfourSngHand(
  record: SngHandRecord,
  meta: SngTenfourMeta,
  heroName: string,
  now: number = Date.now(),
): SngTenfourHand | null {
  if (record.startStacks.length !== meta.playersAtStart) return null; // データ不整合。安全側で諦める。
  const live = liveSeats(record.startStacks);
  if (live.length < 2 || !live.includes(meta.mySeat)) return null;
  const order = actingOrder(live, record.bbSeat);
  let positions: string[];
  try {
    positions = tenfourPositions(order.length, record.sbSeat === null);
  } catch {
    return null; // 想定外の人数（core の 2..6 の範囲外）。
  }
  if (positions.length !== order.length) return null; // 想定外の並び（データ不整合）。安全側で諦める。

  const seatPos = new Map<number, string>(order.map((seat, i) => [seat, positions[i]!]));
  const toBb = (chips: number): number => Math.round((chips / record.bb) * 100) / 100;
  const nameOf = (seat: number): string =>
    seat === meta.mySeat ? heroName : meta.names[seat] ?? `Seat ${seat}`;

  const heroPosition = seatPos.get(meta.mySeat) ?? '?';

  const players: TenfourPlayer[] = order.map((seat) => {
    const isHero = seat === meta.mySeat;
    const cards = record.shown[seat] ?? (isHero ? meta.myCards ?? undefined : undefined);
    return {
      position: seatPos.get(seat) ?? '?',
      name: nameOf(seat),
      stack_delta_bb: toBb((record.won[seat] ?? 0) - sngCommittedOf(seat, record)),
      cards: cards ? pairCards(cards) : [UNKNOWN, UNKNOWN],
      is_hero: isHero,
    };
  });

  const actions: TenfourAction[] = record.actions.map((a) => ({
    position: seatPos.get(a.seat) ?? '?',
    name: nameOf(a.seat),
    action: ACTION_LABEL[a.kind],
    amount_bb: a.kind === 'fold' || a.kind === 'check' ? null : toBb(a.betTo),
    street: STREETS[a.street] ?? 'preflop',
  }));

  const board: Record<string, TenfourCard[]> = {};
  if (record.board.length >= 3) board.flop = record.board.slice(0, 3).map(toTenfourCard);
  if (record.board.length >= 4) board.turn = [toTenfourCard(record.board[3])];
  if (record.board.length >= 5) board.river = [toTenfourCard(record.board[4])];

  const reached = reachedStreet(record.board);
  const street_pots: Record<string, number> = {};
  for (let s = 1; s <= reached; s += 1) {
    street_pots[STREETS[s]!] = toBb(sngStreetPotChips(record, live, s));
  }
  const isShowdown = Object.keys(record.shown).length > 0;
  if (isShowdown) {
    const totalPot = live.reduce((a, seat) => a + sngCommittedOf(seat, record), 0);
    street_pots.showdown = toBb(totalPot);
  }

  // 勝者。分け合いなら hero 視点（hero が含まれればそちらを報告する）。
  const winners = order.filter((seat) => (record.won[seat] ?? 0) > 0);
  let result_winner = '';
  let result_won_bb: number | null = null;
  if (winners.length === 1) {
    result_winner = nameOf(winners[0]!);
    result_won_bb = toBb(record.won[winners[0]!] ?? 0);
  } else if (winners.length > 1) {
    if (winners.includes(meta.mySeat)) {
      result_winner = heroName;
      result_won_bb = toBb(record.won[meta.mySeat] ?? 0);
    } else {
      result_winner = winners.map(nameOf).join(' / ');
      result_won_bb = toBb(winners.reduce((a, seat) => a + (record.won[seat] ?? 0), 0));
    }
  }

  return {
    source_file: '',
    parsed_at: tenfourParsedAt(now),
    hand_id: `${record.gameId}_${String(record.handNo).padStart(4, '0')}`,
    timestamp: tenfourTimestamp(record.playedAt),
    hero_name: heroName,
    hero_position: heroPosition,
    hero_cards: pairCards(meta.myCards ?? undefined),
    players,
    board,
    actions,
    street_pots,
    result_winner,
    result_won_bb,
    raw_ocr: {},
    parse_errors: [],
    source: 'sng',
    stacks_bb: record.startStacks.map(toBb),
    level: record.level,
    ante_bb: toBb(record.ante),
    sng_id: record.gameId,
    hand_no: record.handNo,
  };
}
