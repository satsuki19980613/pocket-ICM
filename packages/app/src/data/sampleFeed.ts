// ホームの投稿サンプル（M6 の公開フィード実装までの仮データ）。
// 各投稿は実在の押し引きスポット（BoardForm）を持ち、カードのタップで実ソルバーが解いて
// 本物の計算結果を表示する（HU/3人/4人は事前計算テーブルで即時・決定的）。
// verdict/pu/ev のカード表示値は実求解の出力に一致させてある（下段の数値）。
import { defaultForm, type BoardForm } from '../formModel';
import type { Position } from '@oshihiki/core';

export type Suit = 'spade' | 'heart' | 'diamond' | 'club';
export interface SampleCard {
  r: string;
  s: Suit;
}
export interface SamplePost {
  id: string;
  author: string;
  handle: string;
  avatar: string;
  avatarClass?: string;
  time: string;
  comment: string;
  form: BoardForm;
  cards: [SampleCard, SampleCard];
  posLabel: string;
  verdict: 'PUSH' | 'FOLD';
  pu: string;
  ev: string;
  likes: number;
  comments: number;
}

/** 全席均一スタックのスポットを作る（サンプル用の簡便ヘルパ）。 */
function spot(playersLeft: number, heroPos: Position, heroHand: string, bb: number): BoardForm {
  const f = defaultForm(playersLeft);
  const stacks: Partial<Record<Position, string>> = {};
  for (const p of Object.keys(f.stacks) as Position[]) stacks[p] = String(bb);
  return { ...f, heroPos, heroHand, stacks };
}

// スポットは高速テーブル圏（HU/3人）で即時・決定的。verdict/pu/ev は実求解に一致（in-browser 照合済）。
export const SAMPLE_POSTS: SamplePost[] = [
  {
    id: 's1',
    author: 'なかはた',
    handle: 'nakahata',
    avatar: 'な',
    avatarClass: 'k',
    time: '12分',
    comment: 'BUの10bb、K9sで押し。3人残りだと思ったより広く押していいのな。降りてた自分が信じられん。',
    form: spot(3, 'BU', 'K9s', 10),
    cards: [
      { r: 'K', s: 'spade' },
      { r: '9', s: 'spade' },
    ],
    posLabel: '3 LEFT · BU',
    verdict: 'PUSH',
    pu: 'PU 17.7%',
    ev: 'EV +0.033pt',
    likes: 14,
    comments: 8,
  },
  {
    id: 's2',
    author: 'さつき',
    handle: 'satsuki',
    avatar: 'さ',
    time: '1時間',
    comment: 'SBのA8o、BBに降りられる前提だと押し得らしい。受けが薄いのを完全に忘れてた。',
    form: spot(3, 'SB', 'A8o', 11),
    cards: [
      { r: 'A', s: 'spade' },
      { r: '8', s: 'heart' },
    ],
    posLabel: '3 LEFT · SB',
    verdict: 'PUSH',
    pu: 'PU 45.3%',
    ev: 'EV +0.070pt',
    likes: 41,
    comments: 23,
  },
  {
    id: 's3',
    author: '海空',
    handle: 'umisora',
    avatar: '海',
    avatarClass: 'n',
    time: '3時間',
    comment: '72o はさすがに降り。BUでも12bbじゃノーチャンスだった。ポジションだけじゃ押せない。',
    form: spot(3, 'BU', '72o', 12),
    cards: [
      { r: '7', s: 'diamond' },
      { r: '2', s: 'club' },
    ],
    posLabel: '3 LEFT · BU',
    verdict: 'FOLD',
    pu: 'PU 14.9%',
    ev: 'EV −0.103pt',
    likes: 9,
    comments: 15,
  },
];
