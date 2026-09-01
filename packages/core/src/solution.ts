/**
 * 解の構造（IMPLEMENTATION_PLAN §3.2）。Solver の出力 / App の入力。
 * 数値は EV / equity ともに実払い pt 建て（SPEC §2.2）。
 */

import { z } from 'zod';
import { POSITIONS } from './positions.js';
import { isCanonicalKey } from './key.js';
import { isHandClass } from './cards.js';

export const ACTION_TYPES = ['PU', 'CA', 'OC'] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

const freqValue = z.number().min(0).max(1);
const handClassKey = z.string().refine(isHandClass, { message: 'invalid hand-class key' });

export const NodeEquitySchema = z.object({
  pre: z.number().finite(),
  post: z.number().finite(),
});

export const QualitySchema = z.object({
  exploitability: z.number().finite().nonnegative(),
  converged: z.boolean(),
  iterations: z.number().int().nonnegative(),
});

export const SolutionNodeSchema = z.object({
  key: z.string().refine(isCanonicalKey, { message: 'key is not in canonical form' }),
  actor: z.enum(POSITIONS),
  actionType: z.enum(ACTION_TYPES),
  pct: z.number().min(0).max(100),
  range: z.string(),
  hands: z.array(handClassKey),
  freq: z.record(handClassKey, freqValue),
  ev: z.record(handClassKey, z.number().finite()),
  equity: z.record(z.enum(POSITIONS), NodeEquitySchema),
  quality: QualitySchema,
});
export type SolutionNode = z.infer<typeof SolutionNodeSchema>;

export function parseSolutionNode(
  input: unknown,
): { ok: boolean; issues: string[]; value?: SolutionNode } {
  const r = SolutionNodeSchema.safeParse(input);
  if (!r.success) {
    return { ok: false, issues: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
  }
  return { ok: true, issues: [], value: r.data };
}
