/**
 * 3-way 逐次 push/fold Nash ソルバー（IMPLEMENTATION_PLAN 1-8 / SPEC §3.1, §4）。
 *
 * ## ゲーム木（残り3人, 行動順 [BU, SB, BB]）
 * 各未開（unopened）先手は PUSH/FOLD、誰かの push 後は CALL/FOLD、
 * 2人オールイン後の3人目は OVERCALL/FOLD。決定ノードは6つ:
 *
 *   A: BU push          key "BU:-,SB:-,BB:-"  actor BU  PU
 *   B: SB call(BU push) key "BU:P,SB:-,BB:-"  actor SB  CA
 *   C: BB call(BU push,SB fold) "BU:P,SB:F,BB:-" actor BB CA
 *   F: BB overcall(BU push,SB call) "BU:P,SB:C,BB:-" actor BB OC
 *   D: SB push(BU fold) "BU:F,SB:-,BB:-"     actor SB  PU
 *   E: BB call(BU fold,SB push) "BU:F,SB:P,BB:-" actor BB CA
 *
 * 終局:
 *   フォールドアウト（ショーダウン無し・ICM 決定的）: BU 勝ち / SB 勝ち / BB walk
 *   ショーダウン（着順分布 MC → サイドポット → ICM）:
 *     S3 BU vs BB, S4 BU vs SB, S5 BU vs SB vs BB, S7 SB vs BB
 *
 * ## 求解（SPEC §3.1）
 * fictitious play。ショーダウンの all-in equity は showdownMc のノードレベル MC で
 * 「equity 先取り」して見積り（epoch ごとに現在レンジで再サンプル）、FP 反復自体は
 * その見積り equity を用いて決定論的に回す（docs/MC_COST_FINDINGS §3 の設計）。
 * 収束は per-node regret × 到達確率の総和（実払い pt）で判定し、上限反復で閾値未達なら
 * 「収束不十分」フラグを付す（3人以上は FP の収束保証が無い / §3.1）。
 *
 * ## 既知の近似（M3 / 3-way）
 * - ツリーのアクション確率（誰が call/oc するか）はコンボ加重のレンジ比で近似し、
 *   hero 個別のカードリムーバルは反映しない（ショーダウン equity 側の MC は衝突棄却で
 *   カードリムーバルを厳密に扱う）。境界ハンドの微差は §4.3 の許容と exploitability で担保。
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
import { icmEquities, payoutsForPlayers } from './icm.js';
import { finalStacksFromShowdown } from './sidepot.js';
import { HAND_CLASS_ORDER } from './huEquity.js';
import { monotonizePush } from './monotonize.js';
import { estimateNodeEquities, type ShowdownNode } from './showdownMc.js';
import { DeterministicRng } from './placement.js';
import { MC_SEED, NODE_MC_SAMPLES } from './mcConfig.js';

const N = HAND_CLASS_ORDER.length; // 169
const TOTAL_COMBOS = 1326;
const COMBO_COUNT: number[] = HAND_CLASS_ORDER.map(
  (label) => comboCount(parseHandClass(label)!.kind),
);
const FULL_RANGE = new Float64Array(N).fill(1);
type F64 = Float64Array<ArrayBufferLike>;

/** レンジのコンボ加重比（0..1）。アクション確率の近似に使う。 */
function rangeFraction(freq: F64): number {
  let w = 0;
  for (let i = 0; i < N; i++) w += COMBO_COUNT[i]! * freq[i]!;
  return w / TOTAL_COMBOS;
}

/** レンジが空なら全レンジで代用（到達確率≈0 のノードで MC を成立させるため）。 */
function nonEmpty(freq: F64): F64 {
  let w = 0;
  for (let i = 0; i < N; i++) w += freq[i]!;
  return w > 1e-9 ? freq : FULL_RANGE;
}

function antePaid(state: BoardState, pos: Position): number {
  const { scheme, amount } = state.ante;
  if (scheme === 'none') return 0;
  if (scheme === 'all') return amount;
  return pos === 'BB' ? amount : 0;
}

/** 単独勝者のフォールドアウト ICM（実払い pt, 全席）。 */
function foldoutIcm(
  T: number[],
  commits: number[],
  winner: number,
  payouts: readonly number[],
): number[] {
  const eligible = [false, false, false];
  eligible[winner] = true;
  const sc = [0, 0, 0];
  return icmEquities(finalStacksFromShowdown(T, commits, eligible, sc), payouts);
}

