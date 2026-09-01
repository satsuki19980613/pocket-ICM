import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { SolutionNode } from '@oshihiki/core';
import {
  loadCasesFromDir,
  runHarness,
  compareCase,
  stubSolver,
  formatReport,
  summarize,
  type HarnessCase,
  type ExpectedNode,
} from '../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CASES_DIR = join(HERE, '..', 'cases');

/** 期待ノードから「完全一致する」解ノードを組み立てる（ハーネスが合格も出せることの証明用）。 */
function perfectNode(exp: ExpectedNode): SolutionNode {
  return {
    key: exp.key!,
    actor: exp.actor,
    actionType: exp.actionType,
    pct: exp.freqPct ?? 0,
    range: exp.range.join(' '),
    hands: [...exp.range],
    freq: Object.fromEntries(exp.range.map((h) => [h, 1.0])),
    ev: { ...(exp.ev ?? {}) },
    equity: (exp.equity ?? {}) as SolutionNode['equity'],
    quality: { exploitability: 0.0001, converged: true, iterations: 100 },
  };
}

describe('case loading', () => {
  it('loads the synthetic cases with no schema errors', () => {
    const { cases, errors } = loadCasesFromDir(CASES_DIR);
    expect(errors).toEqual([]);
    expect(cases.length).toBeGreaterThanOrEqual(2);
    expect(cases.map((c) => c.name)).toContain('synthetic-hu-10bb');
  });
});

describe('M1-1 完了条件: 空実装ソルバーに対して全件不一致', () => {
  it('reports every case as failing against stubSolver', async () => {
    const { cases } = loadCasesFromDir(CASES_DIR);
    const results = await runHarness(stubSolver, cases);
    const s = summarize(results);
    expect(s.total).toBe(cases.length);
    expect(s.passed).toBe(0);
    expect(s.failed).toBe(cases.length);
    // 各ケースの各ノードが「ソルバーが解ノードを返さなかった」で不一致になっている
    for (const r of results) {
      expect(r.pass).toBe(false);
      for (const n of r.nodes) {
        expect(n.pass).toBe(false);
        expect(n.issues.join(' ')).toMatch(/返さなかった/);
      }
    }
  });

  it('the report marks failures with ✗', async () => {
    const { cases } = loadCasesFromDir(CASES_DIR);
    const results = await runHarness(stubSolver, cases);
    const text = formatReport(results);
    expect(text).toContain('✗');
    expect(text).toContain('0/');
  });
});

describe('ハーネスは合格も正しく出せる（偽陰性でない証明）', () => {
  it('passes when the solver returns the expected node exactly', async () => {
    const { cases } = loadCasesFromDir(CASES_DIR);
    const hu = cases.find((c) => c.name === 'synthetic-hu-10bb')!;
    const perfect = (_input: unknown): SolutionNode[] => hu.expected.map(perfectNode);
    const results = await runHarness(perfect, [hu]);
    expect(results[0]!.pass).toBe(true);
  });
});

describe('境界ハンド許容（§4.3）', () => {
  function huCase(): HarnessCase {
    const { cases } = loadCasesFromDir(CASES_DIR);
    return cases.find((c) => c.name === 'synthetic-hu-10bb')!;
  }

  it('tolerates omission of a hand with |EV| < δ (boundary), still passes', () => {
    const c = huCase();
    const exp = c.expected[0]!;
    // JTs はレンジ内 かつ ev 0.004、δ = 0.05% * 16 = 0.008 -> 境界。除いても合格。
    const node = perfectNode(exp);
    node.hands = exp.range.filter((h) => h !== 'JTs');
    const res = compareCase(c, [node]);
    expect(res.pass).toBe(true);
    expect(res.nodes[0]!.boundaryHands).toContain('JTs');
  });

  it('fails when omitting a clear push (|EV| not small)', () => {
    const c = huCase();
    const exp = c.expected[0]!;
    const node = perfectNode(exp);
    node.hands = exp.range.filter((h) => h !== 'AA'); // AA は ev マップに無く境界外
    const res = compareCase(c, [node]);
    expect(res.pass).toBe(false);
    expect(res.nodes[0]!.hardMismatchHands).toContain('AA');
  });

  it('fails when frequency is off by more than ±0.5%', () => {
    const c = huCase();
    const exp = c.expected[0]!;
    const node = perfectNode(exp);
    node.pct = (exp.freqPct ?? 0) + 1.0;
    const res = compareCase(c, [node]);
    expect(res.pass).toBe(false);
    expect(res.nodes[0]!.issues.join(' ')).toMatch(/頻度/);
  });

  it('fails when EQ is off beyond tolerance', () => {
    const c = huCase(); // exactEquity: true -> 0.02% * 16 = 0.0032 pt
    const exp = c.expected[0]!;
    const node = perfectNode(exp);
    node.equity = { SB: { pre: 4.9 + 0.05, post: 5.05 }, BB: { pre: 5.1, post: 4.95 } } as SolutionNode['equity'];
    const res = compareCase(c, [node]);
    expect(res.pass).toBe(false);
    expect(res.nodes[0]!.issues.join(' ')).toMatch(/EQPre/);
  });

  it('fails when exploitability exceeds the threshold', () => {
    const c = huCase();
    const exp = c.expected[0]!;
    const node = perfectNode(exp);
    node.quality = { exploitability: 0.5, converged: true, iterations: 100 };
    const res = compareCase(c, [node]);
    expect(res.pass).toBe(false);
    expect(res.nodes[0]!.issues.join(' ')).toMatch(/exploitability/);
  });
});
