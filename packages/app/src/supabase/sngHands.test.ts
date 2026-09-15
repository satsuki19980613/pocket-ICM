import { describe, expect, it } from 'vitest';

import { rowToHand, rowToHoleCard, type SngHandRow, type SngHoleCardRow } from './sngHands';

function handRow(over: Partial<SngHandRow> = {}): SngHandRow {
  return {
    game_id: 'sg_abc12345',
    hand_no: 3,
    played_at: '2026-09-15T06:20:07.000Z',
    level: 2,
    sb: 100,
    bb: 200,
    ante: 50,
    hand: '1|L2|B0,1,2|S15000,15000,15000|C|D|A2r400.0f.1f|W1200,0,0|E',
    created_at: '2026-09-15T06:20:08.000Z',
    ...over,
  };
}

describe('rowToHand', () => {
  it('サーバの行を記録に変換する', () => {
    const r = rowToHand(handRow());
    expect(r).toEqual({
      gameId: 'sg_abc12345',
      handNo: 3,
      playedAt: Date.parse('2026-09-15T06:20:07.000Z'),
      level: 2,
      sb: 100,
      bb: 200,
      ante: 50,
      encoded: handRow().hand,
    });
  });

  it('壊れた行は null', () => {
    expect(rowToHand(handRow({ hand_no: 0 }))).toBeNull();
    expect(rowToHand(handRow({ level: 0 }))).toBeNull();
    expect(rowToHand(handRow({ bb: 0 }))).toBeNull();
    expect(rowToHand(handRow({ ante: -1 }))).toBeNull();
    expect(rowToHand(handRow({ hand: '' }))).toBeNull();
    expect(rowToHand(handRow({ game_id: '' }))).toBeNull();
    expect(rowToHand(handRow({ played_at: 'nope' }))).toBeNull();
  });
});

function holeRow(over: Partial<SngHoleCardRow> = {}): SngHoleCardRow {
  return {
    game_id: 'sg_abc12345',
    hand_no: 3,
    owner: 'u1',
    cards: 'AhKd',
    created_at: '2026-09-15T06:20:08.000Z',
    ...over,
  };
}

describe('rowToHoleCard', () => {
  it('4 文字を 2 枚に割る', () => {
    expect(rowToHoleCard(holeRow())).toEqual({ gameId: 'sg_abc12345', handNo: 3, cards: ['Ah', 'Kd'] });
  });

  it('壊れた行は null', () => {
    expect(rowToHoleCard(holeRow({ cards: 'Ah' }))).toBeNull();
    expect(rowToHoleCard(holeRow({ hand_no: 0 }))).toBeNull();
    expect(rowToHoleCard(holeRow({ game_id: '' }))).toBeNull();
  });
});
