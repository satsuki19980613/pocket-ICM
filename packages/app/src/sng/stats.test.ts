import { describe, expect, it } from 'vitest';

import type { SngResultLocal } from './historyStore';
import { cumulativePt, filterByPeriod, recentPlaces, summarizeSng } from './stats';

function res(over: Partial<SngResultLocal>): SngResultLocal {
  return {
    gameId: 'sg_1',
    owner: 'u1',
    seat: 0,
    place: 3,
    pt: 0,
    players: 6,
    mode: 'club',
    endedAt: Date.UTC(2026, 8, 1),
    ...over,
  };
}

describe('summarizeSng', () => {
  it('空なら 0 埋め', () => {
    const s = summarizeSng([]);
    expect(s.games).toBe(0);
    expect(s.avgPlace).toBe(0);
    expect(s.firstRate).toEqual({ n: 0, d: 0 });
    expect(s.cashRate).toEqual({ n: 0, d: 0 });
    expect(s.totalPt).toBe(0);
    expect(s.placeDist).toEqual([0, 0, 0, 0, 0, 0]);
    expect(s.maxPlayers).toBe(0);
    expect(s.firstPlayedAt).toBeNull();
    expect(s.lastPlayedAt).toBeNull();
  });

  it('平均順位・1位率・入賞率・累計pt・順位分布を集計する', () => {
    const recs = [
      res({ place: 1, pt: 5, players: 6, endedAt: 1 }),
      res({ place: 1, pt: 5, players: 6, endedAt: 2 }),
      res({ place: 6, pt: -1, players: 6, endedAt: 3 }),
      res({ place: 2, pt: 3, players: 4, endedAt: 4 }),
    ];
    const s = summarizeSng(recs);
    expect(s.games).toBe(4);
    expect(s.avgPlace).toBe((1 + 1 + 6 + 2) / 4);
    expect(s.firstRate).toEqual({ n: 2, d: 4 });
    // pt > 0 のものだけ入賞: 5, 5, 3 の 3 件
    expect(s.cashRate).toEqual({ n: 3, d: 4 });
    expect(s.totalPt).toBe(5 + 5 - 1 + 3);
    expect(s.placeDist).toEqual([2, 1, 0, 0, 0, 1]);
    expect(s.maxPlayers).toBe(6);
    expect(s.firstPlayedAt).toBe(1);
    expect(s.lastPlayedAt).toBe(4);
  });

  it('4人卓しか無ければ 5・6 位は起こらない', () => {
    const recs = [res({ place: 4, players: 4 }), res({ place: 1, players: 4 })];
    const s = summarizeSng(recs);
    expect(s.maxPlayers).toBe(4);
    expect(s.placeDist).toEqual([1, 0, 0, 1, 0, 0]);
  });
});

describe('cumulativePt', () => {
  it('endedAt 昇順の累計を返す', () => {
    const recs = [res({ pt: 5 }), res({ pt: -1 }), res({ pt: 3 })];
    expect(cumulativePt(recs)).toEqual([
      { x: 1, y: 5 },
      { x: 2, y: 4 },
      { x: 3, y: 7 },
    ]);
  });

  it('空なら空配列', () => {
    expect(cumulativePt([])).toEqual([]);
  });
});

describe('filterByPeriod', () => {
  // 2026-09-15 (火) 15:20 ローカル（slumbot/stats.test.ts と同じ基準日）。
  const now = new Date(2026, 8, 15, 15, 20).getTime();

  it('直近 N・all は末尾/全件', () => {
    const many = Array.from({ length: 150 }, (_, i) => res({ endedAt: i }));
    expect(filterByPeriod(many, 'last100', now)).toHaveLength(100);
    expect(filterByPeriod(many, 'last100', now)[0]!.endedAt).toBe(50);
    expect(filterByPeriod(many, 'all', now)).toHaveLength(150);
  });
});

describe('recentPlaces', () => {
  it('endedAt 昇順のまま末尾 n 件の順位を返す', () => {
    const recs = [res({ place: 1 }), res({ place: 3 }), res({ place: 2 }), res({ place: 4 })];
    expect(recentPlaces(recs, 2)).toEqual([2, 4]);
  });

  it('既定は 10 件', () => {
    const recs = Array.from({ length: 15 }, (_, i) => res({ place: (i % 6) + 1 }));
    expect(recentPlaces(recs)).toHaveLength(10);
    expect(recentPlaces(recs)).toEqual(recs.slice(-10).map((r) => r.place));
  });

  it('件数が n 未満ならある分だけ', () => {
    const recs = [res({ place: 5 })];
    expect(recentPlaces(recs, 10)).toEqual([5]);
  });

  it('空なら空配列', () => {
    expect(recentPlaces([])).toEqual([]);
  });
});
