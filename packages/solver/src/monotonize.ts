/**
 * 押し引きレンジの単調性補正（env 非依存コア）。
 *
 * ## 問題
 * push/fold の純戦略は「EV差(push−fold) ≥ 0 ⇔ プッシュ」のゼロ交差で決めるが、境界付近の
 * ハンドは EV がほぼ 0（無差別）。ノードレベル MC の有限サンプル・ノイズで、隣り合う同格の
 * ハンドが「たまたまプラス／マイナス」に転び、チャートが市松状（swiss-cheese）に穴あきになる。
 * 例: K7s は押すのに K8s は降り、T4s 押しなのに T5s 降り——**弱い手を押して強い手を降りる**、
 * 本来のナッシュ均衡ではあり得ない矛盾。実プレイヤーには「常識外」に見える（さつき指摘 2026-09-06）。
 *
 * ## 解
 * ハンドの**支配関係（strong ≽ weak: 強い手は弱い手の上位互換）**に沿って EV を単調化
 * （重み付き isotonic 回帰 = block-pooling）してから 0 で線引きする。単調化後は「ある手を
 * 押すなら、それを支配する手は必ず押す」が保証され、穴あきが消えて連続レンジになる。
 *
 * ## EV 中立
 * 動くのは支配関係に違反した ≈0 の境界ハンドのみ（隣接違反をプールして平均）。明確な +EV/−EV
 * ハンドは |EV| が大きく違反しないのでプールされず不変。よって EV への影響は無差別帯以内で中立。
 * HRC のチャートが常に連続なのも同種の平滑化による（[[solve-speed-findings]] 参照）。
 *
 * ## 支配関係（オールインequity で確実に ≽ と言えるものだけ; 疑わしきは非比較で自由に残す）
 *  - ペア vs ペア: 上位ランクが下位を支配。
 *  - 同種の非ペア（s-s / o-o）: 両カードとも idx 以下（＝両方とも強い）なら支配（カード支配定理）。
 *  - スーテッド ≽ オフスート: カードが支配（両カード idx 以下）する時のみ（逆向きは主張しない）。
 *  - ペア vs 非ペア / オフスート→スーテッド等は**非比較**（真の再序列が起こり得るので拘束しない）。
 */
import { parseHandClass, rankIndex } from '@oshihiki/core';

export interface MonotonizeInput {
  /** 169（または合成テスト用の任意長）クラスのラベル列。 */
  classOrder: readonly string[];
  /**
   * 単調化する値（クラス別）。**滑らかな信号を渡すこと**:
   *  - MC 解 / M3: FP 平均頻度 arr（[0,1], 反復平均で低ノイズ）→ threshold 0.5。
   *  - 事前計算テーブル / NN: 格納 EV差 → threshold 0。
   * 単発リサンプルの EV差はノイズが大きく %が過剰に振れるため使わない。
   */
  values: ArrayLike<number>;
  /** クラス別コンボ数（isotonic の重み）。 */
  combos: readonly number[];
  /** push 判定しきい値（EV は 0, FP 頻度は 0.5）。既定 0。 */
  threshold?: number;
}

/** classOrder（安定参照）ごとの支配ペア列をキャッシュ。 */
const _pairCache = new WeakMap<readonly string[], Int32Array>();

/** i が j を確実に支配（i ≽ j）か。idx は小さいほど強い（A=0..2=12）。 */
function dominates(
  ki: string, hii: number, loi: number,
  kj: string, hij: number, loj: number,
): boolean {
  if (ki === 'pair' && kj === 'pair') return hii < hij; // 上位ペアが下位を支配
  if (ki === 'pair' || kj === 'pair') return false; // ペア vs 非ペアは非比較
  if (ki === kj) {
    // 同種の非ペア: 両カードとも強い（idx 以下）かつ同一でない
    return hii <= hij && loi <= loj && !(hii === hij && loi === loj);
  }
  if (ki === 's' && kj === 'o') return hii <= hij && loi <= loj; // スーテッドがカード支配
  return false; // オフスート→スーテッドは主張しない
}

/** classOrder から支配ペア (i≽j) をフラット配列 [i0,j0,i1,j1,...] で得る（キャッシュ）。 */
function dominationPairs(classOrder: readonly string[]): Int32Array {
  const cached = _pairCache.get(classOrder);
  if (cached) return cached;
  const n = classOrder.length;
  const kind: string[] = new Array(n);
  const hi = new Int32Array(n);
  const lo = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const hc = parseHandClass(classOrder[i]!)!;
    kind[i] = hc.kind;
    hi[i] = rankIndex(hc.hi);
    lo[i] = rankIndex(hc.lo);
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      if (dominates(kind[i]!, hi[i]!, lo[i]!, kind[j]!, hi[j]!, lo[j]!)) out.push(i, j);
    }
  }
  const arr = Int32Array.from(out);
  _pairCache.set(classOrder, arr);
  return arr;
}

