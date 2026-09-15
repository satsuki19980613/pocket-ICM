import { describe, expect, it } from 'vitest';

import type { SngGameResult, SngHandRecord } from '@oshihiki/sng';

import { gameResultToRows, recordToRows } from './db';

const record: SngHandRecord = {
  gameId: 'sg_test00000001',
  handNo: 3,
  playedAt: Date.UTC(2026, 8, 15, 10, 0, 0),
  level: 2,
  sb: 100,
  bb: 200,
  ante: 25,
  btn: 0,
  sbSeat: 1,
  bbSeat: 2,
  startStacks: [15000, 15000, 15000],
  shown: { 2: ['Ah', 'Kd'] },
  board: ['2c', '7h', 'Ts', 'Jd', 'Qs'],
  actions: [],
  won: [0, 0, 425],
  eliminated: [],
};

const holes = {
  'user-a': ['Ah', 'Kd'] as const,
  'user-b': ['2s', '2h'] as const,
};

describe('recordToRows', () => {
  it('hand 行を組み立てる（列にメタを分離し、圧縮表現は encoded をそのまま使う）', () => {
    const { hand } = recordToRows(record, '1|L2|B0,1,2|...', holes);
    expect(hand).toEqual({
      game_id: 'sg_test00000001',
      hand_no: 3,
      played_at: new Date(record.playedAt).toISOString(),
      participants: ['user-a', 'user-b'],
      level: 2,
      sb: 100,
      bb: 200,
      ante: 25,
      hand: '1|L2|B0,1,2|...',
    });
  });

  it('hole 行は holesByUserId の各エントリから 1 行ずつ', () => {
    const { holes: rows } = recordToRows(record, 'x', holes);
    expect(rows).toEqual([
      { game_id: 'sg_test00000001', hand_no: 3, owner: 'user-a', cards: 'AhKd' },
      { game_id: 'sg_test00000001', hand_no: 3, owner: 'user-b', cards: '2s2h' },
    ]);
  });

  it('holesByUserId が空なら hole 行も participants も空', () => {
    const { hand, holes: rows } = recordToRows(record, 'x', {});
    expect(hand.participants).toEqual([]);
    expect(rows).toEqual([]);
  });
});

const gameResult: SngGameResult = {
  gameId: 'sg_test00000002',
  hostId: 'user-a',
  config: { players: 3, startBb: 100, speed: 'normal', levelMin: 3, mode: 'club' },
  status: 'finished',
  startedAt: 1_000,
  endedAt: 9_000,
  hands: 42,
  players: [
    { userId: 'user-a', name: 'A', seat: 0, place: 1, pt: 5 },
    { userId: 'user-b', name: 'B', seat: 1, place: 2, pt: 3 },
    { userId: 'user-c', name: 'C', seat: 2, place: 3, pt: 2 },
  ],
};

describe('gameResultToRows', () => {
  it('game 行を組み立てる', () => {
    const { game } = gameResultToRows(gameResult);
    expect(game).toEqual({
      id: 'sg_test00000002',
      host: 'user-a',
      config: gameResult.config,
      participants: ['user-a', 'user-b', 'user-c'],
      status: 'finished',
      started_at: new Date(1_000).toISOString(),
      ended_at: new Date(9_000).toISOString(),
      hands: 42,
      seats: [
        { seat: 0, user_id: 'user-a', name: 'A' },
        { seat: 1, user_id: 'user-b', name: 'B' },
        { seat: 2, user_id: 'user-c', name: 'C' },
      ],
    });
  });

  it('seats は seat 昇順に並べる（players の並び順に依存しない）', () => {
    const shuffled: SngGameResult = {
      ...gameResult,
      players: [
        { userId: 'user-c', name: 'C', seat: 2, place: 3, pt: 2 },
        { userId: 'user-a', name: 'A', seat: 0, place: 1, pt: 5 },
        { userId: 'user-b', name: 'B', seat: 1, place: 2, pt: 3 },
      ],
    };
    const { game } = gameResultToRows(shuffled);
    expect(game.seats).toEqual([
      { seat: 0, user_id: 'user-a', name: 'A' },
      { seat: 1, user_id: 'user-b', name: 'B' },
      { seat: 2, user_id: 'user-c', name: 'C' },
    ]);
  });

  it('results 行は参加者ごとに players/mode/ended_at を複製する', () => {
    const { results } = gameResultToRows(gameResult);
    expect(results).toEqual([
      { game_id: 'sg_test00000002', owner: 'user-a', seat: 0, place: 1, pt: 5, players: 3, mode: 'club', ended_at: new Date(9_000).toISOString() },
      { game_id: 'sg_test00000002', owner: 'user-b', seat: 1, place: 2, pt: 3, players: 3, mode: 'club', ended_at: new Date(9_000).toISOString() },
      { game_id: 'sg_test00000002', owner: 'user-c', seat: 2, place: 3, pt: 2, players: 3, mode: 'club', ended_at: new Date(9_000).toISOString() },
    ]);
  });

  it('cancelled は started_at が null でもよい', () => {
    const cancelled: SngGameResult = { ...gameResult, status: 'cancelled', startedAt: null };
    const { game } = gameResultToRows(cancelled);
    expect(game.started_at).toBeNull();
    expect(game.status).toBe('cancelled');
  });
});
