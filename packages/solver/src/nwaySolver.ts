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
import { createRequire } from 'node:module';
import { cpus } from 'node:os';
import { icmEquities, payoutsForPlayers } from './icm.js';
import { finalStacksFromShowdown } from './sidepot.js';
import { HAND_CLASS_ORDER } from './huEquity.js';
import type { ShowdownNode } from './showdownMc.js';
import { MC_SEED, NODE_MC_SAMPLES } from './mcConfig.js';
import { computeShowdownMc, type ShowdownMcResult } from './showdownJob.js';

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
function buildEngine(state: BoardState, samples: number, seed: number, workers: number) {
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
  let pool: WorkerPool | null = null;
  let poolDisabled = workers <= 1;
  const ensurePool = (): WorkerPool | null => {
    if (poolDisabled) return null;
    if (!pool) {
      try {
        pool = new WorkerPool(workers);
      } catch (e) {
        poolDisabled = true;
        process.stderr.write(
          `[nwaySolver] worker 並列を無効化し単一スレッドで続行: ${e instanceof Error ? e.message : String(e)}\n`,
        );
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

    const wp = ensurePool();
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
function computeEVs(eng: Engine, strat: Map<number, F64>): EVBundle {
  const aggrProb = new Map<number, number>();
  for (const nd of eng.nodes) aggrProb.set(nd.id, rangeFraction(strat.get(nd.id)!));

  const { down, terminal } = eng.enumerateAll(aggrProb);

  const aggrEV = new Map<number, F64>();
  const foldEV = new Map<number, number>();
  for (const nd of eng.nodes) {
    const { i, S } = nd;
    const foldOut = down(i + 1, S); // フォールド後（S 不変, i∉A）
    const aggrOut = down(i + 1, S | (1 << i)); // アグレッシブ後（i∈A）

    // フォールド EV（クラス非依存）
    let fev = 0;
    for (const [A, q] of foldOut) fev += q * eng.valAll(A)[i]!;
    foldEV.set(nd.id, fev);

    // アグレッシブ EV（クラス別）
    const aev = new Float64Array(N_CLASSES);
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

/** 初期戦略（全ノード 0.5）。 */
function initStrategies(eng: Engine): Map<number, F64> {
  const strat = new Map<number, F64>();
  for (const nd of eng.nodes) strat.set(nd.id, new Float64Array(N_CLASSES).fill(0.5));
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
  const eng = buildEngine(state, samples, seed, workers);
  const poolPt = eng.payouts.reduce((a, b) => a + b, 0);
  // ノードレベル MC の推定量バイアス + アクション確率のカードリムーバル近似で
  // 均衡でも ~プール比 0.1% の床を持つ（M3 申し送り）。しきい値は床の上に置く。
  const targetExpl = opts.targetExploitabilityPt ?? poolPt * 0.0015;

  try {
    const strat = initStrategies(eng);
    await eng.refresh(strat, 0);

    let iterations = 0;
    let exploitabilityPt = Number.POSITIVE_INFINITY;
    let converged = false;

    for (let t = 1; t <= maxIters; t++) {
      iterations = t;
      if (t > 1 && t % refreshEvery === 0) await eng.refresh(strat, Math.floor(t / refreshEvery));
      const ev = computeEVs(eng, strat);
      const w = 1 / (t + 1);
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
        exploitabilityPt = exploitability(eng, strat, computeEVs(eng, strat));
        if (exploitabilityPt <= targetExpl) {
          converged = true;
          break;
        }
      }
    }

    // 最終見積りで EV / exploitability / EQPost を確定
    await eng.refresh(strat, 0x7fffffff);
    const finalEv = computeEVs(eng, strat);
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
  const eng = buildEngine(state, samples, seed, workers);
  try {
    const strat = new Map<number, F64>();
    for (const nd of eng.nodes) {
      const arr = produce(nd.key, nd.actionType);
      if (arr.length !== N_CLASSES) throw new Error(`produce(${nd.key}) must return length ${N_CLASSES}`);
      strat.set(nd.id, arr);
    }
    await eng.refresh(strat, 0x7fffffff);
    const ev = computeEVs(eng, strat);
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

/** workers オプションの解決（env フォールバック, 上限は 60% コア）。 */
function resolveWorkers(opt: number | undefined): number {
  const cap = maxWorkerCap();
  let req = opt;
  if (req === undefined) {
    const env = process.env.OSHIHIKI_WORKERS;
    req = env ? Number(env) : 0;
  }
  if (!Number.isFinite(req) || req <= 1) return 0;
  return Math.min(Math.floor(req), cap);
}

/** マシンの 60% コア数（最低 1）。SPEC 運用: ソルバーは CPU 60% まで使用可。 */
export function maxWorkerCap(): number {
  return Math.max(1, Math.floor(cpus().length * 0.6));
}

/* ------------------------------------------------------------------ *
 * worker プール（ショーダウン MC の並列化, SPEC 運用: CPU 60% まで）
 * ------------------------------------------------------------------ */

interface ShowdownJobInput {
  node: ShowdownNode;
  ranges: F64[];
  samples: number;
  seed: number;
}

/**
 * worker_threads プール。worker が利用不可・失敗する環境では、呼び出し側が
 * workers<=1 を選ぶことで単一スレッドに退避する（テストは単一スレッド既定）。
 */
class WorkerPool {
  private workers: import('node:worker_threads').Worker[] = [];
  private idle: import('node:worker_threads').Worker[] = [];
  private queue: { input: ShowdownJobInput; resolve: (r: ShowdownMcResult) => void; reject: (e: unknown) => void }[] = [];
  private pending = new Map<
    import('node:worker_threads').Worker,
    { resolve: (r: ShowdownMcResult) => void; reject: (e: unknown) => void }
  >();

  constructor(size: number) {
    const req = createRequire(import.meta.url);
    const { Worker } = req('node:worker_threads') as typeof import('node:worker_threads');
    const url = req('node:url') as typeof import('node:url');
    const path = req('node:path') as typeof import('node:path');
    const fs = req('node:fs') as typeof import('node:fs');
    // worker は必ずコンパイル済み dist/nwayWorker.js を起動する。
    // 呼び出し元がソース（tsx: .../src/nwaySolver.ts）か dist（.../dist/nwaySolver.js）かで
    // このモジュールの位置が変わるため、両候補を試して存在する方を使う。
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const candidates = [
      path.join(here, 'nwayWorker.js'), // dist 実行時: 同ディレクトリ
      path.join(here, '..', 'dist', 'nwayWorker.js'), // src 実行時（tsx）: 隣の dist
    ];
    const workerPath = candidates.find((p) => fs.existsSync(p));
    if (!workerPath) {
      throw new Error(
        `nwayWorker.js が見つかりません（candidates: ${candidates.join(', ')}）。` +
          '`npx tsc -b packages/solver` で dist を生成してください。',
      );
    }
    // worker はコンパイル済み dist（.js）を素の Node で走らせる。@oshihiki/core の
    // package exports は既定で src/index.ts を指す（tsx/vitest 用）ため、worker では
    // カスタム条件 `oshihiki-dist` を立てて core を dist/index.js に解決させる
    // （tsx ローダは worker スレッドへ伝播しないため）。core dist が無ければ並列不可。
    const coreDist = path.join(here, '..', '..', 'core', 'dist', 'index.js');
    if (!fs.existsSync(coreDist)) {
      throw new Error(
        `@oshihiki/core の dist が未生成（${coreDist}）。` +
          '`npx tsc -b` で core をビルドしてください。',
      );
    }
    const execArgv = ['--conditions', 'oshihiki-dist'];
    for (let i = 0; i < size; i++) {
      const w = new Worker(workerPath, { execArgv });
      w.on('message', (msg: { ok: true; result: ShowdownMcResult } | { ok: false; error: string }) => {
        const p = this.pending.get(w);
        this.pending.delete(w);
        this.idle.push(w);
        this.drain();
        if (!p) return;
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error));
      });
      w.on('error', (err) => {
        const p = this.pending.get(w);
        this.pending.delete(w);
        if (p) p.reject(err);
      });
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  run(input: ShowdownJobInput): Promise<ShowdownMcResult> {
    return new Promise((resolve, reject) => {
      this.queue.push({ input, resolve, reject });
      this.drain();
    });
  }

  private drain(): void {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const w = this.idle.pop()!;
      const job = this.queue.shift()!;
      this.pending.set(w, { resolve: job.resolve, reject: job.reject });
      // Float64Array は構造化クローンで転送（コピー）。
      w.postMessage(job.input);
    }
  }

  async dispose(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.terminate()));
    this.workers = [];
    this.idle = [];
  }
}
