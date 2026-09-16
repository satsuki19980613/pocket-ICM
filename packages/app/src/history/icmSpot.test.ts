import { checkBoardStateSemantics, potChecksumDelta } from '@oshihiki/core';
import { decodeHand, encodeHand } from '@oshihiki/sng';
import type { ActionRecord, SngHandRecord } from '@oshihiki/sng';
import { describe, expect, it } from 'vitest';

import type { SngGameLocal } from '../sng/historyStore';
import { HERO_MAX_BB, handClassOf, icmSpotKey, sngIcmSpot } from './icmSpot';

const played = new Date(2026, 8, 16, 20, 0, 0).getTime();

// レベル1: bb=200 / sb=100 / ante=50（指示のとおり bb 換算が読みやすい基準）。
const SB = 100;
const BB = 200;
const ANTE = 50;

function act(seat: number, kind: ActionRecord['kind'], betTo: number, put: number, street = 0): ActionRecord {
  return { seat, kind, betTo, put, auto: false, street };
}

function game(over: Partial<SngGameLocal>): SngGameLocal {
  return {
    gameId: 'sg_test',
    config: { players: 6, startBb: 200, speed: 'normal', levelMin: 4, mode: 'club' },
    seats: [],
    status: 'finished',
    startedAt: played - 60_000,
    endedAt: played,
    hands: 1,
    ...over,
  };
}

function baseRec(over: Partial<SngHandRecord>): SngHandRecord {
  return {
    gameId: 'sg_test',
    handNo: 1,
    playedAt: played,
    level: 1,
    sb: SB,
    bb: BB,
    ante: ANTE,
    btn: 0,
    sbSeat: 1,
    bbSeat: 2,
    startStacks: [3000, 3000, 3000],
    shown: {},
    board: [],
    actions: [],
    won: [0, 0, 0],
    eliminated: [],
    ...over,
  };
}