/** 3-way の6戦略（クラス別頻度）。 */
export interface ThreeWayStrategies {
  pushA: F64; // BU push
  callB: F64; // SB call (BU push)
  callC: F64; // BB call (BU push, SB fold)
  pushD: F64; // SB push (BU fold)
  callE: F64; // BB call (BU fold, SB push)
  ocF: F64; // BB overcall (BU push, SB call)
}

interface NodeEV {
  aggr: F64;
  fold: F64;
}
interface AllEVs {
  A: NodeEV;
  B: NodeEV;
  C: NodeEV;
  D: NodeEV;
  E: NodeEV;
  F: NodeEV;
  probs: { pcA: number; fB: number; fC: number; fF: number; fD: number; fE: number };
}

/** 状態から終局構造と MC ヘルパを組んだ「エンジン」。solve と evaluate で共用する。 */
function buildEngine(state: BoardState, samples: number, seed: number) {
  const order = positionsForPlayersLeft(3); // [BU, SB, BB]
  const payouts = payoutsForPlayers(3); // [5,3,2]
  const seatOf = (pos: Position) => {
    const s = state.seats.find((x) => x.pos === pos && x.state !== 'empty');
    if (!s) throw new Error(`solveThreeWay: missing live seat ${pos}`);
    return s;
  };
  const seatObjs = order.map(seatOf);
  const T = seatObjs.map((s, i) => s.stack + s.bet + antePaid(state, order[i]!));
  const dead = seatObjs.map((s, i) => s.bet + antePaid(state, order[i]!));
  const BU = 0;
  const SB = 1;
  const BB = 2;

  const V_BUwin = foldoutIcm(T, [T[BU]!, dead[SB]!, dead[BB]!], BU, payouts);
  const V_SBwin = foldoutIcm(T, [dead[BU]!, T[SB]!, dead[BB]!], SB, payouts);
  const V_walk = foldoutIcm(T, [dead[BU]!, dead[SB]!, dead[BB]!], BB, payouts);

  const S3: ShowdownNode = { preHandStacks: T, commits: [T[BU]!, dead[SB]!, T[BB]!], participants: [BU, BB], payouts };
  const S4: ShowdownNode = { preHandStacks: T, commits: [T[BU]!, T[SB]!, dead[BB]!], participants: [BU, SB], payouts };
  const S5: ShowdownNode = { preHandStacks: T, commits: [T[BU]!, T[SB]!, T[BB]!], participants: [BU, SB, BB], payouts };
  const S7: ShowdownNode = { preHandStacks: T, commits: [dead[BU]!, T[SB]!, T[BB]!], participants: [SB, BB], payouts };

  // epoch MC の見積り
  const mc = {
    pcS3_BU: new Float64Array(N) as F64,
    pcS3_BB: new Float64Array(N) as F64,
    pcS4_BU: new Float64Array(N) as F64,
    pcS4_SB: new Float64Array(N) as F64,
    pcS5_BU: new Float64Array(N) as F64,
    pcS5_SB: new Float64Array(N) as F64,
    pcS5_BB: new Float64Array(N) as F64,
    pcS7_SB: new Float64Array(N) as F64,
    pcS7_BB: new Float64Array(N) as F64,
    smS3: [0, 0, 0],
    smS4: [0, 0, 0],
    smS5: [0, 0, 0],
    smS7: [0, 0, 0],
  };

  const heroClassEq = (node: ShowdownNode, heroPartIdx: number, ranges: F64[], rng: DeterministicRng): F64 => {
    const r = ranges.map((x) => nonEmpty(x));
    r[heroPartIdx] = FULL_RANGE;
    return estimateNodeEquities(node, r, samples, rng).eq[heroPartIdx]!;
  };
  const seatMarginals = (node: ShowdownNode, ranges: F64[], rng: DeterministicRng): number[] =>
    estimateNodeEquities(node, ranges.map((x) => nonEmpty(x)), samples, rng).seatMarginal;

  const refresh = (st: ThreeWayStrategies, epoch: number): void => {
    const rng = new DeterministicRng((seed ^ (epoch * 0x9e3779b1)) >>> 0);
    mc.pcS3_BU = heroClassEq(S3, 0, [st.pushA, st.callC], rng);
    mc.pcS3_BB = heroClassEq(S3, 1, [st.pushA, st.callC], rng);
    mc.smS3 = seatMarginals(S3, [st.pushA, st.callC], rng);
    mc.pcS4_BU = heroClassEq(S4, 0, [st.pushA, st.callB], rng);
    mc.pcS4_SB = heroClassEq(S4, 1, [st.pushA, st.callB], rng);
    mc.smS4 = seatMarginals(S4, [st.pushA, st.callB], rng);
    mc.pcS5_BU = heroClassEq(S5, 0, [st.pushA, st.callB, st.ocF], rng);
    mc.pcS5_SB = heroClassEq(S5, 1, [st.pushA, st.callB, st.ocF], rng);
    mc.pcS5_BB = heroClassEq(S5, 2, [st.pushA, st.callB, st.ocF], rng);
    mc.smS5 = seatMarginals(S5, [st.pushA, st.callB, st.ocF], rng);
    mc.pcS7_SB = heroClassEq(S7, 0, [st.pushD, st.callE], rng);
    mc.pcS7_BB = heroClassEq(S7, 1, [st.pushD, st.callE], rng);
    mc.smS7 = seatMarginals(S7, [st.pushD, st.callE], rng);
  };

  const computeEVs = (st: ThreeWayStrategies): AllEVs => {
    const pcA = rangeFraction(st.pushA);
    const fB = rangeFraction(st.callB);
    const fC = rangeFraction(st.callC);
    const fF = rangeFraction(st.ocF);
    const fD = rangeFraction(st.pushD);
    const fE = rangeFraction(st.callE);

    const mk = (): NodeEV => ({ aggr: new Float64Array(N), fold: new Float64Array(N) });
    const A = mk();
    const B = mk();
    const C = mk();
    const D = mk();
    const E = mk();
    const F = mk();

    const evFoldF = mc.smS4[BB]!;
    const evFoldC = V_BUwin[BB]!;
    const evFoldB = fC * mc.smS3[SB]! + (1 - fC) * V_BUwin[SB]!;
    const evFoldA = (1 - fD) * V_walk[BU]! + fD * (fE * mc.smS7[BU]! + (1 - fE) * V_SBwin[BU]!);
    const evFoldD = V_walk[SB]!;
    const evFoldE = V_SBwin[BB]!;

    for (let i = 0; i < N; i++) {
      F.aggr[i] = mc.pcS5_BB[i]!;
      F.fold[i] = evFoldF;
      C.aggr[i] = mc.pcS3_BB[i]!;
      C.fold[i] = evFoldC;
      B.aggr[i] = fF * mc.pcS5_SB[i]! + (1 - fF) * mc.pcS4_SB[i]!;
      B.fold[i] = evFoldB;
      A.aggr[i] =
        fB * (fF * mc.pcS5_BU[i]! + (1 - fF) * mc.pcS4_BU[i]!) +
        (1 - fB) * (fC * mc.pcS3_BU[i]! + (1 - fC) * V_BUwin[BU]!);
      A.fold[i] = evFoldA;
      D.aggr[i] = fE * mc.pcS7_SB[i]! + (1 - fE) * V_SBwin[SB]!;
      D.fold[i] = evFoldD;
      E.aggr[i] = mc.pcS7_BB[i]!;
      E.fold[i] = evFoldE;
    }
    return { A, B, C, D, E, F, probs: { pcA, fB, fC, fF, fD, fE } };
  };

  const exploitability = (st: ThreeWayStrategies, ev: AllEVs): number => {
    const { probs } = ev;
    const reach = {
      A: 1,
      B: probs.pcA,
      C: probs.pcA * (1 - probs.fB),
      F: probs.pcA * probs.fB,
      D: 1 - probs.pcA,
      E: (1 - probs.pcA) * probs.fD,
    };
    const nodeRegret = (nd: NodeEV, avg: F64): number => {
      let r = 0;
      for (let i = 0; i < N; i++) {
        const best = Math.max(nd.aggr[i]!, nd.fold[i]!);
        const cur = avg[i]! * nd.aggr[i]! + (1 - avg[i]!) * nd.fold[i]!;
        r += COMBO_COUNT[i]! * (best - cur);
      }
      return r / TOTAL_COMBOS;
    };
    return (
      reach.A * nodeRegret(ev.A, st.pushA) +
      reach.B * nodeRegret(ev.B, st.callB) +
      reach.C * nodeRegret(ev.C, st.callC) +
      reach.F * nodeRegret(ev.F, st.ocF) +
      reach.D * nodeRegret(ev.D, st.pushD) +
      reach.E * nodeRegret(ev.E, st.callE)
    );
  };

  const eqPost = (ev: AllEVs): number[] => {
    const p = ev.probs;
    return [0, 1, 2].map(
      (seat) =>
        p.pcA *
          (p.fB * (p.fF * mc.smS5[seat]! + (1 - p.fF) * mc.smS4[seat]!) +
            (1 - p.fB) * (p.fC * mc.smS3[seat]! + (1 - p.fC) * V_BUwin[seat]!)) +
        (1 - p.pcA) *
          (p.fD * (p.fE * mc.smS7[seat]! + (1 - p.fE) * V_SBwin[seat]!) +
            (1 - p.fD) * V_walk[seat]!),
    );
  };

  return { order, payouts, T, refresh, computeEVs, exploitability, eqPost };
}

