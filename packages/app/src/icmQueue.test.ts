import { describe, it, expect } from 'vitest';
import type { BoardState } from '@oshihiki/core';
import { icmSpotKey } from './history/icmSpot';
import { ICM_QUEUE_MAX, dequeueIcm, enqueueIcm, hasIcmKey, type IcmQueueItem, type IcmQueueRequest } from './icmQueue';

const state = {} as unknown as BoardState;

function req(gameId: string, handNo: number): IcmQueueRequest {
  return {
    gameId,
    handNo,
    state,
    heroHand: 'AKs',
    heroPos: 'BTN',
    playersLeft: 4,
  };
}

describe('enqueueIcm', () => {
  it('末尾に足す（新しい配列を返す。元の配列は変えない）', () => {
    const q0: IcmQueueItem[] = [];
    const r = enqueueIcm(q0, req('g1', 1));
    expect(r.added).toBe(true);
    expect(r.full).toBe(false);
    expect(r.queue).toHaveLength(1);
    expect(r.queue[0]).toMatchObject({ gameId: 'g1', handNo: 1, key: icmSpotKey('g1', 1) });
    expect(q0).toHaveLength(0); // 破壊的変更していない
  });

  it('同じハンド（同じ key）の重複は足さない', () => {
    const r1 = enqueueIcm([], req('g1', 1));
    const r2 = enqueueIcm(r1.queue, req('g1', 1));
    expect(r2.added).toBe(false);
    expect(r2.full).toBe(false);
    expect(r2.queue).toHaveLength(1);
  });

  it('上限に達していたら足さず full:true', () => {
    let queue: IcmQueueItem[] = [];
    for (let i = 0; i < ICM_QUEUE_MAX; i++) {
      queue = enqueueIcm(queue, req('g1', i)).queue;
    }
    expect(queue).toHaveLength(ICM_QUEUE_MAX);
    const r = enqueueIcm(queue, req('g1', 999));
    expect(r.added).toBe(false);
    expect(r.full).toBe(true);
    expect(r.queue).toHaveLength(ICM_QUEUE_MAX);
  });
});

describe('dequeueIcm', () => {
  it('先頭を取り出す（残りは新しい配列）', () => {
    const q1 = enqueueIcm([], req('g1', 1)).queue;
    const q2 = enqueueIcm(q1, req('g1', 2)).queue;
    const r = dequeueIcm(q2);
    expect(r.item?.key).toBe(icmSpotKey('g1', 1));
    expect(r.queue).toHaveLength(1);
    expect(r.queue[0]?.key).toBe(icmSpotKey('g1', 2));
    expect(q2).toHaveLength(2); // 破壊的変更していない
  });

  it('空なら item:null', () => {
    const r = dequeueIcm([]);
    expect(r.item).toBeNull();
    expect(r.queue).toHaveLength(0);
  });
});

describe('hasIcmKey', () => {
  it('行列にあれば true、無ければ false', () => {
    const q = enqueueIcm([], req('g1', 1)).queue;
    expect(hasIcmKey(q, icmSpotKey('g1', 1))).toBe(true);
    expect(hasIcmKey(q, icmSpotKey('g1', 2))).toBe(false);
  });
});
