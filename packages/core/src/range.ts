/**
 * レンジ記法パーサ（IMPLEMENTATION_PLAN §4.6）。
 *
 * HRC / PokerStove 互換のレンジ文字列 ⇄ 169 ハンドクラス集合を相互変換する。
 * ハンド集合の照合（HRC 照合ハーネス）とソルバー出力の文字列化に使う。
 *
 * ## 対応する文法（トークンは空白またはカンマ区切り）
 *
 * | 記法 | 意味 | 例 → 展開 |
 * |---|---|---|
 * | `Any two` / `anytwo` / `100%` | 全 169 クラス | — |
 * | ペア単体 | そのペア | `77` → 77 |
 * | ペア+ | そのペアから AA まで | `TT+` → TT JJ QQ KK AA |
 * | スーテッド/オフスート単体 | そのクラス | `T9o` → T9o |
 * | スーテッド/オフスート+ | 高カード固定、キッカーを（高カードの1つ下まで）上げる | `A2s+` → A2s..AKs / `KTo+` → KTo KJo KQo |
 * | ダッシュ範囲 | 端点間を列挙（高カード・スート種が一致すること） | `A5o-A3o` → A5o A4o A3o / `99-66` → 66 77 88 99 |
 * | `Rx` | 高カードが R の非ペア全部（スーテッド＋オフスート） | `Ax` → A2s..AKs, A2o..AKo |
 * | `Rx+` | 高カードが R 以上の非ペア全部 | `Tx+` → 高カード T,J,Q,K,A の非ペア全て |
 *
 * ## 方針
 * - 大文字小文字は無視（`a2s+` も可）。ペアの `+` と非ペアの `+` を区別する。
 * - パースは寛容に。往復（parseRange → formatRange → parseRange）で集合が保存されることを不変条件とする。
 * - `formatRange` は正規化圧縮を行うが、HRC の特定文字列を再現するのではなく
 *   「同じ集合を表す決定的な文字列」を返す（往復閉包が保証されればよい）。
 *
 * 注（実装判断 / draft-2 §4.6 拡張）: §4.6 が列挙するのは最小トークン集合で、
 * 実 HRC 出力は `Rx+` 系・`92s+` 系・ダッシュ範囲を含む。本パーサはそれらを
 * 網羅するよう文法を拡張してある（参照データ `_reference-*.json` を全て展開可能）。
 */

import { RANKS, rankIndex, type Rank } from './cards.js';

/** ペアラベル `RR` を返す。 */
function pairLabel(r: Rank): string {
  return `${r}${r}`;
}

/** 非ペアラベル。hi/lo は強さ（idx 小=強）で正規化する。 */
function nonPairLabel(hiIdx: number, loIdx: number, kind: 's' | 'o'): string {
  return `${RANKS[hiIdx]}${RANKS[loIdx]}${kind}`;
}

/** ペア `RR` を r から AA まで（+ 展開）。 */
function expandPairPlus(rIdx: number): string[] {
  const out: string[] = [];
  for (let i = rIdx; i >= 0; i--) out.push(pairLabel(RANKS[i]!));
  return out;
}

/** ペアのダッシュ範囲 [aIdx, bIdx]（順不同）。 */
function expandPairDash(aIdx: number, bIdx: number): string[] {
  const lo = Math.max(aIdx, bIdx);
  const hi = Math.min(aIdx, bIdx);
  const out: string[] = [];
  for (let i = hi; i <= lo; i++) out.push(pairLabel(RANKS[i]!));
  return out;
}

/**
 * 非ペア + 展開。高カード固定、キッカーを loIdx から「高カードの1つ下」まで強くする。
 * 例 A2s+ → A2s,A3s,...,AKs。
 */
function expandNonPairPlus(hiIdx: number, loIdx: number, kind: 's' | 'o'): string[] {
  const out: string[] = [];
  for (let i = loIdx; i > hiIdx; i--) out.push(nonPairLabel(hiIdx, i, kind));
  return out;
}

/** 非ペアのダッシュ範囲（同一高カード・同一スート種）。キッカー端点間。 */
function expandNonPairDash(
  hiIdx: number,
  aLoIdx: number,
  bLoIdx: number,
  kind: 's' | 'o',
): string[] {
  const lo = Math.max(aLoIdx, bLoIdx); // 弱い方（idx 大）
  const hi = Math.min(aLoIdx, bLoIdx); // 強い方
  const out: string[] = [];
  for (let i = lo; i >= hi; i--) out.push(nonPairLabel(hiIdx, i, kind));
  return out;
}

/** `Rx`（高カード R の非ペア全部、s と o の両方）。 */
function expandXFamily(hiIdx: number): string[] {
  const out: string[] = [];
  for (let i = hiIdx + 1; i < RANKS.length; i++) {
    out.push(nonPairLabel(hiIdx, i, 's'));
    out.push(nonPairLabel(hiIdx, i, 'o'));
  }
  return out;
}

