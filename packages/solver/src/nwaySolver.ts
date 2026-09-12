/**
 * 汎用 N-way（3〜6人）逐次 push/fold Nash ソルバー
 * （IMPLEMENTATION_PLAN 1-8 / M4 / SPEC §3.1, §4）。
 *
 * M3 の `multiwaySolver.ts`（solveThreeWay）は 6 決定ノードを手書き展開したが、
 * 4/5/6 人ではノード数が 14/30/62 と爆発する。本モジュールは任意 N のゲーム木を
 * プログラム的に構成し、同一の「equity 先取り MC + fictitious play」設計で解く。
 * solveThreeWay とは独立実装であり、N=3 で両者が一致することが相互検証になる。
 *
 * ## ゲーム木（残り N 人, 行動順 order = positionsForPlayersLeft(N)）
 * push/fold では行動は席順に 1 周し、各プレイヤーはちょうど 1 回、二択を行う:
 *   - 前方に誰もオールインしていなければ PUSH / FOLD（未開＝PU）
 *   - 前方に 1 人オールインなら CALL / FOLD（CA）
 *   - 前方に 2 人以上オールインなら OVERCALL / FOLD（OC）
 * 「アグレッシブ」＝自分の全スタック T[i] を投入。決定ノードは (actor i, 前方の
 * オールイン集合 S⊆{0..i-1}) で一意化される。総数は 2^N − 2
 *   （N=3→6, 4→14, 5→30, 6→62）。ただし (BB, S=∅) は「ウォーク」で決定ではない。
 *
 * ## 終局（オールイン集合 A で分類）
 *   |A|=0: 全員フォールド → BB ウォーク（ICM 決定的）
 *   |A|=1: 単独オールインの不戦勝（foldout, ICM 決定的）
 *   |A|≥2: ショーダウン（サイドポット分配 → 終局スタック → ICM）。
 *          all-in equity は showdownMc のノードレベル MC で「先取り」見積り。
 *
 * ## 求解（SPEC §3.1, docs/MC_COST_FINDINGS §3）
 * 各ショーダウン集合 A について、参加者の「到達レンジ」（各参加者がその A に至る
 * ノードで採っている現在戦略）でノードレベル MC を回し、参加者ごとのクラス別
 * all-in equity（pcEq）と全席の周辺 equity（seatMarginal）を epoch ごとに再サンプル。
 * FP 反復自体はその見積り equity で決定論的に回す。収束は per-node regret × 到達確率の
 * 総和（実払い pt）で判定し、上限反復で閾値未達なら「収束不十分」フラグを付す
 * （3 人以上は FP の収束保証が無い / §3.1）。
 *
 * ## 既知の近似（M3 から継承）
 * - ツリーのアクション確率はコンボ加重のレンジ比で近似し、hero 個別のカードリムーバルは
 *   反映しない（ショーダウン equity 側の MC は衝突棄却で厳密に扱う）。境界ハンドの微差は
 *   §4.3 の許容と exploitability で担保。
 * - per-class equity は epoch MC のクラス別バケットで、サンプル数に応じたノイズ床を持つ。
 */

import type { BoardState, SolutionNode, Position } from '@oshihiki/core';
import {
  normalizeKey,
  formatRange,
  comboCount,
  parseHandClass,
  positionsForPlayersLeft,
} from '@oshihiki/core';
import type { ActionChar } from '@oshihiki/core';
import { icmEquities, payoutsForPlayers } from './icm.js';
import { finalStacksFromShowdown } from './sidepot.js';
import { HAND_CLASS_ORDER } from './huEquity.js';
import type { ShowdownNode } from './showdownMc.js';
import { MC_SEED, NODE_MC_SAMPLES } from './mcConfig.js';
import { monotonizePush } from './monotonize.js';
import { computeShowdownMc, DEFAULT_STRAT, type ShowdownMcResult, type StratSpec } from './showdownJob.js';
import {
  computeShowdown2Exact,
  computeShowdown3Exact,
  computeShowdown3ExactDenseChunk,
  mergeShowdown3ExactDenseChunks,
  rankClassesByEquityVs,
  exact3LookupCost,
  DENSE_SWEEP_THRESHOLD,
  EPS_ARRIVAL,
  type WinTieTable,
  type Exact3DenseChunk,
} from './showdownExact.js';
import type { WinTie3Table } from './wintie3Table.js';
import { weightAndUses, conditionalAggrProb } from './cardRemoval.js';

/**
 * WorkerPool の最小構造型。実体は nwayWorkerPool.ts（Node 専用, node:worker_threads 依存）で、
 * ブラウザバンドルに混入させないため型リンクは張らず、動的 import で読む（下記 ensurePool）。
 */
interface WorkerPoolLike {
  run(input: {
    node: ShowdownNode;
    ranges: F64[];
    samples: number;
    seed: number;
    strat?: StratSpec;
    /** true なら MC ではなく `computeShowdown3Exact`（worker 側で loadWinTie3Table() を遅延ロード）。 */
    exact3?: boolean;
  }): Promise<ShowdownMcResult>;
  /**
   * item1: 1 つの exact3 dense 集合を 'a'（hero0 のクラス）範囲 [lo,hi) だけ計算させる
   * （critical path 短縮のため 1 集合を worker 台数ぶんに割って並列化する）。
   */
  runExact3Chunk?(input: { node: ShowdownNode; ranges: F64[]; lo: number; hi: number }): Promise<Exact3DenseChunk>;
  dispose(): Promise<void>;
}

const N_CLASSES = HAND_CLASS_ORDER.length; // 169
const TOTAL_COMBOS = 1326;
const COMBO_COUNT: number[] = HAND_CLASS_ORDER.map(
  (label) => comboCount(parseHandClass(label)!.kind),
);
const FULL_RANGE = new Float64Array(N_CLASSES).fill(1);
const ALL_CLASS_IDX = Int16Array.from({ length: N_CLASSES }, (_, i) => i);
type F64 = Float64Array;

function popcount(x: number): number {
  let c = 0;
  while (x) {
    x &= x - 1;
    c++;
  }
  return c;
}

/** レンジのコンボ加重比（0..1）。アクション確率の近似に使う。 */
function rangeFraction(freq: F64): number {
  let w = 0;
  for (let i = 0; i < N_CLASSES; i++) w += COMBO_COUNT[i]! * freq[i]!;
  return w / TOTAL_COMBOS;
}

/** レンジが空なら全レンジで代用（到達確率≈0 のノードで MC を成立させるため）。 */
function nonEmpty(freq: F64): F64 {
  let w = 0;
  for (let i = 0; i < N_CLASSES; i++) w += freq[i]!;
  return w > 1e-9 ? freq : FULL_RANGE;
}

/**
 * `computeShowdown3Exact` の ε-pruning（showdownExact.EPS_ARRIVAL, 既定 1e-3）と**同じ
 * しきい値**でクラス数を数える（part C の予算見積り用）。しきい値がずれると見積りが
 * 実コストと食い違うので、必ず showdownExact.EPS_ARRIVAL を import して使うこと。
 */
function nzCountEps(freq: F64): number {
  const r = nonEmpty(freq);
  let n = 0;
  for (let i = 0; i < N_CLASSES; i++) if (r[i]! >= EPS_ARRIVAL) n++;
  return n;
}

/**
 * 3 人ショーダウン集合 1 個を `computeShowdown3Exact` で解くコストの見積り（テーブル
 * 参照回数）。hero パス 3 回（各 169 × 他2人の ε-pruning 後クラス数の積）＋
 * seatMarginal 1 回（3 人とも ε-pruning 後クラス数の直積）。part C の予算判定に使う。
 * 式そのものは showdownExact.ts の `exact3LookupCost`（dense/sparse 切替判定と共用）。
 */
function exact3LookupEstimate(ranges: readonly F64[]): number {
  return exact3LookupCost(nzCountEps(ranges[0]!), nzCountEps(ranges[1]!), nzCountEps(ranges[2]!));
}

function antePaid(state: BoardState, pos: Position): number {
  const { scheme, amount } = state.ante;
  if (scheme === 'none') return 0;
  if (scheme === 'all') return amount;
  return pos === 'BB' ? amount : 0;
}

/** 32bit 整数ミックス（seed 派生用, 決定的）。 */
function mix(a: number, b: number, c: number): number {
  let h = (a ^ 0x9e3779b1) >>> 0;
  h = (Math.imul(h ^ b, 0x85ebca6b) + 0x165667b1) >>> 0;
  h = (Math.imul(h ^ c, 0xc2b2ae35) + 0x27d4eb2f) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return h;
}

/** 決定ノード記述子。 */
interface NodeDesc {
  i: number; // actor 席インデックス（order 内）
  S: number; // 前方オールイン集合（bitmask over 0..i-1）
  id: number; // i*64 + S
  actor: Position;
  actionType: 'PU' | 'CA' | 'OC';
  key: string;
  /** 同時オールイン上限（maxActive）到達で「決定なし＝強制フォールド」のノード。 */
  truncated: boolean;
}

