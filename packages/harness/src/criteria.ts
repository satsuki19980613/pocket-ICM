/**
 * 照合の合格基準（IMPLEMENTATION_PLAN §4.3）。項目別にトレランスを分ける。
 *
 * | 項目           | 合格基準 |
 * | EQPre/EQPost   | 絶対誤差 0.1%（厳密 equity は 0.02%） |
 * | レンジ         | 完全一致。ただし |EV|<δ(プール比0.05%) のハンドは不一致許容 |
 * | 頻度%          | ±0.5% |
 * | exploitability | 実払いプール比 0.05% 未満 |
 *
 * すべての % は基準プール poolPt（既定 16 = HRC 入力形シフト後）に対する比。
 * SPEC §2.2: HRC の 1.00% = 0.16pt（実払い）。
 */

export interface Tolerances {
  /** EQ 絶対誤差の許容（% of pool） */
  eqAbsPct: number;
  /** 厳密 equity ケースの EQ 許容（% of pool） */
  eqAbsPctExact: number;
  /** レンジ境界許容 δ（% of pool）。|EV|<δ のハンドは不一致を許容 */
  rangeDeltaPct: number;
  /** 頻度%の絶対許容（パーセントポイント） */
  freqPctAbs: number;
  /** exploitability 上限（% of pool） */
  exploitabilityPct: number;
}

export const DEFAULT_TOLERANCES: Tolerances = {
  eqAbsPct: 0.1,
  eqAbsPctExact: 0.02,
  rangeDeltaPct: 0.05,
  freqPctAbs: 0.5,
  exploitabilityPct: 0.05,
};

export const DEFAULT_POOL_PT = 16;

/** % of pool を実払い pt の絶対量へ変換する。 */
export function pctToPt(pct: number, poolPt: number): number {
  return (pct / 100) * poolPt;
}

export function resolveTolerances(overrides?: Partial<Tolerances>): Tolerances {
  return { ...DEFAULT_TOLERANCES, ...(overrides ?? {}) };
}

/** EQ（pre/post）の絶対誤差が許容内か。 */
export function eqWithinTolerance(
  expected: number,
  actual: number,
  poolPt: number,
  tol: Tolerances,
  exact: boolean,
): boolean {
  const limPct = exact ? tol.eqAbsPctExact : tol.eqAbsPct;
  const limPt = pctToPt(limPct, poolPt);
  return Math.abs(expected - actual) <= limPt + 1e-12;
}

/** 頻度%が許容内か。 */
export function freqWithinTolerance(expectedPct: number, actualPct: number, tol: Tolerances): boolean {
  return Math.abs(expectedPct - actualPct) <= tol.freqPctAbs + 1e-12;
}

/** exploitability が閾値未満か（品質担保）。 */
export function exploitabilityWithinThreshold(
  exploitPt: number,
  poolPt: number,
  tol: Tolerances,
): boolean {
  return exploitPt < pctToPt(tol.exploitabilityPct, poolPt) + 1e-12;
}

/**
 * レンジ（ハンド集合）の照合。
 * 完全一致を原則とし、対称差のハンドは |EV|<δ の場合のみ「境界ハンド」として許容。
 * EV は expected.ev を優先、なければ actualEv を使う。EV 不明の差は許容しない（hard）。
 */
export function compareRange(
  expectedHands: readonly string[],
  actualHands: readonly string[],
  evByHand: Readonly<Record<string, number>>,
  poolPt: number,
  tol: Tolerances,
): { boundaryHands: string[]; hardMismatchHands: string[] } {
  const exp = new Set(expectedHands);
  const act = new Set(actualHands);
  const deltaPt = pctToPt(tol.rangeDeltaPct, poolPt);

  const diff: string[] = [];
  for (const h of exp) if (!act.has(h)) diff.push(h);
  for (const h of act) if (!exp.has(h)) diff.push(h);

  const boundaryHands: string[] = [];
  const hardMismatchHands: string[] = [];
  for (const h of diff) {
    const ev = evByHand[h];
    if (ev !== undefined && Math.abs(ev) < deltaPt) {
      boundaryHands.push(h);
    } else {
      hardMismatchHands.push(h);
    }
  }
  return {
    boundaryHands: [...new Set(boundaryHands)].sort(),
    hardMismatchHands: [...new Set(hardMismatchHands)].sort(),
  };
}