export interface MultiwaySolveOptions {
  maxIters?: number;
  /** exploitability 早期停止しきい値（実払い pt）。既定はプール比 0.05%。 */
  targetExploitabilityPt?: number;
  /** MC equity を再サンプルする反復間隔（epoch 長）。 */
  refreshEvery?: number;
  /** ショーダウン MC のサンプル数。 */
  samples?: number;
  seed?: number;
}

export interface MultiwaySolveResult {
  nodes: SolutionNode[];
  iterations: number;
  exploitabilityPt: number;
  converged: boolean;
  equity: Record<string, { pre: number; post: number }>;
  strategies: ThreeWayStrategies;
}

export function solveThreeWay(state: BoardState, opts: MultiwaySolveOptions = {}): MultiwaySolveResult {
  if (state.playersLeft !== 3) {
    throw new Error(`solveThreeWay requires playersLeft=3, got ${state.playersLeft}`);
  }
  const samples = opts.samples ?? NODE_MC_SAMPLES;
  const maxIters = opts.maxIters ?? 1000;
  const refreshEvery = opts.refreshEvery ?? 100;
  const seed = opts.seed ?? MC_SEED;
  const eng = buildEngine(state, samples, seed);
  const poolPt = eng.payouts.reduce((a, b) => a + b, 0);
  // SPEC §3.1 の理想は実払いプール比 0.05%（=0.005pt）だが、3-way の
  // ノードレベル MC 推定量はクラス別 equity のバイアス + アクション確率の
  // カードリムーバル近似により ~0.01pt（プール比 0.1%）の構造的な床を持つ
  // （サンプル数を増やしても縮まない。M3 申し送り: 推定量のバイアス低減で締める）。
  // 収束フラグが均衡解でも常時「不十分」にならないよう、既定しきい値は床の上に置く。
  // §4.3 はマルチウェイの基準緩和を許容している。運用しながら調整可（さつき判断）。
  const targetExpl = opts.targetExploitabilityPt ?? poolPt * 0.0015;

  const st: ThreeWayStrategies = {
    pushA: new Float64Array(N).fill(0.5),
    callB: new Float64Array(N).fill(0.5),
    callC: new Float64Array(N).fill(0.5),
    pushD: new Float64Array(N).fill(0.5),
    callE: new Float64Array(N).fill(0.5),
    ocF: new Float64Array(N).fill(0.5),
  };
  const keys: (keyof ThreeWayStrategies)[] = ['pushA', 'callB', 'callC', 'pushD', 'callE', 'ocF'];
  const evKey: Record<keyof ThreeWayStrategies, keyof AllEVs> = {
    pushA: 'A',
    callB: 'B',
    callC: 'C',
    pushD: 'D',
    callE: 'E',
    ocF: 'F',
  };

  eng.refresh(st, 0);
  let iterations = 0;
  let exploitabilityPt = Number.POSITIVE_INFINITY;
  let converged = false;

  for (let t = 1; t <= maxIters; t++) {
    iterations = t;
    if (t > 1 && t % refreshEvery === 0) eng.refresh(st, Math.floor(t / refreshEvery));
    const ev = eng.computeEVs(st);
    const w = 1 / (t + 1);
    for (const k of keys) {
      const nd = ev[evKey[k]] as NodeEV;
      const arr = st[k];
      for (let i = 0; i < N; i++) {
        const br = nd.aggr[i]! >= nd.fold[i]! ? 1 : 0;
        arr[i]! += w * (br - arr[i]!);
      }
    }
    if (t % refreshEvery === 0 || t === maxIters) {
      exploitabilityPt = eng.exploitability(st, eng.computeEVs(st));
      if (exploitabilityPt <= targetExpl) {
        converged = true;
        break;
      }
    }
  }

  // 最終見積りで EV / exploitability / EQPost を確定
  eng.refresh(st, 0x7fffffff);
  const finalEv = eng.computeEVs(st);
  exploitabilityPt = eng.exploitability(st, finalEv);
  converged = exploitabilityPt <= targetExpl;

  const eqPre = icmEquities(eng.T, eng.payouts);
  const post = eng.eqPost(finalEv);
  const equity: Record<string, { pre: number; post: number }> = {};
  for (let s = 0; s < 3; s++) equity[eng.order[s]!] = { pre: eqPre[s]!, post: post[s]! };
  const quality = { exploitability: exploitabilityPt, converged, iterations };

  const makeNode = (
    actions: Partial<Record<Position, '-' | 'P' | 'C' | 'F'>>,
    actor: Position,
    actionType: 'PU' | 'CA' | 'OC',
    strat: F64,
    nodeEv: NodeEV,
  ): SolutionNode => {
    // 表示レンジは FP 平均頻度を支配関係で単調化して 0.5 で線引き（市松穴を除去, EV中立）。
    const pushBool = monotonizePush({ classOrder: HAND_CLASS_ORDER, values: strat, combos: COMBO_COUNT, threshold: 0.5 });
    const freq: Record<string, number> = {};
    const ev: Record<string, number> = {};
    const hands: string[] = [];
    let weighted = 0;
    for (let i = 0; i < N; i++) {
      const label = HAND_CLASS_ORDER[i]!;
      const push = pushBool[i]! ? 1 : 0;
      freq[label] = push;
      ev[label] = nodeEv.aggr[i]! - nodeEv.fold[i]!;
      if (push) hands.push(label);
      weighted += COMBO_COUNT[i]! * push;
    }
    return {
      key: normalizeKey(3, actions),
      actor,
      actionType,
      pct: (weighted / TOTAL_COMBOS) * 100,
      range: formatRange(hands),
      hands,
      freq,
      ev,
      equity: equity as SolutionNode['equity'],
      quality,
    };
  };

  const nodes: SolutionNode[] = [
    makeNode({}, 'BU', 'PU', st.pushA, finalEv.A),
    makeNode({ BU: 'P' }, 'SB', 'CA', st.callB, finalEv.B),
    makeNode({ BU: 'P', SB: 'F' }, 'BB', 'CA', st.callC, finalEv.C),
    makeNode({ BU: 'P', SB: 'C' }, 'BB', 'OC', st.ocF, finalEv.F),
    makeNode({ BU: 'F' }, 'SB', 'PU', st.pushD, finalEv.D),
    makeNode({ BU: 'F', SB: 'P' }, 'BB', 'CA', st.callE, finalEv.E),
  ];

  return { nodes, iterations, exploitabilityPt, converged, equity, strategies: st };
}