/** 1 ショーダウン MC ジョブの入力（環境非依存）。 */
export interface ShowdownMcJob {
  node: ShowdownNode;
  ranges: F64[];
  samples: number;
  seed: number;
  /** 層化 MC の指定（3 人以上・winTie あり・stratifiedMc 時）。省略で従来経路。 */
  strat?: StratSpec;
  /**
   * true なら MC ではなく `computeShowdown3Exact`（3 人ショーダウンの厳密計算）をこの
   * ジョブとして実行する（part C の予算内で winTie3 が与えられているとき）。このとき
   * `samples`/`seed`/`strat` は無視される（node/ranges だけを使う）。
   * ランナー（Node の worker_threads プール・ブラウザの Web Worker プール）は
   * `loadWinTie3Table()` 等でテーブルを自前で用意し、このフラグを見て
   * `computeShowdown3Exact` に切り替える必要がある（未対応のランナーに投げると壊れるため、
   * `mcRunner` 注入時は winTie3 と併用する場合に呼び出し側が対応すること）。
   */
  exact3?: boolean;
  /**
   * 指定時は「dense sweep の 'a'（hero0 のクラス）範囲 [lo,hi) だけの部分和」
   * （`computeShowdown3ExactDenseChunk` が返す `Exact3DenseChunk`）を計算して返すジョブ
   * であることを示す（node/ranges と併用し、exact3/samples/seed/strat は無視する）。
   * 1 つの exact3 集合を `mcRunnerParallelism`（または Node の worker 台数）ぶんに割って
   * 並列化するために使う（nwaySolver.ts の refresh・nwayWorker.ts と同じ契約）。
   */
  exact3Chunk?: { lo: number; hi: number };
}

/**
 * ショーダウン MC の並列ランナー（依存性注入）。渡された全ジョブを（並列に）解いて
 * 入力順の結果配列を返す。ブラウザは Web Worker プールで、Node は既定の worker_threads
 * プールで実装できる。指定時は `workers` より優先される。
 *
 * 結果は入力ジョブと同じ並びの union: `exact3Chunk` ジョブには `Exact3DenseChunk`
 * （部分和ペイロード）を、それ以外（通常 MC / 全体 exact3）には `ShowdownMcResult` を返す。
 */
export type McRunner = (jobs: ShowdownMcJob[]) => Promise<(ShowdownMcResult | Exact3DenseChunk)[]>;

/** N-way 求解の共通オプション。 */
export interface MultiwayNSolveOptions {
  maxIters?: number;
  /** exploitability 早期停止しきい値（実払い pt）。既定はプール比 0.15%。 */
  targetExploitabilityPt?: number;
  /** MC equity を再サンプルする反復間隔（epoch 長）。 */
  refreshEvery?: number;
  /**
   * refresh の間隔スケジュール。**既定 'fixed'**（従来どおり `refreshEvery` の倍数で refresh、
   * bit 互換）。'geometric' にすると `t<=1000` は `refreshEvery` 間隔、`1000<t<=3000` は
   * `2×refreshEvery`、`t>3000` は `4×refreshEvery` と後半ほど疎に refresh する。
   * fictitious play の平均戦略は 1 反復あたり O(1/t) しか動かないため、後半の refresh を
   * 間引いても平均戦略への影響は小さい一方、MC/exact3 の再計算コストは大きく減る。
   * 最終の full refresh（収束後の最終評価）は本オプションの対象外で常に実行される。
   */
  refreshSchedule?: 'fixed' | 'geometric';
  /**
   * FP 平均戦略の重み指数 p（既定 0 = 一様平均 w_t = 1/(t+1)）。p=1 で線形重み（w_t = 2/(t+2),
   * 反復 t の最適反応を t に比例して重く見る＝初期 0.5 戦略の残滓を早く消す）、p=2 で二乗重み。
   * 超短スタック局面では一様平均が 3000 反復で収束しない（BU PU 64% ↔ 8000 反復 78%）ため実験用。
   */
  avgPower?: number;
  /**
   * ショーダウン MC のサンプル数。省略時は人数に応じた既定（下記）。
   * 3 人以上の集合には `mcSamplesFor` により**到達確率比例で減らして**配る。
   */
  samples?: number;
  /**
   * 全ショーダウン集合へ `samples` を**均等配分**する（旧挙動）。既定 false。
   * 到達確率比例配分（既定）は同一解に約 10 倍速で到達することを実測済みなので、
   * 通常は不要。旧結果の再現・配分の対照実験のためだけに残す。
   */
  uniformSamples?: boolean;
  seed?: number;
  /**
   * ショーダウン MC を並列実行する worker 数。0/1 で単一スレッド（既定）。
   * `undefined` かつ環境変数 `OSHIHIKI_WORKERS` 未設定なら単一スレッド。
   */
  workers?: number;
  /**
   * hero カードリムーバルを反映したアクション確率（fold-through）補正を使うか。
   * **既定 false**（card-blind, M4 の検証済みベースライン）。
   *
   * M5 実験（docs/NWAY_VALIDATION §5）で true を評価したが、HRC 5-way 照合の
   * 平均 |freq% 差| が 1.68→1.98pt と**悪化**した。原因は本補正が「hero のみ除去」の
   * 一次近似で、既にオールイン済みのプレイヤーのカードを除去しないため（HRC は完全な
   * レンジ vs レンジのカードリムーバル）。片側だけの部分補正は card-blind の平均場より
   * かえって参照解から離れることがある。よって既定は card-blind のまま。true は
   * 将来の「完全カードリムーバル」実装への足場・再現用に opt-in で残す。
   */
  cardRemoval?: boolean;
  /**
   * ショーダウン MC の並列ランナー（依存性注入）。指定すると `workers`（Node の
   * worker_threads プール）より優先し、refresh の全ジョブをこのランナーに渡す。
   * ブラウザ（App）は Web Worker プールをここに注入して並列化する。
   */
  mcRunner?: McRunner;
  /**
   * `mcRunner` 注入時、dense 判定される exact3 集合を分割するチャンク数の基準
   * （既定 1 = 分割なし）。内部 worker プール（Node, `workers` オプション）と同じ考え方で、
   * `Math.min(mcRunnerParallelism, 8)` 個の 'a'（hero0 のクラス）範囲チャンクに割って
   * `mcRunner` へ渡し、`mergeShowdown3ExactDenseChunks` で合算する。ブラウザは自前の
   * Web Worker プールのサイズ（`mcPool` の worker 数）をここに渡すことで、Node の
   * worker_threads プールと同じ速度構造になる（1 集合の壁時計コストが
   * ~1/mcRunnerParallelism に縮む）。`mcRunner` 未注入時は無視される。
   */
  mcRunnerParallelism?: number;
  /**
   * 共通乱数（Common Random Numbers）。**既定 false**。true にすると、反復（epoch）を
   * またいで MC のサンプル列を固定し、equity 見積りを「レンジ変化だけ」の滑らかな関数にする。
   * epoch ごとの再サンプリング・ノイズが消えるため exploitability が単調に落ち、収束判定
   * （早期停止・plateau 停止）が安定して機能する。最終評価だけは独立シードで引き直し、
   * サンプルへの過適合（楽観バイアス）を避ける。事前計算のグリッド生成で必須。
   */
  commonRandom?: boolean;
  /**
   * ウォームスタート初期戦略（node.key → 169 クラス頻度）。近傍グリッド点の解を初期値に
   * 与えると、勾配が緩やかなため少ない反復で収束する。省略時は全ノード 0.5 から開始。
   */
  initStrategy?: Map<string, Float64Array>;
  /**
   * ウォームスタート時の「見かけ上すでに経過した反復数」。fictitious play の平均化重み
   * w=1/(t+initIterations+1) を小さくして初期戦略を保護する（大きいほど初期値を尊重）。
   * 既定 0（コールドスタート）。
   */
  initIterations?: number;
  /**
   * plateau 早期停止。指定すると、exploitability の相対改善が直近チェックでこの割合を
   * 下回ったら停止する（例 0.02 = 2%未満の改善で頭打ちとみなす）。MC ノイズ床が
   * targetExploitabilityPt より高くて絶対しきい値に到達できない場合でも、頭打ちを検出して
   * 無駄な反復を止める。commonRandom と併用推奨。省略時は無効（従来どおり絶対しきい値のみ）。
   */
  plateauStopFrac?: number;
  /**
   * HU 勝ち/引き分けテーブル（`loadHuWinTieTable()`）。与えると **2 人ショーダウンを
   * 厳密計算**に切り替える（MC ノイズ 0・大幅高速化）。3 人以上の同時オールインは
   * 従来どおり MC。省略時は全て MC（従来動作）。
   */
  winTie?: WinTieTable;
  /**
   * 3-way オールイン結果テーブル（`loadWinTie3Table()`）。与えると**3 人ショーダウンを
   * 厳密計算**に切り替える（MC ノイズ 0）。2 人は `winTie` が別途担当し、4 人以上の同時
   * オールインは従来どおり MC。省略時は 3 人以上は全て MC（従来動作、既定動作は不変）。
   */
  winTie3?: WinTie3Table;
  /**
   * 同時オールインの上限人数。**既定 3**（HRC の Math エンジン・ICMIZER と同じゲーム定義:
   * 3 人がオールインした時点で残りは自動フォールド。docs/BATON_OC.md §9）。
   * 3 人以上の同時オールインは到達確率が桁で小さく（4 人集合 0.0003%）、実測で解は
   * ノイズ幅以内しか変わらない一方、6 人卓ではショーダウン集合が 42→16 に減り 4〜6 倍速。
   * 完全ゲーム（全員がオーバーコール可）は 99 などを指定する。
   */
  maxActive?: number;
  /**
   * 3 人以上のショーダウン MC を**層化**する（既定 true, `winTie` があるときのみ有効）。
   * overcaller は「最も狭い相手レンジに対する勝率」上位 `ocCandidates` クラスだけを評価し、
   * 未評価クラスは候補最小値で埋める。OC の最適反応が候補の下位 1/4 に触れたら次回から
   * 候補数を倍にする（適応 K）。false で従来のコンボ数比例 MC（対照実験用）。
   */
  stratifiedMc?: boolean;
  /** 層化 MC の overcaller 候補クラス数の初期値（既定 24。12 では僅かに漂うことを実測）。 */
  ocCandidates?: number;
  /**
   * 表示レンジの線引き方式（**既定 'avg'**）。HRC 照合（2026-09-07, docs/BATON_OC.md §11）:
   *  - 'avg'    : FP 全反復の平均頻度 ≥ 0.5。均衡近似である「平均戦略」そのもの。
   *               6人 平均|差| 1.26pt / 4人 CO +1.0pt。
   *  - 'lateAvg': 反復の後半だけの平均頻度 ≥ 0.5。6人 1.26pt / 4人 CO −2.1pt。
   *  - 'evSign' : 最終 EV差 ≥ 0（最適反応のスナップショット）。6人 0.99pt / 4人 CO −2.4pt。
   *               無差別帯で振れる（FP の BR は収束しない）ため既定にしない。
   * いずれも差は |EV| < 0.01pt の無差別ハンドの数え方で、EV 上の損は無い。実験用に残す。
   */
  displayMode?: 'avg' | 'lateAvg' | 'evSign';
  /**
   * 3 人ショーダウン集合 1 個あたりの `computeShowdown3Exact` 呼び出しコスト上限
   * （テーブル参照回数の見積り, 既定 6,000,000）。`winTie3` があっても、この見積りを
   * 超える集合はその refresh に限り従来の MC 経路にフォールバックする（part C）。
   *
   * ## なぜ要るか
   * FP の平均戦略は厳密に 0 にならない（ε-pruning しても 1/t の減衰途中は広い）ため、
   * 序盤の refresh や病的に広い到達レンジを持つ集合では、ε-pruning 後もなお
   * 169×|nz1|×|nz2|（hero パス×3）＋|nz0|×|nz1|×|nz2|（seatMarginal）が数百万〜億に
   * 達しうる。この予算は「exact が MC より速いか」の目安ではない
   * （目的は**厳密解**そのものであり、MC はそもそもノイズを持つ近似）。dense パス
   * （single-sweep, `computeShowdown3Exact` 内部で自動選択）導入後は、到達レンジが
   * 169³ 分すべて広くても 1 回の refresh を現実的な時間で厳密計算できるため、この予算は
   * もはや「exact が遅いから MC に逃がす」チューニングではなく、**病的に広い到達レンジを
   * 持つ序盤の全集合が同時に dense 評価される**（FP 初期値 0.5 由来で最初の数 refresh は
   * ほぼ全集合が dense 判定になりうる）ときの合計時間を頭打ちにするための安全弁でしかない。
   * 既定 6,000,000 は「1 集合が dense 判定される sparse 換算コスト上限」を緩めに設定した
   * もの（169³ ≈ 483 万をわずかに超える程度）で、実運用ではほぼ全ての refresh で
   * exact 判定される（`_bench3exact.ts` 参照）。
   */
  exact3Budget?: number;
  /**
   * ベンチマーク・デバッグ専用: refresh 1 回ごとに、3 人ショーダウン集合のうち
   * `computeShowdown3Exact`（exact）と MC フォールバック（part C）にそれぞれ何個
   * 振り分けたかを通知する。求解結果には一切影響しない（副作用なしのオプショナル
   * コールバック）。
   */
  onExact3Stats?: (info: { epoch: number; exact: number; mc: number; total: number }) => void;
}

