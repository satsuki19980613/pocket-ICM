import { describe, it, expect } from 'vitest';
import {
  countOf,
  handToDisplayCards,
  feedCardOf,
  dbToHeroAction,
  heroActionToDb,
  mapFeedRow,
  type FeedResult,
} from './feed';
import type { SolveResultDto } from '../solverProtocol';
import type { BoardState } from '@oshihiki/core';

describe('countOf', () => {
  it('PostgREST の [{count}] を数に落とす', () => {
    expect(countOf([{ count: 3 }])).toBe(3);
    expect(countOf([{ count: 0 }])).toBe(0);
  });
  it('欠損/異常は 0', () => {
    expect(countOf(undefined)).toBe(0);
    expect(countOf([])).toBe(0);
    expect(countOf([{}])).toBe(0);
    expect(countOf(null)).toBe(0);
  });
});

describe('handToDisplayCards', () => {
  it('スーテッドは同スート（♠♠）', () => {
    expect(handToDisplayCards('K9s')).toEqual([
      { r: 'K', s: 'spade' },
      { r: '9', s: 'spade' },
    ]);
  });
  it('オフスートは ♠♥', () => {
    expect(handToDisplayCards('A8o')).toEqual([
      { r: 'A', s: 'spade' },
      { r: '8', s: 'heart' },
    ]);
  });
  it('ペアは ♠♥', () => {
    expect(handToDisplayCards('TT')).toEqual([
      { r: 'T', s: 'spade' },
      { r: 'T', s: 'heart' },
    ]);
  });
  it('"10" 表記は T に正規化', () => {
    expect(handToDisplayCards('107s')).toEqual([
      { r: 'T', s: 'spade' },
      { r: '7', s: 'spade' },
    ]);
  });
});

describe('hero action の DB 変換', () => {
  it('PUSH↔ALL_IN, FOLD↔FOLD', () => {
    expect(heroActionToDb('PUSH')).toBe('ALL_IN');
    expect(heroActionToDb('FOLD')).toBe('FOLD');
    expect(heroActionToDb(null)).toBe(null);
    expect(dbToHeroAction('ALL_IN')).toBe('PUSH');
    expect(dbToHeroAction('FOLD')).toBe('FOLD');
    expect(dbToHeroAction(null)).toBe(null);
  });
});

// --- feedCardOf のフィクスチャ ---
function makeResult(hand: string, pos: string, bb: number, heroFreq: number, ev: number, pct: number): FeedResult {
  const solution: SolveResultDto = {
    playersLeft: 3,
    heroPos: pos,
    heroHand: hand,
    iterations: 100,
    exploitabilityPt: 0.001,
    converged: true,
    equity: {},
    nodes: [
      {
        key: `${pos}:AI`,
        actor: pos,
        actionType: 'PU',
        pct,
        range: [],
        hands: 0,
        heroFreq,
        heroEv: ev,
      },
    ],
  } as unknown as SolveResultDto;
  const spot = { seats: [{ pos, stack: bb }] } as unknown as BoardState;
  return {
    id: 'r1',
    owner: 'u1',
    spot,
    solution,
    hero_action: null,
    ev_loss: null,
    created_at: '2026-09-04T00:00:00Z',
  };
}

describe('feedCardOf', () => {
  it('見出しノードから判定/レンジ/EV/bb/手札を導く（PUSH）', () => {
    const card = feedCardOf(makeResult('K9s', 'BU', 10, 1, 0.02, 39.1));
    expect(card.verdict).toBe('PUSH');
    expect(card.heroHand).toBe('K9s');
    expect(card.heroPos).toBe('BU');
    expect(card.bb).toBe(10);
    expect(card.pu).toBeCloseTo(39.1);
    expect(card.ev).toBeCloseTo(0.02);
    expect(card.cards[0]).toEqual({ r: 'K', s: 'spade' });
  });
  it('heroFreq<0.5 は FOLD', () => {
    const card = feedCardOf(makeResult('72o', 'BU', 12, 0, -0.045, 30));
    expect(card.verdict).toBe('FOLD');
    expect(card.bb).toBe(12);
  });
});

