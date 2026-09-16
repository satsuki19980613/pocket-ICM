/**
 * ICM Calc ボタンの動作確認用サンプル（管理者専用, `components/Admin.tsx`）。
 *
 * 直前のコミットで SIT & GO のハンド履歴に「ICM Calc」ボタンを追加したが（`history/icmSpot.ts`
 * の `sngIcmSpot`）、実データでは対象条件（特に hero 25bb 以下 = `HERO_MAX_BB`）を満たすハンドが
 * まだ無く、実機で動作を確認できない。ここでは動作確認用の試合・ハンドを**この端末の
 * IndexedDB にだけ**入れる（`historyStore.ts` を経由するだけで、サーバへは一切書かない）。
 *
 * `sng_results` 相当（`results` ストア）には何も入れない＝成績（Stats）を汚さない。その結果
 * ハンド履歴の試合見出しは対応する `SngResultLocal` が無いため「進行中 / 未確定」になるが、
 * これはサンプルである以上想定どおり（`SngHistoryView.tsx` の表示規則どおり）。
 *
 * 中身はブラインド veryslow Level 17（sb=500/bb=1000/ante=250、`@oshihiki/sng` の
 * `blindsAt('veryslow', 17)` と同じ表）・開始スタック 20,000 チップ（config の
 * `startBb: 100` × `BASE_BB: 200`）の 6 人卓のうち、判定が割れる 6 ハンドを固定で持つ
 * （#1 は例外で Level 1）。`sngIcmSpot` の対象外理由をひととおり踏める並びにしてある。
 *
 * `buildSngSamples` は純関数（IndexedDB に触らない）。IndexedDB は Node に無いので、
 * ここのテスト（`sampleHands.test.ts`）は `buildSngSamples` だけを対象にする
 * （`insertSngSamples`/`removeSngSamples` はブラウザ実機で確認する。`historyStore.ts` に
 * テストが無いのと同じ理由）。
 */

import { decodeHand, encodeHand, type ActionRecord, type SngHandRecord } from '@oshihiki/sng';

import { sngIcmSpot } from '../history/icmSpot';
import {
  deleteGameAndHands,
  putGames,
  putHands,
  type SngGameLocal,
  type SngHandLocal,
} from './historyStore';

export const SAMPLE_GAME_ID = 'sg_sample_icm';

/** street はすべて 0（プリフロップ）固定・自動処理ではない前提で組み立てる分だけの省略ヘルパー。 */
function act(seat: number, kind: ActionRecord['kind'], betTo: number, put: number): ActionRecord {
  return { seat, kind, betTo, put, auto: false, street: 0 };
}

const STACKS_6 = [20000, 20000, 20000, 20000, 20000, 20000] as const;

/** ハンド 1 件分の材料（`SngHandRecord`/`SngHandLocal` に必要な情報のうち固定値の部分）。 */
interface SampleSpec {
  readonly handNo: number;
  readonly level: number;
  readonly sb: number;
  readonly bb: number;
  readonly ante: number;
  readonly btn: number;
  readonly sbSeat: number | null;
  readonly bbSeat: number;
  readonly startStacks: readonly number[];
  readonly actions: readonly ActionRecord[];
  readonly won: readonly number[];
  readonly myCards: readonly [string, string] | null;
  readonly board?: readonly string[];
  readonly shown?: Readonly<Record<number, readonly [string, string]>>;
}

/**
 * 6 件のサンプル。判定（`sngIcmSpot` の `ok`/`reason`）ごとの意図は各コメントのとおり。
 * fold の `betTo` は decodeHand のラウンドトリップに合わせ「そのストリートの直前の値」
 * （＝そこまでの最大の betTo）にしてある。表向きの説明用の値とは限らない
 * （例: #1 の SB/BB の fold は BU のレイズ後なので betTo=500、#20 の BB の fold は
 * 両者オールイン後なので betTo=24750）。
 */