export interface MultiwayNSolveResult {
  nodes: SolutionNode[];
  iterations: number;
  exploitabilityPt: number;
  converged: boolean;
  equity: Record<string, { pre: number; post: number }>;
  /** ノードキー → クラス別頻度（169）。決定性・相互検証テスト用。 */
  strategies: Map<string, F64>;
}

/**
 * ショーダウン集合 A（参加者 k 人）に配る MC サンプル数（到達確率比例配分）。
 *
 * ## 根拠
 * 集合 A の EV 誤差寄与 ≒ `reach(A) × サンプリング誤差(A)`。同時オールインは 1 人増える
 * ごとに「その人もコールする」条件が乗るので reach は桁で落ちる。実測（4人卓
 * CO14/BU34/SB33/BB22, 到達レンジの幅の積＝上界）:
 *   2人集合 ≒ 1（大半） / 3人集合 0.005〜0.05% / **4人集合 0.0003%（33万回に1回）**
 * にもかかわらず全集合へ同数サンプルを配ると、**求解時間の 99% が 3 人以上に費やされる**
 * （2 人は showdownExact で厳密・ゼロコストになったため）。誤差あたりのコストが最悪の配分。
 *
 * ## 配分則
 * 1 人増えるごとに 1/8。ただし MC 推定が成立する下限（base/16）で打ち切る。
 *
 * ## なぜ下限が要るか＝OC ノードが壊れると上流が崩れる（実測で因果まで特定）
 * **3 人以上の同時オールインは OC（オーバーコール）が発生したときにしか起きない。**
 * その OC レンジは構造的にごく狭く、実測では 4人/6人・6/10/20/34bb のすべてで
 * **必ず {AA} ⊆ OC ⊆ {AA, KK, QQ}（または空）**、中央値 0.5%。ところが
 * `estimateNodeEquities` は hero クラスを**コンボ数比例**で引くため（AA は 6/1326＝
 * わずか 0.45%）、OC の可否を決める AA/KK/QQ に落ちるサンプルが最初から極端に少ない。
 * サンプルを削りすぎると OC レンジが先に壊れ、それが上流の PU レンジまで崩す:
 *   3000: OC=[AA KK QQ] → CO 18.6% / BU 37.9%（24000 と同一）
 *   1500: OC=[AA AKs KK QQ]（AKs 混入）→ CO 17.6%
 *    750: OC=[AA KK QQ JJ TT 99]  → **CO 12.8% / BU 28.5%（崩壊）**
 * 下限はこの「OC レンジの健全性」で決まる。3人集合が受け取る base/8=3000 は安全側で、
 * 6人卓 8000 反復でも **OC 42 ノード中の異常 0 件**・均等配分と同一解を確認済み。
 *
 * ## 検証（8000反復, 同一シード）
 *   均等配分 141.8s → CO 18.3% / BU 37.9% / SB 100%（expl 0.0008）
 *   本配分    14.2s → CO 18.6% / BU 37.9% / SB 100%（expl 0.0015）
 * = **同一の答えに約 10 倍速**。バイアスが無いことは 1/4・1/8 配分 ×
 * 4000/8000/16000 反復の対照実験で確認済み（すべて同じ 37.9% に収束）。
 */
export function mcSamplesFor(k: number, base: number): number {
  if (k <= 2) return base; // 2人は winTie 指定時は厳密。未指定時は reach≒1 なので削らない。
  return Math.max(Math.round(base / 16), Math.round(base / 8 ** (k - 2)));
}

/**
 * refresh（MC / exact3 の再サンプル・再計算）を実行する反復 t の集合を決める判定関数を作る。
 *
 * - 'fixed'（既定）: t が `refreshEvery` の倍数（従来どおり, bit 互換）。
 * - 'geometric': fictitious play の平均戦略は反復ごとに重み `w=1/(t+1)` でしか動かない
 *   （= 1 反復あたりの変化は O(1/t)）ため、反復が進むほど MC/exact3 の再サンプル間隔を
 *   疎にしても平均戦略への影響は小さい。`t<=1000` は `refreshEvery` 間隔、
 *   `1000<t<=3000` は `2×refreshEvery` 間隔、`t>3000` は `4×refreshEvery` 間隔で refresh する
 *   （最終の full refresh は本関数の対象外・従来どおり不変）。
 *
 * 呼び出しは `t=1,2,...,maxIters` の**昇順**を前提とする（'geometric' は内部状態を持つ
 * クロージャで、各 t につき厳密に 1 回だけ呼ぶこと）。
 */
function makeRefreshSchedule(refreshEvery: number, mode: 'fixed' | 'geometric'): (t: number) => boolean {
  if (mode === 'fixed') return (t: number) => t % refreshEvery === 0;
  let next = refreshEvery;
  return (t: number): boolean => {
    if (t < next) return false;
    const step = next < 1000 ? refreshEvery : next < 3000 ? refreshEvery * 2 : refreshEvery * 4;
    next += step;
    return true;
  };
}

/** 人数ごとの既定サンプル数（コストは Σ_A(|A|+1)|A| に比例。人数増で漸減）。 */
function defaultSamples(n: number): number {
  switch (n) {
    case 3:
      return NODE_MC_SAMPLES; // 100k
    case 4:
      return 60_000;
    case 5:
      return 40_000;
    default:
      return 30_000; // 6-way
  }
}

/**
 * 状態から終局構造・ノード集合・ショーダウン MC を束ねた「エンジン」。
 * solve と evaluate で共用する。
 */
