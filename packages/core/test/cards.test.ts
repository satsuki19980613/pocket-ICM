import { describe, it, expect } from 'vitest';
import {
  allHandClasses,
  allHandClassLabels,
  parseHandClass,
  isHandClass,
  comboCount,
} from '../src/cards.js';

describe('hand classes', () => {
  it('enumerates exactly 169 classes', () => {
    const all = allHandClasses();
    expect(all.length).toBe(169);
  });

  it('has 13 pairs, 78 suited, 78 offsuit', () => {
    const all = allHandClasses();
    expect(all.filter((h) => h.kind === 'pair').length).toBe(13);
    expect(all.filter((h) => h.kind === 's').length).toBe(78);
    expect(all.filter((h) => h.kind === 'o').length).toBe(78);
  });

  it('labels are unique', () => {
    const labels = allHandClassLabels();
    expect(new Set(labels).size).toBe(169);
  });

  it('total combos across all classes is 1326', () => {
    const total = allHandClasses().reduce((acc, h) => acc + comboCount(h.kind), 0);
    expect(total).toBe(1326);
  });

  it('parses valid notations', () => {
    expect(parseHandClass('AA')?.kind).toBe('pair');
    expect(parseHandClass('K6s')?.kind).toBe('s');
    expect(parseHandClass('QJo')?.kind).toBe('o');
    expect(parseHandClass('AA')?.hi).toBe('A');
    expect(parseHandClass('K6s')?.hi).toBe('K');
    expect(parseHandClass('K6s')?.lo).toBe('6');
  });

  it('rejects invalid notations', () => {
    expect(isHandClass('AAs')).toBe(false); // pair with suffix
    expect(isHandClass('6Ks')).toBe(false); // low rank first
    expect(isHandClass('AK')).toBe(false); // non-pair without suffix
    expect(isHandClass('K6x')).toBe(false); // bad suffix
    expect(isHandClass('1A')).toBe(false); // bad rank
    expect(isHandClass('')).toBe(false);
  });

  it('round-trips every enumerated label through the parser', () => {
    for (const h of allHandClasses()) {
      const p = parseHandClass(h.label);
      expect(p).not.toBeNull();
      expect(p!.label).toBe(h.label);
    }
  });
});