describe('mapFeedRow', () => {
  const author = { id: 'u1', handle: 'satsuki', display_name: 'Satsuki', avatar_url: null };
  const result = makeResult('A8o', 'SB', 11, 1, 0.122, 78.9);

  it('著者・結果・件数・♡・本文（公開時の一言）を束ねる（結果投稿）', () => {
    const post = mapFeedRow(
      {
        id: 't1',
        created_at: 'x',
        kind: 'result',
        body: 'SBのA8o、押し得らしい',
        image_url: null,
        updated_at: null,
        author,
        result,
        comments: [{ count: 5 }],
        likes: [{ count: 2 }],
      },
      new Set(['t1']),
    );
    expect(post).not.toBeNull();
    expect(post!.thread_id).toBe('t1');
    expect(post!.kind).toBe('result');
    expect(post!.result).toBe(result);
    expect(post!.body).toBe('SBのA8o、押し得らしい');
    expect(post!.comment_count).toBe(5);
    expect(post!.like_count).toBe(2);
    expect(post!.liked_by_me).toBe(true);
  });

  it('通常投稿（本文のみ）は result が無くても正当な行として通す', () => {
    const post = mapFeedRow(
      {
        id: 't5',
        created_at: 'x',
        kind: 'post',
        body: '今日のセッション振り返り',
        image_url: null,
        updated_at: null,
        author,
        result: null,
        comments: [{ count: 1 }],
        likes: [{ count: 0 }],
      },
      new Set(),
    );
    expect(post).not.toBeNull();
    expect(post!.kind).toBe('post');
    expect(post!.result).toBeNull();
    expect(post!.body).toBe('今日のセッション振り返り');
    expect(post!.image_url).toBeNull();
  });

  it('通常投稿（本文＋画像）も result null のまま通す', () => {
    const post = mapFeedRow(
      {
        id: 't6',
        created_at: 'x',
        kind: 'post',
        body: 'この局面どう思う？',
        image_url: 'https://example.com/thread-images/u1/x.webp',
        updated_at: '2026-09-08T00:00:00Z',
        author,
        result: null,
        comments: [{ count: 0 }],
        likes: [{ count: 0 }],
      },
      new Set(),
    );
    expect(post).not.toBeNull();
    expect(post!.body).toBe('この局面どう思う？');
    expect(post!.image_url).toBe('https://example.com/thread-images/u1/x.webp');
    expect(post!.updated_at).toBe('2026-09-08T00:00:00Z');
  });

  it('著者が欠けた行は種別によらず null', () => {
    expect(
      mapFeedRow(
        { id: 't2', created_at: 'x', kind: 'result', body: null, image_url: null, updated_at: null, author: null, result },
        new Set(),
      ),
    ).toBeNull();
    expect(
      mapFeedRow(
        { id: 't7', created_at: 'x', kind: 'post', body: 'x', image_url: null, updated_at: null, author: null, result: null },
        new Set(),
      ),
    ).toBeNull();
  });

  it('結果投稿で result が欠けた行は null（不可視 result の左結合抜け等）', () => {
    expect(
      mapFeedRow(
        { id: 't3', created_at: 'x', kind: 'result', body: null, image_url: null, updated_at: null, author, result: null },
        new Set(),
      ),
    ).toBeNull();
  });

  it('公開時の一言が無し/未♡は null/false', () => {
    const post = mapFeedRow(
      {
        id: 't4',
        created_at: 'x',
        kind: 'result',
        body: null,
        image_url: null,
        updated_at: null,
        author,
        result,
        comments: [{ count: 0 }],
        likes: [{ count: 0 }],
      },
      new Set(),
    );
    expect(post!.body).toBeNull();
    expect(post!.liked_by_me).toBe(false);
    expect(post!.comment_count).toBe(0);
  });

  it('回帰: 一言無しで公開した投稿に他人の返信が付いても本文欄には出ない', () => {
    // 実際に起きたバグの再現条件: @rin が一言無しで公開（threads.body は null）→
    // @satsuki がスレッドに返信（comments 行が増える。ここでは count にのみ反映）。
    // 旧実装は「スレッドの投稿者を問わず comments の先頭行」を lead_comment として拾っていたため
    // @satsuki の返信が @rin の投稿本文として表示されてしまっていた。
    // 新実装は body を threads 行から素通しするだけで comments には一切触れないため、
    // RawThreadRow の型上も comments は count 集計（`{count}[]`）しか持てず、
    // 他人の返信本文がここに紛れ込む経路が存在しない。
    const post = mapFeedRow(
      {
        id: 't8',
        created_at: 'x',
        kind: 'result',
        body: null, // rin は一言無しで公開
        image_url: null,
        updated_at: null,
        author: { id: 'u-rin', handle: 'rin', display_name: 'Rin', avatar_url: null },
        result,
        comments: [{ count: 1 }], // satsuki の返信で +1（本文の中身はここには来ない）
        likes: [{ count: 0 }],
      },
      new Set(),
    );
    expect(post).not.toBeNull();
    expect(post!.body).toBeNull();
    expect(post!.comment_count).toBe(1);
  });
});
