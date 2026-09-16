/**
 * SIT & GO のハンド記録 → ICM 計算（push/fold ソルバー）の入力局面（`BoardState`）。
 *
 * **これは契約ファイル**（型・条件の定義）で、実装は下の TODO を埋めて完成させる。
 *
 * ねらい: 会員同士の SIT & GO で実際に起きた局面のうち、**ICM 計算の前提が揃っているもの
 * だけ**を取り出して、ハンド履歴からそのまま計算キューへ送れるようにする。スクショ経由
 * （OCR）の「読み取れる条件」（`components/IcmInput.tsx` の `READ_CONDITIONS`）と同じ
 * 条件を、記録という誤読のない材料に対して当てはめる。
 *
 * ソルバーは「未開（誰も動いていない）プリフロップ」を根として**木を全部解く**
 * （`formModel.ts` の説明を参照）ので、入力に必要なのはハンド開始時点のスナップショット
 * だけ: 人数・各席のスタック・ブラインド・アンティ・hero のポジション・hero の手札・
 * ゲームモード（プライズ表）。上流のアクション（誰が push/fold したか）は結果画面の
 * ノード選択で辿る。
 *
 * 【対象にする条件】(すべて満たすときだけ `ok`)
 *   1. 自分の席が分かり、そのハンドで生きている（`startStacks[mySeat] > 0`）
 *   2. 自分の手札が分かる（`myCards`、無ければショーダウンで公開された `shown[mySeat]`）
 *   3. 生存人数が 2〜6 人（`positionsForPlayersLeft` の対応範囲 ＝ MAX_PLAYERS まで）
 *   4. SB を出す席がある（`rec.sbSeat !== null`）。デッドボタンで SB 不在の配りは
 *      `BoardState`（SB/BB がブラインドを出している前提）で表せないので対象外
 *   5. 生存席全員が「アンティ＋自分のブラインド」を**払ってもチップが残る**
 *      （払った時点でオールインの席があると、全席 live・未開の開始状態にならない）
 *   6. 自分の最初のプリフロップの手番までのアクションが **fold と allin だけ**
 *      （レイズ・リンプ・非オールインのコールが入った局面は push/fold の木に無い）
 *   7. 自分にプリフロップの手番が回っている（BB へ全員フォールドのウォーク、および
 *      ブラインドで既にオールインになっていて選択が無い場合は対象外）
 *   8. 試合の設定（`SngGameLocal.config.mode`）が分かる。プライズ表がこれで決まる
 *   9. 自分のハンド開始時スタックが **25bb 以下**（`HERO_MAX_BB`）。押し引き（AOF）が
 *      最適に近いのは概ねここまで、というのがこのアプリの一貫した立場で、3〜4人では
 *      ソルバー自身も 25bb 超の hero を対象外として突き返す
 *      （`packages/solver/src/pfTable.ts` の `pfCoverage`→`'heroDeep'`、
 *      `packages/app/src/solver.worker.ts` の `OUT_OF_SCOPE_MSG`）。ここで弾いておかないと
 *      「ボタンは出るのに記録が失敗になる」ハンドができてしまう。深さは
 *      `stack + bet + ante`（＝ハンド開始時の持ちチップ）で測る
 *      （`packages/solver/src/pfResult.ts` の `stackTotals` と同じ定義）。
 *
 * 【対象にしないもの・意図的に見ていないもの】
 *   - 自分自身がそのあと何を選んだか（fold/limp/raise/allin のどれでもよい）。
 *     リンプやレイズは「本来 push か fold かを見たい」場面そのものなので弾かない。
 *   - 相手のスタックの深さ。相手だけ深い局面は事前計算表を使わず厳密 MC で解ける。
 */

import type { BoardState, Position } from '@oshihiki/core';
import { parseHandClass, positionsForPlayersLeft, rankIndex, SUITS } from '@oshihiki/core';
import type { SngHandRecord } from '@oshihiki/sng';

import type { BoardForm } from '../formModel';
import { buildBoardState } from '../formModel';
import type { SngGameLocal } from '../sng/historyStore';
import { actingOrder, chipsToBbSng, liveSeats } from '../sng/tenfour';
import { sngForcedOf } from './pots';

