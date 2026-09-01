import { describe, it, expect } from 'vitest';
import { parseSolutionNode } from '../src/solution.js';
import { normalizeKey } from '../src/key.js';

function sampleNode(): unknown {
  return {
    key: normalizeKey(5, { UTG: 'P' }),
    actor: 'UTG',
    actionType: 'PU',
    pct: 8.7,
    range: '77+ A9s+ ATo+',
    hands: ['AA', 'KK', 'A9s'],
    freq: { '77': 1.0, A9s: 0.62, '72o': 0.0 },
    ev: { K6s: 0.18, '72o': 0.0 },
    equity: { UTG: { pre: 2.14, post: 2.26 } },
    quality: { exploitability: 0.0003, converged: true, iterations: 412 },
  };
}

describe('solution node schema', () => {
  it('accepts a well-formed node', () => {
    const r = parseSolutionNode(sampleNode());
    expect(r.ok).toBe(true);
  });

  it('rejects a non-canonical key', () => {
    const bad = sampleNode() as Record<string, unknown>;
    bad.key = 'UTG:P,CO:-,BU:-,BB:-,SB:-'; // wrong order
    expect(parseSolutionNode(bad).ok).toBe(false);
  });

  it('rejects an unknown action type', () => {
    const bad = sampleNode() as Record<string, unknown>;
    bad.actionType = 'RAISE';
    expect(parseSolutionNode(bad).ok).toBe(false);
  });

  it('rejects frequencies outside [0,1]', () => {
    const bad = sampleNode() as any;
    bad.freq = { '77': 1.4 };
    expect(parseSolutionNode(bad).ok).toBe(false);
  });

  it('rejects an invalid hand-class key in ev', () => {
    const bad = sampleNode() as any;
    bad.ev = { '6Ks': 0.1 };
    expect(parseSolutionNode(bad).ok).toBe(false);
  });
});
