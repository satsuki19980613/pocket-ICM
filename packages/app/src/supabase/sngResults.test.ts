import { describe, expect, it } from 'vitest';

import { rowToResult, type SngResultRow } from './sngResults';

function row(over: Partial<SngResultRow> = {}): SngResultRow {
  return {
    game_id: 'sg_abc12345',
    owner: 'u1',
    seat: 2,
    place: 1,
    pt: 5,
    players: 6,
    mode: 'club',
    ended_at: '2026-09-15T06:20:07.000Z',
    ...over,
  };
}

describe('rowToResult', () => {
  it('サーバの行を記録に変換する', () => {
    const r = rowToResult(row());
    expect(r).toEqual({
      gameId: 'sg_abc12345',
      owner: 'u1',
      seat: 2,
      place: 1,
      pt: 5,
      players: 6,
      mode: 'club',
      endedAt: Date.parse('2026-09-15T06:20:07.000Z'),
    });
  });

  it('PostgREST が numeric を文字列で返しても数に戻す', () => {
    const r = rowToResult(row({ pt: '-1' as unknown as number }));
    expect(r?.pt).toBe(-1);
  });

  it('未知のモードは null', () => {
    expect(rowToResult(row({ mode: 'unknown-mode' }))).toBeNull();
  });

  it('壊れた日付・数値は null', () => {
    expect(rowToResult(row({ ended_at: 'not a date' }))).toBeNull();
    expect(rowToResult(row({ pt: 'nan' as unknown as number }))).toBeNull();
    expect(rowToResult(row({ seat: 1.5 }))).toBeNull();
    expect(rowToResult(row({ place: 0 }))).toBeNull();
    expect(rowToResult(row({ players: 1 }))).toBeNull();
    expect(rowToResult(row({ game_id: '' }))).toBeNull();
    expect(rowToResult(row({ owner: '' }))).toBeNull();
  });

  it('レジェンド系のモードも通る', () => {
    expect(rowToResult(row({ mode: 'legend-season' }))?.mode).toBe('legend-season');
  });
});
