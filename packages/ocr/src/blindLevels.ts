/**
 * ポーカーチェイス クラブマッチのブラインド構造と「保存則ベース」の解決（さつき決定 2026-09-09）。
 *
 * 目的:
 *  1. クラブマッチは総チップが保存される（開始 6 人 × 15,000 = 90,000・1 テーブル・勝者総取り）。
 *     **場の総 BB = 90,000 ÷ 現在の BB（チップ）** が理論的に定まり、これを整合性チェックの基準にする。
 *  2. BB/SB/アンティ（チップ）を確定する。BB の中央表示は大きく明瞭で信頼して読めるので、
 *     **読み取った BB をそのまま基準**にする（＝保存則ベース）。公式レベル表は「小さな誤読の補正」に
 *     だけタイトに併用する。
 *
 * 重要（複数スピード）: クラブマッチには**複数のブラインド構造（スピード）**が存在する。
 * 2026-09-10 にさつきから「ゆっくり」「もっとゆっくり」の公式ストラクチャ表を受領し、
 * 「通常」と合わせて **3 表すべてを登録**した（それ以前は「通常」しか無く、他は読み値採用だった）。
 *   - 通常: 16 レベル（200/50 〜 60000/15000）
 *   - ゆっくり: 32 レベル（200/50 〜 60000/15000）… 実機 185057 の 480/960/240 はこの lv9
 *   - もっとゆっくり: 59 レベル（200/50 〜 60000/15000）
 * SB は全構造で BB/2（実測不変）。アンティは概ね 0.25×BB だが**式では作れない**
 * （例: もっとゆっくり BB 300 の ante は 75 ではなく 70）。必ず表の値を使う。
 * どの表にもタイト一致しない BB は**読み値をそのまま採用**し、保存則（90,000÷BB）で扱う。
 * 総チップは常に 6 人 × 15,000＝90,000（さつき確定 2026-09-10）で、スピードによらない。
 *
 * 生表（BB/ante の 3 構造）の正本は `@oshihiki/core` の blindStructure（移設済み）。
 */

import {
  BLIND_TABLE_NORMAL as BB_ANTE,
  BLIND_TABLE_SLOW as BB_ANTE_SLOW,
  BLIND_TABLE_VERY_SLOW as BB_ANTE_VERY_SLOW,
  type BlindSpeed,
} from '@oshihiki/core';

export type { BlindSpeed };

/** クラブマッチ 1 レベル（チップ）。SB は常に BB/2。 */
export interface BlindLevel {
  readonly level: number;
  readonly bb: number;
  readonly sb: number;
  readonly ante: number;
  /** どの構造（スピード）のレベルか。 */
  readonly speed: BlindSpeed;
}

/** クラブマッチ開始総チップ（6 人 × 15,000）。1 テーブル保存＝場の総チップは常にこれ。 */
export const CLUB_MATCH_TOTAL_CHIPS = 90000;

/** 解決済みブラインド（チップ）。level=0 は「どの公式表にも当たらない＝読み値採用」。 */
export interface ResolvedBlinds {
  readonly sb: number;
  readonly bb: number;
  readonly ante: number;
  /** 一致した公式表のレベル番号。どの表にも当たらなければ 0。 */
  readonly level: number;
  /** 一致した表のスピード。どれにも当たらなければ無し。 */
  readonly speed?: BlindSpeed;
}

function toLevels(rows: readonly (readonly [bb: number, ante: number])[], speed: BlindSpeed): readonly BlindLevel[] {
  return rows.map(([bb, ante], i) => ({ level: i + 1, bb, sb: bb / 2, ante, speed }));
}

/** クラブマッチ「通常」のブラインドレベル表（チップ）。 */
export const CLUB_MATCH_LEVELS: readonly BlindLevel[] = toLevels(BB_ANTE, 'normal');
/** クラブマッチ「ゆっくり」のブラインドレベル表（チップ）。 */
export const CLUB_MATCH_LEVELS_SLOW: readonly BlindLevel[] = toLevels(BB_ANTE_SLOW, 'slow');
/** クラブマッチ「もっとゆっくり」のブラインドレベル表（チップ）。 */
export const CLUB_MATCH_LEVELS_VERY_SLOW: readonly BlindLevel[] = toLevels(BB_ANTE_VERY_SLOW, 'veryslow');

/** 3 スピードすべてのレベル（スナップ候補の母集団）。 */
export const ALL_CLUB_MATCH_LEVELS: readonly BlindLevel[] = [
  ...CLUB_MATCH_LEVELS,
  ...CLUB_MATCH_LEVELS_SLOW,
  ...CLUB_MATCH_LEVELS_VERY_SLOW,
];

/**
 * 読み取り BB（チップ）を公式表（3 スピード）へ**タイトに**スナップする。相対距離が gate（既定 2%）
 * 以内のレベルがあれば返す。無ければ null（＝表に無い構造＝読み値採用）。
 *
 * gate をタイトにするのは、正しい読みを近い別レベルへ誤スナップして総チップ保存を壊さないため。
 * 当初 6% だったが、実測で**「ゆっくり」の 800 を「通常」の 780（相対 2.6%）へ誤スナップ**しており
 * （GT: Screenshot_20260901-142955 / -143002）、総チップ保存の理論値が 112.5 → 115.4 とずれて
 * 「2.9bb 不足」に見え、スタックを 2.9bb も書き換えかねない状態だった。2% へ絞ると同フレームは
 * 800 のまま解決され、実チップが保存している GT 8 枚すべてで残差が ±0.10bb 以内に収まる。
 *
 * 3 スピードを併せると BB が 1.2〜3.8% しか離れていない組（8600/8700, 6000/6100, 19600/20000 等）や、
 * **BB が同じで ante だけ違う組**（300 → ゆっくり 75 / もっとゆっくり 70、13000 → 通常 3200 /
 * もっとゆっくり 3300）が出る。そこで候補が複数あるときは**読み取った ante で決める**
 * （ante は BB より小さく誤読しやすいので重みは軽くし、BB 距離を主・ante 距離を従とする）。
 */
