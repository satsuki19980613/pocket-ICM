/**
 * 2 人ショーダウンの**厳密**計算（MC 置き換え, env 非依存コア）。
 *
 * ## なぜ厳密にできるか
 * 2 人のオールインでは、最終スタックは「p0 勝ち / p1 勝ち / 引き分け（スプリット）」の
 * **3 通りだけ**で決まる（どのカードで勝ったかは無関係）。よって ICM は 3 回計算すれば足り、
 * あとは「クラス×クラスの勝ち率・引き分け率」表とレンジの行列積で期待値が閉じた形で出る。
 * 盤面サンプリング（MC）が不要になり、**ノイズ 0・桁違いに高速**。
 *
 * push/fold の到達確率の大半は「押した1人＋コールした1人」の 2 人ショーダウンなので、
 * ここを厳密化するだけで MC ノイズ床の主要因が消える（3 人以上の同時オールインは
 * 頻度が低いので従来どおり MC）。
 *
 * ## カードリムーバル
 * hero がクラス c を持つとき、villain がクラス c' を持てるコンボ数は衝突で減る。
 * その有効コンボ数 `validCombos[c][c']` で条件付き確率を重み付けする（MC の衝突棄却と等価）。
 */

import { icmEquities } from './icm.js';
import { finalStacksFromShowdown } from './sidepot.js';
import { HAND_CLASS_ORDER, handClassToCombos } from './huEquity.js';
import { canonicalHeroCombo } from './huTable.js';
import { PATTERNS } from './wintie3Index.js';
import { buildDotWeights } from './wintie3Table.js';
import type { ShowdownNode } from './showdownMc.js';
import type { ShowdownMcResult } from './showdownJob.js';
import type { WinTie3Table } from './wintie3Table.js';

const N_CLASSES = HAND_CLASS_ORDER.length; // 169
const FULL_RANGE = new Float64Array(N_CLASSES).fill(1);

/** hero クラス i vs villain クラス j の厳密な勝ち率・引き分け率（行優先 dims×dims）。 */
export interface WinTieTable {
  dims: number;
  order: string[];
  win: Float32Array;
  tie: Float32Array;
}

export function buildWinTieTable(order: string[], dims: number, win: Float32Array, tie: Float32Array): WinTieTable {
  if (win.length !== dims * dims || tie.length !== dims * dims) {
    throw new Error(`win/tie table size mismatch: ${win.length}/${tie.length} != ${dims * dims}`);
  }
  return { dims, order, win, tie };
}

/**
 * validCombos[c*169+c'] = hero がクラス c の（代表）コンボを持つとき、
 * villain が取りうるクラス c' のコンボ数（カード衝突を除く）。
 * suit 対称性より hero のどの代表コンボでも同数なので、代表 1 つで数えれば厳密。
 */
let _valid: Int32Array | null = null;
function validCombos(): Int32Array {
  if (_valid) return _valid;
  const v = new Int32Array(N_CLASSES * N_CLASSES);
  const combosOf = HAND_CLASS_ORDER.map((l) => handClassToCombos(l));
  for (let c = 0; c < N_CLASSES; c++) {
    const [h0, h1] = canonicalHeroCombo(HAND_CLASS_ORDER[c]!);
    for (let d = 0; d < N_CLASSES; d++) {
      let n = 0;
      for (const [a, b] of combosOf[d]!) if (a !== h0 && a !== h1 && b !== h0 && b !== h1) n++;
      v[c * N_CLASSES + d] = n;
    }
  }
  _valid = v;
  return v;
}

function nonEmpty(freq: Float64Array): Float64Array {
  let w = 0;
  for (let i = 0; i < N_CLASSES; i++) w += freq[i]!;
  return w > 1e-9 ? freq : FULL_RANGE;
}

/**
 * 全 169 クラスを「レンジ opp に対する HU all-in equity（勝ち + 引き分け/2, カードリムーバル込み）」の
 * 降順に並べたクラス index 列を返す。
 *
 * 3 人以上のショーダウンで overcaller（3 人目以降）の hero パスを層化するとき、評価する候補
 * クラス（上位 K）を選ぶのに使う。OC レンジは構造的にレンジ上端の閾値なので（実測: 常に
 * {AA} ⊆ OC ⊆ {AA,KK,QQ}, docs/BATON_OC.md §2b）、「最も狭い相手レンジに対する勝率」順の
 * 上位だけ評価すれば足りる。
 */
export function rankClassesByEquityVs(opp: Float64Array, table: WinTieTable): Int16Array {
  if (table.dims !== N_CLASSES) throw new Error('win/tie table dims mismatch');
  const valid = validCombos();
  const { win, tie } = table;
  const score = new Float64Array(N_CLASSES);
  for (let c = 0; c < N_CLASSES; c++) {
    let z = 0;
    let s = 0;
    const rowV = c * N_CLASSES;
    for (let d = 0; d < N_CLASSES; d++) {
      const r = opp[d]!;
      if (r <= 0) continue;
      const w = r * valid[rowV + d]!;
      if (w === 0) continue;
      z += w;
      s += w * (win[rowV + d]! + tie[rowV + d]! / 2);
    }
    score[c] = z > 0 ? s / z : 0;
  }
  const idx = Array.from({ length: N_CLASSES }, (_, i) => i);
  idx.sort((a, b) => score[b]! - score[a]! || a - b);
  return Int16Array.from(idx);
}

