import type { ActionRecord, SngConfig, SngHandRecord } from '@oshihiki/sng';
import { describe, expect, it } from 'vitest';

import { namesFromSeats, sngConfigSummary, toTenfourSngHand, type SngTenfourMeta } from './tenfour';

const played = new Date(2026, 8, 15, 20, 0, 0).getTime();

function act(seat: number, kind: ActionRecord['kind'], betTo: number, put: number, street = 0): ActionRecord {
  return { seat, kind, betTo, put, auto: false, street };
}

function baseRecord(over: Partial<SngHandRecord>): SngHandRecord {
  return {
    gameId: 'sg_test0001',
    handNo: 7,
    playedAt: played,
    level: 1,
    sb: 100,
    bb: 200,
    ante: 0,
    btn: 0,
    sbSeat: 1,
    bbSeat: 2,
    startStacks: [15000, 15000, 15000, 15000, 15000, 15000],
    shown: {},
    board: [],
    actions: [],
    won: [0, 0, 0, 0, 0, 0],
    eliminated: [],
    ...over,
  };
}

const NAMES6 = ['Zero', 'One', 'Two', 'Hero', 'Four', 'Five'];

describe('toTenfourSngHand: SRP（プリフロップ RFI にコールされ、チェック止まりでショーダウン）', () => {
  const record = baseRecord({
    board: ['2s', '7h', 'Tc', '4d', '9c'],
    actions: [
      act(3, 'raise', 600, 600, 0),
      act(4, 'fold', 0, 0, 0),
      act(5, 'fold', 0, 0, 0),
      act(0, 'fold', 0, 0, 0),
      act(1, 'fold', 0, 0, 0),
      act(2, 'call', 600, 400, 0),
      act(2, 'check', 0, 0, 1),
      act(3, 'check', 0, 0, 1),
      act(2, 'check', 0, 0, 2),
      act(3, 'check', 0, 0, 2),
      act(2, 'check', 0, 0, 3),
      act(3, 'check', 0, 0, 3),
    ],
    shown: { 2: ['Qh', 'Qc'], 3: ['Ah', 'Kd'] },
    won: [0, 0, 0, 1300, 0, 0],
  });
  const meta: SngTenfourMeta = { mySeat: 3, myCards: ['Ah', 'Kd'], names: NAMES6, playersAtStart: 6 };

  it('UTG（hero）が RFI → BB だけコールでショーダウン', () => {
    const h = toTenfourSngHand(record, meta, 'Satsuki', played)!;
    expect(h.hand_id).toBe('sg_test0001_0007');
    expect(h.hero_name).toBe('Satsuki');
    expect(h.hero_position).toBe('UTG');
    expect(h.hero_cards).toEqual([
      { rank: 'A', suit: 'h' },
      { rank: 'K', suit: 'd' },
    ]);
    expect(h.players.map((p) => p.position)).toEqual(['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB']);
    expect(h.players.map((p) => p.name)).toEqual(['Satsuki', 'Four', 'Five', 'Zero', 'One', 'Two']);
    expect(h.players[0]).toMatchObject({ position: 'UTG', stack_delta_bb: 3.5, is_hero: true });
    expect(h.players[5]).toMatchObject({ position: 'BB', stack_delta_bb: -3, cards: [{ rank: 'Q', suit: 'h' }, { rank: 'Q', suit: 'c' }] });
    // フォールドしたビレインは非公開のまま。
    expect(h.players[1]!.cards).toEqual([
      { rank: '?', suit: '?' },
      { rank: '?', suit: '?' },
    ]);
    expect(h.actions[0]).toEqual({ position: 'UTG', name: 'Satsuki', action: 'Raise', amount_bb: 3, street: 'preflop' });
    expect(h.actions[5]).toEqual({ position: 'BB', name: 'Two', action: 'Call', amount_bb: 3, street: 'preflop' });
    expect(h.street_pots).toEqual({ flop: 6.5, turn: 6.5, river: 6.5, showdown: 6.5 });
    expect(h.result_winner).toBe('Satsuki');
    expect(h.result_won_bb).toBe(6.5);
    expect(h.stacks_bb).toEqual([75, 75, 75, 75, 75, 75]);
    expect(h.level).toBe(1);
    expect(h.ante_bb).toBe(0);
    expect(h.source).toBe('sng');
    expect(h.sng_id).toBe('sg_test0001');
    expect(h.hand_no).toBe(7);
  });
});

