import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadCasesFromDir, runHarness, compareCase } from '../src/index.js';
// solver はワークスペース symlink されていないため相対パスで読む（harness が solver を駆動する統合確認）。
import { huSolver } from '../../solver/src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CASES_DIR = join(HERE, '..', 'cases');

describe('harness × 実 HU ソルバー（プラミング統合）', () => {
  it('HU ケースで両ノードを §3.2 の key で解決でき、exploitability ゲートを通す', async () => {
    const { cases } = loadCasesFromDir(CASES_DIR);
    const hu = cases.find((c) => c.name === 'synthetic-hu-10bb')!;

    const nodes = huSolver(hu.input);
    expect(nodes.map((n) => n.key)).toEqual(['SB:-,BB:-', 'SB:P,BB:-']);

    // 期待ノード（key "SB:-,BB:-"）に対して「ソルバーが解ノードを返さなかった」に
    // ならないこと（= key でノードを解決できている）。値は placeholder のため全一致は問わない。
    const res = compareCase(hu, nodes);
    const puDiff = res.nodes.find((n) => n.key === 'SB:-,BB:-')!;
    expect(puDiff.issues.join(' ')).not.toMatch(/返さなかった/);
    // exploitability は品質ゲートを通る（この項目では不合格理由に出ない）
    expect(puDiff.issues.join(' ')).not.toMatch(/exploitability/);
  });

  it('runHarness が実ソルバーで例外なく走る', async () => {
    const { cases } = loadCasesFromDir(CASES_DIR);
    const hu = cases.find((c) => c.name === 'synthetic-hu-10bb')!;
    const results = await runHarness(huSolver, [hu]);
    expect(results).toHaveLength(1);
    expect(results[0]!.issues.join(' ')).not.toMatch(/ソルバー例外/);
  });
});
