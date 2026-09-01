import { describe, it, expect } from 'vitest';
import {
  parseBoardState,
  checkBoardStateSemantics,
  potChecksumDelta,
  type BoardState,
} from '../src/boardState.js';

/** IMPLEMENTATION_PLAN §3.1 の例（5人）。 */
function sample(): unknown {
  return {
    street: 'preflop',
    blinds: { sb: 0.5, bb: 1.0 },
    ante: { scheme: 'all', amount: 0.1 },
    heroHand: 'K6s',
    playersLeft: 5,
    seats: [
      { pos: 'UTG', stack: 18.2, state: 'live', bet: 0, name: 'player1' },
      { pos: 'CO', stack: 96.8, state: 'fold', bet: 0, name: 'player2' },
      { pos: 'BU', stack: 43.6, state: 'live', bet: 0, name: 'player3' },
      { pos: 'SB', stack: 62.7, state: 'live', bet: 0.5, name: 'player4' },
      { pos: 'BB', stack: 100.8, state: 'live', bet: 1.0, name: 'player5' },
    ],
    heroPos: 'UTG',
    pot: 1.6,
    heroHandConfidence: 0.99,
  };
}

describe('boardState schema', () => {
  it('accepts the spec example', () => {
    const r = parseBoardState(sample());
    expect(r.ok).toBe(true);
    expect(r.value?.playersLeft).toBe(5);
  });

  it('rejects a bad hand-class notation', () => {
    const bad = sample() as Record<string, unknown>;
    bad.heroHand = '6Ks';
    const r = parseBoardState(bad);
    expect(r.ok).toBe(false);
    expect(r.issues.join(' ')).toContain('heroHand');
  });

  it('rejects non-preflop street', () => {
    const bad = sample() as Record<string, unknown>;
    bad.street = 'flop';
    expect(parseBoardState(bad).ok).toBe(false);
  });

  it('rejects negative stack', () => {
    const bad = sample() as Record<string, unknown>;
    (bad.seats as any[])[0].stack = -1;
    expect(parseBoardState(bad).ok).toBe(false);
  });

  it('rejects confidence outside [0,1]', () => {
    const bad = sample() as Record<string, unknown>;
    (bad.seats as any[])[0].confidence = { stack: 1.5 };
    expect(parseBoardState(bad).ok).toBe(false);
  });
});

describe('boardState semantics', () => {
  it('passes the spec example', () => {
    const r = parseBoardState(sample());
    const s = checkBoardStateSemantics(r.value as BoardState);
    expect(s.ok).toBe(true);
    expect(s.issues).toEqual([]);
  });

  it('flags active-seat / playersLeft mismatch', () => {
    const b = parseBoardState(sample()).value as BoardState;
    b.playersLeft = 4;
    const s = checkBoardStateSemantics(b);
    expect(s.ok).toBe(false);
    expect(s.issues.join(' ')).toMatch(/active seats/);
  });

  it('excludes empty seats from the player count', () => {
    const raw = sample() as any;
    raw.seats.push({ pos: 'HJ', stack: 0, state: 'empty', bet: 0 });
    // still 5 active players; empty seat must not break it
    const parsed = parseBoardState(raw);
    // note: 6 seats but playersLeft 5 -> HJ empty excluded. But position set of
    // active seats is the 5-player set, so semantics should pass.
    const s = checkBoardStateSemantics(parsed.value as BoardState);
    expect(s.ok).toBe(true);
  });

  it('flags heroPos not among active seats', () => {
    const b = parseBoardState(sample()).value as BoardState;
    b.heroPos = 'BB';
    b.seats = b.seats.map((x) => (x.pos === 'BB' ? { ...x, state: 'empty' } : x));
    b.playersLeft = 4;
    const s = checkBoardStateSemantics(b);
    expect(s.ok).toBe(false);
  });

  it('flags ante none with nonzero amount', () => {
    const b = parseBoardState(sample()).value as BoardState;
    b.ante = { scheme: 'none', amount: 0.1 };
    expect(checkBoardStateSemantics(b).ok).toBe(false);
  });
});

describe('pot checksum', () => {
  it('computes delta for all-ante scheme (SB+BB+5*0.1 = 2.0 vs pot 1.6 -> 0.4)', () => {
    const b = parseBoardState(sample()).value as BoardState;
    // Σbet = 0.5 + 1.0 = 1.5 ; ante all 0.1*5 = 0.5 ; theoretical 2.0 ; pot 1.6
    const d = potChecksumDelta(b);
    expect(d).toBeCloseTo(0.4, 9);
  });

  it('returns null when pot is absent', () => {
    const b = parseBoardState(sample()).value as BoardState;
    delete (b as Record<string, unknown>).pot;
    expect(potChecksumDelta(b)).toBeNull();
  });
});