/** 参加者 2 人のショーダウンで、勝者パターン別の全席 ICM 値ベクトルを作る。 */
function outcomeVectors(node: ShowdownNode): { v0: number[]; v1: number[]; vt: number[] } {
  const n = node.preHandStacks.length;
  const [p0, p1] = node.participants as readonly [number, number];
  const eligible = new Array<boolean>(n).fill(false);
  eligible[p0] = true;
  eligible[p1] = true;
  const val = (sc0: number, sc1: number): number[] => {
    const sc = new Array<number>(n).fill(0);
    sc[p0] = sc0;
    sc[p1] = sc1;
    return icmEquities(finalStacksFromShowdown(node.preHandStacks, node.commits, eligible, sc), node.payouts, node.preHandStacks);
  };
  return { v0: val(0, 1), v1: val(1, 0), vt: val(0, 0) };
}

/**
 * 2 人ショーダウンの pcEq / seatMarginal を**厳密に**計算する。
 * `computeShowdownMc` と同じ契約（pcEq[p] は hero=全169クラス条件, seatMarginal は到達レンジ平均）。
 */
export function computeShowdown2Exact(
  node: ShowdownNode,
  ranges: readonly Float64Array[],
  table: WinTieTable,
): ShowdownMcResult {
  if (node.participants.length !== 2) throw new Error('computeShowdown2Exact requires exactly 2 participants');
  if (ranges.length !== 2) throw new Error('ranges length must equal participants');
  if (table.dims !== N_CLASSES) throw new Error('win/tie table dims mismatch');

  const [p0, p1] = node.participants as readonly [number, number];
  const { v0, v1, vt } = outcomeVectors(node);
  const valid = validCombos();
  const { win, tie } = table;
  const base = [nonEmpty(ranges[0]!), nonEmpty(ranges[1]!)];

  /**
   * hero がクラス c を持つ条件で、相手レンジ oppR に対する (勝ち, 引き分け) 期待確率。
   * heroFirst=true なら表を hero 視点でそのまま引く（win[c][c']）。
   */
  const condWT = (oppR: Float64Array): { W: Float64Array; T: Float64Array } => {
    const W = new Float64Array(N_CLASSES);
    const T = new Float64Array(N_CLASSES);
    for (let c = 0; c < N_CLASSES; c++) {
      let z = 0, sw = 0, st = 0;
      const rowV = c * N_CLASSES;
      for (let d = 0; d < N_CLASSES; d++) {
        const r = oppR[d]!;
        if (r <= 0) continue;
        const w = r * valid[rowV + d]!;
        if (w === 0) continue;
        z += w;
        sw += w * win[rowV + d]!;
        st += w * tie[rowV + d]!;
      }
      if (z > 0) { W[c] = sw / z; T[c] = st / z; }
    }
    return { W, T };
  };

  // pcEq: hero は全169クラスを張るので、相手の到達レンジだけで決まる。
  const a = condWT(base[1]!); // 参加者0 が hero、相手は参加者1
  const b = condWT(base[0]!); // 参加者1 が hero、相手は参加者0
  const pc0 = new Float64Array(N_CLASSES);
  const pc1 = new Float64Array(N_CLASSES);
  for (let c = 0; c < N_CLASSES; c++) {
    const w0 = a.W[c]!, t0 = a.T[c]!;
    pc0[c] = w0 * v0[p0]! + t0 * vt[p0]! + (1 - w0 - t0) * v1[p0]!;
    const w1 = b.W[c]!, t1 = b.T[c]!;
    // 参加者1 が勝つ ＝ v1、負ける ＝ v0
    pc1[c] = w1 * v1[p1]! + t1 * vt[p1]! + (1 - w1 - t1) * v0[p1]!;
  }

  // seatMarginal: 両者の到達レンジで平均した勝ち/引き分け確率（参加者0 視点）。
  const r0 = base[0]!, r1 = base[1]!;
  const comboOf = HAND_CLASS_ORDER.map((l) => handClassToCombos(l).length);
  let Z = 0, SW = 0, ST = 0;
  for (let c = 0; c < N_CLASSES; c++) {
    const rc = r0[c]!;
    if (rc <= 0) continue;
    const hw = rc * comboOf[c]!;
    const rowV = c * N_CLASSES;
    for (let d = 0; d < N_CLASSES; d++) {
      const rd = r1[d]!;
      if (rd <= 0) continue;
      const w = hw * rd * valid[rowV + d]!;
      if (w === 0) continue;
      Z += w;
      SW += w * win[rowV + d]!;
      ST += w * tie[rowV + d]!;
    }
  }
  const Wbar = Z > 0 ? SW / Z : 0;
  const Tbar = Z > 0 ? ST / Z : 0;
  const Lbar = 1 - Wbar - Tbar;
  const nSeats = node.preHandStacks.length;
  const seatMarginal = new Array<number>(nSeats);
  for (let s = 0; s < nSeats; s++) seatMarginal[s] = Wbar * v0[s]! + Tbar * vt[s]! + Lbar * v1[s]!;

  return { pcEq: [pc0, pc1], seatMarginal };
}

