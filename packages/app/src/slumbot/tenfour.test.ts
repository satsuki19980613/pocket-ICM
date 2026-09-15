import { describe, expect, it } from 'vitest';

import type { HuHandRecord } from './history';
import { tenfourFileName, tenfourFolder, tenfourTimestamp, toTenfourCard, toTenfourHand } from './tenfour';

const played = new Date(2026, 8, 15, 15, 20, 7).getTime();

function rec(over: Partial<HuHandRecord>): HuHandRecord {
  return {
    id: 'sb_mf9x2k1a7q3z',
    playedAt: played,
    heroSeat: 1,
    action: 'b200c/kb100c/kk/b300f',
    heroCards: ['As', 'Kd'],
    botCards: null,
    board: ['2s', '7h', 'Tc', '4d', '9c'],
    winnings: -300,
    showdown: false,
    evWinnings: -300,
    synced: true,
    ...over,
  };
}

describe('toTenfourHand', () => {
  it('降りて終わったハンド（自分が SB）', () => {
    const h = toTenfourHand(rec({}), 'Satsuki', played)!;
    expect(h.hand_id).toBe('sb_mf9x2k1a7q3z');
    expect(h.timestamp).toBe('2026/09/15 15:20');
    expect(h.parsed_at).toBe('2026-09-15T15:20:07');
    expect(h.hero_name).toBe('Satsuki');
    expect(h.hero_position).toBe('SB');
    expect(h.hero_cards).toEqual([
      { rank: 'A', suit: 's' },
      { rank: 'K', suit: 'd' },
    ]);
    expect(h.players).toEqual([
      {
        position: 'SB',
        name: 'Satsuki',
        stack_delta_bb: -3,
        cards: [
          { rank: 'A', suit: 's' },
          { rank: 'K', suit: 'd' },
        ],
        is_hero: true,
      },
      {
        position: 'BB',
        name: 'Slumbot',
        stack_delta_bb: 3,
        cards: [
          { rank: '?', suit: '?' },
          { rank: '?', suit: '?' },
        ],
        is_hero: false,
      },
    ]);
    expect(h.actions).toEqual([
      { position: 'SB', name: 'Satsuki', action: 'Raise', amount_bb: 2, street: 'preflop' },
      { position: 'BB', name: 'Slumbot', action: 'Call', amount_bb: 2, street: 'preflop' },
      { position: 'BB', name: 'Slumbot', action: 'Check', amount_bb: null, street: 'flop' },
      { position: 'SB', name: 'Satsuki', action: 'Bet', amount_bb: 1, street: 'flop' },
      { position: 'BB', name: 'Slumbot', action: 'Call', amount_bb: 1, street: 'flop' },
      { position: 'BB', name: 'Slumbot', action: 'Check', amount_bb: null, street: 'turn' },
      { position: 'SB', name: 'Satsuki', action: 'Check', amount_bb: null, street: 'turn' },
      { position: 'BB', name: 'Slumbot', action: 'Bet', amount_bb: 3, street: 'river' },
      { position: 'SB', name: 'Satsuki', action: 'Fold', amount_bb: null, street: 'river' },
    ]);
    expect(h.board).toEqual({
      flop: [
        { rank: '2', suit: 's' },
        { rank: '7', suit: 'h' },
        { rank: 'T', suit: 'c' },
      ],
      turn: [{ rank: '4', suit: 'd' }],
      river: [{ rank: '9', suit: 'c' }],
    });
    expect(h.street_pots).toEqual({ flop: 4, turn: 6, river: 6 });
    // 相手のリバーの 3bb はコールされていないので戻る。持ち帰りは 6bb。
    expect(h.result_winner).toBe('Slumbot');
    expect(h.result_won_bb).toBe(6);
    expect(h.parse_errors).toEqual([]);
    expect(h.raw_ocr).toEqual({});
    expect(h.source).toBe('slumbot');
    expect(h.stack_bb).toBe(200);
    expect(h.allin_ev_delta_bb).toBe(0);
  });

  it('捲り合い（自分が BB で勝ち）: showdown のポットと EV の差', () => {
    const h = toTenfourHand(
      rec({ heroSeat: 0, action: 'b20000c', botCards: ['Qh', 'Qc'], winnings: 20000, showdown: true, evWinnings: 5000 }),
      'Satsuki',
      played,
    )!;
    expect(h.hero_position).toBe('BB');
    expect(h.players[0]).toMatchObject({ position: 'SB', name: 'Slumbot', stack_delta_bb: -200 });
    expect(h.players[1]).toMatchObject({ position: 'BB', name: 'Satsuki', stack_delta_bb: 200, is_hero: true });
    expect(h.actions).toEqual([
      { position: 'SB', name: 'Slumbot', action: 'Raise', amount_bb: 200, street: 'preflop' },
      { position: 'BB', name: 'Satsuki', action: 'Call', amount_bb: 200, street: 'preflop' },
    ]);
    expect(h.street_pots).toEqual({ flop: 400, turn: 400, river: 400, showdown: 400 });
    expect(h.result_winner).toBe('Satsuki');
    expect(h.result_won_bb).toBe(400);
    expect(h.allin_ev_delta_bb).toBe(-150);
  });

  it('プリフロップで相手が降りたハンド: ボード無し・ポット無し', () => {
    const h = toTenfourHand(rec({ action: 'f', heroSeat: 0, winnings: 50, board: [] }), 'Satsuki', played)!;
    expect(h.board).toEqual({});
    expect(h.street_pots).toEqual({});
    expect(h.result_won_bb).toBe(1);
    expect(h.actions).toEqual([{ position: 'SB', name: 'Slumbot', action: 'Fold', amount_bb: null, street: 'preflop' }]);
  });

  it('引き分けは勝者なし', () => {
    const h = toTenfourHand(rec({ action: 'ck/kk/kk/kk', winnings: 0, showdown: true, botCards: ['Ah', 'Kc'] }), 'S', played)!;
    expect(h.result_winner).toBe('');
    expect(h.result_won_bb).toBeNull();
  });

  it('壊れた action は null', () => {
    expect(toTenfourHand(rec({ action: 'kk' }), 'S', played)).toBeNull();
  });
});

describe('names', () => {
  it('ファイル名とフォルダは tenfour に倣う', () => {
    expect(tenfourFileName(rec({}))).toBe('slumbot_20260915_1520_mf9x2k1a7q3z.json');
    expect(tenfourFolder(rec({}))).toBe('2026-09-15');
    expect(tenfourTimestamp(new Date(2026, 0, 2, 3, 4).getTime())).toBe('2026/01/02 03:04');
  });

  it('カードの変換', () => {
    expect(toTenfourCard('Th')).toEqual({ rank: 'T', suit: 'h' });
    expect(toTenfourCard('ah')).toEqual({ rank: 'A', suit: 'h' });
    expect(toTenfourCard(undefined)).toEqual({ rank: '?', suit: '?' });
    expect(toTenfourCard('Xx')).toEqual({ rank: '?', suit: '?' });
  });
});