/** 照合ハーネス互換の Solver（3-way）。 */
export function threeWaySolver(state: BoardState): SolutionNode[] {
  return solveThreeWay(state).nodes;
}

export interface ThreeWayStrategyEval {
  /** per-node regret × 到達確率の総和（実払い pt, >=0）。 */
  exploitabilityPt: number;
  equity: Record<string, { pre: number; post: number }>;
}

/**
 * 任意の 3-way 戦略プロファイルの exploitability を評価する
 * （exploitability 自己検証 / IMPLEMENTATION_PLAN 1-7）。
 * @param strategies 6ノードのクラス別頻度（各長さ 169）。
 */
export function evaluateThreeWayStrategy(
  state: BoardState,
  strategies: ThreeWayStrategies,
  opts: { samples?: number; seed?: number } = {},
): ThreeWayStrategyEval {
  if (state.playersLeft !== 3) throw new Error('evaluateThreeWayStrategy requires playersLeft=3');
  const samples = opts.samples ?? NODE_MC_SAMPLES;
  const seed = opts.seed ?? MC_SEED;
  const eng = buildEngine(state, samples, seed);
  eng.refresh(strategies, 0x7fffffff);
  const ev = eng.computeEVs(strategies);
  const exploitabilityPt = eng.exploitability(strategies, ev);
  const eqPre = icmEquities(eng.T, eng.payouts);
  const post = eng.eqPost(ev);
  const equity: Record<string, { pre: number; post: number }> = {};
  for (let s = 0; s < 3; s++) equity[eng.order[s]!] = { pre: eqPre[s]!, post: post[s]! };
  return { exploitabilityPt, equity };
}
