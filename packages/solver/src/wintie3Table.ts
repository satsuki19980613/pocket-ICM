/**
 * 3-way オールイン結果テーブルの参照 API（env 非依存コア）。
 *
 * `scripts/gen3wayOutcomeTable.ts` が生成した wintie3-169.u16.bin（169 クラスの
 * ソート済み三つ組ごとに 13 パターン確率 + validCount を格納）をメモリ上に保持し、
 * 任意のプレイヤー順 (x,y,z) に対して 13 パターン確率を返す。
 *
 * 三つ組のソート・並べ替えは wintie3Index.ts（tripleIndex / permuteProbs13）と同じ
 * ロジックだが、ここではホットパス（computeShowdown3Exact の 169×169×169 ループ）用に
 * アロケーション無しで書き直す：
 *   - Array#sort ではなく 3 要素の手書き安定ソート（比較 3 回）で index と perm を求める。
 *   - permuteProbs13（新規 Array を返す）ではなく、呼び出し側が渡した出力バッファに
 *     直接書き込む版を使う。
 */

import { N_CLASSES3, PATTERNS, patternIndexOf, sortedTripleIndex } from './wintie3Index.js';

const N_PATTERNS = PATTERNS.length; // 13
const PROBS_STORED = N_PATTERNS - 1; // 12（13個目 [0,0,0] は 1-sum で復元）
const N_PERMS = 6; // 3 要素の置換は 6 通り（PATTERNS[0..5] が全置換に一致）

/**
 * uint16 → 確率（0..1）の事前計算 LUT（part 2 微最適化）。
 * `lookup`/`dot`/`denseQuad` のホットループは 1 回の呼び出しで最大 12 回この変換を行い、
 * dense sweep（169³ 相当）では合計で数千万回の除算になる。除算 1 回を 65536 要素の
 * Float64Array 引きに置き換えるだけで、値は `i/65535` と bit 一致（LUT 自体を同じ式で
 * 一度だけ計算するため）のまま演算コストだけ下げられる（huTable.ts の float16 LUT 化と同種）。
 */
const PROB_LUT: Float64Array = (() => {
  const t = new Float64Array(65536);
  for (let i = 0; i < 65536; i++) t[i] = i / 65535;
  return t;
})();

/**
 * (c1,c2) → 三つ組 index の O(1) オフセット表（part A）。
 * sortedTripleIndex(c1,c2,c3) = OFFSET2[c1*N+c2] + c3（c1<=c2<=c3 のとき）。
 * モジュール初期化時に 1 度だけ構築（169*169 = 28,561 回の呼び出し、ホットパスの外）。
 * 既存の sortedTripleIndex をそのまま使って埋めるので、算術の重複実装によるバグの
 * リスクがない（呼べば必ず一致する）。
 */
const OFFSET2: Int32Array = (() => {
  const t = new Int32Array(N_CLASSES3 * N_CLASSES3);
  for (let c1 = 0; c1 < N_CLASSES3; c1++) {
    for (let c2 = c1; c2 < N_CLASSES3; c2++) {
      t[c1 * N_CLASSES3 + c2] = sortedTripleIndex(c1, c2, c2) - c2;
    }
  }
  return t;
})();

/**
 * MAP_N_TO_M[permId*13+n] = m: ストレージ順パターン index n（PATTERNS[n], ソート済み
 * スロット順）を、permId に対応する並べ替え（perm = PATTERNS[permId], 0..5 は 3 要素の
 * 全置換）でプレイヤー順に写したときの、プレイヤー順パターン index m。
 * permuteProbsInto と同じ変換ロジックだが、確率ではなく「index → index」の写像だけを
 * 事前計算する（dot() のホットパスでは配列引きだけで済ませるため）。
 *
 * permId の決め方: sortedIndexAndPerm 系のソートネットワークが返す (i0,i1,i2)（ソート済み
 * スロット→元のプレイヤー添字）は常に {0,1,2} の置換になる。PATTERNS の先頭 6 個は
 * ちょうど {0,1,2} の全 6 置換なので、permId = patternIndexOf(i0,i1,i2) がそのまま
 * 0..5 の一意な id になる（値が同じ＝タイでも、添字の置換自体は一意に決まる）。
 */