// ============================================================================
// 3 人ショーダウンの厳密計算（wintie3 テーブル使用, src/wintie3Table.ts）。
// ============================================================================

const N_PATTERNS3 = PATTERNS.length; // 13

/**
 * 3-way dense ranking（wintie3Index.PATTERNS, 0=1位・同着は同値を共有する弱順位）を、
 * sidepot.ts の `finalStacksFromShowdown` / `distributePots` が要求する
 * **strongerCount**（自分より真に強い手を持つ"人数"）に変換する。
 *
 * dense rank は「自分より強い"値の種類数"」なので、2 人が同着トップで 1 人が最下位の
 * ケース（パターン [0,0,1]）では最下位の dense rank は 1 だが、strongerCount は 2
 * （トップの 2 人**それぞれ**に負けている）。一般式: strongerCount[i] は「自分より小さい
 * dense 値を持つ"人数"の総和」＝ Σ_{v < dense[i]} count(dense値がvの人数)。
 *
 * distributePots は各レイヤで「拠出者かつ eligible の中で strongerCount 最小」を勝者とする
 * だけなので、3人の中の**相対順序と同着関係**さえ正しければ絶対値のギャップ（dense のまま
 * 使った場合の [0,0,2]→[0,0,1] のような差）は側廊（サイドポット）の勝敗判定に影響しない
 * （sidepot.ts 冒頭のコメント: 「部分集合内でも最小 strongerCount = その集合の勝者」）。
 * ただし `finalStacksFromShowdown` に渡す値そのものの意味（"何人に負けているか"）は
 * この変換で初めて正しくなるため、ここで一度だけ変換して 13 パターン分の ICM ベクトルを作る。
 */
function denseToStrongerCount(pattern: readonly [number, number, number]): [number, number, number] {
  const cnt = [0, 0, 0];
  for (const d of pattern) cnt[d]!++;
  const out: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    let s = 0;
    for (let v = 0; v < pattern[i]!; v++) s += cnt[v]!;
    out[i] = s;
  }
  return out;
}

/** PATTERNS と同順の strongerCount 変換済みパターン（モジュール初期化時に 1 度だけ計算）。 */
const STRONGER_COUNT_PATTERNS: readonly (readonly [number, number, number])[] = PATTERNS.map((p) =>
  denseToStrongerCount(p),
);

/**
 * 参加者 3 人のショーダウンで、13 パターン（wintie3Index.PATTERNS と同順、参加者
 * [0]=node.participants[0] 等の並び）別の全席 ICM 値ベクトルを作る。ノードにつき 1 度だけ計算し、
 * hero・クラスのループでは再利用する（13 × 全席分の icmEquities 呼び出しのみ）。
 */
function outcomeVectors3(node: ShowdownNode): number[][] {
  const n = node.preHandStacks.length;
  const [p0, p1, p2] = node.participants as readonly [number, number, number];
  const eligible = new Array<boolean>(n).fill(false);
  eligible[p0] = true;
  eligible[p1] = true;
  eligible[p2] = true;
  const sc = new Array<number>(n).fill(0);
  return STRONGER_COUNT_PATTERNS.map(([s0, s1, s2]) => {
    sc[p0] = s0;
    sc[p1] = s1;
    sc[p2] = s2;
    return icmEquities(finalStacksFromShowdown(node.preHandStacks, node.commits, eligible, sc), node.payouts, node.preHandStacks);
  });
}

/**
 * ε-pruning のしきい値（part B）。fictitious play の平均戦略は重み 0.5/t で減衰するだけで
 * **厳密に 0 にはならない**ため、反復を重ねるほど「到達レンジ」の 169 クラス全部が非ゼロの
 * 微小値を持つようになる（O(1/t)）。プルーニング無しだと 3 人ショーダウンの内側ループが
 * 常に 169³ 相当のフルコストを払うことになり、これが所要時間の支配項になる
 * （ベンチマーク前の実測: 6-player の 1 refresh で ~400M 回のテーブル参照）。
 *
 * ここでは頻度 < 1e-3（クラス全体の重みの 0.1% 未満）のクラスを「到達しない」とみなして
 * 無視する。これは近似だが、影響は無視できる範囲に収まる:
 *   - 落とすクラスの重みはどれも高々 0.1% なので、条件付き期待値（pcEq）への影響は
 *     せいぜい「その周辺クラスの equity 差 × 0.1%」オーダー（≪ 0.01pt）。
 *   - 求解全体の収束目標は「flat-EV 帯」（無差別戦略の EV 差が ~0.005pt 未満で振れる領域）
 *     なので、この程度の摂動は既存の MC ノイズ床・停止しきい値より十分小さい。
 * 実測は test/monotonize.test.ts 相当ではなく本ファイルのテスト（pcEq 差 < 0.002pt）で検証。
 *
 * 3 パス（hero 3 人 + seatMarginal）すべてで同じしきい値を一貫して使う（一部だけ厳密・
 * 一部だけ近似だと整合しない集合平均になるため）。
 */
export const EPS_ARRIVAL = 1e-3;

/** レンジの ε 以上のクラス index 一覧（昇順、part B）。空レンジはあらかじめ nonEmpty() で埋めてから渡すこと。 */
function nonzeroClasses(freq: Float64Array): Int16Array {
  const list: number[] = [];
  for (let c = 0; c < N_CLASSES; c++) if (freq[c]! >= EPS_ARRIVAL) list.push(c);
  return Int16Array.from(list);
}

