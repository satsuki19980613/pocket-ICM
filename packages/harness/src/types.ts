/**
 * 照合ハーネスの型（IMPLEMENTATION_PLAN §4）。
 *
 * テストケースは JSON で管理する（§4.4-1）。各ケースは盤面状態（入力）と、
 * HRC などのゴールデンリファレンスから人力で収集した期待値を持つ。
 * 期待値の数値は実払い pt 建て（SPEC §2.2）。
 */

import { z } from 'zod';
import { BoardStateSchema, POSITIONS, ACTION_TYPES, isHandClass } from '@oshihiki/core';

const handClass = z.string().refine(isHandClass, { message: 'invalid hand-class' });

export const ExpectedNodeSchema = z.object({
  /** 正規キー（未指定なら actor/actionType から突き合わせない。通常は指定する） */
  key: z.string().optional(),
  actor: z.enum(POSITIONS),
  actionType: z.enum(ACTION_TYPES),
  /** 純化後レンジ（ハンドクラスの明示リスト）。レンジ記法パーサは §4.6 で別途。 */
  range: z.array(handClass),
  /** その枝の頻度%（0..100） */
  freqPct: z.number().min(0).max(100).optional(),
  /** EQPre/EQPost（実払い pt 建て）。ポジション → {pre,post} */
  equity: z.record(z.enum(POSITIONS), z.object({ pre: z.number(), post: z.number() })).optional(),
  /** 各ハンドの EV（実払い pt）。境界ハンド許容の判定に使う */
  ev: z.record(handClass, z.number()).optional(),
});
export type ExpectedNode = z.infer<typeof ExpectedNodeSchema>;

export const HarnessCaseSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  /** % 変換の基準プール（実払いシフト後。既定 16）。SPEC §2.2 */
  poolPt: z.number().positive().optional(),
  /** ケース個別のトレランス上書き */
  tolerances: z
    .object({
      eqAbsPct: z.number().optional(),
      eqAbsPctExact: z.number().optional(),
      rangeDeltaPct: z.number().optional(),
      freqPctAbs: z.number().optional(),
      exploitabilityPct: z.number().optional(),
    })
    .partial()
    .optional(),
  /** この局面が厳密 equity（HU 等）で解けるか。EQ の締めたトレランスを適用 */
  exactEquity: z.boolean().optional(),
  input: BoardStateSchema,
  expected: z.array(ExpectedNodeSchema),
});
export type HarnessCase = z.infer<typeof HarnessCaseSchema>;

export function parseHarnessCase(input: unknown): { ok: boolean; issues: string[]; value?: HarnessCase } {
  const r = HarnessCaseSchema.safeParse(input);
  if (!r.success) {
    return { ok: false, issues: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
  }
  return { ok: true, issues: [], value: r.data };
}

/** ノード単位の照合結果。 */
export interface NodeDiff {
  key: string;
  actor: string;
  actionType: string;
  pass: boolean;
  /** 失敗理由（合格なら空） */
  issues: string[];
  /** |EV|<δ のため不一致を許容した境界ハンド（§4.3） */
  boundaryHands: string[];
  /** 許容できない不一致ハンド（レンジ差） */
  hardMismatchHands: string[];
}

/** ケース単位の照合結果。 */
export interface CaseResult {
  name: string;
  pass: boolean;
  /** ケース全体に関わる問題（ノードが見つからない等） */
  issues: string[];
  nodes: NodeDiff[];
}

export interface HarnessSummary {
  total: number;
  passed: number;
  failed: number;
  results: CaseResult[];
}
