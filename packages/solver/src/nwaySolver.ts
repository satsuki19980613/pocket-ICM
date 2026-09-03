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
import { computeShowdownMc, type ShowdownMcResult } from './showdownJob.js';
import { weightAndUses, conditionalAggrProb } from './cardRemoval.js';

/**
 * WorkerPool の最小構造型。実体は nwayWorkerPool.ts（Node 専用, node:worker_threads 依存）で、
 * ブラウザバンドルに混入させないため型リンクは張らず、動的 import で読む（下記 ensurePool）。
 */
interface WorkerPoolLike {
  run(input: { node: ShowdownNode; ranges: F64[]; samples: number; seed: number }): Promise<ShowdownMcResult>;
  dispose(): Promise<void>;
}

const N_CLASSES = HAND_CLASS_ORDER.length; // 169
const TOTAL_COMBOS = 1326;
const COMBO_COUNT: number[] = HAND_CLASS_ORDER.map(
  (label) => comboCount(parseHandClass(label)!.kind),
);
const FULL_RANGE = new Float64Array(N_CLASSES).fill(1);
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
}

/** 1 ショーダウン MC ジョブの入力（環境非依存）。 */
export interface ShowdownMcJob {
  node: ShowdownNode;
  ranges: F64[];
  samples: number;
  seed: number;
}

/**
 * ショーダウン MC の並列ランナー（依存性注入）。渡された全ジョブを（並列に）解いて
 * 入力順の結果配列を返す。ブラウザは Web Worker プールで、Node は既定の worker_threads
 * プールで実装できる。指定時は `workers` より優先される。
 */
export type McRunner = (jobs: ShowdownMcJob[]) => Promise<ShowdownMcResult[]>;