/**
 * 到達レンジの ε-pruning 後クラス数（nz0,nz1,nz2）から、sparse パス（part A: hero パス 3 回 +
 * seatMarginal 1 回）の想定テーブル参照回数を見積もる。nwaySolver.ts の
 * `exact3LookupEstimate`（exact3Budget 判定用）と `computeShowdown3Exact` の
 * sparse/dense 切替判定が**同じ式**を使うよう、ここに 1 箇所だけ定義して共有する。
 */
export function exact3LookupCost(nz0: number, nz1: number, nz2: number): number {
  return N_CLASSES * nz1 * nz2 + N_CLASSES * nz0 * nz2 + N_CLASSES * nz0 * nz1 + nz0 * nz1 * nz2;
}

/**
 * dense パス（single-sweep）に切り替えるしきい値（sparse 想定コストがこれを超えたら dense）。
 * dense パスは到達レンジの広さに関わらず常に 169³ ≈ 483万回のテーブル行アクセスが上限
 * （マスクで一部スキップ）なので、sparse の見積りがこれを大きく超える場合（到達レンジが
 * 広い＝ε-pruning があまり効いていない集合）は dense の方が「行を 1 回だけ読んで 4 つの
 * 累積器に同時投影する」ぶん実コストが小さくなる。実測（_bench3exact.ts）に基づく既定値。
 */
export const DENSE_SWEEP_THRESHOLD = 1_000_000;

/**
 * 3 人ショーダウンの pcEq / seatMarginal を**厳密に**計算する（wintie3 テーブル使用）。
 * `computeShowdownMc` / `computeShowdown2Exact` と同じ契約（pcEq[p] は 169-vector,
 * hero=p が全 169 クラス条件・他の 2 人は到達レンジ, seatMarginal は 3 人とも到達レンジで平均）。
 *
 * ## カードリムーバル
 * wintie3 テーブルの `validCount(c1,c2,c3)` は「3 クラスすべての具体コンボから、カード衝突の
 * ない三つ組を全列挙した厳密個数」（gen3wayOutcomeTable.buildValidCombos 参照 = 最大
 * 12×12×12=1728 通りの全チェック、MC ではなく厳密）。2-way の `validCombos`（hero 側は
 * canonicalHeroCombo の代表 1 コンボだけで数える近似）と異なり、**3 クラス全員分の実コンボを
 * 数え上げ済み**なので、2-way の seatMarginal 計算にある「hero 側 comboOf[c] 補正」に相当する
 * 追加の重みは不要（掛けると二重カウントになる）。したがって重みは常に
 * `(他2レンジの頻度の積) × validCount` のみで良い（本関数のホットループの根拠）。
 *
 * ## 実装（part A: `WinTie3Table.dot` によるアロケーション・置換コスト対策）
 * `w × Σ_n P_n × v_n[seat]` を素直に三重ループの内側で「13 パターンに permute → 13 回の
 * 乗算」として計算すると、置換（並べ替え）自体のコスト（パターン index の再計算）が
 * O(169³) の内側で支配的になる。hero パスでは seat（=hero の相手2人ではなく hero 自身の
 * 席）が固定なので、射影先ベクトル `T[n] = v_n[seatH]`（13 要素）は hero クラス c に依らず
 * 1 度だけ決まる。そこで `buildDotWeights(T, U)` で 6 permId 分の射影行列 U（6×13）を
 * **h ループの外**で 1 回だけ組み立て、内側のホットループでは `table.dot(x,y,z,U,vcOut)`
 * だけを呼ぶ（生の uint16 行から直接 12 回の乗算＋和を取るだけで、中間の 13 要素確率配列
 * への並べ替えを一切経由しない）。`dot()` は `validCount × Σ_n P_n × U[permId][n]` を
 * 直接返し、`validCount` 自体は `vcOut[0]` に書かれる（1 回のテーブル参照で両方取得、
 * 二重引きを避ける）。
 *
 * ## part B: ε-pruning
 * 他 2 人の到達レンジは `nonzeroClasses`（頻度 ≥ `EPS_ARRIVAL` のクラスのみ）で絞り込む。
 * FP 平均戦略は 0 に厳密収束しない（1/t で減衰するだけ）ため、無限定にループすると
 * 169² 相当の内側ループが常にフルサイズになる。ドキュメントは `EPS_ARRIVAL` 定義を参照。
 */
export function computeShowdown3Exact(
  node: ShowdownNode,
  ranges: readonly Float64Array[],
  table: WinTie3Table,
): ShowdownMcResult {
  if (node.participants.length !== 3) throw new Error('computeShowdown3Exact requires exactly 3 participants');
  if (ranges.length !== 3) throw new Error('ranges length must equal participants');

  const outcomeVecs = outcomeVectors3(node); // 13 個、各 nSeats
  const base = [nonEmpty(ranges[0]!), nonEmpty(ranges[1]!), nonEmpty(ranges[2]!)];
  const nz = [nonzeroClasses(base[0]!), nonzeroClasses(base[1]!), nonzeroClasses(base[2]!)];

  const cost = exact3LookupCost(nz[0]!.length, nz[1]!.length, nz[2]!.length);
  if (cost > DENSE_SWEEP_THRESHOLD) {
    return computeShowdown3ExactDense(node, outcomeVecs, base as [Float64Array, Float64Array, Float64Array], nz as [Int16Array, Int16Array, Int16Array], table);
  }
  return computeShowdown3ExactSparse(node, outcomeVecs, base as [Float64Array, Float64Array, Float64Array], nz as [Int16Array, Int16Array, Int16Array], table);
}

