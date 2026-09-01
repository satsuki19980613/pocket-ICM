/**
 * 7 枚ポーカーハンド評価器（自作・依存ゼロ）。
 *
 * カード id: 0..51。rank = (id >> 2) + 2（2..14, 14=A）。suit = id & 3。
 * eval7 は 7 枚から最強 5 枚役を表す比較可能な整数を返す（大きいほど強い）。
 * 同じ役・同じキッカーなら同じ値（タイ判定に使える）。
 *
 * スコア encoding: category(0..8) を最上位に、キッカー rank(2..14) を 4bit×5 で連結。
 *   category*16^5 + k1*16^4 + k2*16^3 + k3*16^2 + k4*16 + k5
 */

export const CATEGORY = {
  HIGH: 0,
  PAIR: 1,
  TWO_PAIR: 2,
  TRIPS: 3,
  STRAIGHT: 4,
  FLUSH: 5,
  FULL_HOUSE: 6,
  QUADS: 7,
  STRAIGHT_FLUSH: 8,
} as const;

const RANK_CHARS = '23456789TJQKA';
const SUIT_CHARS = 'shdc';

/** rank(2..14), suit(0..3) → card id */
export function makeCard(rank: number, suit: number): number {
  return ((rank - 2) << 2) | suit;
}

export function cardRank(id: number): number {
  return (id >> 2) + 2;
}
export function cardSuit(id: number): number {
  return id & 3;
}

/** "As", "Kd", "Th" などをカード id へ。 */
export function parseCard(s: string): number {
  if (s.length !== 2) throw new Error(`bad card: ${s}`);
  const r = RANK_CHARS.indexOf(s[0]!);
  const su = SUIT_CHARS.indexOf(s[1]!);
  if (r < 0 || su < 0) throw new Error(`bad card: ${s}`);
  return makeCard(r + 2, su);
}

export function cardToString(id: number): string {
  return `${RANK_CHARS[cardRank(id) - 2]}${SUIT_CHARS[cardSuit(id)]}`;
}

function encodeScore(category: number, kickers: ArrayLike<number>): number {
  let score = category;
  for (let i = 0; i < 5; i++) {
    score = score * 16 + (kickers[i] ?? 0);
  }
  return score;
}

/**
 * rank 集合ビットマスク（bit r = rank r が存在, 2..14）から
 * ストレートの最高 rank を返す。無ければ 0。A-2-3-4-5（ホイール）は high=5。
 */
function straightHigh(rankMask: number): number {
  // ホイール用: A(14) があれば擬似的に rank 1 を立てる
  let mask = rankMask;
  if (mask & (1 << 14)) mask |= 1 << 1;
  // 高い方から 5 連続を探す
  for (let hi = 14; hi >= 5; hi--) {
    const need = (1 << hi) | (1 << (hi - 1)) | (1 << (hi - 2)) | (1 << (hi - 3)) | (1 << (hi - 4));
    if ((mask & need) === need) return hi;
  }
  return 0;
}

// ホットパス用の再利用スクラッチ（eval7 は逐次呼び出しのみ。再入不可）。
const _rankCount = new Int8Array(15);
const _suitCountBuf = new Int8Array(4);
const _rankMaskBySuitBuf = new Int32Array(4);
const _kick = new Int8Array(5);

/** mask（bit 2..14）から最高位の rank を返す。無ければ 0。 */
function highBit(mask: number): number {
  for (let r = 14; r >= 2; r--) if (mask & (1 << r)) return r;
  return 0;
}

/**
 * 7 枚評価。cards は長さ 7 のカード id 配列。
 * アロケーションを避けるためモジュールスコープのスクラッチを再利用する
 * （非再入・シングルスレッド前提）。
 */