/**
 * 支配半順序に沿って push レンジを単調化（穴あきを除去）して返す。
 *
 * **最小反転**方式: 生の線引き（values ≥ threshold）を「支配関係に整合した up-set（弱い手が
 * 入れば強い手も必ず入る）」へ、**コンボ重みで最小の反転**で修復する。これは最小 s-t カット
 * （プロジェクト選択）で厳密に解ける:
 *   - 生プッシュ i: S→i 容量 w[i]（fold へ反転＝カットで w[i] コスト）。
 *   - 生フォールド i: i→T 容量 w[i]（push へ反転＝カットで w[i] コスト）。
 *   - 支配 i≽j ごとに j→i を ∞（「弱い j が push なら強い i も push」を強制＝up-set 制約）。
 * カット後のソース側集合が最小反転の push レンジ。**%（プッシュ・コンボ数）はほぼ保存**され
 * （動くのは穴を作っていた無差別ハンドだけ）、ノイズ量に依らず過補正しない。ゼロ交差の純戦略で
 * 既に単調な入力は無反転で素通りする。
 */
export function monotonizePush(input: MonotonizeInput): boolean[] {
  const { classOrder, values, combos } = input;
  const threshold = input.threshold ?? 0;
  const n = classOrder.length;
  const pairs = dominationPairs(classOrder);
  const S = n, T = n + 1, V = n + 2;
  const INF = 1e18;

  // --- 最小カット・グラフ（Dinic）---
  const head: number[] = new Array(V).fill(-1);
  const to: number[] = [];
  const cap: number[] = [];
  const nxt: number[] = [];
  const addEdge = (u: number, w: number, c: number): void => {
    to.push(w); cap.push(c); nxt.push(head[u]!); head[u] = to.length - 1;
    to.push(u); cap.push(0); nxt.push(head[w]!); head[w] = to.length - 1; // 逆辺
  };
  for (let i = 0; i < n; i++) {
    if (values[i]! >= threshold) addEdge(S, i, combos[i]!); // 生プッシュ
    else addEdge(i, T, combos[i]!); // 生フォールド
  }
  for (let p = 0; p < pairs.length; p += 2) addEdge(pairs[p + 1]!, pairs[p]!, INF); // j→i (i≽j)

  const level = new Int32Array(V);
  const iter = new Int32Array(V);
  const queue = new Int32Array(V);
  const bfs = (): boolean => {
    level.fill(-1);
    let qh = 0, qt = 0;
    level[S] = 0; queue[qt++] = S;
    while (qh < qt) {
      const u = queue[qh++]!;
      for (let e = head[u]!; e !== -1; e = nxt[e]!) {
        if (cap[e]! > 0 && level[to[e]!] === -1) { level[to[e]!] = level[u]! + 1; queue[qt++] = to[e]!; }
      }
    }
    return level[T] !== -1;
  };
  const dfs = (u: number, f: number): number => {
    if (u === T) return f;
    for (; iter[u]! !== -1; iter[u] = nxt[iter[u]!]!) {
      const e = iter[u]!;
      const w = to[e]!;
      if (cap[e]! > 0 && level[w] === level[u]! + 1) {
        const d = dfs(w, Math.min(f, cap[e]!));
        if (d > 0) { cap[e]! -= d; cap[e ^ 1]! += d; return d; }
      }
    }
    return 0;
  };
  while (bfs()) {
    for (let i = 0; i < V; i++) iter[i] = head[i]!;
    let f: number;
    do { f = dfs(S, INF); } while (f > 0);
  }

  // 残余グラフで S から到達可能なノード＝ソース側＝push。
  level.fill(-1);
  let qh = 0, qt = 0;
  level[S] = 0; queue[qt++] = S;
  while (qh < qt) {
    const u = queue[qh++]!;
    for (let e = head[u]!; e !== -1; e = nxt[e]!) {
      if (cap[e]! > 0 && level[to[e]!] === -1) { level[to[e]!] = 0; queue[qt++] = to[e]!; }
    }
  }
  const push: boolean[] = new Array(n);
  for (let i = 0; i < n; i++) push[i] = level[i] !== -1;
  return push;
}