/**
 * テスト専用: `computeShowdown3Exact` と同じ公開シグネチャで、常に sparse パスを使って計算する
 * （dense パスとの数値一致を検証するため。しきい値によらず強制的に sparse を通す）。
 */
export function computeShowdown3ExactForceSparse(
  node: ShowdownNode,
  ranges: readonly Float64Array[],
  table: WinTie3Table,
): ShowdownMcResult {
  const outcomeVecs = outcomeVectors3(node);
  const base = [nonEmpty(ranges[0]!), nonEmpty(ranges[1]!), nonEmpty(ranges[2]!)];
  const nz = [nonzeroClasses(base[0]!), nonzeroClasses(base[1]!), nonzeroClasses(base[2]!)];
  return computeShowdown3ExactSparse(node, outcomeVecs, base as [Float64Array, Float64Array, Float64Array], nz as [Int16Array, Int16Array, Int16Array], table);
}

/**
 * テスト専用: `computeShowdown3Exact` と同じ公開シグネチャで、常に dense パス（single-sweep）
 * を使って計算する（sparse パスとの数値一致を検証するため）。
 */
export function computeShowdown3ExactForceDense(
  node: ShowdownNode,
  ranges: readonly Float64Array[],
  table: WinTie3Table,
): ShowdownMcResult {
  const outcomeVecs = outcomeVectors3(node);
  const base = [nonEmpty(ranges[0]!), nonEmpty(ranges[1]!), nonEmpty(ranges[2]!)];
  const nz = [nonzeroClasses(base[0]!), nonzeroClasses(base[1]!), nonzeroClasses(base[2]!)];
  return computeShowdown3ExactDense(node, outcomeVecs, base as [Float64Array, Float64Array, Float64Array], nz as [Int16Array, Int16Array, Int16Array], table);
}

/**
 * sparse パス（従来の part A/B 実装）。到達レンジの ε-pruning 後クラス数が小さい（狭い）
 * 集合向け: hero パスごとに他 2 人の非ゼロクラスだけを回す（`table.dot()` ホットパス）。
 */
function computeShowdown3ExactSparse(
  node: ShowdownNode,
  outcomeVecs: number[][],
  base: [Float64Array, Float64Array, Float64Array],
  nz: [Int16Array, Int16Array, Int16Array],
  table: WinTie3Table,
): ShowdownMcResult {
  const participants = node.participants as readonly [number, number, number];

  const T = new Float64Array(N_PATTERNS3); // seatH 固定の射影先（h ループの各回で書き換えて使い回す）
  const U = new Float64Array(6 * N_PATTERNS3); // buildDotWeights の出力（permId 行 × 13 パターン列）
  const vcOut = new Int32Array(1);
  const pcEq: Float64Array[] = [new Float64Array(N_CLASSES), new Float64Array(N_CLASSES), new Float64Array(N_CLASSES)];

  // pcEq: hero=h は全 169 クラスを張る（他 2 人の頻度×validCount で重み付け）。
  for (let h = 0; h < 3; h++) {
    const seatH = participants[h]!;
    const eqH = pcEq[h]!;
    for (let n = 0; n < N_PATTERNS3; n++) T[n] = outcomeVecs[n]![seatH]!;
    buildDotWeights(T, U);
    for (let c = 0; c < N_CLASSES; c++) {
      let s = 0;
      let wsum = 0;
      if (h === 0) {
        const nzB = nz[1]!, nzC = nz[2]!, rB = base[1]!, rC = base[2]!;
        for (let ib = 0; ib < nzB.length; ib++) {
          const cb = nzB[ib]!;
          const wb = rB[cb]!;
          for (let ic = 0; ic < nzC.length; ic++) {
            const cc = nzC[ic]!;
            const dotVal = table.dot(c, cb, cc, U, vcOut);
            const validCount = vcOut[0]!;
            if (validCount === 0) continue;
            const w = wb * rC[cc]!;
            wsum += w * validCount;
            s += w * dotVal;
          }
        }
      } else if (h === 1) {
        const nzA = nz[0]!, nzC = nz[2]!, rA = base[0]!, rC = base[2]!;
        for (let ia = 0; ia < nzA.length; ia++) {
          const ca = nzA[ia]!;
          const wa = rA[ca]!;
          for (let ic = 0; ic < nzC.length; ic++) {
            const cc = nzC[ic]!;
            const dotVal = table.dot(ca, c, cc, U, vcOut);
            const validCount = vcOut[0]!;
            if (validCount === 0) continue;
            const w = wa * rC[cc]!;
            wsum += w * validCount;
            s += w * dotVal;
          }
        }
      } else {
        const nzA = nz[0]!, nzB = nz[1]!, rA = base[0]!, rB = base[1]!;
        for (let ia = 0; ia < nzA.length; ia++) {
          const ca = nzA[ia]!;
          const wa = rA[ca]!;
          for (let ib = 0; ib < nzB.length; ib++) {
            const cb = nzB[ib]!;
            const dotVal = table.dot(ca, cb, c, U, vcOut);
            const validCount = vcOut[0]!;
            if (validCount === 0) continue;
            const w = wa * rB[cb]!;
            wsum += w * validCount;
            s += w * dotVal;
          }
        }
      }
      if (wsum > 0) {
        eqH[c] = s / wsum;
      } else {
        eqH[c] = 0;
      }
    }
  }

  // seatMarginal: 3 人とも到達レンジで平均（169³ 相当ではなく非ゼロクラスの直積のみ）。
  // ここは 1 ノードにつき 1 回しか通らない（hero パスのように ×3 されない）ので、
  // part A の dot() 最適化は適用せず素直な 13-vector 累積のままにする（仕様どおり）。
  const nSeats = node.preHandStacks.length;
  const nz0 = nz[0]!, nz1 = nz[1]!, nz2 = nz[2]!;
  const r0 = base[0]!, r1 = base[1]!, r2 = base[2]!;
  const probsBuf = new Float64Array(N_PATTERNS3);
  const pnMarg = new Float64Array(N_PATTERNS3);
  let Z = 0;
  for (let i0 = 0; i0 < nz0.length; i0++) {
    const c0 = nz0[i0]!;
    const w0 = r0[c0]!;
    for (let i1 = 0; i1 < nz1.length; i1++) {
      const c1 = nz1[i1]!;
      const w01 = w0 * r1[c1]!;
      for (let i2 = 0; i2 < nz2.length; i2++) {
        const c2 = nz2[i2]!;
        const validCount = table.lookup(c0, c1, c2, probsBuf);
        const w = w01 * r2[c2]! * validCount;
        if (w === 0) continue;
        Z += w;
        for (let n = 0; n < N_PATTERNS3; n++) pnMarg[n]! += w * probsBuf[n]!;
      }
    }
  }
  const seatMarginal = new Array<number>(nSeats).fill(0);
  if (Z > 0) {
    for (let n = 0; n < N_PATTERNS3; n++) {
      const p = pnMarg[n]! / Z;
      if (p === 0) continue;
      const vec = outcomeVecs[n]!;
      for (let s = 0; s < nSeats; s++) seatMarginal[s]! += p * vec[s]!;
    }
  }

  return { pcEq, seatMarginal };
}