export interface SngIcmSpotArgs {
  readonly rec: SngHandRecord;
  /** 試合の設定（プライズ表＝ゲームモードの唯一の材料）。無ければ対象外。 */
  readonly game: SngGameLocal | null;
  /** 分かっていれば自分の席。 */
  readonly mySeat: number | null;
  /** `sng_hole_cards` 由来の自分の手札。無ければ `rec.shown[mySeat]` を使う。 */
  readonly myCards?: readonly [string, string] | null;
}

/** 対象外の理由コード（UI の文言はコード別に 1 つだけ持つ）。 */
export type IcmSpotReason =
  | 'no-seat' // 自分の席が分からない
  | 'not-live' // そのハンドでは既に脱落している
  | 'no-cards' // 自分の手札が分からない
  | 'players' // 生存人数が 2〜6 人の範囲外
  | 'dead-sb' // SB を出す席がない（デッドボタン）
  | 'short-blind' // ブラインド／アンティを払った時点でオールインの席がある
  | 'preflop-action' // 自分の手番までにレイズ・リンプ・非オールインのコールが入った
  | 'no-decision' // 自分に手番が回っていない（ウォーク等）
  | 'no-game' // 試合の設定（ゲームモード）が分からない
  | 'hero-deep' // 自分のハンド開始時スタックが 25bb 超
  | 'build'; // `BoardState` の組み立て・検証に失敗した（想定外）

/** 押し引き（AOF）が対象とする hero の最大スタック（bb）。契約の条件 9。 */
export const HERO_MAX_BB = 25;

export interface SngIcmSpotOk {
  readonly ok: true;
  /** ソルバーへの入力（`buildBoardState` を通した検証済みの値）。 */
  readonly state: BoardState;
  /** 表示用（ボタンの aria-label・記録の見出し）。 */
  readonly heroHand: string;
  readonly heroPos: Position;
  readonly playersLeft: number;
}

export interface SngIcmSpotNg {
  readonly ok: false;
  readonly reason: IcmSpotReason;
  /** 画面にそのまま出せる一言（日本語）。 */
  readonly note: string;
}

export type SngIcmSpotResult = SngIcmSpotOk | SngIcmSpotNg;

/** 対象外の理由コードごとの、画面にそのまま出せる日本語の一言。 */
const NG_NOTE: Record<IcmSpotReason, string> = {
  'no-seat': '自分の席が分かりません',
  'not-live': 'そのハンドでは既に脱落しています',
  'no-cards': '自分の手札が分かりません',
  players: '生存人数が2〜6人の範囲外です',
  'dead-sb': 'デッドボタンで SB を出す席がありません',
  'short-blind': 'ブラインドやアンティを払うとオールインになる席があります',
  'preflop-action': 'レイズやリンプが入った局面は押し引きの対象外です',
  'no-decision': '自分に手番が回っていません',
  'no-game': '試合の設定（ゲームモード）が分かりません',
  'hero-deep': '自分のスタックが深すぎます（25bb超）',
  build: '局面の組み立てに失敗しました',
};

function ng(reason: IcmSpotReason, note: string = NG_NOTE[reason]): SngIcmSpotNg {
  return { ok: false, reason, note };
}