describe('sngIcmSpot', () => {
  it('成立ケース（6人・全員フォールドで自分に回ってきた）', () => {
    // btn=0, sbSeat=1, bbSeat=2 の 6 人。actingOrder は bbSeat(2) を末尾に回すので
    // [3,4,5,0,1,2] → positionsForPlayersLeft(6) = [UTG,HJ,CO,BU,SB,BB] と対応する。
    const rec = baseRec({
      startStacks: [4000, 4000, 4000, 4000, 4000, 4000],
      won: [0, 0, 0, 0, 0, 0],
      // UTG(3)・HJ(4) が fold、CO(5, hero) の手番まで到達して hero も fold。
      // fold の betTo は「そのストリートの直前の値のまま」（decodeHand のラウンドトリップに
      // 揃え、プリフロップの直前値＝bb の 200 にしておく）。
      actions: [act(3, 'fold', 200, 0, 0), act(4, 'fold', 200, 0, 0), act(5, 'fold', 200, 0, 0)],
    });
    const g = game({ config: { players: 6, startBb: 200, speed: 'normal', levelMin: 4, mode: 'club' } });

    const r = sngIcmSpot({ rec, game: g, mySeat: 5, myCards: ['Ah', '5h'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.playersLeft).toBe(6);
    expect(r.heroPos).toBe('CO');
    expect(r.heroHand).toBe('A5s');
    expect(r.state.playersLeft).toBe(6);
    expect(r.state.heroPos).toBe('CO');
    expect(r.state.blinds).toEqual({ sb: 0.5, bb: 1 });
    expect(r.state.ante).toEqual({ scheme: 'all', amount: 0.25 });
    expect(r.state.gameMode).toBe('club');

    // 手計算: forced = ante(50) [+ sb100 / + bb200]。stack は (startStacks-forced)/bb。
    const byPos = new Map(r.state.seats.map((s) => [s.pos, s]));
    expect(byPos.get('UTG')?.stack).toBe(19.75); // forced=50
    expect(byPos.get('HJ')?.stack).toBe(19.75); // forced=50
    expect(byPos.get('CO')?.stack).toBe(19.75); // forced=50（hero）
    expect(byPos.get('BU')?.stack).toBe(19.75); // forced=50
    expect(byPos.get('SB')?.stack).toBe(19.25); // forced=150
    expect(byPos.get('BB')?.stack).toBe(18.75); // forced=250

    expect(potChecksumDelta(r.state)).toBe(0);
    expect(checkBoardStateSemantics(r.state).ok).toBe(true);

    // ラウンドトリップ: encodeHand/decodeHand を通しても同じ判定・局面になる。
    const meta = { gameId: rec.gameId, handNo: rec.handNo, playedAt: rec.playedAt, sb: rec.sb, bb: rec.bb, ante: rec.ante };
    const decoded = decodeHand(encodeHand(rec), meta);
    expect(decoded).toEqual(rec);
    expect(sngIcmSpot({ rec: decoded!, game: g, mySeat: 5, myCards: ['Ah', '5h'] })).toEqual(r);
  });

  it('成立ケース（3人・上流にオールインがあって自分がコール判断）', () => {
    // btn=0, sbSeat=1, bbSeat=2 の 3 人。actingOrder はそのまま [0,1,2] → [BU,SB,BB]。
    const rec = baseRec({
      startStacks: [3000, 3000, 3000],
      won: [0, 0, 0],
      // BU がオールイン（対象内）、SB は fold、BB（hero）はコールで判断する。
      actions: [act(0, 'allin', 3000, 2950, 0), act(1, 'fold', 0, 0, 0), act(2, 'call', 3000, 2950, 0)],
    });
    const g = game({});

    const r = sngIcmSpot({ rec, game: g, mySeat: 2, myCards: ['Kh', 'Kd'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.playersLeft).toBe(3);
    expect(r.heroPos).toBe('BB');
    expect(r.heroHand).toBe('KK');
    // hero(BB) forced=ante50+bb200=250 → stack=(3000-250)/200=13.75。
    const bb = r.state.seats.find((s) => s.pos === 'BB');
    expect(bb?.stack).toBe(13.75);
    expect(potChecksumDelta(r.state)).toBe(0);
    expect(checkBoardStateSemantics(r.state).ok).toBe(true);
  });

  it('no-seat: 自分の席が分からない', () => {
    const rec = baseRec({});
    const r = sngIcmSpot({ rec, game: game({}), mySeat: null, myCards: ['Ah', 'Kd'] });
    expect(r).toEqual({ ok: false, reason: 'no-seat', note: expect.any(String) });
  });

  it('not-live: そのハンドでは既に脱落している', () => {
    const rec = baseRec({ startStacks: [3000, 3000, 0] });
    const r = sngIcmSpot({ rec, game: game({}), mySeat: 2, myCards: ['Ah', 'Kd'] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('not-live');
  });

  it('no-cards: 自分の手札が分からない', () => {
    const rec = baseRec({});
    const r = sngIcmSpot({ rec, game: game({}), mySeat: 0, myCards: null });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('no-cards');
  });

  it('players: 生存人数が 2〜6 人の範囲外', () => {
    const rec = baseRec({ startStacks: [3000, 0, 0], sbSeat: 0, bbSeat: 0 });
    const r = sngIcmSpot({ rec, game: game({}), mySeat: 0, myCards: ['Ah', 'Kd'] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('players');
  });

  it('dead-sb: SB を出す席がない（デッドボタン）', () => {
    const rec = baseRec({ sbSeat: null });
    const r = sngIcmSpot({ rec, game: game({}), mySeat: 2, myCards: ['Ah', 'Kd'] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('dead-sb');
  });

  it('short-blind: ブラインドを払うとちょうど 0 になる席がある', () => {
    // SB(seat1) の開始スタックを「アンティ+SB」ちょうどにする＝払うと 0。
    const rec = baseRec({ startStacks: [3000, SB + ANTE, 3000] });
    const r = sngIcmSpot({ rec, game: game({}), mySeat: 2, myCards: ['Ah', 'Kd'] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('short-blind');
  });

  it('preflop-action: 自分の手番までにレイズが入った', () => {
    const rec = baseRec({
      actions: [act(0, 'raise', 400, 400, 0), act(1, 'fold', 0, 0, 0)],
    });
    const r = sngIcmSpot({ rec, game: game({}), mySeat: 2, myCards: ['Ah', 'Kd'] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('preflop-action');
  });

  it('no-decision: 自分に手番が回っていない（BB ウォーク）', () => {
    const rec = baseRec({
      actions: [act(0, 'fold', 0, 0, 0), act(1, 'fold', 0, 0, 0)],
    });
    const r = sngIcmSpot({ rec, game: game({}), mySeat: 2, myCards: ['Ah', 'Kd'] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('no-decision');
  });

  it('hero-deep: 自分のハンド開始時スタックが 25bb 超', () => {
    // hero(BU=seat0) は最初に行動するので上流アクションは無い。開始スタックだけ深い。
    const rec = baseRec({
      startStacks: [(HERO_MAX_BB + 5) * BB, 3000, 3000],
      actions: [act(0, 'fold', 0, 0, 0)],
    });
    const r = sngIcmSpot({ rec, game: game({}), mySeat: 0, myCards: ['Ah', 'Kd'] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('hero-deep');
  });

  it('no-game: 試合の設定（ゲームモード）が分からない', () => {
    const rec = baseRec({
      actions: [act(0, 'allin', 3000, 2950, 0), act(1, 'fold', 0, 0, 0), act(2, 'call', 3000, 2950, 0)],
    });
    const r = sngIcmSpot({ rec, game: null, mySeat: 2, myCards: ['Ah', 'Kd'] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('no-game');
  });
});

describe('handClassOf', () => {
  it('ペア', () => {
    expect(handClassOf(['Kd', 'Ks'])).toBe('KK');
  });
  it('スーテッド', () => {
    expect(handClassOf(['Ah', '5h'])).toBe('A5s');
  });
  it('オフスート', () => {
    expect(handClassOf(['5c', 'Ad'])).toBe('A5o');
  });
  it('不正: 枚数違い', () => {
    expect(handClassOf(['Ah'])).toBeNull();
    expect(handClassOf(['Ah', 'Kd', 'Qs'])).toBeNull();
  });
  it('不正: 未知のランク', () => {
    expect(handClassOf(['Zh', 'Kd'])).toBeNull();
  });
  it('不正: 未知のスート', () => {
    expect(handClassOf(['Ax', 'Kd'])).toBeNull();
  });
});

describe('icmSpotKey', () => {
  it('gameId と handNo から一意なキーを作る', () => {
    expect(icmSpotKey('sg_abc', 5)).toBe('sg_abc#5');
  });
});