/**
 * dense パス（single-sweep）。sparse パスの想定コストが `DENSE_SWEEP_THRESHOLD` を超える
 * （＝ ε-pruning 後もなお到達レンジが広い）集合向け。169×169×169 を**一度だけ**舐め、
 * 各三つ組 (a,b,c) で `table.denseQuad()` を 1 回呼んで行を 1 回だけデコードし、
 * hero0/hero1/hero2/seatMarginal の**最大 4 つ**の累積器へ同時に投影する
 * （sparse パスのように「同じ行を最大 4 回（hero 3 回 + marginal 1 回）別々にデコード
 * し直す」のを避ける）。
 *
 * ## 正しさ
 * sparse パスと数式は同一（重み・validCount・射影の掛け方は全て一致）。浮動小数の加算順序
 * だけが異なりうる（sparse は「他2人の非ゼロクラスの直積」を hero パスごとに独立に舐めるが、
 * dense は「全 169³ の直積を 1 回だけ」舐めて条件分岐で振り分ける）ため、結果は bit 一致
 * ではなく数値誤差（1e-12 未満）の範囲で一致する（test/showdown3Exact.test.ts で検証）。
 *
 * ## マスクによる枝刈り
 * a（hero0 の全クラス）・b（hero1 の全クラス）・c（hero2 の全クラス）はそれぞれ常に 169
 * 通り舐める（hero は常に全レンジを張る規約）が、各三つ組でどの累積器が必要かは
 * 他 2 人の到達レンジ（in0/in1/in2, ε-pruning 済みマスク）で決まる:
 *   - hero0 用（s0[a] に投影）: b∈nz1 かつ c∈nz2 のときだけ
 *   - hero1 用（s1[b] に投影）: a∈nz0 かつ c∈nz2 のときだけ
 *   - hero2 用（s2[c] に投影）: a∈nz0 かつ b∈nz1 のときだけ
 *   - marginal 用: a∈nz0 かつ b∈nz1 かつ c∈nz2 のときだけ（hero2 条件を包含）
 * a,b どちらも他 2 人のレンジに入っていなければ（!in0[a] && !in1[b]）、その (a,b) に対する
 * c ループはどの累積器にも寄与しないので b ループの時点でまるごと打ち切る。
 */
function computeShowdown3ExactDense(
  node: ShowdownNode,
  outcomeVecs: number[][],
  base: [Float64Array, Float64Array, Float64Array],
  nz: [Int16Array, Int16Array, Int16Array],
  table: WinTie3Table,
): ShowdownMcResult {
  // item1 (worker 分割): 単一チャンク [0,N_CLASSES) で computeShowdown3ExactDenseChunkImpl を
  // 呼び、mergeShowdown3ExactDenseChunks で正規化する。チャンクが 1 個だけなら
  // 合算はどの累積器も「自分自身 + 0」で加算順序が変わらないため、旧実装（単一スイープを
  // そのままここに書いていた版）と bit 一致する（worker 分割時に使う関数と全く同じ式を
  // 通るので数値が食い違いようがない、という意図）。
  const chunk = computeShowdown3ExactDenseChunkImpl(node, outcomeVecs, base, nz, table, 0, N_CLASSES);
  return mergeShowdown3ExactDenseChunks(node, [chunk]);
}

