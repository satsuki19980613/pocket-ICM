import { describe, it, expect } from 'vitest';
import { normalizeKey, parseKey, isCanonicalKey } from '../src/key.js';

describe('solution key normalization', () => {
  it('fills unacted positions with "-" in action order', () => {
    expect(normalizeKey(5, { UTG: 'P' })).toBe('UTG:P,CO:-,BU:-,SB:-,BB:-');
  });

  it('matches the spec example', () => {
    // "UTG:P,CO:F,BU:-,SB:-,BB:-"
    expect(normalizeKey(5, { UTG: 'P', CO: 'F' })).toBe('UTG:P,CO:F,BU:-,SB:-,BB:-');
  });

  it('round-trips normalize -> parse -> normalize', () => {
    const key = normalizeKey(6, { UTG: 'F', HJ: 'P', CO: 'C' });
    const parsed = parseKey(key);
    expect(parsed.playersLeft).toBe(6);
    const rebuilt = normalizeKey(
      parsed.playersLeft,
      Object.fromEntries(parsed.entries.map((e) => [e.pos, e.action])),
    );
    expect(rebuilt).toBe(key);
  });

  it('recognizes canonical keys', () => {
    expect(isCanonicalKey('UTG:P,CO:F,BU:-,SB:-,BB:-')).toBe(true);
    expect(isCanonicalKey('SB:P,BB:-')).toBe(true);
  });

  it('rejects non-canonical ordering', () => {
    // BB listed before SB is not the canonical action order
    expect(isCanonicalKey('UTG:-,CO:-,BU:-,BB:-,SB:-')).toBe(false);
    expect(() => parseKey('UTG:-,CO:-,BU:-,BB:-,SB:-')).toThrow();
  });

  it('rejects invalid action chars', () => {
    expect(isCanonicalKey('SB:X,BB:-')).toBe(false);
  });

  it('rejects unknown position count', () => {
    expect(isCanonicalKey('UTG:P')).toBe(false); // 1 player is invalid
  });
});