const MAP_N_TO_M: Int8Array = (() => {
  const t = new Int8Array(N_PERMS * N_PATTERNS);
  const callerPattern = new Int32Array(3);
  for (let permId = 0; permId < N_PERMS; permId++) {
    const perm = PATTERNS[permId]!; // [i0,i1,i2]
    for (let n = 0; n < N_PATTERNS; n++) {
      const pat = PATTERNS[n]!;
      callerPattern[perm[0]!] = pat[0];
      callerPattern[perm[1]!] = pat[1];
      callerPattern[perm[2]!] = pat[2];
      t[permId * N_PATTERNS + n] = patternIndexOf(callerPattern[0]!, callerPattern[1]!, callerPattern[2]!);
    }
  }
  return t;
})();

/**
 * `dot()` に渡す 6×13 の射影行列を、プレイヤー順パターン index n（0..12,
 * outcomeVectors3 が返す並びと同じ）で書かれた 13 要素の重みベクトル T から組み立てる。
 * out[permId*13+n] = T[MAP_N_TO_M[permId*13+n]]。
 *
 * 呼び出しコストは 78 回の配列引きだけ（78 = 6 permId × 13 n）。showdownExact 側は
 * hero パスごとに 1 回（seat 固定）呼べばよく、169×169 のホットループの**外**で完結する。
 */
export function buildDotWeights(T: ArrayLike<number>, out: Float64Array): void {
  if (T.length !== N_PATTERNS) throw new Error(`buildDotWeights: T length must be ${N_PATTERNS}`);
  if (out.length !== N_PERMS * N_PATTERNS) throw new Error(`buildDotWeights: out length must be ${N_PERMS * N_PATTERNS}`);
  for (let permId = 0; permId < N_PERMS; permId++) {
    const row = permId * N_PATTERNS;
    for (let n = 0; n < N_PATTERNS; n++) out[row + n] = T[MAP_N_TO_M[row + n]!]!;
  }
}

/** プレイヤー順 (x,y,z) の 13 パターン確率テーブル参照。 */
export interface WinTie3Table {
  /**
   * プレイヤー順 (x,y,z) の 13 パターン確率を out（長さ 13, 呼び出し前の内容は無視して
   * 全上書き）に書き込み、有効コンボ数（カード衝突のない具体コンボ三つ組の厳密個数,
   * 0..1728）を返す。out[n] は wintie3Index.PATTERNS[n] を**引数の順 (x,y,z)** で解釈した
   * 確率（ストレージのソート済みスロット順ではない）。ホットパス用にアロケーションしない。
   */
  lookup(x: number, y: number, z: number, out: Float64Array): number;

  /**
   * `lookup()` の 13 パターン確率を明示的な出力配列に展開する代わりに、事前に
   * `buildDotWeights()` で作った 6×13 射影行列 U（permId 行 × パターン列, permId は
   * このテーブルが内部で決める並べ替え id）との内積を**生の uint16 行から直接**計算する
   * （中間の確率配列への並べ替えを経由しない, part A）。
   *
   * 戻り値は `validCount × Σ_n prob_n(プレイヤー順 x,y,z) × U[permId][n]`。
   * validCount 自体は `vcOut[0]` に書き込む（呼び出し側が `wsum += w*vcOut[0]` のように
   * 別途使うため。1 回のテーブル参照で両方を取得し、二重引きを避ける）。
   */
  dot(x: number, y: number, z: number, U: Float64Array, vcOut: Int32Array): number;