/**
 * dense sweep 1 チャンク分の生の部分和（正規化＝除算前）。worker が返す最小ペイロード
 * （item3）: s0/wsum0 はこのチャンクが担当する 'a'（hero0 のクラス, [aLo,aHi)）の
 * 完結した合計（他チャンクの分と混ざらない・マージ時は位置に書き込むだけでよい）。
 * s1/wsum1・s2/wsum2・Z・pnMarg は 'a' 全体で決まる部分和なので、チャンク間で**加算**
 * してから正規化する（`mergeShowdown3ExactDenseChunks` 参照）。
 */
export interface Exact3DenseChunk {
  aLo: number;
  aHi: number;
  /** 長さ aHi-aLo（このチャンクの 'a' 範囲ぶんだけ, hero0 用）。 */
  s0: Float64Array;
  wsum0: Float64Array;
  /** 長さ N_CLASSES（hero1 用の部分和、他チャンクと合算が必要）。 */
  s1: Float64Array;
  wsum1: Float64Array;
  /** 長さ N_CLASSES（hero2 用の部分和、他チャンクと合算が必要）。 */
  s2: Float64Array;
  wsum2: Float64Array;
  /** seatMarginal 用の部分和（他チャンクと合算が必要）。 */
  Z: number;
  pnMarg: Float64Array;
}

/**
 * item1: dense sweep の外側ループ（hero0 のクラス 'a', 0..168）を [aLo,aHi) に限定して
 * 実行し、正規化前の生の部分和を返す（`computeShowdown3ExactDense` と数式・ループ構造は
 * 完全に同一で、範囲だけを制限している）。'a' は他のどの累積器にも跨がって使われない
 * （s0/wsum0 は 'a' 単位で完結、s1/s2/marginal は 'a' 全体で決まる部分和）ため、
 * [0,N_CLASSES) を K 個の [aLo,aHi) に分割して並列に呼び、`mergeShowdown3ExactDenseChunks`
 * で合算すれば、K=1 のときの合算は「自分自身+0」で丸めが一切入らず旧実装と bit 一致し、
 * K>1 でも実数演算としては数学的に同じ和を加算順序だけ変えて計算するだけ（浮動小数の
 * 丸め誤差は 1e-12 未満のオーダーで、既存の dense/sparse 比較テストと同じ許容が使える）。
 */
function computeShowdown3ExactDenseChunkImpl(
  node: ShowdownNode,
  outcomeVecs: number[][],
  base: [Float64Array, Float64Array, Float64Array],
  nz: [Int16Array, Int16Array, Int16Array],
  table: WinTie3Table,
  aLo: number,
  aHi: number,
): Exact3DenseChunk {
  const participants = node.participants as readonly [number, number, number];

  const buildMask = (list: Int16Array): Uint8Array => {
    const m = new Uint8Array(N_CLASSES);
    for (let i = 0; i < list.length; i++) m[list[i]!] = 1;
    return m;
  };
  const in0 = buildMask(nz[0]);
  const in1 = buildMask(nz[1]);
  const in2 = buildMask(nz[2]);
  const r0 = base[0], r1 = base[1], r2 = base[2];

  // hero0/1/2 用の射影行列（buildDotWeights, ループの外＝169³ ループの外で1度だけ）。
  const U0 = new Float64Array(6 * N_PATTERNS3);
  const U1 = new Float64Array(6 * N_PATTERNS3);
  const U2 = new Float64Array(6 * N_PATTERNS3);
  {
    const T = new Float64Array(N_PATTERNS3);
    for (let n = 0; n < N_PATTERNS3; n++) T[n] = outcomeVecs[n]![participants[0]]!;
    buildDotWeights(T, U0);
    for (let n = 0; n < N_PATTERNS3; n++) T[n] = outcomeVecs[n]![participants[1]]!;
    buildDotWeights(T, U1);
    for (let n = 0; n < N_PATTERNS3; n++) T[n] = outcomeVecs[n]![participants[2]]!;
    buildDotWeights(T, U2);
  }

  const chunkLen = aHi - aLo;
  const s0 = new Float64Array(chunkLen), wsum0 = new Float64Array(chunkLen);
  const s1 = new Float64Array(N_CLASSES), wsum1 = new Float64Array(N_CLASSES);
  const s2 = new Float64Array(N_CLASSES), wsum2 = new Float64Array(N_CLASSES);
  let Z = 0;
  const pnMarg = new Float64Array(N_PATTERNS3);

  const sTriple = new Float64Array(3);
  const probsOut = new Float64Array(N_PATTERNS3);

  for (let a = aLo; a < aHi; a++) {
    const aIn0 = in0[a]! !== 0;
    const ra = r0[a]!;
    const ai = a - aLo;
    for (let b = 0; b < N_CLASSES; b++) {
      const bIn1 = in1[b]! !== 0;
      if (!aIn0 && !bIn1) continue; // どの累積器にも寄与しない（c によらず）
      const rb = r1[b]!;
      for (let c = 0; c < N_CLASSES; c++) {
        const cIn2 = in2[c]! !== 0;
        const needH0 = bIn1 && cIn2;
        const needH1 = aIn0 && cIn2;
        const needH2 = aIn0 && bIn1;
        if (!needH0 && !needH1 && !needH2) continue;
        const vc = table.denseQuad(a, b, c, U0, U1, U2, sTriple, probsOut);
        if (vc === 0) continue;
        const rc = r2[c]!;
        if (needH0) {
          const w = rb * rc;
          wsum0[ai]! += w * vc;
          s0[ai]! += w * vc * sTriple[0]!;
        }
        if (needH1) {
          const w = ra * rc;
          wsum1[b]! += w * vc;
          s1[b]! += w * vc * sTriple[1]!;
        }
        if (needH2) {
          const w = ra * rb;
          wsum2[c]! += w * vc;
          s2[c]! += w * vc * sTriple[2]!;
        }
        if (cIn2 && needH2) {
          // needH2 (a∈nz0 && b∈nz1) かつ c∈nz2 ＝ 3 人とも到達レンジ内（marginal 条件）。
          const w = ra * rb * rc;
          Z += w * vc;
          for (let n = 0; n < N_PATTERNS3; n++) pnMarg[n]! += w * vc * probsOut[n]!;
        }
      }
    }
  }

  return { aLo, aHi, s0, wsum0, s1, wsum1, s2, wsum2, Z, pnMarg };
}