export function eval7(cards: readonly number[]): number {
  if (cards.length !== 7) throw new Error(`eval7 needs 7 cards, got ${cards.length}`);

  const rankCount = _rankCount;
  rankCount.fill(0);
  let suitCount0 = 0;
  let suitCount1 = 0;
  let suitCount2 = 0;
  let suitCount3 = 0;
  let maskSuit0 = 0;
  let maskSuit1 = 0;
  let maskSuit2 = 0;
  let maskSuit3 = 0;
  let rankMask = 0;

  for (let i = 0; i < 7; i++) {
    const c = cards[i]!;
    const r = (c >> 2) + 2;
    const s = c & 3;
    rankCount[r]!++;
    rankMask |= 1 << r;
    if (s === 0) {
      suitCount0++;
      maskSuit0 |= 1 << r;
    } else if (s === 1) {
      suitCount1++;
      maskSuit1 |= 1 << r;
    } else if (s === 2) {
      suitCount2++;
      maskSuit2 |= 1 << r;
    } else {
      suitCount3++;
      maskSuit3 |= 1 << r;
    }
  }

  const suitCount = _suitCountBuf;
  suitCount[0] = suitCount0;
  suitCount[1] = suitCount1;
  suitCount[2] = suitCount2;
  suitCount[3] = suitCount3;
  const rankMaskBySuit = _rankMaskBySuitBuf;
  rankMaskBySuit[0] = maskSuit0;
  rankMaskBySuit[1] = maskSuit1;
  rankMaskBySuit[2] = maskSuit2;
  rankMaskBySuit[3] = maskSuit3;

  // --- フラッシュ / ストレートフラッシュ ---
  let flushSuit = -1;
  for (let s = 0; s < 4; s++) if (suitCount[s]! >= 5) flushSuit = s;

  if (flushSuit >= 0) {
    const sfHigh = straightHigh(rankMaskBySuit[flushSuit]!);
    if (sfHigh > 0) {
      return encodeScore(CATEGORY.STRAIGHT_FLUSH, [sfHigh]);
    }
  }

  // --- 役の枚数分類（ビットマスク・アロケーションなし） ---
  let maskOf4 = 0;
  let maskOf3 = 0;
  let maskOf2 = 0;
  let tripCount = 0;
  let pairCount = 0;
  for (let r = 14; r >= 2; r--) {
    const cnt = rankCount[r]!;
    if (cnt === 4) maskOf4 |= 1 << r;
    else if (cnt === 3) {
      maskOf3 |= 1 << r;
      tripCount++;
    } else if (cnt === 2) {
      maskOf2 |= 1 << r;
      pairCount++;
    }
  }

  const k = _kick;

  // クワッズ
  if (maskOf4 !== 0) {
    const q = highBit(maskOf4);
    k[0] = q;
    k[1] = highBit(rankMask & ~(1 << q));
    k[2] = 0;
    k[3] = 0;
    k[4] = 0;
    return encodeScore(CATEGORY.QUADS, k);
  }

  // フルハウス（トリップス + ペア、またはトリップス2組）
  if (tripCount >= 1 && (tripCount >= 2 || pairCount >= 1)) {
    const t = highBit(maskOf3);
    const pairRank = tripCount >= 2 ? highBit(maskOf3 & ~(1 << t)) : highBit(maskOf2);
    k[0] = t;
    k[1] = pairRank;
    k[2] = 0;
    k[3] = 0;
    k[4] = 0;
    return encodeScore(CATEGORY.FULL_HOUSE, k);
  }

  // フラッシュ
  if (flushSuit >= 0) {
    const fm = rankMaskBySuit[flushSuit]!;
    let added = 0;
    for (let r = 14; r >= 2 && added < 5; r--) {
      if (fm & (1 << r)) k[added++] = r;
    }
    for (; added < 5; added++) k[added] = 0;
    return encodeScore(CATEGORY.FLUSH, k);
  }

  // ストレート
  const stHigh = straightHigh(rankMask);
  if (stHigh > 0) {
    k[0] = stHigh;
    k[1] = 0;
    k[2] = 0;
    k[3] = 0;
    k[4] = 0;
    return encodeScore(CATEGORY.STRAIGHT, k);
  }

  // トリップス
  if (tripCount >= 1) {
    const t = highBit(maskOf3);
    const rest = rankMask & ~(1 << t);
    const k1 = highBit(rest);
    const k2 = highBit(rest & ~(1 << k1));
    k[0] = t;
    k[1] = k1;
    k[2] = k2;
    k[3] = 0;
    k[4] = 0;
    return encodeScore(CATEGORY.TRIPS, k);
  }

  // ツーペア
  if (pairCount >= 2) {
    const p1 = highBit(maskOf2);
    const p2 = highBit(maskOf2 & ~(1 << p1));
    const kick = highBit(rankMask & ~(1 << p1) & ~(1 << p2));
    k[0] = p1;
    k[1] = p2;
    k[2] = kick;
    k[3] = 0;
    k[4] = 0;
    return encodeScore(CATEGORY.TWO_PAIR, k);
  }

  // ワンペア
  if (pairCount === 1) {
    const p = highBit(maskOf2);
    const rest = rankMask & ~(1 << p);
    const k1 = highBit(rest);
    const k2 = highBit(rest & ~(1 << k1));
    const k3 = highBit(rest & ~(1 << k1) & ~(1 << k2));
    k[0] = p;
    k[1] = k1;
    k[2] = k2;
    k[3] = k3;
    k[4] = 0;
    return encodeScore(CATEGORY.PAIR, k);
  }

  // ハイカード
  let added = 0;
  for (let r = 14; r >= 2 && added < 5; r--) {
    if (rankMask & (1 << r)) k[added++] = r;
  }
  for (; added < 5; added++) k[added] = 0;
  return encodeScore(CATEGORY.HIGH, k);
}

/** スコアから category を取り出す（テスト・デバッグ用）。 */
export function scoreCategory(score: number): number {
  return Math.floor(score / 16 ** 5);
}
