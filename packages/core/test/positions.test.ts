import { describe, it, expect } from 'vitest';
import {
  positionsForPlayersLeft,
  positionsMatchPlayersLeft,
  isValidPlayersLeft,
} from '../src/positions.js';

describe('positions', () => {
  it('gives the correct action-order set for each player count', () => {
    expect(positionsForPlayersLeft(2)).toEqual(['SB', 'BB']);
    expect(positionsForPlayersLeft(3)).toEqual(['BU', 'SB', 'BB']);
    expect(positionsForPlayersLeft(4)).toEqual(['CO', 'BU', 'SB', 'BB']);
    expect(positionsForPlayersLeft(5)).toEqual(['UTG', 'CO', 'BU', 'SB', 'BB']);
    expect(positionsForPlayersLeft(6)).toEqual(['UTG', 'HJ', 'CO', 'BU', 'SB', 'BB']);
  });

  it('BB is always last (acts last preflop)', () => {
    for (let n = 2; n <= 6; n++) {
      const order = positionsForPlayersLeft(n);
      expect(order[order.length - 1]).toBe('BB');
    }
  });

  it('throws outside 2..6', () => {
    expect(() => positionsForPlayersLeft(1)).toThrow();
    expect(() => positionsForPlayersLeft(7)).toThrow();
  });

  it('validates player counts', () => {
    expect(isValidPlayersLeft(2)).toBe(true);
    expect(isValidPlayersLeft(6)).toBe(true);
    expect(isValidPlayersLeft(1)).toBe(false);
    expect(isValidPlayersLeft(7)).toBe(false);
    expect(isValidPlayersLeft(3.5)).toBe(false);
  });

  it('matches position sets regardless of order', () => {
    expect(positionsMatchPlayersLeft(['BB', 'SB', 'UTG', 'BU', 'CO'], 5)).toBe(true);
    expect(positionsMatchPlayersLeft(['UTG', 'CO', 'BU', 'SB'], 5)).toBe(false);
    expect(positionsMatchPlayersLeft(['UTG', 'HJ', 'CO', 'BU', 'SB'], 5)).toBe(false);
  });
});
