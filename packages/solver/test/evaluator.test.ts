import { describe, it, expect } from 'vitest';
import { eval7, scoreCategory, parseCard, CATEGORY } from '../src/evaluator.js';

const hand = (...cards: string[]) => cards.map(parseCard);
const cat = (...cards: string[]) => scoreCategory(eval7(hand(...cards)));

describe('evaluator: category detection', () => {
  it('royal / straight flush', () => {
    expect(cat('As', 'Ks', 'Qs', 'Js', 'Ts', '2h', '3d')).toBe(CATEGORY.STRAIGHT_FLUSH);
  });
  it('quads', () => {
    expect(cat('Ac', 'Ad', 'Ah', 'As', 'Kc', 'Qd', '2h')).toBe(CATEGORY.QUADS);
  });
  it('full house', () => {
    expect(cat('Ac', 'Ad', 'Ah', 'Kc', 'Kd', '2h', '3s')).toBe(CATEGORY.FULL_HOUSE);
  });
  it('flush', () => {
    expect(cat('2s', '5s', '9s', 'Js', 'Ks', 'Ah', 'Qd')).toBe(CATEGORY.FLUSH);
  });
  it('straight', () => {
    expect(cat('5c', '6d', '7h', '8s', '9c', 'Ah', 'Kd')).toBe(CATEGORY.STRAIGHT);
  });
  it('wheel straight A-2-3-4-5', () => {
    expect(cat('Ac', '2d', '3h', '4s', '5c', 'Kh', 'Qd')).toBe(CATEGORY.STRAIGHT);
  });
  it('trips', () => {
    expect(cat('Ac', 'Ad', 'Ah', 'Kc', 'Qd', '2h', '3s')).toBe(CATEGORY.TRIPS);
  });
  it('two pair', () => {
    expect(cat('Ac', 'Ad', 'Kc', 'Kd', 'Qh', '2s', '3c')).toBe(CATEGORY.TWO_PAIR);
  });
  it('one pair', () => {
    expect(cat('Ac', 'Ad', 'Kc', 'Qd', 'Jh', '2s', '3c')).toBe(CATEGORY.PAIR);
  });
  it('high card', () => {
    expect(cat('Ac', 'Kd', 'Qc', 'Jd', '9h', '2s', '3c')).toBe(CATEGORY.HIGH);
  });
});

describe('evaluator: ranking order', () => {
  it('respects the full category ordering', () => {
    const sf = eval7(hand('As', 'Ks', 'Qs', 'Js', 'Ts', '2h', '3d'));
    const quads = eval7(hand('Ac', 'Ad', 'Ah', 'As', 'Kc', 'Qd', '2h'));
    const fh = eval7(hand('Ac', 'Ad', 'Ah', 'Kc', 'Kd', '2h', '3s'));
    const flush = eval7(hand('2s', '5s', '9s', 'Js', 'Ks', 'Ah', 'Qd'));
    const straight = eval7(hand('5c', '6d', '7h', '8s', '9c', 'Ah', 'Kd'));
    const trips = eval7(hand('Ac', 'Ad', 'Ah', 'Kc', 'Qd', '2h', '3s'));
    const twoPair = eval7(hand('Ac', 'Ad', 'Kc', 'Kd', 'Qh', '2s', '3c'));
    const pair = eval7(hand('Ac', 'Ad', 'Kc', 'Qd', 'Jh', '2s', '3c'));
    const high = eval7(hand('Ac', 'Kd', 'Qc', 'Jd', '9h', '2s', '3c'));
    expect(sf).toBeGreaterThan(quads);
    expect(quads).toBeGreaterThan(fh);
    expect(fh).toBeGreaterThan(flush);
    expect(flush).toBeGreaterThan(straight);
    expect(straight).toBeGreaterThan(trips);
    expect(trips).toBeGreaterThan(twoPair);
    expect(twoPair).toBeGreaterThan(pair);
    expect(pair).toBeGreaterThan(high);
  });

  it('higher straight beats lower straight', () => {
    const nine = eval7(hand('5c', '6d', '7h', '8s', '9c', '2h', '3d'));
    const six = eval7(hand('2c', '3d', '4h', '5s', '6c', 'Kh', 'Qd'));
    expect(nine).toBeGreaterThan(six);
  });

  it('kicker breaks a tie of the same pair', () => {
    const aceKick = eval7(hand('Kc', 'Kd', 'Ah', 'Qs', 'Jc', '2h', '3d'));
    const queenKick = eval7(hand('Kc', 'Kd', 'Qh', 'Js', '9c', '2h', '3d'));
    expect(aceKick).toBeGreaterThan(queenKick);
  });

  it('picks the best 5 of 7 (flush over an available pair)', () => {
    const s = scoreCategory(eval7(hand('Ah', 'Ad', '2s', '5s', '9s', 'Js', 'Ks')));
    expect(s).toBe(CATEGORY.FLUSH);
  });

  it('identical best-5 hands tie (equal score)', () => {
    // 両者ボードの A-high ストレートで役が完成、手札は無関係
    const a = eval7(hand('2c', '3d', 'Th', 'Js', 'Qc', 'Kd', 'Ah'));
    const b = eval7(hand('2s', '3h', 'Th', 'Js', 'Qc', 'Kd', 'Ah'));
    expect(a).toBe(b);
  });
});
