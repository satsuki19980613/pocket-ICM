import { describe, it, expect } from 'vitest';
import type { BoardState } from '@oshihiki/core';
import { dbToHeroAction, heroActionToDb, rowToRecord, type RawResultRow } from './records';

const spot: BoardState = {
  street: 'preflop',
  blinds: { sb: 0.5, bb: 1 },
  ante: { scheme: 'none', amount: 0 },
  heroHand: 'AKs',
  playersLeft: 3,
  heroPos: 'BU',
  seats: [
    { pos: 'BU', stack: 20, state: 'live', bet: 0 },
    { pos: 'SB', stack: 19.5, state: 'live', bet: 0.5 },
    { pos: 'BB', stack: 19, state: 'live', bet: 1 },
  ],
  pot: 1.5,
};

function row(over: Partial<RawResultRow> = {}): RawResultRow {
  return {
    id: 'r1',
    status: 'done',
    client_id: 'c1',
    hero_hand: 'AKs',
    hero_pos: 'BU',
    players_left: 3,
    verdict: 'ALL_IN',
    hero_action: 'FOLD',
    hero_ev: 0.4,
    ev_loss: 0.4,
    solve_ms: 1200,
    error: null,
    image_id: 'img-1',
    ocr_read_id: 'ocr-1',
    spot,
    solution: null,
    is_public: false,
    created_at: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('dbToHeroAction / heroActionToDb', () => {
  it('DB値 ⇄ 内部 HeroAction を相互変換する', () => {
    expect(dbToHeroAction('ALL_IN')).toBe('PUSH');
    expect(dbToHeroAction('FOLD')).toBe('FOLD');
    expect(dbToHeroAction(null)).toBeNull();
    expect(dbToHeroAction(undefined)).toBeNull();
    expect(heroActionToDb('PUSH')).toBe('ALL_IN');
    expect(heroActionToDb('FOLD')).toBe('FOLD');
    expect(heroActionToDb(null)).toBeNull();
    expect(heroActionToDb(undefined)).toBeNull();
  });
});

describe('rowToRecord', () => {
  it('通常行を SpotRecord へ写像する', () => {
    const rec = rowToRecord(row());
    expect(rec).toMatchObject({
      id: 'r1',
      status: 'done',
      heroHand: 'AKs',
      heroPos: 'BU',
      playersLeft: 3,
      verdict: 'PUSH',
      heroAction: 'FOLD',
      heroEv: 0.4,
      evLoss: 0.4,
      published: false,
      ms: 1200,
      serverId: 'r1',
      clientId: 'c1',
      pendingSync: false,
      imageId: 'img-1',
      ocrReadId: 'ocr-1',
    });
    expect(rec.state).toBe(spot);
    expect(rec.createdAt).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
  });

  it('hero_action/verdict が null（未選択・計算中）なら内部値も null/既定にする', () => {
    const rec = rowToRecord(row({ hero_action: null, verdict: null, ev_loss: null, status: 'solving' }));
    expect(rec.heroAction).toBeNull();
    expect(rec.evLoss).toBeNull();
    // verdict は暫定 'FOLD'（SpotRecord.verdict は非 null フィールドのため）。
    expect(rec.verdict).toBe('FOLD');
  });

  it('非正規化列（hero_hand 等）が欠けている旧データは spot から補う', () => {
    const rec = rowToRecord(row({ hero_hand: null, hero_pos: null, players_left: null }));
    expect(rec.heroHand).toBe(spot.heroHand);
    expect(rec.heroPos).toBe(spot.heroPos);
    expect(rec.playersLeft).toBe(spot.playersLeft);
  });

  it('client_id が null（旧データ）なら clientId は id で代用する', () => {
    const rec = rowToRecord(row({ client_id: null }));
    expect(rec.clientId).toBe('r1');
  });

  it('error/imageId/ocrReadId は null なら undefined にする（optional field 流儀）', () => {
    const rec = rowToRecord(row({ error: null, image_id: null, ocr_read_id: null }));
    expect(rec.error).toBeUndefined();
    expect(rec.imageId).toBeUndefined();
    expect(rec.ocrReadId).toBeUndefined();
  });

  it('solve_ms/hero_ev が null（計算中）なら 0 を既定にする', () => {
    const rec = rowToRecord(row({ solve_ms: null, hero_ev: null, status: 'solving', solution: null }));
    expect(rec.ms).toBe(0);
    expect(rec.heroEv).toBe(0);
    expect(rec.result).toBeNull();
  });
});