/** 割り算の浮動小数のゴミが出ないよう、小数第 4 位で丸める。 */
function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/** 1 ハンドが ICM 計算の対象かを判定し、対象なら入力局面を組み立てる。 */
export function sngIcmSpot(args: SngIcmSpotArgs): SngIcmSpotResult {
  const { rec, game, mySeat, myCards } = args;

  // 1. 自分の席が分かり、そのハンドで生きている。
  if (mySeat === null) return ng('no-seat');
  if ((rec.startStacks[mySeat] ?? 0) <= 0) return ng('not-live');

  // 2. 自分の手札が分かる（ショーダウン公開分にもフォールバック）。
  const cards = myCards ?? rec.shown[mySeat] ?? null;
  if (!cards) return ng('no-cards');
  const heroHand = handClassOf(cards);
  if (!heroHand) return ng('no-cards');

  // 3. 生存人数が 2〜6 人。
  const live = liveSeats(rec.startStacks);
  if (live.length < 2 || live.length > 6) return ng('players');

  // 4. SB を出す席がある（デッドボタンは対象外）。
  if (rec.sbSeat === null) return ng('dead-sb');

  // 5. 生存席全員が、アンティ＋自分のブラインドを払ってもチップが残る。
  for (const seat of live) {
    const forced = sngForcedOf(seat, rec);
    if (forced >= (rec.startStacks[seat] ?? 0)) return ng('short-blind');
  }

  // ポジション割り当て: actingOrder と positionsForPlayersLeft は同じ並び（先に動く席が
  // 先頭・BB が末尾）なので、order[i] ↔ positionsForPlayersLeft(n)[i] で 1 対 1 に対応する。
  const order = actingOrder(live, rec.bbSeat);
  const positions = positionsForPlayersLeft(order.length);
  const seatIdx = order.indexOf(mySeat);
  const heroPos: Position = positions[seatIdx]!;

  // 6・7. 自分の最初のプリフロップの手番までは fold/allin だけ。手番が来ないなら対象外。
  const preflopActions = rec.actions.filter((a) => a.street === 0);
  let heroActed = false;
  for (const a of preflopActions) {
    if (a.seat === mySeat) {
      heroActed = true;
      break;
    }
    if (a.kind !== 'fold' && a.kind !== 'allin') return ng('preflop-action');
  }
  if (!heroActed) return ng('no-decision');

  // 8. 試合の設定（プライズ表）が分かる。
  if (game === null) return ng('no-game');

  // 9. 自分のハンド開始時スタックが 25bb 以下。
  const heroStackBb = chipsToBbSng(rec.startStacks[mySeat] ?? 0, rec.bb);
  if (heroStackBb > HERO_MAX_BB) return ng('hero-deep');

  const stacks: Partial<Record<Position, string>> = {};
  order.forEach((seat, i) => {
    const pos = positions[i]!;
    const forced = sngForcedOf(seat, rec);
    const stackBb = chipsToBbSng((rec.startStacks[seat] ?? 0) - forced, rec.bb);
    stacks[pos] = String(stackBb);
  });

  const anteBb = round4(rec.ante / rec.bb);
  const form: BoardForm = {
    playersLeft: order.length,
    sb: String(round4(rec.sb / rec.bb)),
    bb: '1',
    anteScheme: rec.ante > 0 ? 'all' : 'none',
    anteAmount: rec.ante > 0 ? String(anteBb) : '0',
    heroPos,
    heroHand,
    stacks,
    gameMode: game.config.mode,
  };

  const built = buildBoardState(form);
  if (!built.ok || !built.state) {
    return ng('build', `${NG_NOTE.build}: ${built.issues.join(' / ')}`);
  }

  return { ok: true, state: built.state, heroHand, heroPos, playersLeft: order.length };
}

/** カード 2 枚（例 `['Ah','5h']`）→ 169 ハンドクラス表記（例 `A5s`）。不正なら null。 */
export function handClassOf(cards: readonly string[]): string | null {
  if (cards.length !== 2) return null;
  const c0 = cards[0];
  const c1 = cards[1];
  if (!isCard(c0) || !isCard(c1)) return null;
  const r0 = c0[0]!;
  const r1 = c1[0]!;
  const i0 = rankIndex(r0);
  const i1 = rankIndex(r1);
  if (r0 === r1) {
    const label = `${r0}${r1}`;
    return parseHandClass(label) ? label : null;
  }
  const suited = c0[1] === c1[1];
  const hi = i0 < i1 ? r0 : r1;
  const lo = i0 < i1 ? r1 : r0;
  const label = `${hi}${lo}${suited ? 's' : 'o'}`;
  return parseHandClass(label) ? label : null;
}

/** カード表記（例 `'Ah'`）としてランク・スートが読めるか。 */
function isCard(c: string | undefined): c is string {
  if (!c || c.length !== 2) return false;
  return rankIndex(c[0]!) >= 0 && (SUITS as readonly string[]).includes(c[1]!);
}

/**
 * 計算キューでハンドを一意に指すキー。
 * `historyStore.ts` の `handKey`（IndexedDB のソート用に 0 埋め・区切り `:`）とは別物。
 */
export function icmSpotKey(gameId: string, handNo: number): string {
  return `${gameId}#${handNo}`;
}
