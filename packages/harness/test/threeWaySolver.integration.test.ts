import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadCasesFromDir, compareCase } from '../src/index.js';
// solver はワークスペース symlink されていないため相対パスで読む。
import { threeWaySolver, solveThreeWay } from '../../solver/src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CASES_DIR = join(HERE, '..', 'cases');
// HRC 実照合値は Phase 0（さつき収集）待ちのため、ここでは配線（key 解決・
// サイドポット経路が例外なく走る）だけを確認する。値の一致は問わない。
const FAST = { maxIters: 200, refreshEvery: 100, samples: 12000 } as const;

describe('harness × 3-way ソルバー（プラミング統合）', () => {
  it(
    'サイドポット発生ケース（不揃いスタック + アンティ）で6ノードを §3.2 key で解決',
    () => {
      const { cases } = loadCasesFromDir(CASES_DIR);
      const c = cases.find((x) => x.name === 'synthetic-3way-bubble')!;
      const nodes = solveThreeWay(c.input, FAST).nodes;
      expect(nodes.map((n) => n.key).sort()).toEqual(
        [
          'BU:-,SB:-,BB:-',
          'BU:F,SB:-,BB:-',
          'BU:F,SB:P,BB:-',
          'BU:P,SB:-,BB:-',
          'BU:P,SB:C,BB:-',
          'BU:P,SB:F,BB:-',
        ].sort(),
      );
      // 期待ノード（PU）に対して「ソルバーが解ノードを返さなかった」にならない
      const res = compareCase(c, nodes);
      const puDiff = res.nodes.find((n) => n.key === 'BU:-,SB:-,BB:-')!;
      expect(puDiff.issues.join(' ')).not.toMatch(/返さなかった/);
    },
    120_000,
  );

  it('threeWaySolver（ハーネス互換シグネチャ）が例外なく SolutionNode[] を返す', () => {
    const { cases } = loadCasesFromDir(CASES_DIR);
    const c = cases.find((x) => x.name === 'synthetic-3way-bubble')!;
    const nodes = threeWaySolver({ ...c.input });
    expect(Array.isArray(nodes)).toBe(true);
    expect(nodes.length).toBe(6);
  }, 120_000);
});