/** `Rx+`（高カード R 以上の非ペア全部）。 */
function expandXFamilyPlus(hiIdx: number): string[] {
  const out: string[] = [];
  for (let h = hiIdx; h >= 0; h--) out.push(...expandXFamily(h));
  return out;
}

const PAIR_RE = /^([akqjt2-9])\1$/i;
const PAIR_PLUS_RE = /^([akqjt2-9])\1\+$/i;
const NONPAIR_RE = /^([akqjt2-9])([akqjt2-9])([so])$/i;
const NONPAIR_PLUS_RE = /^([akqjt2-9])([akqjt2-9])([so])\+$/i;
const X_RE = /^([akqjt2-9])x$/i;
const X_PLUS_RE = /^([akqjt2-9])x\+$/i;

/** 単一の非ペアトークン（`A5o` 等）を [hiIdx, loIdx, kind] に。順序違反や同ランクは例外。 */
function parseNonPairAtom(a: string, b: string, kind: string): [number, number, 's' | 'o'] {
  const ai = rankIndex(a.toUpperCase());
  const bi = rankIndex(b.toUpperCase());
  if (ai < 0 || bi < 0) throw new RangeSyntaxError(`unknown rank in "${a}${b}${kind}"`);
  if (ai === bi) throw new RangeSyntaxError(`non-pair with equal ranks: "${a}${b}${kind}"`);
  if (ai > bi) throw new RangeSyntaxError(`high card must come first: "${a}${b}${kind}"`);
  return [ai, bi, kind.toLowerCase() as 's' | 'o'];
}

export class RangeSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RangeSyntaxError';
  }
}

/** ダッシュ範囲トークンを展開する。 */
function expandDash(left: string, right: string): string[] {
  const lp = PAIR_RE.exec(left);
  const rp = PAIR_RE.exec(right);
  if (lp && rp) {
    return expandPairDash(rankIndex(lp[1]!.toUpperCase()), rankIndex(rp[1]!.toUpperCase()));
  }
  const ln = NONPAIR_RE.exec(left);
  const rn = NONPAIR_RE.exec(right);
  if (ln && rn) {
    const [lhi, llo, lkind] = parseNonPairAtom(ln[1]!, ln[2]!, ln[3]!);
    const [rhi, rlo, rkind] = parseNonPairAtom(rn[1]!, rn[2]!, rn[3]!);
    if (lhi !== rhi || lkind !== rkind) {
      throw new RangeSyntaxError(`dash endpoints must share high card and suitedness: "${left}-${right}"`);
    }
    return expandNonPairDash(lhi, llo, rlo, lkind);
  }
  throw new RangeSyntaxError(`invalid dash range: "${left}-${right}"`);
}

/** 単一トークン（ダッシュ以外）を展開する。 */
function expandToken(tok: string): string[] {
  let m: RegExpExecArray | null;

  if ((m = PAIR_PLUS_RE.exec(tok))) {
    return expandPairPlus(rankIndex(m[1]!.toUpperCase()));
  }
  if ((m = PAIR_RE.exec(tok))) {
    return [pairLabel(RANKS[rankIndex(m[1]!.toUpperCase())]!)];
  }
  if ((m = NONPAIR_PLUS_RE.exec(tok))) {
    const [hi, lo, kind] = parseNonPairAtom(m[1]!, m[2]!, m[3]!);
    return expandNonPairPlus(hi, lo, kind);
  }
  if ((m = NONPAIR_RE.exec(tok))) {
    const [hi, lo, kind] = parseNonPairAtom(m[1]!, m[2]!, m[3]!);
    return [nonPairLabel(hi, lo, kind)];
  }
  if ((m = X_PLUS_RE.exec(tok))) {
    return expandXFamilyPlus(rankIndex(m[1]!.toUpperCase()));
  }
  if ((m = X_RE.exec(tok))) {
    return expandXFamily(rankIndex(m[1]!.toUpperCase()));
  }
  throw new RangeSyntaxError(`unrecognized range token: "${tok}"`);
}

const ALL_TOKEN_RE = /^(any\s*two|anytwo|any2|100%|all)$/i;

/**
 * レンジ文字列を 169 ハンドクラスの集合に展開する。
 * @throws RangeSyntaxError 不正トークン
 */
