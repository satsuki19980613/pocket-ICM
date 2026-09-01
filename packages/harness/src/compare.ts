/**
 * 期待値（HRC 参照）と、ソルバーが返した解ノードの照合。
 */

import type { BoardState, SolutionNode } from '@oshihiki/core';
import { normalizeKey } from '@oshihiki/core';
import type { HarnessCase, ExpectedNode, NodeDiff, CaseResult } from './types.js';
import {
  resolveTolerances,
  DEFAULT_POOL_PT,
  compareRange,
  eqWithinTolerance,
  freqWithinTolerance,
  exploitabilityWithinThreshold,
} from './criteria.js';

/** 期待ノードのキーを決める（明示 key があればそれ、なければ actor から素朴に生成不可なので照合対象を actor/actionType にする）。 */
function expectedKey(exp: ExpectedNode): string | undefined {
  return exp.key;
}

/** 実ノード群から、期待ノードに対応するものを探す。 */
function findActual(
  actual: SolutionNode[],
  exp: ExpectedNode,
): SolutionNode | undefined {
  const key = expectedKey(exp);
  if (key !== undefined) {
    const byKey = actual.find((n) => n.key === key);
    if (byKey) return byKey;
    return undefined;
  }
  // key 未指定時は actor + actionType で緩く突き合わせる
  return actual.find((n) => n.actor === exp.actor && n.actionType === exp.actionType);
}

function compareNode(
  exp: ExpectedNode,
  actual: SolutionNode | undefined,
  poolPt: number,
  tol: ReturnType<typeof resolveTolerances>,
  exactEquity: boolean,
): NodeDiff {
  const label = {
    key: exp.key ?? `${exp.actor}:${exp.actionType}`,
    actor: exp.actor,
    actionType: exp.actionType,
  };

  if (!actual) {
    return {
      ...label,
      pass: false,
      issues: ['ソルバーが対応する解ノードを返さなかった'],
      boundaryHands: [],
      hardMismatchHands: [...exp.range],
    };
  }

  const issues: string[] = [];

  // アクション種別の一致
  if (actual.actionType !== exp.actionType) {
    issues.push(`actionType 不一致: expected ${exp.actionType}, actual ${actual.actionType}`);
  }
  if (actual.actor !== exp.actor) {
    issues.push(`actor 不一致: expected ${exp.actor}, actual ${actual.actor}`);
  }

  // レンジ照合（境界ハンド許容）
  const evByHand: Record<string, number> = { ...(exp.ev ?? {}), ...actual.ev };
  const { boundaryHands, hardMismatchHands } = compareRange(
    exp.range,
    actual.hands,
    evByHand,
    poolPt,
    tol,
  );
  if (hardMismatchHands.length > 0) {
    issues.push(`レンジ不一致（境界外）: ${hardMismatchHands.join(' ')}`);
  }

  // 頻度%
  if (exp.freqPct !== undefined) {
    if (!freqWithinTolerance(exp.freqPct, actual.pct, tol)) {
      issues.push(`頻度% 不一致: expected ${exp.freqPct}, actual ${actual.pct} (±${tol.freqPctAbs})`);
    }
  }

  // EQPre/EQPost
  if (exp.equity) {
    for (const [pos, e] of Object.entries(exp.equity)) {
      const a = actual.equity[pos as keyof typeof actual.equity];
      if (!a) {
        issues.push(`equity[${pos}] がソルバー出力に無い`);
        continue;
      }
      if (!eqWithinTolerance(e.pre, a.pre, poolPt, tol, exactEquity)) {
        issues.push(`EQPre[${pos}] 不一致: expected ${e.pre}, actual ${a.pre}`);
      }
      if (!eqWithinTolerance(e.post, a.post, poolPt, tol, exactEquity)) {
        issues.push(`EQPost[${pos}] 不一致: expected ${e.post}, actual ${a.post}`);
      }
    }
  }

  // exploitability（品質担保）
  if (!exploitabilityWithinThreshold(actual.quality.exploitability, poolPt, tol)) {
    issues.push(
      `exploitability 閾値超過: ${actual.quality.exploitability} >= ${(tol.exploitabilityPct / 100) * poolPt}`,
    );
  }

  return {
    ...label,
    pass: issues.length === 0,
    issues,
    boundaryHands,
    hardMismatchHands,
  };
}

/** 1 ケースを照合する。 */
export function compareCase(testCase: HarnessCase, actual: SolutionNode[]): CaseResult {
  const poolPt = testCase.poolPt ?? DEFAULT_POOL_PT;
  const tol = resolveTolerances(testCase.tolerances);
  const exactEquity = testCase.exactEquity ?? false;

  const caseIssues: string[] = [];
  const nodes: NodeDiff[] = testCase.expected.map((exp) => {
    const a = findActual(actual, exp);
    return compareNode(exp, a, poolPt, tol, exactEquity);
  });

  if (testCase.expected.length === 0) {
    caseIssues.push('期待ノードが 0 件（ケース定義が空）');
  }

  const pass = caseIssues.length === 0 && nodes.every((n) => n.pass);
  return { name: testCase.name, pass, issues: caseIssues, nodes };
}

/** ソルバーを走らせて全ケースを照合する。 */
export async function runHarness(
  solver: (input: BoardState) => SolutionNode[] | Promise<SolutionNode[]>,
  cases: HarnessCase[],
): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  for (const c of cases) {
    let actual: SolutionNode[] = [];
    try {
      actual = await solver(c.input);
    } catch (err) {
      results.push({
        name: c.name,
        pass: false,
        issues: [`ソルバー例外: ${(err as Error).message}`],
        nodes: [],
      });
      continue;
    }
    results.push(compareCase(c, actual));
  }
  return results;
}

// re-export so callers can build normalized keys for expectations if desired
export { normalizeKey };