describe('toTenfourSngHand: walk（BB まで全員フォールド。手札は非公開）', () => {
  const record = baseRecord({
    ante: 0,
    actions: [act(3, 'fold', 0, 0, 0), act(4, 'fold', 0, 0, 0), act(5, 'fold', 0, 0, 0), act(0, 'fold', 0, 0, 0), act(1, 'fold', 0, 0, 0)],
    won: [0, 0, 300, 0, 0, 0],
  });
  const meta: SngTenfourMeta = { mySeat: 2, myCards: ['2c', '7d'], names: NAMES6, playersAtStart: 6 };

  it('BB（hero）がブラインドを持ち帰る。board / street_pots は空', () => {
    const h = toTenfourSngHand(record, meta, 'Satsuki', played)!;
    expect(h.hero_position).toBe('BB');
    expect(h.board).toEqual({});
    expect(h.street_pots).toEqual({});
    expect(h.result_winner).toBe('Satsuki');
    expect(h.result_won_bb).toBe(1.5);
    expect(h.players.find((p) => p.is_hero)).toMatchObject({ position: 'BB', stack_delta_bb: 0.5 });
    // 誰の手札も公開されない（hero 自身の手札は meta.myCards から分かる）。
    for (const p of h.players) if (!p.is_hero) expect(p.cards).toEqual([{ rank: '?', suit: '?' }, { rank: '?', suit: '?' }]);
  });
});

describe('toTenfourSngHand: 3人オールイン（同スタック・サイドポット無し）', () => {
  const record = baseRecord({
    gameId: 'sg_test0002',
    handNo: 40,
    sb: 100,
    bb: 200,
    ante: 0,
    btn: 0,
    sbSeat: 1,
    bbSeat: 2,
    startStacks: [2000, 2000, 2000],
    board: ['2s', '7h', 'Tc', '4d', '9c'],
    actions: [act(0, 'allin', 2000, 2000, 0), act(1, 'allin', 2000, 1900, 0), act(2, 'allin', 2000, 1800, 0)],
    shown: { 0: ['2h', '2d'], 1: ['5h', '5d'], 2: ['Ah', 'Ad'] },
    won: [0, 0, 6000],
  });
  const meta: SngTenfourMeta = { mySeat: 2, myCards: ['Ah', 'Ad'], names: ['P0', 'P1', 'Hero'], playersAtStart: 3 };

  it('3 人ぶんの拠出がそのままポットになり、リバーまで一括で走る', () => {
    const h = toTenfourSngHand(record, meta, 'Satsuki', played)!;
    expect(h.hero_position).toBe('BB');
    expect(h.players.map((p) => p.position)).toEqual(['BTN', 'SB', 'BB']);
    expect(h.actions.map((a) => a.action)).toEqual(['All-in', 'All-in', 'All-in']);
    expect(h.street_pots).toEqual({ flop: 30, turn: 30, river: 30, showdown: 30 });
    expect(h.players[0]).toMatchObject({ position: 'BTN', stack_delta_bb: -10 });
    expect(h.players[1]).toMatchObject({ position: 'SB', stack_delta_bb: -10 });
    expect(h.players[2]).toMatchObject({ position: 'BB', stack_delta_bb: 20, is_hero: true });
    expect(h.result_winner).toBe('Satsuki');
    expect(h.result_won_bb).toBe(30);
  });
});

