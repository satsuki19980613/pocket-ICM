/**
 * テストケースを JSON ディレクトリから読み込む（IMPLEMENTATION_PLAN §4.4-1）。
 * JSON を置けば動く構造。実 HRC データが未収集でも、合成ケースで機能する。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseHarnessCase, type HarnessCase } from './types.js';
import { checkBoardStateSemantics } from '@oshihiki/core';

export interface LoadResult {
  cases: HarnessCase[];
  errors: { file: string; issues: string[] }[];
}

/** 単一 JSON 文字列をケースへ。構造・意味論の両方を検証する。 */
export function parseCaseJson(text: string, sourceLabel = '<inline>'): { case?: HarnessCase; issues: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { issues: [`JSON パース失敗: ${(e as Error).message}`] };
  }
  const parsed = parseHarnessCase(raw);
  if (!parsed.ok || !parsed.value) {
    return { issues: parsed.issues };
  }
  const sem = checkBoardStateSemantics(parsed.value.input);
  if (!sem.ok) {
    return { issues: sem.issues.map((i) => `input: ${i}`) };
  }
  return { case: parsed.value, issues: [] };
}

/** ディレクトリ内の *.json をすべて読み込む。 */
export function loadCasesFromDir(dir: string): LoadResult {
  const cases: HarnessCase[] = [];
  const errors: { file: string; issues: string[] }[] = [];

  let files: string[] = [];
  try {
    // `_` 始まりは生データ/参照用（未確定フォーマット）としてスキップする。
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
      .sort();
  } catch (e) {
    return { cases, errors: [{ file: dir, issues: [`ディレクトリ読み込み失敗: ${(e as Error).message}`] }] };
  }

  for (const f of files) {
    const full = join(dir, f);
    const text = readFileSync(full, 'utf8');
    const r = parseCaseJson(text, f);
    if (r.case) cases.push(r.case);
    else errors.push({ file: f, issues: r.issues });
  }
  return { cases, errors };
}