export function snapByBb(bbChips: number, gate = 0.02, anteChips = NaN): BlindLevel | null {
  if (!Number.isFinite(bbChips) || bbChips <= 0) return null;
  const useAnte = Number.isFinite(anteChips) && anteChips > 0;
  let best: BlindLevel | null = null;
  let bestScore = Infinity;
  for (const lv of ALL_CLUB_MATCH_LEVELS) {
    const relBb = Math.abs(lv.bb - bbChips) / lv.bb;
    if (relBb > gate) continue;
    // BB 距離が主。ante は「同じ BB の別スピード」を分ける決め手なので従（重み 0.5）。
    const score = relBb + (useAnte ? 0.5 * (Math.abs(lv.ante - anteChips) / lv.ante) : 0);
    if (score < bestScore) { bestScore = score; best = lv; }
  }
  return best;
}

/**
 * ヘッダの SB/BB/アンティ（チップ）からブラインドを解決する（保存則ベースの主入口）。
 *  - BB が読めない場合は SB×2 で代用（SB=BB/2 の不変を使う）。両方読めなければ null（＝チェック無効）。
 *  - 公式表（通常／ゆっくり／もっとゆっくり）に**タイト一致**すればその厳密値（小誤読を補正）。
 *    同じ BB が複数スピードにあるときは読み取った ante で決める。
 *  - 一致しなければ**読み値をそのまま採用**（表に無い構造）: bb=読み値, sb=bb/2（不変を強制）,
 *    ante=読み値が妥当（0.15〜0.35×bb）ならそれ、外れれば 0.25×bb で近似。level=0。
 * いずれの場合も総 BB は `totalBbFromBbChips(bb)`（=90,000÷bb）で求まり、全スピードを自動対応する。
 *
 * **総チップを超える BB はヘッダの誤読とみなし、SB でも救済しない**（null ＝ チェック無効＝従来の
 * 安全側）。BB が場の総チップ（クラブマッチ 90,000）を上回ることはあり得ず、公式表の最大 BB も
 * 60,000 なので正しい読みは落ちない。実測: 装飾テーマ卓（Screenshot_20260910-192316.png）で
 * ヘッダの「280/560」が SB 3 / BB 8,828,054 と読まれた。BB をそのまま使うと総 BB の理論値が
 * 0.01 BB、SB×2 で救済すると BB 6 → 15,000 BB になり、どちらも「クラブマッチではない」と誤って
 * 棄却する。同じヘッダが壊れている以上 SB も信用できないので、SB×2 の救済は BB が**読めなかった**
 * とき（欠測）に限る。
 */
export function resolveBlindChips(sbChips: number, bbChips: number, anteChips: number, tightGate = 0.02): ResolvedBlinds | null {
  const bbRead = Number.isFinite(bbChips) && bbChips > 0;
  if (bbRead && bbChips > CLUB_MATCH_TOTAL_CHIPS) return null; // ヘッダ誤読
  const sbRescue = Number.isFinite(sbChips) && sbChips > 0 && sbChips * 2 <= CLUB_MATCH_TOTAL_CHIPS;
  const bbGuess = bbRead ? bbChips : sbRescue ? sbChips * 2 : NaN;
  if (!Number.isFinite(bbGuess)) return null;

  const matched = snapByBb(bbGuess, tightGate, anteChips);
  if (matched) {
    return { sb: matched.sb, bb: matched.bb, ante: matched.ante, level: matched.level, speed: matched.speed };
  }

  // 別スピード: 読み値採用。SB=BB/2 を強制、アンティは妥当域なら読み値・外れれば 0.25×BB。
  const bb = Math.round(bbGuess);
  const sb = Math.round(bb / 2);
  const antePlausible = Number.isFinite(anteChips) && anteChips >= 0.15 * bb && anteChips <= 0.35 * bb;
  const ante = antePlausible ? Math.round(anteChips) : Math.round(0.25 * bb);
  return { sb, bb, ante, level: 0 };
}

/**
 * SB/BB の読み（チップ）がストラクチャー表と照合できるか: BB が表のいずれかのレベルに
 * タイト一致し、かつ SB がちょうど BB の半分。ヘッダの読み位置合わせの判定に使う
 * （extractAnchored.readHeaderBlinds）。読み位置がずれて数字が切れたり「BB」の文字を
 * 巻き込んだりした読み（SB 80・SB 8280・BB 8,828,054 など）はここで落ちる。
 */
export function isTableConsistentBlinds(sbChips: number, bbChips: number, tightGate = 0.02): boolean {
  if (!(Number.isFinite(sbChips) && Number.isFinite(bbChips) && sbChips > 0 && bbChips > 0)) return false;
  if (Math.abs(sbChips * 2 - bbChips) > 0.01 * bbChips) return false;
  return snapByBb(bbChips, tightGate) !== null;
}

/** レベルの BB 換算アンティ（= ante/bb）。クラブマッチは概ね 0.25 だがレベルで微変動。 */
export function anteBbOf(level: BlindLevel): number {
  return level.ante / level.bb;
}

/** 現在の BB（チップ）から場の総 BB（= 総チップ ÷ BB）を返す。クラブマッチ前提。 */
export function totalBbFromBbChips(bbChips: number, totalChips = CLUB_MATCH_TOTAL_CHIPS): number {
  return totalChips / bbChips;
}
