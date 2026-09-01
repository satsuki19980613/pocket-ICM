/**
 * 信頼度スコアの集約とポット・チェックサム（SPEC §6.3 / Plan 2-8）。
 *
 * OCR の各読み取り値は信頼度 [0,1] を持つ。しきい値未満の項目、および
 * ポット・チェックサム不一致に関わる項目を「強調対象」として列挙し、
 * 条件確認画面でハイライトさせる（§6.6: 読めた分は埋め、要確認を明示）。
 *
 * チェックサムは画面の実値で突き合わせる:
 *   理論合計 = Σ(各席の拠出) + アンティ寄与
 *   拠出_i   = folded ? ブラインド義務 : screenBet_i     （フォールド済み席のデッド分を含む）
 * 注: OCR の `pot` 読み取りが「中央ポットのみ」か「場に出た総額」かは実機の表示に依存し、
 * golden dataset での較正対象。ここでは総額前提の理論値を返し、較正で tol を調整する。
 */

import type { RawReads } from './types.js';
import type { SeatFacts } from './spotReconstruction.js';

export interface ChecksumResult {
  /** 理論合計（Σ拠出 + アンティ寄与）。 */
  readonly theoretical: number;
  /** OCR が読んだポット。 */
  readonly readPot: number;
  /** |theoretical - readPot|。 */
  readonly delta: number;
  /** tol 以内なら true。 */
  readonly ok: boolean;
}

/** ポット・チェックサム（画面値）。tol は許容差（bb）。 */
export function potChecksum(
  reads: RawReads,
  facts: readonly SeatFacts[],
  tol = 0.5,
): ChecksumResult {
  const contributions = facts.reduce(
    (acc, f) => acc + (f.folded ? f.blindOb : f.screenBet),
    0,
  );
  const anteAmount = reads.ante.scheme === 'none' ? 0 : reads.ante.amount.value;
  const anteContribution =
    reads.ante.scheme === 'all'
      ? anteAmount * facts.length
      : reads.ante.scheme === 'bb'
        ? anteAmount
        : 0;
  const theoretical = contributions + anteContribution;
  const readPot = reads.pot.value;
  const delta = Math.abs(theoretical - readPot);
  const effectiveTol = Math.max(tol, 0.05 * theoretical);
  return { theoretical, readPot, delta, ok: delta <= effectiveTol };
}

export interface ConfidenceReport {
  /** しきい値未満、またはチェックサム不一致で強調すべき項目キー。 */
  readonly lowConfidenceFields: string[];
  readonly checksum: ChecksumResult;
}

/**
 * 信頼度の集約。conf < threshold の項目と、チェックサム不一致に関わる項目を列挙。
 * 項目キーは条件確認画面のフィールドに対応（例 "heroHand", "pot", "SB.stack", "CO.bet"）。
 */
export function aggregateConfidence(
  reads: RawReads,
  facts: readonly SeatFacts[],
  opts: { threshold?: number; checksumTol?: number } = {},
): ConfidenceReport {
  const threshold = opts.threshold ?? 0.8;
  const low = new Set<string>();

  if (reads.heroHand.conf < threshold) low.add('heroHand');
  if (reads.pot.conf < threshold) low.add('pot');
  if (reads.blinds.sb.conf < threshold) low.add('blinds.sb');
  if (reads.blinds.bb.conf < threshold) low.add('blinds.bb');
  if (reads.ante.scheme !== 'none' && reads.ante.amount.conf < threshold) low.add('ante.amount');

  // 席の項目は Position で keying する（条件確認画面が Position keyed のため）。
  const rawById = new Map(reads.seats.map((s) => [s.id, s]));
  for (const f of facts) {
    const s = rawById.get(f.id);
    if (!s) continue;
    if (s.stack.conf < threshold) low.add(`${f.pos}.stack`);
    if (s.bet.conf < threshold) low.add(`${f.pos}.bet`);
    if (Math.min(s.occupancy.conf, s.action.conf) < threshold) low.add(`${f.pos}.state`);
  }

  const checksum = potChecksum(reads, facts, opts.checksumTol);
  if (!checksum.ok) {
    // 不一致に関わりうる項目の信頼度を下げる（§6.3）。
    low.add('pot');
    for (const f of facts) low.add(`${f.pos}.bet`);
  }

  return { lowConfidenceFields: [...low].sort(), checksum };
}
