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
 * 重要（複数スピード・実測 2026-09-09）: クラブマッチには**複数のブラインド構造（スピード）**が存在する。
 *   - 実機 142308 は SB/BB 100/200・アンティ50 ＝下の公式表（「通常」）レベル1（総 450BB×200=90,000 で保存）。
 *   - 実機 185057 は SB/BB 480/960・アンティ240 ＝**この表に無い別スピード**（総 93.75BB×960=90,000 で保存）。
 * どちらも 90,000 で保存＝いずれも本物のクラブマッチ。よって**単一表に固定スナップしてはいけない**
 * （960 を近い 1100 へ誤スナップすると保存が壊れる）。表にタイト一致しない BB は**読み値をそのまま採用**し、
 * 保存則（90,000÷BB）で全スピードを自動対応する。SB は全構造で BB/2（実測不変）、アンティ≒0.25×BB。
 *
 * 下の CLUB_MATCH_LEVELS は公式「通常」16 レベル（ゲーム内ストラクチャ表・さつき提供 2026-09-09）。
 */

/** クラブマッチ 1 レベル（チップ）。SB は常に BB/2。 */
export interface BlindLevel {
  readonly level: number;
  readonly bb: number;
  readonly sb: number;
  readonly ante: number;
}

/** クラブマッチ開始総チップ（6 人 × 15,000）。1 テーブル保存＝場の総チップは常にこれ。 */
export const CLUB_MATCH_TOTAL_CHIPS = 90000;

/** 解決済みブラインド（チップ）。level=0 は「表に無い別スピード＝読み値採用」。 */
export interface ResolvedBlinds {
  readonly sb: number;
  readonly bb: number;
  readonly ante: number;
  /** 公式「通常」表のレベル番号。表にタイト一致しないスピードは 0。 */
  readonly level: number;
}

/** 公式「通常」表 [BB, ante]（チップ）。SB=BB/2。ゲーム内ストラクチャ表そのまま（さつき提供）。 */
const BB_ANTE: readonly (readonly [bb: number, ante: number])[] = [
  [200, 50], [280, 70], [400, 100], [560, 140], [780, 200], [1100, 280], [1640, 410], [2500, 630],
  [3800, 950], [5700, 1400], [8600, 2200], [13000, 3200], [19600, 4900], [29500, 7400], [44300, 11000],
  [60000, 15000],
];

/** クラブマッチ「通常」のブラインドレベル表（チップ）。他スピードは表を持たず読み値＋保存則で扱う。 */
export const CLUB_MATCH_LEVELS: readonly BlindLevel[] = BB_ANTE.map(([bb, ante], i) => ({
  level: i + 1,
  bb,
  sb: bb / 2,
  ante,
}));

/**
 * 読み取り BB（チップ）を公式「通常」表へ**タイトに**スナップする。相対距離が gate（既定 2%）以内の
 * レベルがあればそれを返す。無ければ null（＝別スピード扱い＝読み値採用）。gate をタイトにするのは、
 * 別スピードの正しい読み（例 960）を近いレベル（1100・12.7%）へ誤スナップして保存を壊さないため。
 *
 * gate は当初 6% だったが、実測で**別スピード 400/800 を表の 780（相対 2.6%）へ誤スナップ**しており
 * （GT: Screenshot_20260901-142955 / -143002）、総チップ保存の理論値が 112.5 → 115.4 とずれて
 * 「2.9bb 不足」に見え、スタックを 2.9bb も書き換えかねない状態だった。2% へ絞ると同フレームは
 * 800 のまま解決され、実チップが保存している GT 8 枚すべてで残差が ±0.10bb 以内に収まる
 * （Android/iPhone とも精度の回帰はゼロ）。表のレベル間隔は ~40% あるので、2% でも
 * 「小さな誤読の補正」という本来の役割は果たせる。
 */
export function snapByBb(bbChips: number, gate = 0.02): BlindLevel | null {
  if (!Number.isFinite(bbChips) || bbChips <= 0) return null;
  let best: BlindLevel | null = null;
  let bestRel = Infinity;
  for (const lv of CLUB_MATCH_LEVELS) {
    const rel = Math.abs(lv.bb - bbChips) / lv.bb;
    if (rel < bestRel) { bestRel = rel; best = lv; }
  }
  return best && bestRel <= gate ? best : null;
}

/**
 * ヘッダの SB/BB/アンティ（チップ）からブラインドを解決する（保存則ベースの主入口）。
 *  - BB が読めない場合は SB×2 で代用（SB=BB/2 の不変を使う）。両方読めなければ null（＝チェック無効）。
 *  - 公式「通常」表に**タイト一致**すればその厳密値（小誤読を補正）。
 *  - 一致しなければ**読み値をそのまま採用**（別スピード）: bb=読み値, sb=bb/2（不変を強制）,
 *    ante=読み値が妥当（0.15〜0.35×bb）ならそれ、外れれば 0.25×bb で近似。level=0。
 * いずれの場合も総 BB は `totalBbFromBbChips(bb)`（=90,000÷bb）で求まり、全スピードを自動対応する。
 */
export function resolveBlindChips(sbChips: number, bbChips: number, anteChips: number, tightGate = 0.02): ResolvedBlinds | null {
  const bbGuess = Number.isFinite(bbChips) && bbChips > 0
    ? bbChips
    : Number.isFinite(sbChips) && sbChips > 0
      ? sbChips * 2
      : NaN;
  if (!Number.isFinite(bbGuess) || bbGuess <= 0) return null;

  const matched = snapByBb(bbGuess, tightGate);
  if (matched) return { sb: matched.sb, bb: matched.bb, ante: matched.ante, level: matched.level };

  // 別スピード: 読み値採用。SB=BB/2 を強制、アンティは妥当域なら読み値・外れれば 0.25×BB。
  const bb = Math.round(bbGuess);
  const sb = Math.round(bb / 2);
  const antePlausible = Number.isFinite(anteChips) && anteChips >= 0.15 * bb && anteChips <= 0.35 * bb;
  const ante = antePlausible ? Math.round(anteChips) : Math.round(0.25 * bb);
  return { sb, bb, ante, level: 0 };
}

/** レベルの BB 換算アンティ（= ante/bb）。クラブマッチは概ね 0.25 だがレベルで微変動。 */
export function anteBbOf(level: BlindLevel): number {
  return level.ante / level.bb;
}

/** 現在の BB（チップ）から場の総 BB（= 総チップ ÷ BB）を返す。クラブマッチ前提。 */
export function totalBbFromBbChips(bbChips: number, totalChips = CLUB_MATCH_TOTAL_CHIPS): number {
  return totalChips / bbChips;
}