/** N-way 求解の共通オプション。 */
export interface MultiwayNSolveOptions {
  maxIters?: number;
  /** exploitability 早期停止しきい値（実払い pt）。既定はプール比 0.15%。 */
  targetExploitabilityPt?: number;
  /** MC equity を再サンプルする反復間隔（epoch 長）。 */
  refreshEvery?: number;
  /** ショーダウン MC のサンプル数。省略時は人数に応じた既定（下記）。 */
  samples?: number;
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
) {
  const n = state.playersLeft;
  const order = positionsForPlayersLeft(n);
  const payouts = payoutsForPlayers(n);
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
      const node: NodeDesc = { i, S, id, actor: order[i]!, actionType, key };
      nodes.push(node);
      nodeById.set(id, node);
    }
  }
  const nodeId = (i: number, S: number): number => i * 64 + S;

  // --- ショーダウン集合 A（|A|≥2）の MC 見積りを保持 ---
  // pcEqA[A].get(seat) = 参加者 seat のクラス別 all-in equity（169, hero=full 条件）
  // smA[A][seat] = 全席の周辺 ICM equity（到達レンジで平均）
  const showdownSets: number[] = [];
  for (let A = 1; A < 1 << n; A++) if (popcount(A) >= 2) showdownSets.push(A);
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

  const refresh = async (strat: Map<number, F64>, epoch: number): Promise<void> => {
    const jobs = showdownSets.map((A) => {
      const { node, participants } = makeShowdownNode(A);
      const ranges = arrivalRanges(A, participants, strat);
      const jobSeed = mix(seed, epoch, A);
      return { A, node, participants, ranges, jobSeed };
    });

    const store = (A: number, participants: number[], res: ShowdownMcResult): void => {
      const m = new Map<number, F64>();
      for (let p = 0; p < participants.length; p++) m.set(participants[p]!, res.pcEq[p]!);
      pcEqA.set(A, m);
      smA.set(A, res.seatMarginal);
    };

    // 注入された並列ランナー（ブラウザ Web Worker プール等）があれば最優先で使う。
    if (mcRunner) {
      const results = await mcRunner(
        jobs.map((j) => ({ node: j.node, ranges: j.ranges, samples, seed: j.jobSeed })),
      );
      for (let i = 0; i < jobs.length; i++) store(jobs[i]!.A, jobs[i]!.participants, results[i]!);
      return;
    }

    const wp = await ensurePool();
    if (!wp) {
      for (const j of jobs) {
        const res = computeShowdownMc(j.node, j.ranges, samples, j.jobSeed);
        store(j.A, j.participants, res);
      }
      return;
    }
    await Promise.all(
      jobs.map(async (j) => {
        const res = await wp.run({ node: j.node, ranges: j.ranges, samples, seed: j.jobSeed });
        store(j.A, j.participants, res);
      }),
    );
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

  return {
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
function computeEVs(eng: Engine, strat: Map<number, F64>, cardRemoval: boolean): EVBundle {
  const aggrProb = new Map<number, number>();
  for (const nd of eng.nodes) aggrProb.set(nd.id, rangeFraction(strat.get(nd.id)!));

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
    const foldOut = down(i + 1, S); // フォールド後（S 不変, i∉A）

    // フォールド EV（クラス非依存, card-blind 母集団）
    let fev = 0;
    for (const [A, q] of foldOut) fev += q * eng.valAll(A)[i]!;
    foldEV.set(nd.id, fev);

    // アグレッシブ EV（クラス別）
    const aev = new Float64Array(N_CLASSES);
    if (condAggr) {
      // hero=i がアグレッシブに出た後（i∈A 確定）の後方ツリーを、hero クラス条件つき
      // アクション確率で DFS 評価する。各内部ノードで out=p·push+(1−p)·fold（ベクトル）。
      const heroAggrDfs = (j: number, G: number, out: F64, depth: number): void => {
        if (j === eng.n) {
          if (popcount(G) === 1) out.fill(eng.V_win[i]![i]!); // A={i}: 不戦勝
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
): MultiwayNSolveResult {
  const eqPre = icmEquities(eng.T, eng.payouts);
  const post = eqPost(eng, finalEv);
  const equity: Record<string, { pre: number; post: number }> = {};
  for (let s = 0; s < eng.n; s++) equity[eng.order[s]!] = { pre: eqPre[s]!, post: post[s]! };
  const quality = { exploitability: exploitabilityPt, converged, iterations };

  const nodes: SolutionNode[] = eng.nodes.map((nd) => {
    const arr = strat.get(nd.id)!;
    const aev = finalEv.aggrEV.get(nd.id)!;
    const fev = finalEv.foldEV.get(nd.id)!;
    const freq: Record<string, number> = {};
    const ev: Record<string, number> = {};
    const hands: string[] = [];
    let weighted = 0;
    for (let c = 0; c < N_CLASSES; c++) {
      const label = HAND_CLASS_ORDER[c]!;
      freq[label] = arr[c]!;
      ev[label] = aev[c]! - fev; // アグレッシブ − フォールド の EV 差
      if (arr[c]! >= 0.5) hands.push(label);
      weighted += COMBO_COUNT[c]! * arr[c]!;
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
  const seed = opts.seed ?? MC_SEED;
  const workers = resolveWorkers(opts.workers);
  const cardRemoval = opts.cardRemoval ?? false;
  const commonRandom = opts.commonRandom ?? false;
  const initIters = opts.initIterations ?? 0;
  const plateauFrac = opts.plateauStopFrac;
  const eng = buildEngine(state, samples, seed, workers, opts.mcRunner);
  const poolPt = eng.payouts.reduce((a, b) => a + b, 0);
  // ノードレベル MC の推定量バイアス + アクション確率のカードリムーバル近似で
  // 均衡でも ~プール比 0.1% の床を持つ（M3 申し送り）。しきい値は床の上に置く。
  const targetExpl = opts.targetExploitabilityPt ?? poolPt * 0.0015;
  // CRN 時は反復間で同一シードを使い回す（epoch を固定）。非 CRN は従来どおり epoch で再サンプル。
  const iterEpoch = (t: number): number => (commonRandom ? 0 : Math.floor(t / refreshEvery));

  try {
    const strat = initStrategies(eng, opts.initStrategy);
    await eng.refresh(strat, 0);

    let iterations = 0;
    let exploitabilityPt = Number.POSITIVE_INFINITY;
    let converged = false;
    let prevExpl = Number.POSITIVE_INFINITY;

    for (let t = 1; t <= maxIters; t++) {
      iterations = t;
      if (t > 1 && t % refreshEvery === 0) await eng.refresh(strat, iterEpoch(t));
      const ev = computeEVs(eng, strat, cardRemoval);
      const w = 1 / (t + initIters + 1);
      for (const nd of eng.nodes) {
        const aev = ev.aggrEV.get(nd.id)!;
        const fev = ev.foldEV.get(nd.id)!;
        const arr = strat.get(nd.id)!;
        for (let c = 0; c < N_CLASSES; c++) {
          const br = aev[c]! >= fev ? 1 : 0;
          arr[c]! += w * (br - arr[c]!);
        }
      }
      if (t % refreshEvery === 0 || t === maxIters) {
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
    await eng.refresh(strat, commonRandom ? 1 : 0x7fffffff);
    const finalEv = computeEVs(eng, strat, cardRemoval);
    exploitabilityPt = exploitability(eng, strat, finalEv);
    converged = exploitabilityPt <= targetExpl;

    return buildResult(eng, strat, finalEv, exploitabilityPt, converged, iterations);
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
  const eng = buildEngine(state, samples, seed, workers, opts.mcRunner);
  try {
    const strat = new Map<number, F64>();
    for (const nd of eng.nodes) {
      const arr = produce(nd.key, nd.actionType);
      if (arr.length !== N_CLASSES) throw new Error(`produce(${nd.key}) must return length ${N_CLASSES}`);
      strat.set(nd.id, arr);
    }
    await eng.refresh(strat, 0x7fffffff);
    const ev = computeEVs(eng, strat, cardRemoval);
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