describe('toTenfourSngHand: デッドボタン（SB 不在）', () => {
  const record = baseRecord({
    sb: 100,
    bb: 200,
    ante: 0,
    btn: 2,
    sbSeat: null,
    bbSeat: 4,
    // 席 3 が既に脱落（このハンドの SB に当たる席）。
    startStacks: [15000, 15000, 15000, 0, 15000, 15000],
    board: ['2s', '7h', 'Tc', '4d', '9c'],
    actions: [
      act(5, 'fold', 0, 0, 0),
      act(0, 'fold', 0, 0, 0),
      act(1, 'fold', 0, 0, 0),
      act(2, 'call', 200, 200, 0),
      act(4, 'check', 0, 0, 0),
      act(4, 'check', 0, 0, 1),
      act(2, 'check', 0, 0, 1),
      act(4, 'check', 0, 0, 2),
      act(2, 'check', 0, 0, 2),
      act(4, 'check', 0, 0, 3),
      act(2, 'check', 0, 0, 3),
    ],
    shown: { 2: ['Kh', 'Kd'], 4: ['Ah', 'Ac'] },
    won: [0, 0, 0, 0, 400, 0],
  });
  const meta: SngTenfourMeta = { mySeat: 4, myCards: ['Ah', 'Ac'], names: NAMES6, playersAtStart: 6 };

  it('SB を欠いた 5 人ぶんのポジションになる（UTG/HJ/CO/BTN/BB）', () => {
    const h = toTenfourSngHand(record, meta, 'Satsuki', played)!;
    // 生存席 [5,0,1,2,4] の並びに UTG/HJ/CO/BTN/BB を割り当てる（SB は無い）。
    expect(h.players.map((p) => p.position)).toEqual(['UTG', 'HJ', 'CO', 'BTN', 'BB']);
    expect(h.players.map((p) => p.position)).not.toContain('SB');
    expect(h.hero_position).toBe('BB');
    const btn = h.players.find((p) => p.position === 'BTN')!;
    expect(btn.stack_delta_bb).toBe(-1);
    const bb = h.players.find((p) => p.position === 'BB')!;
    expect(bb).toMatchObject({ stack_delta_bb: 1, is_hero: true });
    expect(h.street_pots).toEqual({ flop: 2, turn: 2, river: 2, showdown: 2 });
    expect(h.result_won_bb).toBe(2);
  });
});

describe('toTenfourSngHand: 異常系', () => {
  it('startStacks の長さが playersAtStart と食い違えば null', () => {
    const record = baseRecord({});
    const meta: SngTenfourMeta = { mySeat: 2, myCards: null, names: NAMES6, playersAtStart: 5 };
    expect(toTenfourSngHand(record, meta, 'Satsuki', played)).toBeNull();
  });

  it('自分の席が飛んでいれば null', () => {
    const record = baseRecord({ startStacks: [15000, 15000, 0, 15000, 15000, 15000] });
    const meta: SngTenfourMeta = { mySeat: 2, myCards: null, names: NAMES6, playersAtStart: 6 };
    expect(toTenfourSngHand(record, meta, 'Satsuki', played)).toBeNull();
  });
});

describe('namesFromSeats', () => {
  const seats = [
    { seat: 0, name: 'Alice' },
    { seat: 2, name: 'Carol' },
  ];

  it('席番号の順に名前を並べ、無ければ Seat n にする', () => {
    expect(namesFromSeats(seats, 4)).toEqual(['Alice', 'Seat 1', 'Carol', 'Seat 3']);
  });

  it('seats が空なら全席 Seat n', () => {
    expect(namesFromSeats([], 3)).toEqual(['Seat 0', 'Seat 1', 'Seat 2']);
  });
});

describe('sngConfigSummary', () => {
  it('人数・開始bb・構造・上昇間隔・モードを並べる', () => {
    const config: SngConfig = { players: 6, startBb: 100, speed: 'normal', levelMin: 4, mode: 'club' };
    expect(sngConfigSummary(config)).toBe('6人 ・ 100bb開始 ・ 通常 ・ 4分上昇 ・ クラブマッチ');
  });

  it('スピード・モードのラベルが変わる', () => {
    const config: SngConfig = { players: 4, startBb: 75, speed: 'veryslow', levelMin: 5, mode: 'rank-4' };
    expect(sngConfigSummary(config)).toBe('4人 ・ 75bb開始 ・ もっとゆっくり ・ 5分上昇 ・ ランクマッチ STAGE Ⅳ');
  });
});