export function parseRangeToSet(input: string): Set<string> {
  const out = new Set<string>();
  const normalized = input.trim();
  if (normalized === '') return out;

  // "Any two" 系（空白を含む）を先に判定
  if (ALL_TOKEN_RE.test(normalized.replace(/\s+/g, ' '))) {
    for (const r of allLabels()) out.add(r);
    return out;
  }

  const tokens = normalized.split(/[\s,]+/).filter((t) => t.length > 0);
  for (const tok of tokens) {
    if (ALL_TOKEN_RE.test(tok)) {
      for (const r of allLabels()) out.add(r);
      continue;
    }
    if (tok.includes('-')) {
      const [left, right, ...rest] = tok.split('-');
      if (right === undefined || rest.length > 0) {
        throw new RangeSyntaxError(`malformed dash range: "${tok}"`);
      }
      for (const l of expandDash(left!, right)) out.add(l);
      continue;
    }
    for (const l of expandToken(tok)) out.add(l);
  }
  return out;
}

/** parseRangeToSet の配列版（決定的順序 = 169 標準順）。 */
export function parseRange(input: string): string[] {
  const set = parseRangeToSet(input);
  return allLabels().filter((l) => set.has(l));
}

let _allLabelsCache: string[] | null = null;
let _allLabelsIndex: Record<string, number> | null = null;
function allLabels(): string[] {
  if (_allLabelsCache) return _allLabelsCache;
  const out: string[] = [];
  for (let i = 0; i < RANKS.length; i++) {
    for (let j = 0; j < RANKS.length; j++) {
      if (i === j) out.push(`${RANKS[i]}${RANKS[j]}`);
      else if (i < j) {
        out.push(`${RANKS[i]}${RANKS[j]}s`);
        out.push(`${RANKS[i]}${RANKS[j]}o`);
      }
    }
  }
  _allLabelsCache = out;
  _allLabelsIndex = Object.fromEntries(out.map((l, i) => [l, i]));
  return out;
}

/**
 * 集合を正規化圧縮した決定的文字列に変換する。
 * - ペア: AA まで連続する塊は `RR+`、それ以外の塊は `HH-LL`、単体は `RR`
 * - 非ペア: 高カード×スート種ごとに、キッカーの連続塊を
 *   （高カードの1つ下まで届けば）`+`、それ以外は `HiXk-HiYk`、単体はそのまま
 *
 * parseRange(formatRange(S)) === S（往復閉包）を満たす。
 */
export function formatRange(labels: Iterable<string>): string {
  const set = new Set(labels);
  // 妥当性チェック（未知ラベルは弾く）
  if (_allLabelsIndex === null) allLabels();
  for (const l of set) {
    if (_allLabelsIndex![l] === undefined) throw new RangeSyntaxError(`unknown hand class: "${l}"`);
  }

  const parts: string[] = [];

  // --- ペア ---
  // idx 昇順（強→弱）でペアの有無を並べ、連続塊を検出
  const pairPresent: boolean[] = RANKS.map((r) => set.has(pairLabel(r)));
  {
    let i = 0;
    while (i < RANKS.length) {
      if (!pairPresent[i]) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < RANKS.length && pairPresent[j + 1]) j++;
      // 塊 [i..j]（i=強, j=弱）
      if (i === 0) {
        // AA から始まる → 最弱側を + 表記
        if (i === j) parts.push(pairLabel(RANKS[i]!));
        else parts.push(`${pairLabel(RANKS[j]!)}+`);
      } else if (i === j) {
        parts.push(pairLabel(RANKS[i]!));
      } else {
        parts.push(`${pairLabel(RANKS[j]!)}-${pairLabel(RANKS[i]!)}`);
      }
      i = j + 1;
    }
  }

  // --- 非ペア（高カードごと × s/o） ---
  for (let hi = 0; hi < RANKS.length; hi++) {
    for (const kind of ['s', 'o'] as const) {
      // キッカー候補は hi+1..12（idx 昇順 = 強→弱）
      const los: number[] = [];
      for (let lo = hi + 1; lo < RANKS.length; lo++) los.push(lo);
      const present = los.map((lo) => set.has(nonPairLabel(hi, lo, kind)));
      let k = 0;
      while (k < los.length) {
        if (!present[k]) {
          k++;
          continue;
        }
        let m = k;
        while (m + 1 < los.length && present[m + 1]) m++;
        const strongLo = los[k]!; // 塊内で最強のキッカー（idx 小）
        const weakLo = los[m]!; // 最弱のキッカー（idx 大）
        if (strongLo === hi + 1) {
          // 高カードの1つ下まで届く → + 表記（弱端から）
          if (k === m) parts.push(nonPairLabel(hi, weakLo, kind));
          else parts.push(`${nonPairLabel(hi, weakLo, kind)}+`);
        } else if (k === m) {
          parts.push(nonPairLabel(hi, weakLo, kind));
        } else {
          parts.push(`${nonPairLabel(hi, weakLo, kind)}-${nonPairLabel(hi, strongLo, kind)}`);
        }
        k = m + 1;
      }
    }
  }

  return parts.join(' ');
}