  /**
   * 単一スイープ（`computeShowdown3Exact` の dense パス）専用: (x,y,z) の行を**一度だけ**
   * 読み（ソート・index 算出・uint16→確率の 12 回の除算を 1 回だけ実行し）、以下の 4 つの
   * 射影を同時に返す。dot() を 3 回・lookup() を 1 回 別々に呼ぶと同じ行のデコードを
   * 4 回繰り返してしまう（169³ 相当の内側ループでは支配的コスト）ため、それを避ける。
   *
   *   - sOut[k] (k=0,1,2) = Σ_n stored[n] × U_k[permId][n]（`dot()` と同じ値, validCount 未乗算）。
   *     U0/U1/U2 はそれぞれ hero0/hero1/hero2 用に `buildDotWeights()` で事前に組んだもの。
   *   - probsOut (長さ13) = プレイヤー順 (x,y,z) に並べ替えた 13 パターン確率
   *     （`lookup()` の出力と同じ値, validCount 未乗算）。
   *   - 戻り値 = validCount（`dot()`/`lookup()` と同じ意味）。
   *
   * 呼び出し側は `w × validCount × sOut[k]` / `w × validCount × probsOut[n]` のように
   * 自分で validCount を掛けて使う（この関数自身は掛けない）。
   */
  denseQuad(
    x: number,
    y: number,
    z: number,
    U0: Float64Array,
    U1: Float64Array,
    U2: Float64Array,
    sOut: Float64Array,
    probsOut: Float64Array,
  ): number;
}

/**
 * 3 要素の手書き安定ソート（比較3回のソーティングネットワーク。Array#sort のアロケーションと
 * 比較コストを避ける）。permOut[slot] = 元の添字（wintie3Index.tripleIndex の perm と同義）。
 * 安定性（値が同じ場合は元の引数順を保つ）は wintie3Index.test 相当のケースで確認済み
 * （小さい方から順に比較・交換するだけなので同値は交換されず順序を保つ）。
 */
function sortedIndexAndPerm(a: number, b: number, c: number, permOut: Int32Array): number {
  let i0 = 0, i1 = 1, i2 = 2;
  let v0 = a, v1 = b, v2 = c;
  if (v0 > v1) {
    const t = v0; v0 = v1; v1 = t;
    const ti = i0; i0 = i1; i1 = ti;
  }
  if (v1 > v2) {
    const t = v1; v1 = v2; v2 = t;
    const ti = i1; i1 = i2; i2 = ti;
  }
  if (v0 > v1) {
    const t = v0; v0 = v1; v1 = t;
    const ti = i0; i0 = i1; i1 = ti;
  }
  permOut[0] = i0;
  permOut[1] = i1;
  permOut[2] = i2;
  return OFFSET2[v0 * N_CLASSES3 + v1]! + v2; // part A: O(1) オフセット表（sortedTripleIndex と等価）
}

/**
 * ストレージ順（ソート済みスロット順）の 13 パターン確率 `stored` を、`perm`
 * （sortedIndexAndPerm が返す並べ替え）で呼び出し側のプレイヤー順に並べ替え、
 * `out`（事前に 0 クリア済みであること）に加算書き込みする。
 * wintie3Index.permuteProbs13 とロジックは同一だが、新規 Array を返さず
 * `callerPatternBuf`（呼び出し側が使い回すスクラッチ, 長さ3）に書きながら計算する。
 */
function permuteProbsInto(
  stored: Float64Array,
  perm: Int32Array,
  callerPatternBuf: Int32Array,
  out: Float64Array,
): void {
  for (let n = 0; n < N_PATTERNS; n++) {
    const pat = PATTERNS[n]!;
    callerPatternBuf[perm[0]!] = pat[0];
    callerPatternBuf[perm[1]!] = pat[1];
    callerPatternBuf[perm[2]!] = pat[2];
    const m = patternIndexOf(callerPatternBuf[0]!, callerPatternBuf[1]!, callerPatternBuf[2]!);
    out[m]! += stored[n]!;
  }
}

/** gen3wayOutcomeTable の meta.json のうち buildWinTie3Table が要る最小フィールド。 */
export interface WinTie3Meta {
  dims: number;
  nTriples: number;
}