function buildEngine(
  state: BoardState,
  samples: number,
  seed: number,
  workers: number,
  mcRunner?: McRunner,
  winTie?: WinTieTable,
  winTie3?: WinTie3Table,
  uniformSamples = false,
  maxActive = 3,
  stratified = true,
  K0: number = DEFAULT_STRAT.K,
  exact3Budget = 6_000_000,
  mcRunnerParallelism = 1,
  onExact3Stats?: (info: { epoch: number; exact: number; mc: number; total: number }) => void,
) {
  const n = state.playersLeft;
  const order = positionsForPlayersLeft(n);
  const payouts = payoutsForPlayers(n, state.gameMode);
  const last = n - 1; // BB 席インデックス

  const seatOf = (pos: Position) => {
    const s = state.seats.find((x) => x.pos === pos && x.state !== 'empty');
    if (!s) throw new Error(`solveMultiway: missing live seat ${pos}`);
    return s;
  };
  const seatObjs = order.map(seatOf);
  const T = seatObjs.map((s, i) => s.stack + s.bet + antePaid(state, order[i]!));
  const dead = seatObjs.map((s, i) => s.bet + antePaid(state, order[i]!));

  // --- foldout / walk の ICM（実払い pt, 全席ベクトル）---
  const eligibleWinner = (winner: number, commits: number[]): number[] => {
    const eligible = new Array<boolean>(n).fill(false);
    eligible[winner] = true;
    const sc = new Array<number>(n).fill(0);
    return icmEquities(finalStacksFromShowdown(T, commits, eligible, sc), payouts);
  };
  // V_win[a] = a が単独オールインで不戦勝（他は dead を拠出してフォールド）。
  const V_win: number[][] = [];
  for (let a = 0; a < n; a++) {
    const commits = dead.slice();
    commits[a] = T[a]!;
    V_win.push(eligibleWinner(a, commits));
  }
  // V_walk = 全員フォールドで BB がブラインド・アンティを回収（全員 dead 拠出）。
  const V_walk = eligibleWinner(last, dead.slice());

  // --- 決定ノードの列挙 ---
  const nodes: NodeDesc[] = [];
  const nodeById = new Map<number, NodeDesc>();
  for (let i = 0; i < n; i++) {
    for (let S = 0; S < 1 << i; S++) {
      if (i === last && S === 0) continue; // ウォーク（決定でない）
      const id = i * 64 + S;
      const pc = popcount(S);
      const actionType: 'PU' | 'CA' | 'OC' = pc === 0 ? 'PU' : pc === 1 ? 'CA' : 'OC';
      // key: 前方 S の最小席=P（最初のオールイン）, 他の S 席=C, フォールド席=F, actor と後方=-
      const actions: Partial<Record<Position, ActionChar>> = {};
      const firstAggr = S === 0 ? -1 : 31 - Math.clz32(S & -S); // 最小ビット位置
      for (let j = 0; j < i; j++) {
        if (S & (1 << j)) actions[order[j]!] = j === firstAggr ? 'P' : 'C';
        else actions[order[j]!] = 'F';
      }
      const key = normalizeKey(n, actions);
      const node: NodeDesc = { i, S, id, actor: order[i]!, actionType, key, truncated: pc >= maxActive };
      nodes.push(node);
      nodeById.set(id, node);
    }
  }
  const nodeId = (i: number, S: number): number => i * 64 + S;

  // --- ショーダウン集合 A（|A|≥2）の MC 見積りを保持 ---
  // pcEqA[A].get(seat) = 参加者 seat のクラス別 all-in equity（169, hero=full 条件）
  // smA[A][seat] = 全席の周辺 ICM equity（到達レンジで平均）
  // 求解中は同時オールイン ≤ maxActive の集合だけを見積もる。最終パス（full）では上限超えの
  // 集合も 1 回だけ見積もり、打ち切りノード（4 人目以降の OC）の最適反応を表示用に評価する
  // （到達確率 0 なので他ノードには影響しない。「どんな状況でも AA は残る」を表示で保証）。
  const showdownSets: number[] = [];
  const allSets: number[] = [];
  for (let A = 1; A < 1 << n; A++) {
    if (popcount(A) < 2) continue;
    allSets.push(A);
    if (popcount(A) <= maxActive) showdownSets.push(A);
  }
  // 層化 MC: 集合 A ごとの overcaller 候補数（適応 K）と、直近 refresh で渡した候補列。
  const kA = new Map<number, number>();
  const candA = new Map<number, Map<number, Int16Array>>();
  const useStrat = stratified && winTie !== undefined;
  const pcEqA = new Map<number, Map<number, F64>>();
  const smA = new Map<number, number[]>();

  /** A に対応する ShowdownNode を作る。 */
  const makeShowdownNode = (A: number): { node: ShowdownNode; participants: number[] } => {
    const participants: number[] = [];
    for (let s = 0; s < n; s++) if (A & (1 << s)) participants.push(s);
    const commits = new Array<number>(n);
    for (let s = 0; s < n; s++) commits[s] = A & (1 << s) ? T[s]! : dead[s]!;
    return { node: { preHandStacks: T, commits, participants, payouts }, participants };
  };

  /** A の参加者到達レンジ（各参加者が A に至るノードの現在戦略）。 */
  const arrivalRanges = (A: number, participants: number[], strat: Map<number, F64>): F64[] =>
    participants.map((a) => {
      const Sa = A & ((1 << a) - 1); // a より前方の A 席（= a が行動した時点の前方オールイン集合）
      const r = strat.get(nodeId(a, Sa));
      return r ? nonEmpty(r) : FULL_RANGE;
    });

  // worker プールは遅延生成（単一スレッド時は生成しない）。生成に失敗した環境
  // （tsx 不在・worker ファイル欠落など）では単一スレッドへ退避する。
  // node:worker_threads 依存の実体は nwayWorkerPool.js に分離し、**動的 import** で
  // 読む（workers<=1 のブラウザ経路では一切参照されず、静的グラフに Node 組み込みが入らない）。
  let pool: WorkerPoolLike | null = null;
  let poolDisabled = workers <= 1;
  const ensurePool = async (): Promise<WorkerPoolLike | null> => {
    if (poolDisabled) return null;
    if (!pool) {
      try {
        // 変数経由の動的 import でバンドラの静的解析を回避（ブラウザ束には含めない）。
        const modPath = './nwayWorkerPool.js';
        const mod = (await import(/* @vite-ignore */ modPath)) as {
          WorkerPool: new (size: number) => WorkerPoolLike;
        };
        pool = new mod.WorkerPool(workers);
      } catch (e) {
        poolDisabled = true;
        warn(`[nwaySolver] worker 並列を無効化し単一スレッドで続行: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    }
    return pool;
  };

  // item1: 1 つの exact3 dense 集合を worker プールへ割る分割数の上限（169 クラスを
  // 1 クラス未満に割っても意味が無い・IPC オーバーヘッドがチャンクあたりの計算量を
  // 上回らない程度、実測で 8 分割あたりが妥当）。実際の分割数は下の EXACT3_CHUNKS_PER_SET
  // 参照（worker プールのタスクキューが自然に負荷分散するため、同時に dense 判定される
  // 集合数によらず一律この上限で割る）。
  const EXACT3_MAX_CHUNKS_PER_SET = 8;

  /** [0,total) をほぼ均等な k 個の [lo,hi) に分割する（item1: dense sweep の 'a' 範囲分割）。 */
  function chunkBounds(total: number, k: number): { lo: number; hi: number }[] {
    const n = Math.max(1, Math.min(k, total));
    const out: { lo: number; hi: number }[] = [];
    let lo = 0;
    for (let i = 0; i < n; i++) {
      const hi = Math.round(((i + 1) * total) / n);
      if (hi > lo) out.push({ lo, hi });
      lo = hi;
    }
    return out;
  }

  const refresh = async (strat: Map<number, F64>, epoch: number, full = false): Promise<void> => {
    const store = (A: number, participants: number[], res: ShowdownMcResult): void => {
      const m = new Map<number, F64>();
      for (let p = 0; p < participants.length; p++) m.set(participants[p]!, res.pcEq[p]!);
      pcEqA.set(A, m);
      smA.set(A, res.seatMarginal);
    };

    // 2 人ショーダウンは勝ち/引き分け表で**厳密**に即時計算し、MC は 3 人以上だけに絞る。
    // push/fold の到達確率の大半は「押した1人＋コールした1人」なので、これで MC ノイズ床の
    // 主要因が消え、同時に大幅に速くなる（テーブル未指定なら従来どおり全て MC）。
    // 残る MC には**到達確率に比例して**サンプルを配る（mcSamplesFor 参照）。同時オールイン
    // する人数が増えるほど到達確率は桁で落ちるので、同数を配るのは誤差あたりのコストが最悪。
    const jobs: {
      A: number; node: ShowdownNode; participants: number[]; ranges: F64[]; jobSeed: number; samples: number;
      strat?: StratSpec;
      exact3?: boolean;
    }[] = [];
    // item1: dense 判定される exact3 集合（内部 worker プール限定, mcRunner 注入時は対象外）。
    // ループを抜けてから一括で EXACT3_CHUNKS_PER_SET 個ずつに割る（下記参照）。
    const denseCandidates: { A: number; node: ShowdownNode; participants: number[]; ranges: F64[] }[] = [];
    // item1: chunkPlan は「実際にチャンク分割すると決まった」集合だけが入る（各要素は
    // 確定した nchunks を保持）。EXACT3_CHUNKS_PER_SET<=1（workers<=1 相当）なら
    // denseCandidates は全て通常の exact3 単発ジョブとして jobs に合流し、chunkPlan は空のまま。
    const chunkPlan: { A: number; node: ShowdownNode; participants: number[]; ranges: F64[]; nchunks: number }[] = [];
    // part C: 予算内なら computeShowdown3Exact（exact）、超えたら今回の refresh 限り MC に
    // フォールバックする集合数（ベンチマーク・onExact3Stats 通知用）。
    let exact3Count = 0;
    let mc3Count = 0;
    // 並列実行の見込み（mcRunner 注入 or workers>1 のプール）があるかどうか。
    // ここでは ensurePool() をまだ呼んでいない（呼ぶのは全ジョブ組み立て後）ため poolDisabled は
    // 「workers<=1 で最初から単一スレッド確定」のときだけ true。pool 初期化が後で失敗した場合は
    // 下の「wp が取れなかった」フォールバックが exact3 ジョブも inline で処理する（安全網）。
    const parallelLikely = mcRunner !== undefined || !poolDisabled;
    for (const A of full ? allSets : showdownSets) {
      const { node, participants } = makeShowdownNode(A);
      const ranges = arrivalRanges(A, participants, strat);
      if (winTie && participants.length === 2) {
        store(A, participants, computeShowdown2Exact(node, ranges, winTie));
        continue;
      }
      if (winTie3 && participants.length === 3) {
        const cost = exact3LookupEstimate(ranges);
        if (cost <= exact3Budget) {
          exact3Count++;
          if (parallelLikely) {
            // dense 判定される集合はチャンク分割の候補にする（実際に分割するかはループ後、
            // 並列度（mcRunner 注入時は mcRunnerParallelism、内部 worker プールは workers）を
            // 見てから決める）。mcRunner 注入時も内部 worker プールと同じ考え方でチャンク分割
            // する（item1 の速度構造をブラウザ側にも適用）。
            if (cost > DENSE_SWEEP_THRESHOLD) {
              denseCandidates.push({ A, node, participants, ranges });
            } else {
              jobs.push({ A, node, participants, ranges, jobSeed: mix(seed, epoch, A), samples: 0, exact3: true });
            }
          } else {
            // 単一スレッドはそのまま inline 計算（従来どおり）。
            store(A, participants, computeShowdown3Exact(node, ranges, winTie3));
          }
          continue;
        }
        mc3Count++;
        // 予算超過: この refresh 限り従来の MC 経路にフォールバック（下の共通ジョブ組み立てに合流）。
      }
      const s = uniformSamples ? samples : mcSamplesFor(participants.length, samples);
      let stratSpec: StratSpec | undefined;
      if (useStrat) {
        // 到達確率（参加者の到達レンジ幅の積＝上界）。通常の 3 人以上の集合は 0.005〜0.05% で、
        // overcaller のレンジは上端の数クラス（AA/KK/QQ）に限られる → 上位 K 候補だけ評価して
        // 未評価クラスを候補最小値で埋める層化が有効。
        // しかし 2〜3bb の超短スタックがいる局面では「誰でもコール」になり、3 人ショーダウンが
        // 数%〜十数% で起き、overcaller のレンジも 60% 以上に広がる。そこで候補を上位 K に絞ると
        // 候補外の手が「候補最小値（＝+EV）」で埋まって OC レンジが膨れ、上流まで崩れる
        // （HRC 照合 2026-09-07: BB OC 84.6% ↔ GOLD 67.4%）。到達確率が 0.5% を超える集合は
        // **全 169 クラス**を評価し、本数も到達確率に比例して増やす（上限 16 倍）。
        let reach = 1;
        for (let p = 0; p < participants.length; p++) reach *= rangeFraction(ranges[p]!);
        if (reach <= 0.005) {
          const K = kA.get(A) ?? K0;
          const cand: (Int16Array | undefined)[] = [];
          const cm = new Map<number, Int16Array>();
          for (let h = 0; h < participants.length; h++) {
            if (h < 2) {
              cand.push(undefined); // pusher / caller は全クラス（各 mLow 本）
              continue;
            }
            // overcaller の**現在の OC レンジが広い**（> 5%）間は全クラスを各 mOc 本で評価する
            // （候補外を候補最小値で埋めると +EV 側に膨れるため。序盤の 50% 初期値や超短スタック
            // 局面の「誰でもコール」がこれに当たる）。注意: 各クラス mLow=3 本では少なすぎて
            // 最適反応が「運の良かった手」に引きずられ OC が膨れる（実測で上流が崩壊）。
            if (rangeFraction(ranges[h]!) > 0.05) {
              cand.push(ALL_CLASS_IDX);
              continue;
            }
            // overcaller（参加者 idx≥2）の候補 = 「他参加者のうち最も狭い到達レンジ」に対する勝率上位 K。
            let tight = -1;
            let tf = Number.POSITIVE_INFINITY;
            for (let p = 0; p < participants.length; p++) {
              if (p === h) continue;
              const f = rangeFraction(ranges[p]!);
              if (f < tf) {
                tf = f;
                tight = p;
              }
            }
            const c = rankClassesByEquityVs(ranges[tight]!, winTie!).subarray(0, K);
            cand.push(c);
            cm.set(participants[h]!, c);
          }
          candA.set(A, cm);
          stratSpec = { cand, mOc: DEFAULT_STRAT.mOc, mLow: DEFAULT_STRAT.mLow, sMarg: DEFAULT_STRAT.sMarg };
        } else {
          // 到達確率が高い集合（超短スタック局面・序盤の未収束時）は従来のコンボ数比例 MC
          // （mcSamplesFor の本数）。stratSpec 無し＝従来経路。
          candA.delete(A);
        }
      }
      jobs.push({ A, node, participants, ranges, jobSeed: mix(seed, epoch, A), samples: s, strat: stratSpec });
    }

    // item1: denseCandidates（dense 判定された exact3 集合）を worker プールへ割る分割数。
    // ワーカープールはタスクキュー（drain）で自然に負荷分散するため、集合数が worker 台数
    // 以上でも「大きな塊のジョブを少数」より「小さなジョブを多数」の方がテール待ち
    // （最後に残ったジョブが大きいほど idle worker が発生する）が減って有利なことを実測
    // （6-player 局面, dense 集合 15〜20 個の場面で「無分割」と「8 分割」は同等〜8 分割が
    // やや優位）。よって集合数によらず一律 min(並列度, 8) 分割にする。並列度は mcRunner
    // 注入時は mcRunnerParallelism（ブラウザ Web Worker プールのサイズ）、それ以外は
    // workers（Node の worker_threads プール台数）。
    const chunkParallelism = mcRunner ? mcRunnerParallelism : workers;
    const EXACT3_CHUNKS_PER_SET = Math.max(1, Math.min(EXACT3_MAX_CHUNKS_PER_SET, chunkParallelism));
    if (EXACT3_CHUNKS_PER_SET <= 1) {
      for (const dc of denseCandidates) {
        jobs.push({ A: dc.A, node: dc.node, participants: dc.participants, ranges: dc.ranges, jobSeed: mix(seed, epoch, dc.A), samples: 0, exact3: true });
      }
    } else {
      for (const dc of denseCandidates) chunkPlan.push({ ...dc, nchunks: EXACT3_CHUNKS_PER_SET });
    }

    if (onExact3Stats && (exact3Count > 0 || mc3Count > 0)) {
      onExact3Stats({ epoch, exact: exact3Count, mc: mc3Count, total: exact3Count + mc3Count });
    }
    if (jobs.length === 0 && chunkPlan.length === 0) return;

    // 注入された並列ランナー（ブラウザ Web Worker プール等）があれば最優先で使う。
    // exact3:true のジョブを含む場合、mcRunner 実装側がそのフラグに対応している必要がある
    // （ShowdownMcJob のドキュメント参照）。chunkPlan（dense 判定された集合）も
    // 内部 worker プールと同じ考え方でチャンク化して mcRunner に渡す
    // （EXACT3_CHUNKS_PER_SET 参照, mcRunnerParallelism<=1 なら chunkPlan は空のまま）。
    if (mcRunner) {
      const mcJobs: ShowdownMcJob[] = jobs.map((j) => ({
        node: j.node, ranges: j.ranges, samples: j.samples, seed: j.jobSeed, strat: j.strat, exact3: j.exact3,
      }));
      const chunkBoundsPerSet = chunkPlan.map((cp) => chunkBounds(N_CLASSES, cp.nchunks));
      const chunkJobs: ShowdownMcJob[] = [];
      for (let ci = 0; ci < chunkPlan.length; ci++) {
        const cp = chunkPlan[ci]!;
        for (const b of chunkBoundsPerSet[ci]!) {
          chunkJobs.push({ node: cp.node, ranges: cp.ranges, samples: 0, seed: 0, exact3Chunk: b });
        }
      }
      const allResults = await mcRunner([...mcJobs, ...chunkJobs]);
      for (let i = 0; i < jobs.length; i++) store(jobs[i]!.A, jobs[i]!.participants, allResults[i] as ShowdownMcResult);
      let idx = jobs.length;
      for (let ci = 0; ci < chunkPlan.length; ci++) {
        const cp = chunkPlan[ci]!;
        const n = chunkBoundsPerSet[ci]!.length;
        const chunks = allResults.slice(idx, idx + n) as Exact3DenseChunk[];
        idx += n;
        store(cp.A, cp.participants, mergeShowdown3ExactDenseChunks(cp.node, chunks));
      }
      return;
    }

    const wp = await ensurePool();
    if (!wp) {
      // pool が使えない（workers<=1、または初期化失敗）: 単一スレッドで inline 計算。
      // exact3 ジョブはここでは通常発生しない（parallelLikely が false なら上で inline 済み）が、
      // ensurePool() が「今回だけ」失敗した場合（poolDisabled が今まさに true になった）に備え、
      // exact3 ジョブも正しく computeShowdown3Exact で処理する安全網。chunkPlan の集合も
      // ここでは分割せず、そのまま computeShowdown3Exact の whole-set 呼び出しに落とす
      // （item1 冒頭コメント: 単一スレッド経路は常に inline whole-set call）。
      for (const j of jobs) {
        const res = j.exact3 ? computeShowdown3Exact(j.node, j.ranges, winTie3!) : computeShowdownMc(j.node, j.ranges, j.samples, j.jobSeed, j.strat);
        store(j.A, j.participants, res);
      }
      for (const cp of chunkPlan) {
        store(cp.A, cp.participants, computeShowdown3Exact(cp.node, cp.ranges, winTie3!));
      }
      return;
    }
    const normalP = jobs.map(async (j) => {
      const res = await wp.run({ node: j.node, ranges: j.ranges, samples: j.samples, seed: j.jobSeed, strat: j.strat, exact3: j.exact3 });
      store(j.A, j.participants, res);
    });
    // item1: dense 集合 1 個を cp.nchunks 個の 'a' 範囲ジョブに割って worker プールへ投げ、
    // 全チャンクが揃ってから merge して store する（1 集合の壁時計コストが最大
    // 1/nchunks 近くまで縮む。nchunks は同時に dense 判定された集合数から決まっている）。
    const chunkP = chunkPlan.map(async (cp) => {
      const runChunk = wp.runExact3Chunk;
      if (!runChunk) {
        // 型上は WorkerPool が常に実装するが、安全網として通常の exact3 ジョブにフォールバック。
        const res = await wp.run({ node: cp.node, ranges: cp.ranges, samples: 0, seed: 0, exact3: true });
        store(cp.A, cp.participants, res);
        return;
      }
      const bounds = chunkBounds(N_CLASSES, cp.nchunks);
      const chunks = await Promise.all(bounds.map((b) => runChunk.call(wp, { node: cp.node, ranges: cp.ranges, lo: b.lo, hi: b.hi })));
      store(cp.A, cp.participants, mergeShowdown3ExactDenseChunks(cp.node, chunks));
    });
    await Promise.all([...normalP, ...chunkP]);
  };

  const dispose = (): void => {
    if (pool) {
      void pool.dispose();
      pool = null;
    }
  };

  // --- 終局集合 A の値ベクトル（全席）---
  const valAll = (A: number): number[] => {
    const pc = popcount(A);
    if (pc === 0) return V_walk;
    if (pc === 1) return V_win[31 - Math.clz32(A)]!;
    return smA.get(A)!;
  };

  // --- ダウンストリーム終局分布 enumerate(j, G): Map<A, prob> ---
  // aggrProb は computeEVs 内で確定させたものを渡す。
  const enumerateAll = (aggrProb: Map<number, number>): {
    down: (j: number, G: number) => Map<number, number>;
    terminal: Map<number, number>;
  } => {
    const memo = new Map<number, Map<number, number>>();
    const down = (j: number, G: number): Map<number, number> => {
      if (j === n) return new Map([[G, 1]]);
      if (j === last && G === 0) return new Map([[0, 1]]); // BB ウォーク（決定なし）
      const memoKey = j * 64 + G;
      const cached = memo.get(memoKey);
      if (cached) return cached;
      const p = aggrProb.get(nodeId(j, G)) ?? 0;
      const res = new Map<number, number>();
      const add = (src: Map<number, number>, w: number): void => {
        if (w === 0) return;
        for (const [A, q] of src) res.set(A, (res.get(A) ?? 0) + w * q);
      };
      add(down(j + 1, G | (1 << j)), p);
      add(down(j + 1, G), 1 - p);
      memo.set(memoKey, res);
      return res;
    };
    return { down, terminal: down(0, 0) };
  };

  /**
   * 適応 K: OC ノードの最適反応（aggrEV ≥ foldEV）が候補列の下位 1/4 に触れていたら、
   * その集合の候補数を次回 refresh から倍にする。候補外は「候補最小値」で埋めているので、
   * 候補が狭すぎると弱い手が過大評価されうる——それを自動で広げる安全弁。戻り値は広げた集合数。
   */
  const adaptCandidates = (ev: EVBundle): number => {
    if (!useStrat) return 0;
    let widened = 0;
    for (const nd of nodes) {
      if (nd.actionType !== 'OC' || nd.truncated) continue;
      if ((ev.reach.get(nd.id) ?? 0) === 0) continue;
      const A0 = nd.S | (1 << nd.i);
      const cand = candA.get(A0)?.get(nd.i);
      if (!cand || cand.length >= N_CLASSES) continue;
      const aev = ev.aggrEV.get(nd.id)!;
      const fev = ev.foldEV.get(nd.id)!;
      let touch = false;
      for (let q = Math.floor(cand.length * 0.75); q < cand.length; q++) {
        if (aev[cand[q]!]! >= fev) {
          touch = true;
          break;
        }
      }
      if (touch) {
        kA.set(A0, Math.min(cand.length * 2, N_CLASSES));
        widened++;
      }
    }
    return widened;
  };

  return {
    maxActive,
    exactTwoWay: winTie !== undefined,
    exactThreeWay: winTie3 !== undefined,
    adaptCandidates,
    n,
    order,
    payouts,
    T,
    last,
    nodes,
    nodeId,
    V_win,
    V_walk,
    valAll,
    refresh,
    dispose,
    getPcEq: (A: number, seat: number): F64 => pcEqA.get(A)!.get(seat)!,
    enumerateAll,
  };
}

type Engine = ReturnType<typeof buildEngine>;

interface EVBundle {
  aggrEV: Map<number, F64>; // node id → クラス別アグレッシブ EV
  foldEV: Map<number, number>; // node id → フォールド EV（スカラ）
  aggrProb: Map<number, number>; // node id → アグレッシブ確率（レンジ比）
  reach: Map<number, number>; // node id → 到達確率
  terminal: Map<number, number>; // 終局集合 A → 確率
}

/** 現在戦略から全ノードの EV / 到達確率 / 終局分布を計算する。 */
function computeEVs(eng: Engine, strat: Map<number, F64>, cardRemoval: boolean, full = false): EVBundle {
  const aggrProb = new Map<number, number>();
  for (const nd of eng.nodes) aggrProb.set(nd.id, nd.truncated ? 0 : rangeFraction(strat.get(nd.id)!));

  const { down, terminal } = eng.enumerateAll(aggrProb);

  // --- hero カードリムーバル: 各ノードのクラス条件つきアグレッシブ確率（169）を先算 ---
  // condAggr[nodeId][c] = 後方プレイヤーが「hero がクラス c を持つ」条件下でアグレッシブに
  // 出る確率。hero のアグレッシブ EV（fold-through）計算にのみ使う（母集団 down は card-blind）。
  const condAggr = cardRemoval ? new Map<number, F64>() : null;
  if (condAggr) {
    for (const nd of eng.nodes) {
      const freq = strat.get(nd.id)!;
      const { W, U } = weightAndUses(freq);
      condAggr.set(nd.id, conditionalAggrProb(freq, W, U));
    }
  }
  // 深さ別スクラッチ（アロケーション抑制）。深さは後方席数 ≤ n。
  const scratchA: F64[] = [];
  const scratchB: F64[] = [];
  if (condAggr) {
    for (let d = 0; d <= eng.n; d++) {
      scratchA.push(new Float64Array(N_CLASSES));
      scratchB.push(new Float64Array(N_CLASSES));
    }
  }

  const aggrEV = new Map<number, F64>();
  const foldEV = new Map<number, number>();
  for (const nd of eng.nodes) {
    const { i, S } = nd;
    if (!full && popcount(S) > eng.maxActive) {
      // 上限超えの前方集合＝到達不能（上流で打ち切り済み）。求解中は評価しない。
      foldEV.set(nd.id, 0);
      aggrEV.set(nd.id, new Float64Array(N_CLASSES));
      continue;
    }
    const foldOut = down(i + 1, S); // フォールド後（S 不変, i∉A）

    // フォールド EV（クラス非依存, card-blind 母集団）
    let fev = 0;
    for (const [A, q] of foldOut) fev += q * eng.valAll(A)[i]!;
    foldEV.set(nd.id, fev);

    // アグレッシブ EV（クラス別）
    const aev = new Float64Array(N_CLASSES);
    if (nd.truncated && !full) {
      // 同時オールイン上限: 求解中は決定なし（強制フォールド）。最終パス（full）でのみ
      // 上限超えの集合を使って最適反応を評価する（表示用）。
      aev.fill(fev);
      aggrEV.set(nd.id, aev);
      continue;
    }
    if (condAggr) {
      // hero=i がアグレッシブに出た後（i∈A 確定）の後方ツリーを、hero クラス条件つき
      // アクション確率で DFS 評価する。各内部ノードで out=p·push+(1−p)·fold（ベクトル）。
      const heroAggrDfs = (j: number, G: number, out: F64, depth: number): void => {
        if (j === eng.n) {
          if (popcount(G) === 1) out.fill(eng.V_win[i]![i]!); // A={i}: 不戦勝
          else if (!full && popcount(G) > eng.maxActive) out.fill(0); // 上限超え（重み 0 の枝）
          else out.set(eng.getPcEq(G, i)); // ショーダウン: クラス別 all-in equity
          return;
        }
        const p = condAggr.get(eng.nodeId(j, G))!;
        const pushBuf = scratchA[depth]!;
        heroAggrDfs(j + 1, G | (1 << j), pushBuf, depth + 1);
        const foldBuf = scratchB[depth]!;
        heroAggrDfs(j + 1, G, foldBuf, depth + 1);
        for (let c = 0; c < N_CLASSES; c++) out[c] = p[c]! * pushBuf[c]! + (1 - p[c]!) * foldBuf[c]!;
      };
      heroAggrDfs(i + 1, S | (1 << i), aev, 0);
    } else {
      const aggrOut = down(i + 1, S | (1 << i)); // アグレッシブ後（i∈A）
      for (const [A, q] of aggrOut) {
        if (q === 0) continue;
        if (popcount(A) === 1) {
          // A = {i}: 不戦勝（S=∅ かつ後方全員フォールド）
          const v = eng.V_win[i]![i]!;
          for (let c = 0; c < N_CLASSES; c++) aev[c]! += q * v;
        } else {
          const pc = eng.getPcEq(A, i);
          for (let c = 0; c < N_CLASSES; c++) aev[c]! += q * pc[c]!;
        }
      }
    }
    aggrEV.set(nd.id, aev);
  }

  // 到達確率（前向き伝播）
  const reach = new Map<number, number>();
  reach.set(eng.nodeId(0, 0), 1);
  for (const nd of eng.nodes) {
    const r = reach.get(nd.id) ?? 0;
    if (r === 0) continue;
    const p = aggrProb.get(nd.id)!;
    const ni = nd.i + 1;
    if (ni <= eng.last) {
      // アグレッシブ枝 → (ni, S|1<<i)。ウォークノードには流さない。
      const aggrTarget = nd.i + 1 <= eng.last ? eng.nodeId(ni, nd.S | (1 << nd.i)) : -1;
      const foldTarget =
        ni === eng.last && nd.S === 0 ? -1 : eng.nodeId(ni, nd.S); // (last, ∅) はウォーク
      if (aggrTarget >= 0) reach.set(aggrTarget, (reach.get(aggrTarget) ?? 0) + r * p);
      if (foldTarget >= 0) reach.set(foldTarget, (reach.get(foldTarget) ?? 0) + r * (1 - p));
    }
  }

  return { aggrEV, foldEV, aggrProb, reach, terminal };
}

/** per-node regret × 到達確率の総和（実払い pt）。 */
function exploitability(eng: Engine, strat: Map<number, F64>, ev: EVBundle): number {
  let total = 0;
  for (const nd of eng.nodes) {
    const r = ev.reach.get(nd.id) ?? 0;
    if (r === 0) continue;
    const aev = ev.aggrEV.get(nd.id)!;
    const fev = ev.foldEV.get(nd.id)!;
    const avg = strat.get(nd.id)!;
    let regret = 0;
    for (let c = 0; c < N_CLASSES; c++) {
      const best = Math.max(aev[c]!, fev);
      const cur = avg[c]! * aev[c]! + (1 - avg[c]!) * fev;
      regret += COMBO_COUNT[c]! * (best - cur);
    }
    total += r * (regret / TOTAL_COMBOS);
  }
  return total;
}

/** ゲーム終局の各席 EQPost（実払い pt）。 */
function eqPost(eng: Engine, ev: EVBundle): number[] {
  const post = new Array<number>(eng.n).fill(0);
  for (const [A, q] of ev.terminal) {
    if (q === 0) continue;
    const v = eng.valAll(A);
    for (let s = 0; s < eng.n; s++) post[s]! += q * v[s]!;
  }
  return post;
}

/** 初期戦略（既定は全ノード 0.5）。warm があれば node.key 一致ノードをその値で初期化（複製）。 */
function initStrategies(eng: Engine, warm?: Map<string, F64>): Map<number, F64> {
  const strat = new Map<number, F64>();
  for (const nd of eng.nodes) {
    if (nd.truncated) {
      strat.set(nd.id, new Float64Array(N_CLASSES)); // 決定なし＝常にフォールド
      continue;
    }
    const w = warm?.get(nd.key);
    strat.set(nd.id, w && w.length === N_CLASSES ? Float64Array.from(w) : new Float64Array(N_CLASSES).fill(0.5));
  }
  return strat;
}

function buildResult(
  eng: Engine,
  strat: Map<number, F64>,
  finalEv: EVBundle,
  exploitabilityPt: number,
  converged: boolean,
  iterations: number,
  displayMode: 'avg' | 'lateAvg' | 'evSign',
  lateAvg: Map<number, F64> | null,
): MultiwayNSolveResult {
  const eqPre = icmEquities(eng.T, eng.payouts);
  const post = eqPost(eng, finalEv);
  const equity: Record<string, { pre: number; post: number }> = {};
  for (let s = 0; s < eng.n; s++) equity[eng.order[s]!] = { pre: eqPre[s]!, post: post[s]! };
  const quality = { exploitability: exploitabilityPt, converged, iterations };

  const nodes: SolutionNode[] = eng.nodes.map((nd) => {
    const arr = strat.get(nd.id)!; // FP 平均頻度（低ノイズ）
    const aev = finalEv.aggrEV.get(nd.id)!;
    const fev = finalEv.foldEV.get(nd.id)!;
    // 表示レンジ（支配関係で単調化して市松穴を除去, EV中立）。既定は FP 平均頻度 ≥ 0.5
    // （displayMode 'avg'）。'evSign' / 'lateAvg' は実験用（MultiwayNSolveOptions.displayMode 参照）。
    // 打ち切りノード（同時オールイン上限, 4 人目以降の OC）は最終パスの最適反応（EV 符号）。
    let pushBool: boolean[];
    const late = lateAvg?.get(nd.id);
    if (nd.truncated || displayMode === 'evSign') {
      const evDiff = new Float64Array(N_CLASSES);
      for (let c = 0; c < N_CLASSES; c++) evDiff[c] = aev[c]! - fev;
      pushBool = monotonizePush({ classOrder: HAND_CLASS_ORDER, values: evDiff, combos: COMBO_COUNT, threshold: 0 });
    } else if (displayMode === 'lateAvg' && late) {
      pushBool = monotonizePush({ classOrder: HAND_CLASS_ORDER, values: late, combos: COMBO_COUNT, threshold: 0.5 });
    } else {
      pushBool = monotonizePush({ classOrder: HAND_CLASS_ORDER, values: arr, combos: COMBO_COUNT, threshold: 0.5 });
    }
    const freq: Record<string, number> = {};
    const ev: Record<string, number> = {};
    const hands: string[] = [];
    let weighted = 0;
    for (let c = 0; c < N_CLASSES; c++) {
      const label = HAND_CLASS_ORDER[c]!;
      const push = pushBool[c]! ? 1 : 0;
      freq[label] = push;
      ev[label] = aev[c]! - fev; // アグレッシブ − フォールド の EV 差（表示用, 生値）
      if (push) hands.push(label);
      weighted += COMBO_COUNT[c]! * push;
    }
    return {
      key: nd.key,
      actor: nd.actor,
      actionType: nd.actionType,
      pct: (weighted / TOTAL_COMBOS) * 100,
      range: formatRange(hands),
      hands,
      freq,
      ev,
      equity: equity as SolutionNode['equity'],
      quality,
    };
  });

  const stratByKey = new Map<string, F64>();
  for (const nd of eng.nodes) stratByKey.set(nd.key, strat.get(nd.id)!);

  return { nodes, iterations, exploitabilityPt, converged, equity, strategies: stratByKey };
}

/**
 * N-way（3〜6人）逐次 push/fold Nash 求解。
 * playersLeft は 3..6。HU（2人）は huSolver を使う。
 */
export async function solveMultiway(
  state: BoardState,
  opts: MultiwayNSolveOptions = {},
): Promise<MultiwayNSolveResult> {
  const n = state.playersLeft;
  if (n < 3 || n > 6) {
    throw new Error(`solveMultiway requires playersLeft 3..6, got ${n}`);
  }
  const samples = opts.samples ?? defaultSamples(n);
  const maxIters = opts.maxIters ?? 1000;
  const refreshEvery = opts.refreshEvery ?? 100;
  const schedule = makeRefreshSchedule(refreshEvery, opts.refreshSchedule ?? 'fixed');
  const seed = opts.seed ?? MC_SEED;
  const workers = resolveWorkers(opts.workers);
  const cardRemoval = opts.cardRemoval ?? false;
  const commonRandom = opts.commonRandom ?? false;
  const initIters = opts.initIterations ?? 0;
  const avgPower = opts.avgPower ?? 0;
  const plateauFrac = opts.plateauStopFrac;
  const eng = buildEngine(
    state, samples, seed, workers, opts.mcRunner, opts.winTie, opts.winTie3, opts.uniformSamples,
    opts.maxActive ?? 3, opts.stratifiedMc ?? true, opts.ocCandidates ?? DEFAULT_STRAT.K,
    opts.exact3Budget ?? 6_000_000, opts.mcRunnerParallelism ?? 1, opts.onExact3Stats,
  );
  // ノードレベル MC の推定量バイアス + アクション確率のカードリムーバル近似で
  // 均衡でも ~プール比 0.1% の床を持つ（M3 申し送り）。しきい値は床の上に置く。
  //
  // ただし winTie3（3人ショーダウンも厳密）を渡していて、かつ呼び出し側が
  // targetExploitabilityPt を明示していない場合は、しきい値を約 7.5 倍狭める
  // （poolPt×0.0002, 旧既定 poolPt×0.0015 の 1/7.5）。旧しきい値 0.0015 は
  // 「MC ノイズ床の上に置く」という前提で決めた値で、2人・3人ショーダウンが厳密になった今は
  // その根拠（ノイズ）が消えている。flat-EV ノード（複数選択肢の EV 差がほぼ 0 の無差別帯）は
  // regret への寄与が小さいため、緩い閾値のままだと「収束十分」と誤判定されて未収束のまま
  // 停止する（実測: 6-player UTG23/HJ11/CO3/BU43/SB2/BB22 で 900 反復停止・BU push 76.8%
  // ↔ 収束後 78.6%）。exact2/exact3 が入っている前提なら閾値を厳しくしても MC ノイズに
  // 阻まれず到達できるため、狭めても安全に収束する。
  //
  // **しきい値の尺度**: 既定はクラブマッチの poolPt（payout の総和）に比例させてきた。クラブは総和が
  // 10〜11 で振れ幅（最上位−最下位＝3〜6）と同じ桁なので、これで妥当な値になる。しかし payout に
  // 負値を許すと総和は尺度として壊れる。レジェンドマッチの 6 人は **ゼロサム**（総和ちょうど 0）で
  // targetExpl=0 ＝ 早期終了が永久に発火せず、ランクマッチ STAGE Ⅴ の 6 人は総和 10 に対し振れ幅 63
  // （クラブの 10 倍）で、振れ幅比ではクラブの 10 倍厳しいしきい値になる（実測: 3000 反復に張り付き
  // 未収束。club 1100 / rank-4 2500 / legend-avg 1700 で収束）。
  // そこで尺度は **振れ幅（max−min）** を基準にし、クラブの「総和÷振れ幅」（同じ人数）を掛けて
  // クラブでは従来の poolPt に厳密一致させる。他モードは振れ幅あたりでクラブと同じ厳しさになる。
  const spanPt = Math.max(...eng.payouts) - Math.min(...eng.payouts);
  const clubPayouts = payoutsForPlayers(eng.payouts.length, 'club');
  const clubPool = clubPayouts.reduce((a, b) => a + b, 0);
  const clubSpan = Math.max(...clubPayouts) - Math.min(...clubPayouts);
  const scalePt = spanPt * (clubPool / clubSpan);
  const targetExpl = opts.targetExploitabilityPt ?? scalePt * (opts.winTie3 !== undefined ? 0.0002 : 0.0015);
  // CRN 時は反復間で同一シードを使い回す（epoch を固定）。非 CRN は従来どおり epoch で再サンプル。
  const iterEpoch = (t: number): number => (commonRandom ? 0 : Math.floor(t / refreshEvery));

  try {
    const strat = initStrategies(eng, opts.initStrategy);
    await eng.refresh(strat, 0);

    let iterations = 0;
    let exploitabilityPt = Number.POSITIVE_INFINITY;
    let converged = false;
    let prevExpl = Number.POSITIVE_INFINITY;
    // 後半平均（表示用）: 反復 t ≥ lateStart の BR を平均する。早期停止で後半に入らなければ null。
    const displayMode = opts.displayMode ?? 'avg';
    const lateStart = Math.floor(maxIters / 2) + 1;
    const lateAvg = new Map<number, F64>();
    let lateCount = 0;

    for (let t = 1; t <= maxIters; t++) {
      iterations = t;
      const isRefreshPoint = schedule(t);
      if (t > 1 && isRefreshPoint) await eng.refresh(strat, iterEpoch(t));
      const ev = computeEVs(eng, strat, cardRemoval);
      if (isRefreshPoint) eng.adaptCandidates(ev);
      const w = (avgPower + 1) / (t + initIters + avgPower + 1);
      const accLate = displayMode === 'lateAvg' && t >= lateStart;
      if (accLate) lateCount++;
      for (const nd of eng.nodes) {
        if (nd.truncated) continue;
        const aev = ev.aggrEV.get(nd.id)!;
        const fev = ev.foldEV.get(nd.id)!;
        const arr = strat.get(nd.id)!;
        let la = accLate ? lateAvg.get(nd.id) : undefined;
        if (accLate && !la) {
          la = new Float64Array(N_CLASSES);
          lateAvg.set(nd.id, la);
        }
        for (let c = 0; c < N_CLASSES; c++) {
          const br = aev[c]! >= fev ? 1 : 0;
          arr[c]! += w * (br - arr[c]!);
          if (la) la[c]! += (br - la[c]!) / lateCount;
        }
      }
      if (isRefreshPoint || t === maxIters) {
        exploitabilityPt = exploitability(eng, strat, computeEVs(eng, strat, cardRemoval));
        if (exploitabilityPt <= targetExpl) {
          converged = true;
          break;
        }
        // plateau 停止: 相対改善が閾値未満なら頭打ちとみなして打ち切る（CRN 前提で有効）。
        if (plateauFrac !== undefined && Number.isFinite(prevExpl)) {
          const improve = (prevExpl - exploitabilityPt) / Math.max(prevExpl, 1e-9);
          if (improve < plateauFrac) break;
        }
        prevExpl = exploitabilityPt;
      }
    }

    // 最終見積りで EV / exploitability / EQPost を確定。
    // CRN 時は学習に使った固定シードと別の独立シードで引き直し、サンプルへの過適合を避ける。
    await eng.refresh(strat, commonRandom ? 1 : 0x7fffffff, true);
    const finalEv = computeEVs(eng, strat, cardRemoval, true);
    // 打ち切りノード（4 人目以降の OC）は最終パスの最適反応を戦略として確定（表示・ウォーム用）。
    for (const nd of eng.nodes) {
      if (!nd.truncated) continue;
      const aev = finalEv.aggrEV.get(nd.id)!;
      const fev = finalEv.foldEV.get(nd.id)!;
      const arr = strat.get(nd.id)!;
      for (let c = 0; c < N_CLASSES; c++) arr[c] = aev[c]! >= fev ? 1 : 0;
    }
    exploitabilityPt = exploitability(eng, strat, finalEv);
    converged = exploitabilityPt <= targetExpl;

    return buildResult(eng, strat, finalEv, exploitabilityPt, converged, iterations, displayMode, lateCount > 0 ? lateAvg : null);
  } finally {
    eng.dispose();
  }
}

/** 照合ハーネス互換の同期 Solver ラッパは提供しない（求解は非同期）。ノードのみ返す。 */
export async function multiwayNSolverNodes(state: BoardState): Promise<SolutionNode[]> {
  return (await solveMultiway(state)).nodes;
}

export interface MultiwayStrategyEval {
  /** per-node regret × 到達確率の総和（実払い pt, >=0）。 */
  exploitabilityPt: number;
  equity: Record<string, { pre: number; post: number }>;
}

/**
 * 任意の N-way 戦略プロファイルの exploitability を評価する
 * （exploitability 自己検証 / IMPLEMENTATION_PLAN 1-7）。
 *
 * @param produce (nodeKey, actionType) → そのノードのクラス別頻度（長さ 169）。
 */
export async function evaluateMultiwayStrategy(
  state: BoardState,
  produce: (key: string, actionType: 'PU' | 'CA' | 'OC') => F64,
  opts: MultiwayNSolveOptions = {},
): Promise<MultiwayStrategyEval> {
  const n = state.playersLeft;
  if (n < 3 || n > 6) throw new Error(`evaluateMultiwayStrategy requires playersLeft 3..6, got ${n}`);
  const samples = opts.samples ?? defaultSamples(n);
  const seed = opts.seed ?? MC_SEED;
  const workers = resolveWorkers(opts.workers);
  const cardRemoval = opts.cardRemoval ?? false;
  const eng = buildEngine(
    state, samples, seed, workers, opts.mcRunner, opts.winTie, opts.winTie3, opts.uniformSamples,
    opts.maxActive ?? 3, opts.stratifiedMc ?? true, opts.ocCandidates ?? DEFAULT_STRAT.K,
    opts.exact3Budget ?? 6_000_000, opts.mcRunnerParallelism ?? 1, opts.onExact3Stats,
  );
  try {
    const strat = new Map<number, F64>();
    for (const nd of eng.nodes) {
      const arr = produce(nd.key, nd.actionType);
      if (arr.length !== N_CLASSES) throw new Error(`produce(${nd.key}) must return length ${N_CLASSES}`);
      strat.set(nd.id, arr);
    }
    await eng.refresh(strat, 0x7fffffff, true);
    const ev = computeEVs(eng, strat, cardRemoval, true);
    const exploitabilityPt = exploitability(eng, strat, ev);
    const eqPre = icmEquities(eng.T, eng.payouts);
    const post = eqPost(eng, ev);
    const equity: Record<string, { pre: number; post: number }> = {};
    for (let s = 0; s < eng.n; s++) equity[eng.order[s]!] = { pre: eqPre[s]!, post: post[s]! };
    return { exploitabilityPt, equity };
  } finally {
    eng.dispose();
  }
}

/** 環境非依存の stderr 警告（Node は process.stderr, ブラウザは console.warn）。 */
function warn(msg: string): void {
  const proc = (globalThis as { process?: { stderr?: { write?: (s: string) => void } } }).process;
  if (proc?.stderr?.write) proc.stderr.write(msg + '\n');
  else console.warn(msg);
}

/** workers オプションの解決（env フォールバック, 上限は 60% コア）。 */
function resolveWorkers(opt: number | undefined): number {
  const cap = maxWorkerCap();
  let req = opt;
  if (req === undefined) {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
      ?.OSHIHIKI_WORKERS;
    req = env ? Number(env) : 0;
  }
  if (!Number.isFinite(req) || req <= 1) return 0;
  return Math.min(Math.floor(req), cap);
}

/**
 * マシンの 60% コア数（最低 1）。SPEC 運用: ソルバーは CPU 60% まで使用可。
 * コア数は `navigator.hardwareConcurrency`（Node 21+ / ブラウザ共通）から取る。
 */
export function maxWorkerCap(): number {
  const hc = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator?.hardwareConcurrency;
  const cores = typeof hc === 'number' && hc > 0 ? hc : 4;
  return Math.max(1, Math.floor(cores * 0.6));
}
