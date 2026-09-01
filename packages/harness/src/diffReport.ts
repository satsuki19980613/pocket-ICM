/**
 * 差分レポート（IMPLEMENTATION_PLAN §4.4-5）。境界ハンドを明示する。
 */

import type { CaseResult, HarnessSummary } from './types.js';

export function summarize(results: CaseResult[]): HarnessSummary {
  const passed = results.filter((r) => r.pass).length;
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    results,
  };
}

/** 人間可読なテキストレポートを生成する。 */
export function formatReport(results: CaseResult[]): string {
  const s = summarize(results);
  const lines: string[] = [];
  lines.push(`照合結果: ${s.passed}/${s.total} 合格, ${s.failed} 不合格`);
  lines.push('');

  for (const r of results) {
    const mark = r.pass ? '✓' : '✗';
    lines.push(`${mark} ${r.name}`);
    for (const issue of r.issues) {
      lines.push(`    ! ${issue}`);
    }
    for (const n of r.nodes) {
      if (n.pass && n.boundaryHands.length === 0) continue;
      const nmark = n.pass ? '~' : '✗';
      lines.push(`    ${nmark} [${n.key}] ${n.actor}/${n.actionType}`);
      for (const issue of n.issues) {
        lines.push(`        - ${issue}`);
      }
      if (n.boundaryHands.length > 0) {
        lines.push(`        boundary(許容): ${n.boundaryHands.join(' ')}`);
      }
      if (n.hardMismatchHands.length > 0) {
        lines.push(`        mismatch(境界外): ${n.hardMismatchHands.join(' ')}`);
      }
    }
  }
  return lines.join('\n');
}