/**
 * gen3wayOutcomeTable が出力した u16 バイナリ（三つ組 index 昇順に
 * [12 uint16 = round(prob*65535)][1 uint16 = validCount] を並べたもの）から
 * WinTie3Table を組み立てる。
 */
export function buildWinTie3Table(u16: Uint16Array, meta: WinTie3Meta): WinTie3Table {
  if (meta.dims !== N_CLASSES3) {
    throw new Error(`wintie3: dims mismatch ${meta.dims} != ${N_CLASSES3}`);
  }
  const expectedLen = meta.nTriples * 13;
  if (u16.length !== expectedLen) {
    throw new Error(`wintie3: size mismatch ${u16.length} != ${expectedLen}`);
  }

  // ホットパス用スクラッチ（呼び出しをまたいで使い回す。JS はシングルスレッドかつ
  // lookup は同期・非再入なのでこの共有バッファは安全）。
  const perm = new Int32Array(3);
  const callerPattern = new Int32Array(3);
  const stored = new Float64Array(N_PATTERNS);

  return {
    lookup(x: number, y: number, z: number, out: Float64Array): number {
      if (out.length !== N_PATTERNS) {
        throw new Error(`wintie3 lookup: out length must be ${N_PATTERNS}`);
      }
      const index = sortedIndexAndPerm(x, y, z, perm);
      const base = index * 13;
      let sum = 0;
      for (let n = 0; n < PROBS_STORED; n++) {
        const p = PROB_LUT[u16[base + n]!]!;
        stored[n] = p;
        sum += p;
      }
      stored[PROBS_STORED] = sum < 1 ? 1 - sum : 0;
      const validCount = u16[base + PROBS_STORED]!;
      out.fill(0);
      permuteProbsInto(stored, perm, callerPattern, out);
      return validCount;
    },

    // part A: 生の uint16 行から中間配列を経由せず直接内積を取る（computeShowdown3Exact の
    // hero パス用ホットパス）。sortedIndexAndPerm 相当のソートをここでもインライン展開し、
    // permOut/stored の配列書き込みを一切行わない（3 比較 + 12 乗算のみ）。
    dot(x: number, y: number, z: number, U: Float64Array, vcOut: Int32Array): number {
      let i0 = 0, i1 = 1, i2 = 2;
      let v0 = x, v1 = y, v2 = z;
      if (v0 > v1) {
        const t = v0; v0 = v1; v1 = t;
        const ti = i0; i0 = i1; i1 = ti;
      }
      if (v1 > v2) {
        const t = v1; v1 = v2; v2 = t;
        const ti = i1; i1 = i2; i2 = ti;
      }
      if (v0 > v1) {
        const t = v0; v0 = v1; v1 = t;
        const ti = i0; i0 = i1; i1 = ti;
      }
      const index = OFFSET2[v0 * N_CLASSES3 + v1]! + v2;
      const permId = patternIndexOf(i0, i1, i2);
      const base = index * 13;
      const rowBase = permId * N_PATTERNS;
      let sum = 0;
      let acc = 0;
      for (let n = 0; n < PROBS_STORED; n++) {
        const p = PROB_LUT[u16[base + n]!]!;
        sum += p;
        acc += p * U[rowBase + n]!;
      }
      const p12 = sum < 1 ? 1 - sum : 0;
      acc += p12 * U[rowBase + PROBS_STORED]!;
      const validCount = u16[base + PROBS_STORED]!;
      vcOut[0] = validCount;
      return validCount * acc;
    },

    // part A': dense パス用の単一デコード（sortedIndexAndPerm 相当のソート＋12 回の除算を
    // 1 回だけ行い、hero0/1/2 の 3 射影 + marginal 用のプレイヤー順確率を同時に返す）。
    denseQuad(
      x: number,
      y: number,
      z: number,
      U0: Float64Array,
      U1: Float64Array,
      U2: Float64Array,
      sOut: Float64Array,
      probsOut: Float64Array,
    ): number {
      let i0 = 0, i1 = 1, i2 = 2;
      let v0 = x, v1 = y, v2 = z;
      if (v0 > v1) {
        const t = v0; v0 = v1; v1 = t;
        const ti = i0; i0 = i1; i1 = ti;
      }
      if (v1 > v2) {
        const t = v1; v1 = v2; v2 = t;
        const ti = i1; i1 = i2; i2 = ti;
      }
      if (v0 > v1) {
        const t = v0; v0 = v1; v1 = t;
        const ti = i0; i0 = i1; i1 = ti;
      }
      const index = OFFSET2[v0 * N_CLASSES3 + v1]! + v2;
      const permId = patternIndexOf(i0, i1, i2);
      const base = index * 13;
      const rowBase = permId * N_PATTERNS;

      // 行を一度だけデコード（12 回の除算, dot()/lookup() と同じ数式・同じ丸め順）。
      let sum = 0;
      for (let n = 0; n < PROBS_STORED; n++) {
        const p = PROB_LUT[u16[base + n]!]!;
        stored[n] = p;
        sum += p;
      }
      stored[PROBS_STORED] = sum < 1 ? 1 - sum : 0;
      const validCount = u16[base + PROBS_STORED]!;

      // hero0/1/2 用の 3 射影（dot() と同じ加算順: 前 12 項→13 項目を最後に加算）。
      let acc0 = 0, acc1 = 0, acc2 = 0;
      for (let n = 0; n < PROBS_STORED; n++) {
        const p = stored[n]!;
        acc0 += p * U0[rowBase + n]!;
        acc1 += p * U1[rowBase + n]!;
        acc2 += p * U2[rowBase + n]!;
      }
      const p12 = stored[PROBS_STORED]!;
      acc0 += p12 * U0[rowBase + PROBS_STORED]!;
      acc1 += p12 * U1[rowBase + PROBS_STORED]!;
      acc2 += p12 * U2[rowBase + PROBS_STORED]!;
      sOut[0] = acc0;
      sOut[1] = acc1;
      sOut[2] = acc2;

      // marginal 用: プレイヤー順（x,y,z）に並べ替えた 13 パターン確率（lookup() と同じ値）。
      probsOut.fill(0);
      perm[0] = i0;
      perm[1] = i1;
      perm[2] = i2;
      permuteProbsInto(stored, perm, callerPattern, probsOut);

      return validCount;
    },
  };
}