/**
 * item1: worker から `node`/`ranges`/`table` だけで 1 チャンクを計算できる公開 API。
 * outcomeVecs/base/nz をここで（そのチャンクのためだけに）再計算するが、これは O(169) +
 * icmEquities 13 回程度で 169³ 相当のスイープに比べれば無視できるコスト。
 */
export function computeShowdown3ExactDenseChunk(
  node: ShowdownNode,
  ranges: readonly Float64Array[],
  table: WinTie3Table,
  aLo: number,
  aHi: number,
): Exact3DenseChunk {
  const outcomeVecs = outcomeVectors3(node);
  const base = [nonEmpty(ranges[0]!), nonEmpty(ranges[1]!), nonEmpty(ranges[2]!)] as [Float64Array, Float64Array, Float64Array];
  const nz = [nonzeroClasses(base[0]), nonzeroClasses(base[1]), nonzeroClasses(base[2])] as [Int16Array, Int16Array, Int16Array];
  return computeShowdown3ExactDenseChunkImpl(node, outcomeVecs, base, nz, table, aLo, aHi);
}

/**
 * item1: `computeShowdown3ExactDenseChunk` が返した複数チャンクを合算し、
 * `computeShowdown3Exact` と同じ契約の `ShowdownMcResult` に正規化する
 * （nwaySolver の refresh から呼ぶ想定・worker 側では呼ばない）。
 */
export function mergeShowdown3ExactDenseChunks(node: ShowdownNode, chunks: readonly Exact3DenseChunk[]): ShowdownMcResult {
  const outcomeVecs = outcomeVectors3(node);
  const nSeats = node.preHandStacks.length;

  const pc0 = new Float64Array(N_CLASSES);
  const s1Sum = new Float64Array(N_CLASSES), w1Sum = new Float64Array(N_CLASSES);
  const s2Sum = new Float64Array(N_CLASSES), w2Sum = new Float64Array(N_CLASSES);
  let Z = 0;
  const pnMarg = new Float64Array(N_PATTERNS3);

  for (const ch of chunks) {
    for (let i = 0; i < ch.aHi - ch.aLo; i++) {
      const a = ch.aLo + i;
      pc0[a] = ch.wsum0[i]! > 0 ? ch.s0[i]! / ch.wsum0[i]! : 0;
    }
    for (let b = 0; b < N_CLASSES; b++) {
      w1Sum[b]! += ch.wsum1[b]!;
      s1Sum[b]! += ch.s1[b]!;
    }
    for (let c = 0; c < N_CLASSES; c++) {
      w2Sum[c]! += ch.wsum2[c]!;
      s2Sum[c]! += ch.s2[c]!;
    }
    Z += ch.Z;
    for (let n = 0; n < N_PATTERNS3; n++) pnMarg[n]! += ch.pnMarg[n]!;
  }

  const pc1 = new Float64Array(N_CLASSES);
  const pc2 = new Float64Array(N_CLASSES);
  for (let b = 0; b < N_CLASSES; b++) pc1[b] = w1Sum[b]! > 0 ? s1Sum[b]! / w1Sum[b]! : 0;
  for (let c = 0; c < N_CLASSES; c++) pc2[c] = w2Sum[c]! > 0 ? s2Sum[c]! / w2Sum[c]! : 0;

  const seatMarginal = new Array<number>(nSeats).fill(0);
  if (Z > 0) {
    for (let n = 0; n < N_PATTERNS3; n++) {
      const p = pnMarg[n]! / Z;
      if (p === 0) continue;
      const vec = outcomeVecs[n]!;
      for (let s = 0; s < nSeats; s++) seatMarginal[s]! += p * vec[s]!;
    }
  }

  return { pcEq: [pc0, pc1, pc2], seatMarginal };
}
