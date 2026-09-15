import { describe, expect, it } from 'vitest';

import { rowToGame, type SngGameRow } from './sngGames';

function row(over: Partial<SngGameRow> = {}): SngGameRow {
  return {
    id: 'sg_abc12345',
    config: { players: 6, startBb: 100, speed: 'normal', levelMin: 4, mode: 'club' },
    status: 'finished',
    started_at: '2026-09-15T06:00:00.000Z',
    ended_at: '2026-09-15T06:20:07.000Z',
    hands: 42,
    seats: [
      { seat: 0, user_id: 'u0', name: 'Alice' },
      { seat: 1, user_id: 'u1', name: 'Bob' },
    ],
    created_at: '2026-09-15T06:20:08.000Z',
    ...over,
  };
}

describe('rowToGame', () => {
  it('サーバの行を記録に変換する', () => {
    const r = rowToGame(row());
    expect(r).toEqual({
      gameId: 'sg_abc12345',
      config: { players: 6, startBb: 100, speed: 'normal', levelMin: 4, mode: 'club' },
      seats: [
        { seat: 0, userId: 'u0', name: 'Alice' },
        { seat: 1, userId: 'u1', name: 'Bob' },
      ],
      status: 'finished',
      startedAt: Date.parse('2026-09-15T06:00:00.000Z'),
      endedAt: Date.parse('2026-09-15T06:20:07.000Z'),
      hands: 42,
    });
  });

  it('started_at が null でも通る（cancelled の一部想定）', () => {
    const r = rowToGame(row({ started_at: null }));
    expect(r?.startedAt).toBeNull();
  });

  it('cancelled も通る', () => {
    expect(rowToGame(row({ status: 'cancelled' }))?.status).toBe('cancelled');
  });

  it('seats が空配列（このカラム追加前の古い行）でも通る', () => {
    expect(rowToGame(row({ seats: [] }))?.seats).toEqual([]);
  });

  it('seats の壊れた要素だけ読み飛ばす', () => {
    const r = rowToGame(
      row({
        seats: [
          { seat: 0, user_id: 'u0', name: 'Alice' },
          { seat: 1, user_id: 'u1' }, // name 無し
          { seat: -1, user_id: 'u2', name: 'Bad' }, // seat 不正
          'not an object',
          { seat: 2, user_id: '', name: 'NoOwner' }, // user_id 空
        ],
      }),
    );
    expect(r?.seats).toEqual([{ seat: 0, userId: 'u0', name: 'Alice' }]);
  });

  it('壊れた行は null', () => {
    expect(rowToGame(row({ id: '' }))).toBeNull();
    expect(rowToGame(row({ status: 'running' }))).toBeNull();
    expect(rowToGame(row({ hands: -1 }))).toBeNull();
    expect(rowToGame(row({ ended_at: 'not a date' }))).toBeNull();
    expect(rowToGame(row({ started_at: 'not a date' }))).toBeNull();
    expect(rowToGame(row({ config: { players: 7, startBb: 100, speed: 'normal', levelMin: 4, mode: 'club' } }))).toBeNull();
    expect(rowToGame(row({ config: null }))).toBeNull();
  });
});