/** MapWinTie3Table に登録する 1 エントリ（ストレージ順=ソート済みスロット順の確率）。 */
export interface WinTie3Entry {
  /** 長さ 13。PATTERNS[n] に対応する確率（ソート済みスロット順, 合計 1）。 */
  probs13: Float64Array;
  /** 衝突のない具体コンボ三つ組の厳密個数。 */
  valid: number;
}

/**
 * テスト用: 少数の三つ組だけを保持する Map ベースの WinTie3Table
 * （gen3wayOutcomeTable.mcTriple 等で作った値をスポット的に登録して使う）。
 * lookup の契約は buildWinTie3Table と同じ（アロケーション無し）。
 *
 * `computeShowdown3Exact` は hero の等級を**常に 169 通り全部**ループする（hero=フル
 * レンジ規約, 2-way と同じ）ため、レンジが狭いスポットでも「登録していない組み合わせ」を
 * 引きに行く（例: hero 側の狭いテスト範囲外のクラス）。これは呼び出し側にとって想定内
 * （その等級の重みはどうせ 0 になってほしい）なので、未登録の三つ組は**エラーにせず**
 * 確率 0・validCount 0（＝重み 0 として自然に無視される）を返す。
 */
export class MapWinTie3Table implements WinTie3Table {
  private readonly perm = new Int32Array(3);
  private readonly callerPattern = new Int32Array(3);
  /** key = sortedTripleIndex(c1,c2,c3)（ストレージ順の三つ組 index）。 */
  private readonly entries: Map<number, WinTie3Entry>;

  constructor(entries: Map<number, WinTie3Entry>) {
    this.entries = entries;
  }