const SAMPLE_SPECS: readonly SampleSpec[] = [
  // #1: 対象外 hero-deep（100bb）。BU（hero）がレイズして勝つが、開始スタックが深すぎる。
  {
    handNo: 1,
    level: 1,
    sb: 100,
    bb: 200,
    ante: 50,
    btn: 0,
    sbSeat: 1,
    bbSeat: 2,
    startStacks: STACKS_6,
    actions: [
      act(3, 'fold', 200, 0),
      act(4, 'fold', 200, 0),
      act(5, 'fold', 200, 0),
      act(0, 'raise', 500, 500),
      act(1, 'fold', 500, 0),
      act(2, 'fold', 500, 0),
    ],
    won: [1100, 0, 0, 0, 0, 0],
    myCards: ['Ah', 'Kd'],
  },
  // #5: 対象外 preflop-action。hero(BU) の手番より前に UTG がレイズしている。
  {
    handNo: 5,
    level: 17,
    sb: 500,
    bb: 1000,
    ante: 250,
    btn: 0,
    sbSeat: 1,
    bbSeat: 2,
    startStacks: STACKS_6,
    actions: [
      act(3, 'raise', 2500, 2500),
      act(4, 'fold', 2500, 0),
      act(5, 'fold', 2500, 0),
      act(0, 'fold', 2500, 0),
      act(1, 'fold', 2500, 0),
      act(2, 'fold', 2500, 0),
    ],
    won: [0, 0, 0, 5500, 0, 0],
    myCards: ['7c', '2d'],
  },
  // #8: 対象外 no-decision。btn=4/sb=5/bb=0＝hero が BB。全員 fold のウォークで手番が来ない。
  {
    handNo: 8,
    level: 17,
    sb: 500,
    bb: 1000,
    ante: 250,
    btn: 4,
    sbSeat: 5,
    bbSeat: 0,
    startStacks: STACKS_6,
    actions: [
      act(1, 'fold', 1000, 0),
      act(2, 'fold', 1000, 0),
      act(3, 'fold', 1000, 0),
      act(4, 'fold', 1000, 0),
      act(5, 'fold', 1000, 0),
    ],
    won: [3000, 0, 0, 0, 0, 0],
    myCards: ['9s', '4h'],
  },
  // #10: 対象外 no-cards。手札が分からない（myCards=null・shown も無し）。
  {
    handNo: 10,
    level: 17,
    sb: 500,
    bb: 1000,
    ante: 250,
    btn: 0,
    sbSeat: 1,
    bbSeat: 2,
    startStacks: STACKS_6,
    actions: [
      act(3, 'fold', 1000, 0),
      act(4, 'fold', 1000, 0),
      act(5, 'fold', 1000, 0),
      act(0, 'fold', 1000, 0),
      act(1, 'fold', 1000, 0),
      act(2, 'fold', 1000, 0),
    ],
    won: [0, 0, 3000, 0, 0, 0],
    myCards: null,
  },
  // #12: 対象 ok（6人・BU・AKo・19.75bb）。hero がオールインして全員 fold。
  {
    handNo: 12,
    level: 17,
    sb: 500,
    bb: 1000,
    ante: 250,
    btn: 0,
    sbSeat: 1,
    bbSeat: 2,
    startStacks: STACKS_6,
    actions: [
      act(3, 'fold', 1000, 0),
      act(4, 'fold', 1000, 0),
      act(5, 'fold', 1000, 0),
      act(0, 'allin', 19750, 19750),
      act(1, 'fold', 19750, 0),
      act(2, 'fold', 19750, 0),
    ],
    won: [22750, 0, 0, 0, 0, 0],
    myCards: ['Ah', 'Ks'],
  },
  // #20: 対象 ok（3人・SB・QQ）。btn=2/sb=0/bb=1。BU と hero(SB) がオールインし、BB は fold。
  // 両者オールインなので自動でリバーまで配られる（board 5枚・shown に両者の手札）。
  {
    handNo: 20,
    level: 17,
    sb: 500,
    bb: 1000,
    ante: 250,
    btn: 2,
    sbSeat: 0,
    bbSeat: 1,
    startStacks: [20000, 15000, 25000, 0, 0, 0],
    actions: [act(2, 'allin', 24750, 24750), act(0, 'allin', 19750, 19250), act(1, 'fold', 24750, 0)],
    won: [41250, 0, 5000, 0, 0, 0],
    myCards: ['Qh', 'Qd'],
    board: ['2c', '7d', 'Js', '4h', '8s'],
    shown: { 0: ['Qh', 'Qd'], 2: ['Ah', 'Kd'] },
  },
];

/** サンプルの試合とハンド（純関数。IndexedDB には触らない）。 */
export function buildSngSamples(now: number = Date.now()): { readonly game: SngGameLocal; readonly hands: SngHandLocal[] } {
  const hands: SngHandLocal[] = SAMPLE_SPECS.map((spec) => {
    const rec: SngHandRecord = {
      gameId: SAMPLE_GAME_ID,
      handNo: spec.handNo,
      playedAt: now + spec.handNo * 60_000,
      level: spec.level,
      sb: spec.sb,
      bb: spec.bb,
      ante: spec.ante,
      btn: spec.btn,
      sbSeat: spec.sbSeat,
      bbSeat: spec.bbSeat,
      startStacks: spec.startStacks,
      shown: spec.shown ?? {},
      board: spec.board ?? [],
      actions: spec.actions,
      won: spec.won,
      eliminated: [],
    };
    return {
      gameId: rec.gameId,
      handNo: rec.handNo,
      playedAt: rec.playedAt,
      level: rec.level,
      sb: rec.sb,
      bb: rec.bb,
      ante: rec.ante,
      encoded: encodeHand(rec),
      mySeat: 0,
      myCards: spec.myCards,
    };
  });

  const lastHandNo = Math.max(...SAMPLE_SPECS.map((s) => s.handNo));
  const game: SngGameLocal = {
    gameId: SAMPLE_GAME_ID,
    config: { players: 6, startBb: 100, speed: 'veryslow', levelMin: 4, mode: 'club' },
    seats: [
      { seat: 0, userId: 'sample-0', name: 'あなた' },
      { seat: 1, userId: 'sample-1', name: 'サンプル1' },
      { seat: 2, userId: 'sample-2', name: 'サンプル2' },
      { seat: 3, userId: 'sample-3', name: 'サンプル3' },
      { seat: 4, userId: 'sample-4', name: 'サンプル4' },
      { seat: 5, userId: 'sample-5', name: 'サンプル5' },
    ],
    status: 'finished',
    startedAt: now,
    endedAt: now + (lastHandNo + 1) * 60_000,
    hands: SAMPLE_SPECS.length,
  };

  return { game, hands };
}

/** この端末の履歴にサンプルを入れる（サーバには送らない）。 */
export async function insertSngSamples(now?: number): Promise<{ readonly hands: number; readonly eligible: number }> {
  const { game, hands } = buildSngSamples(now);
  await putGames([game]);
  await putHands(hands);

  let eligible = 0;
  for (const h of hands) {
    const meta = { gameId: h.gameId, handNo: h.handNo, playedAt: h.playedAt, sb: h.sb, bb: h.bb, ante: h.ante };
    const rec = decodeHand(h.encoded, meta);
    if (rec && sngIcmSpot({ rec, game, mySeat: h.mySeat, myCards: h.myCards }).ok) eligible += 1;
  }
  return { hands: hands.length, eligible };
}

/** 入れたサンプルを消す。 */
export function removeSngSamples(): Promise<void> {
  return deleteGameAndHands(SAMPLE_GAME_ID);
}
