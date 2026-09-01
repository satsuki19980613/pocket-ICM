/**
 * カードと 169 ハンドクラス表記。
 *
 * ランクは強い順に index 付け（A=0 が最強, 2=12 が最弱）。
 * ハンドクラス表記は HRC 互換:
 *   - ペア:     "AA".."22"
 *   - スーテッド: "AKs".."32s"（高ランクを先に書く）
 *   - オフスート: "AKo".."32o"
 * 合計 13 + 78 + 78 = 169。
 */

export const RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'] as const;
export type Rank = (typeof RANKS)[number];

export const SUITS = ['s', 'h', 'd', 'c'] as const;
export type Suit = (typeof SUITS)[number];

/** ランク文字 → 強さ index（A=0, 2=12）。不正なら -1。 */
export function rankIndex(r: string): number {
  return (RANKS as readonly string[]).indexOf(r);
}

export type HandClassKind = 'pair' | 's' | 'o';

export interface HandClass {
  /** 高ランク（ペアなら両方同じ） */
  readonly hi: Rank;
  /** 低ランク */
  readonly lo: Rank;
  readonly kind: HandClassKind;
  /** 正規表記（例 "K6s", "AA", "QJo"） */
  readonly label: string;
}

const HAND_CLASS_RE = /^([AKQJT2-9])([AKQJT2-9])(s|o)?$/;

/**
 * ハンドクラス表記をパースする。不正なら null。
 * ペアは 2 文字（"AA"）。非ペアは 3 文字で末尾に s / o。
 * 非ペアは高ランクが先でなければならない（"6Ks" は不正）。
 */
export function parseHandClass(label: string): HandClass | null {
  const m = HAND_CLASS_RE.exec(label);
  if (!m) return null;
  const a = m[1] as Rank;
  const b = m[2] as Rank;
  const suffix = m[3];
  const ia = rankIndex(a);
  const ib = rankIndex(b);
  if (ia < 0 || ib < 0) return null;

  if (a === b) {
    // ペア: suffix があってはならない
    if (suffix) return null;
    return { hi: a, lo: b, kind: 'pair', label: `${a}${b}` };
  }
  // 非ペア: suffix 必須、高ランクが先
  if (!suffix) return null;
  if (ia > ib) return null; // a が b より弱い（index 大）= 順序違反
  return { hi: a, lo: b, kind: suffix as 's' | 'o', label: `${a}${b}${suffix}` };
}

export function isHandClass(label: string): boolean {
  return parseHandClass(label) !== null;
}

/** 169 ハンドクラスをすべて列挙する（決定的順序）。 */
export function allHandClasses(): HandClass[] {
  const out: HandClass[] = [];
  for (let i = 0; i < RANKS.length; i++) {
    for (let j = 0; j < RANKS.length; j++) {
      const hi = RANKS[i]!;
      const lo = RANKS[j]!;
      if (i === j) {
        out.push({ hi, lo, kind: 'pair', label: `${hi}${lo}` });
      } else if (i < j) {
        // i が高ランク（強い）
        out.push({ hi, lo, kind: 's', label: `${hi}${lo}s` });
        out.push({ hi, lo, kind: 'o', label: `${hi}${lo}o` });
      }
    }
  }
  return out;
}

/** 169 クラスのラベル一覧。 */
export function allHandClassLabels(): string[] {
  return allHandClasses().map((h) => h.label);
}

/**
 * ハンドクラスに含まれる具体コンボ数。
 * ペア=6, スーテッド=4, オフスート=12。合計は 1326。
 */
export function comboCount(kind: HandClassKind): number {
  switch (kind) {
    case 'pair':
      return 6;
    case 's':
      return 4;
    case 'o':
      return 12;
  }
}
