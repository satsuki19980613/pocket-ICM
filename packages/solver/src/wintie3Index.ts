/**
 * 3-way オールイン結果テーブル（gen3wayOutcomeTable）の三つ組インデックス変換。
 *
 * 保存する 818,805 エントリは、169 ハンドクラスの「昇順ソート済み三つ組」
 * (c1<=c2<=c3) の辞書式順序で並ぶ（169*170*171/6 通り = 組合せ with repetition）。
 * 実際の求解ではプレイヤー順のクラス (x,y,z) は任意順で来るので、
 *
 *   1. (x,y,z) をソートしてストレージの index を求める
 *   2. ソートで生じた並べ替え（perm）で、保存されている 13 パターンの確率を
 *      プレイヤー順に戻す
 *
 * という 2 段階変換が要る。本モジュールはその変換だけを提供する（実データの
 * 読み込み・生成は wintie3Loader / scripts/gen3wayOutcomeTable の役目）。
 */

/**
 * 13 種類の弱順位パターン（dense ranking, 0=1位）。
 * [p0,p1,p2] はストレージの「ソート済みスロット 0/1/2」の着順。
 * 同着は同じ値を共有する（例: [0,0,1] は 0,1 番スロットが同着1位、2番が3位）。
 * このリストは 3 要素の置換について閉じている（＝どう並べ替えても必ずこの
 * 13 個のどれかに一致する）ことが permuteProbs13 の正しさの前提。
 */
export const PATTERNS: readonly (readonly [number, number, number])[] = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
  [0, 0, 1],
  [0, 1, 0],
  [1, 0, 0],
  [0, 1, 1],
  [1, 0, 1],
  [1, 1, 0],
  [0, 0, 0],
] as const;

export const N_CLASSES3 = 169;
/** 169*170*171/6 = 818,805（重複組合せ C(169+2,3)）。 */
export const N_TRIPLES3 = (N_CLASSES3 * (N_CLASSES3 + 1) * (N_CLASSES3 + 2)) / 6;

// パターン [p0,p1,p2]（各 0..2）→ PATTERNS の index への逆引き。
// code = p0*9 + p1*3 + p2 （27 通り中 13 個だけ有効）。ホットパスで使うので
// Map ではなく Int8Array で O(1) 引き（gen3wayOutcomeTable の MC ループから直接呼ばれる）。
const PATTERN_CODE_TO_INDEX = new Int8Array(27).fill(-1);
for (let n = 0; n < PATTERNS.length; n++) {
  const [p0, p1, p2] = PATTERNS[n]!;
  PATTERN_CODE_TO_INDEX[p0 * 9 + p1 * 3 + p2] = n;
}

/** 着順 [p0,p1,p2]（各プレイヤーの「自分より強い人数」, 0..2）→ PATTERNS の index。 */
export function patternIndexOf(p0: number, p1: number, p2: number): number {
  const code = p0 * 9 + p1 * 3 + p2;
  const idx = PATTERN_CODE_TO_INDEX[code]!;
  if (idx < 0) throw new Error(`invalid pattern: [${p0},${p1},${p2}]`);
  return idx;
}

// c1 未満のブロック（c1' 固定で c1'<=c2<=c3<=N-1 な三つ組の個数）の累積和。
// blockSize(c1') = m'*(m'+1)/2, m' = N-c1'（c2,c3 の取り得る値の個数）。
const BLOCK_START: readonly number[] = (() => {
  const N = N_CLASSES3;
  const arr = new Array<number>(N + 1);
  arr[0] = 0;
  for (let c1 = 0; c1 < N; c1++) {
    const m = N - c1;
    arr[c1 + 1] = arr[c1]! + (m * (m + 1)) / 2;
  }
  return arr;
})();

/** sum_{c2'=lo}^{hi-1} (N - c2') を閉じた式で計算（等差数列の和）。 */
function rowOffset(c1: number, c2: number): number {
  const n = c2 - c1;
  if (n <= 0) return 0;
  const first = N_CLASSES3 - c1; // c2'=c1 の項
  const last = N_CLASSES3 - c2 + 1; // c2'=c2-1 の項
  return (n * (first + last)) / 2;
}

/**
 * 既にソート済みの (c1<=c2<=c3) から辞書式 index（0..818,804）を求める。
 * 外側から c1 昇順 → c2 昇順（c1..N-1） → c3 昇順（c2..N-1）の辞書式順序。
 */
export function sortedTripleIndex(c1: number, c2: number, c3: number): number {
  if (!(0 <= c1 && c1 <= c2 && c2 <= c3 && c3 < N_CLASSES3)) {
    throw new Error(`sortedTripleIndex: invalid triple (${c1},${c2},${c3})`);
  }
  return BLOCK_START[c1]! + rowOffset(c1, c2) + (c3 - c2);
}

export interface TripleLookup {
  /** 818,805 通り中の一意な index（0 始まり、ソート済み三つ組の辞書式順）。 */
  index: number;
  /**
   * 並べ替え。callerPattern[perm[slot]] = storedPattern[slot] を満たす。
   * つまり perm[slot] は「ストレージのソート済みスロット slot（0=最小クラス側）に
   * 対応する、呼び出し側のプレイヤー添字（0,1,2 のどれか）」。
   * permuteProbs13() に渡して確率をプレイヤー順へ戻す。
   */
  perm: [number, number, number];
}

/**
 * プレイヤー順のクラス (a,b,c) から、ストレージの index と並べ替え perm を求める。
 *
 * 安定ソート（値が同じ場合は元の引数順を保つ）で昇順に並べ替えるので、クラスが
 * 重複していても perm は一意に決まる（どのスロットがどのプレイヤー由来かを追跡できる）。
 */
export function tripleIndex(a: number, b: number, c: number): TripleLookup {
  // [値, 元の添字] のペアを値で安定ソート。
  const pairs: [number, number][] = [
    [a, 0],
    [b, 1],
    [c, 2],
  ];
  pairs.sort((p, q) => p[0]! - q[0]!); // Array#sort は仕様上安定（ES2019+）。
  const sorted0 = pairs[0]![0]!;
  const sorted1 = pairs[1]![0]!;
  const sorted2 = pairs[2]![0]!;
  const perm: [number, number, number] = [pairs[0]![1]!, pairs[1]![1]!, pairs[2]![1]!];
  const index = sortedTripleIndex(sorted0, sorted1, sorted2);
  return { index, perm };
}

/**
 * ストレージ順（ソート済みスロット順）のパターン確率 13 個を、呼び出し側の
 * プレイヤー順に並べ替える。storedProbs13[n] は PATTERNS[n]（スロット順の着順）の確率。
 * PATTERNS が置換について閉じているため、常に一意な行き先が見つかる（例外は投げない）。
 */
export function permuteProbs13(
  storedProbs13: ArrayLike<number>,
  perm: readonly [number, number, number],
): number[] {
  if (storedProbs13.length !== PATTERNS.length) {
    throw new Error(`permuteProbs13: storedProbs13 must have ${PATTERNS.length} entries`);
  }
  const out = new Array<number>(PATTERNS.length).fill(0);
  const callerPattern: [number, number, number] = [0, 0, 0];
  for (let n = 0; n < PATTERNS.length; n++) {
    const stored = PATTERNS[n]!;
    callerPattern[perm[0]] = stored[0];
    callerPattern[perm[1]] = stored[1];
    callerPattern[perm[2]] = stored[2];
    const m = patternIndexOf(callerPattern[0], callerPattern[1], callerPattern[2]);
    out[m]! += storedProbs13[n]!;
  }
  return out;
}
