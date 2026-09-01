import { describe, it, expect } from 'vitest';
import {
  pctToPt,
  compareRange,
  eqWithinTolerance,
  exploitabilityWithinThreshold,
  DEFAULT_TOLERANCES,
  DEFAULT_POOL_PT,
} from '../src/criteria.js';

describe('pool-ratio conversion (SPEC §2.2: 1% = 0.16pt at pool 16)', () => {
  it('converts 1% of pool 16 to 0.16pt', () => {
    expect(pctToPt(1, 16)).toBeCloseTo(0.16, 12);
  });
  it('0.05% of pool 16 = 0.008pt', () => {
    expect(pctToPt(0.05, 16)).toBeCloseTo(0.008, 12);
  });
});

describe('compareRange boundary classification', () => {
  const tol = DEFAULT_TOLERANCES;
  const pool = DEFAULT_POOL_PT;

  it('classifies a small-|EV| diff as boundary and a large one as hard', () => {
    const expected = ['AA', 'KK', 'K2o'];
    const actual = ['AA', 'KK']; // missing K2o
    const ev = { K2o: 0.004 }; // < 0.008 -> boundary
    const r = compareRange(expected, actual, ev, pool, tol);
    expect(r.boundaryHands).toEqual(['K2o']);
    expect(r.hardMismatchHands).toEqual([]);
  });

  it('treats an unknown-EV diff as hard mismatch', () => {
    const r = compareRange(['AA'], [], {}, pool, tol);
    expect(r.hardMismatchHands).toEqual(['AA']);
  });

  it('classifies an extra hand (in actual, not expected) too', () => {
    const r = compareRange(['AA'], ['AA', 'KK'], { KK: 0.001 }, pool, tol);
    expect(r.boundaryHands).toEqual(['KK']);
  });
});

describe('eqWithinTolerance exact vs loose', () => {
  it('loose 0.1% allows 0.016pt at pool 16', () => {
    expect(eqWithinTolerance(2.0, 2.0 + 0.015, 16, DEFAULT_TOLERANCES, false)).toBe(true);
    expect(eqWithinTolerance(2.0, 2.0 + 0.02, 16, DEFAULT_TOLERANCES, false)).toBe(false);
  });
  it('exact 0.02% allows only 0.0032pt at pool 16', () => {
    expect(eqWithinTolerance(2.0, 2.0 + 0.003, 16, DEFAULT_TOLERANCES, true)).toBe(true);
    expect(eqWithinTolerance(2.0, 2.0 + 0.004, 16, DEFAULT_TOLERANCES, true)).toBe(false);
  });
});

describe('exploitability threshold', () => {
  it('accepts below and rejects at/above 0.05% of pool', () => {
    expect(exploitabilityWithinThreshold(0.007, 16, DEFAULT_TOLERANCES)).toBe(true);
    expect(exploitabilityWithinThreshold(0.01, 16, DEFAULT_TOLERANCES)).toBe(false);
  });
});