  /** ソート済み (c1<=c2<=c3) 指定の配列から直接登録する簡便コンストラクタ。 */
  static fromSortedTriples(
    triples: readonly { c1: number; c2: number; c3: number; probs13: Float64Array; valid: number }[],
  ): MapWinTie3Table {
    const m = new Map<number, WinTie3Entry>();
    for (const t of triples) {
      const idx = sortedTripleIndex(t.c1, t.c2, t.c3);
      m.set(idx, { probs13: t.probs13, valid: t.valid });
    }
    return new MapWinTie3Table(m);
  }

  lookup(x: number, y: number, z: number, out: Float64Array): number {
    if (out.length !== N_PATTERNS) {
      throw new Error(`wintie3 lookup: out length must be ${N_PATTERNS}`);
    }
    const index = sortedIndexAndPerm(x, y, z, this.perm);
    const e = this.entries.get(index);
    out.fill(0);
    if (!e) return 0; // 未登録＝重み0として無視（上記コメント参照）。
    permuteProbsInto(e.probs13, this.perm, this.callerPattern, out);
    return e.valid;
  }

  dot(x: number, y: number, z: number, U: Float64Array, vcOut: Int32Array): number {
    let i0 = 0, i1 = 1, i2 = 2;
    let v0 = x, v1 = y, v2 = z;
    if (v0 > v1) {
      const t = v0; v0 = v1; v1 = t;
      const ti = i0; i0 = i1; i1 = ti;
    }
    if (v1 > v2) {
      const t = v1; v1 = v2; v2 = t;
      const ti = i1; i1 = i2; i2 = ti;
    }
    if (v0 > v1) {
      const t = v0; v0 = v1; v1 = t;
      const ti = i0; i0 = i1; i1 = ti;
    }
    const index = OFFSET2[v0 * N_CLASSES3 + v1]! + v2;
    const permId = patternIndexOf(i0, i1, i2);
    const e = this.entries.get(index);
    if (!e) {
      vcOut[0] = 0;
      return 0;
    }
    const rowBase = permId * N_PATTERNS;
    const probs = e.probs13;
    let acc = 0;
    for (let n = 0; n < N_PATTERNS; n++) acc += probs[n]! * U[rowBase + n]!;
    vcOut[0] = e.valid;
    return e.valid * acc;
  }

  denseQuad(
    x: number,
    y: number,
    z: number,
    U0: Float64Array,
    U1: Float64Array,
    U2: Float64Array,
    sOut: Float64Array,
    probsOut: Float64Array,
  ): number {
    let i0 = 0, i1 = 1, i2 = 2;
    let v0 = x, v1 = y, v2 = z;
    if (v0 > v1) {
      const t = v0; v0 = v1; v1 = t;
      const ti = i0; i0 = i1; i1 = ti;
    }
    if (v1 > v2) {
      const t = v1; v1 = v2; v2 = t;
      const ti = i1; i1 = i2; i2 = ti;
    }
    if (v0 > v1) {
      const t = v0; v0 = v1; v1 = t;
      const ti = i0; i0 = i1; i1 = ti;
    }
    const index = OFFSET2[v0 * N_CLASSES3 + v1]! + v2;
    const permId = patternIndexOf(i0, i1, i2);
    const e = this.entries.get(index);
    if (!e) {
      sOut.fill(0);
      probsOut.fill(0);
      return 0;
    }
    const rowBase = permId * N_PATTERNS;
    const probs = e.probs13;
    let acc0 = 0, acc1 = 0, acc2 = 0;
    for (let n = 0; n < N_PATTERNS; n++) {
      const p = probs[n]!;
      acc0 += p * U0[rowBase + n]!;
      acc1 += p * U1[rowBase + n]!;
      acc2 += p * U2[rowBase + n]!;
    }
    sOut[0] = acc0;
    sOut[1] = acc1;
    sOut[2] = acc2;
    probsOut.fill(0);
    this.perm[0] = i0;
    this.perm[1] = i1;
    this.perm[2] = i2;
    permuteProbsInto(probs, this.perm, this.callerPattern, probsOut);
    return e.valid;
  }
}
