import { describe, expect, it } from 'vitest';

import type { HuHandRecord } from '../slumbot/history';
import { recordToRow, rowToRecord } from './huHands';

const rec: HuHandRecord = {
  id: 'sb_mf9x2k1a7q3z',
  playedAt: Date.UTC(2026, 8, 15, 6, 20, 7),
  heroSeat: 1,
  action: 'b200c/kb100c/kk/b300f',
  heroCards: ['As', 'Kd'],
  botCards: null,
  board: ['2s', '7h', 'Tc', '4d', '9c'],
  winnings: -300,
  showdown: false,
  evWinnings: -300,
  synced: false,
};

describe('recordToRow / rowToRecord', () => {
  it('往復して同じ記録になる（synced は true に立つ）', () => {
    const row = recordToRow(rec);
    expect(row).toEqual({
      id: 'sb_mf9x2k1a7q3z',
      played_at: '2026-09-15T06:20:07.000Z',
      hero_seat: 1,
      action: 'b200c/kb100c/kk/b300f',
      hero_cards: 'AsKd',
      bot_cards: null,
      board: '2s7hTc4d9c',
      winnings: -300,
      showdown: false,
      ev_winnings: -300,
    });
    expect(rowToRecord(row)).toEqual({ ...rec, synced: true });
  });

  it('相手の手札・空のボード・未計算 EV', () => {
    const r2: HuHandRecord = { ...rec, botCards: ['Qh', 'Qc'], board: [], evWinnings: null, showdown: true };
    const row = recordToRow(r2);
    expect(row.bot_cards).toBe('QhQc');
    expect(row.board).toBe('');
    expect(row.ev_winnings).toBeNull();
    expect(rowToRecord(row)).toEqual({ ...r2, synced: true });
  });

  it('壊れた行は null', () => {
    const row = recordToRow(rec);
    expect(rowToRecord({ ...row, played_at: 'not a date' })).toBeNull();
    expect(rowToRecord({ ...row, hero_cards: 'As' })).toBeNull();
    expect(rowToRecord({ ...row, id: 'easzNx' })).toBeNull();
  });

  it('PostgREST が数値を文字列で返しても数に戻す', () => {
    const row = recordToRow(rec);
    const back = rowToRecord({ ...row, winnings: '-300' as unknown as number });
    expect(back?.winnings).toBe(-300);
  });
});
