/**
 * HU（ヘッズアップ）push/fold Nash ソルバー（IMPLEMENTATION_PLAN 1-6, 1-7, 1-9）。
 *
 * ゲーム構造（SPEC §4）:
 *   HU は SB(=BTN) が先に行動。SB は PUSH(オールイン) か FOLD。
 *   SB が PUSH したら BB は CALL か FOLD。ポストフロップは無い（即ショーダウン）。
 *
 * ツリー（key は SPEC §3.2: アクターのセルを "-"、それまでの行動を埋める）:
 *   PU ノード: key "SB:-,BB:-"  actor SB  actionType PU   → SB の push レンジ
 *   CA ノード: key "SB:P,BB:-"  actor BB  actionType CA   → SB push に対する BB の call レンジ
 *
 * ## ICM とスタック
 * 実払い payout（クラブマッチなら `+5,+3`）を直接使う（SPEC §2.2）。モード差は payoutsHu。
 * HU は総チップ保存のため ICM equity は終局スタックに「線形」:
 *   V_i(stack) = 3 + 2·stack/Ttot     （Ttot = Tsb + Tbb）
 * よって all-in ショーダウンのタイ（分割）は勝敗の平均に厳密一致し、
 * スカラー equity（win+tie/2）だけで厳密な ICM 期待値が計算できる。
 * → HU では win/tie/lose を別々に持つ必要はなく、既存の 169×169 スカラーテーブルで足りる。
 *
 * ## カードリムーバル
 * レンジ vs レンジの重み付けは combo レベルで厳密に行う（自ハンドが持つ2枚を
 * 相手の可能コンボから除外）。ショーダウン期待値はクラス平均 equity テーブルを引く。
 *
 * ## 求解
 * fictitious play（相手の平均戦略への最良応答を平均に取り込む）。
 * 収束は exploitability（両者の最良応答ゲイン和, 実払い pt）で判定する。
 */

import type { BoardState, SolutionNode } from '@oshihiki/core';
import {
  normalizeKey,
  formatRange,
  comboCount as classComboCount,
  parseHandClass,
} from '@oshihiki/core';
import { icmEquities, payoutsForPlayers } from './icm.js';
import { HAND_CLASS_ORDER, handClassToCombos } from './huEquity.js';
import type { LoadedHuTable } from './huTableCore.js';

export type { LoadedHuTable } from './huTableCore.js';

const N = HAND_CLASS_ORDER.length; // 169
const TOTAL_COMBOS = 1326;

/**
 * HU テーブルの既定ローダ（依存性注入）。Node では index.ts が
 * `setDefaultHuTableLoader(() => loadHuTable())` を登録する。ブラウザでは登録せず、
 * 呼び出し側が `opts.table` を必ず渡す（node:fs を静的に取り込まないため）。
 */
let defaultHuTableLoader: (() => LoadedHuTable) | null = null;
export function setDefaultHuTableLoader(fn: () => LoadedHuTable): void {
  defaultHuTableLoader = fn;
}
function resolveHuTable(table?: LoadedHuTable): LoadedHuTable {
  if (table) return table;
  if (defaultHuTableLoader) return defaultHuTableLoader();
  throw new Error(
    'HU equity テーブルが未提供です。opts.table を渡すか、既定ローダを登録してください' +
      '（Node: @oshihiki/solver の index を import すると自動登録）。',
  );
}
/** 自分が2枚持つとき、相手に配れる残りコンボ数 = C(50,2)。 */
const AVAIL = 1225;

// ---- 静的 combo 構造（モジュール読み込み時に一度だけ構築） ----

/** クラス i の具体コンボ（カード id ペア）。 */
const CLASS_COMBOS: [number, number][][] = HAND_CLASS_ORDER.map((label) =>
  handClassToCombos(label),
);
/** クラス i のコンボ数。 */
const COMBO_COUNT: number[] = HAND_CLASS_ORDER.map(
  (label) => classComboCount(parseHandClass(label)!.kind),
);
/** コンボ (a<b) → クラス index。 */
const COMBO_CLASS = new Int16Array(52 * 52).fill(-1);
/** カード → そのカードを含むコンボの [相手カード, クラス] 一覧。 */
const COMBOS_BY_CARD: { other: number; cls: number }[][] = Array.from(
  { length: 52 },
  () => [],
);
for (let i = 0; i < N; i++) {
  for (const [a, b] of CLASS_COMBOS[i]!) {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    COMBO_CLASS[lo * 52 + hi] = i;
    COMBOS_BY_CARD[a]!.push({ other: b, cls: i });
    COMBOS_BY_CARD[b]!.push({ other: a, cls: i });
  }
}
function comboClass(a: number, b: number): number {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return COMBO_CLASS[lo * 52 + hi]!;
}

// ---- accumulate: カードリムーバル厳密のレンジ集計 ----

interface Accum {
  /** 各アクションクラス i について、相手コンボ（衝突除外）の Σ oppProb·value のコンボ平均。 */
  num: Float64Array;
  /** 同上の Σ oppProb（= 相手がその枝に入る期待コンボ数）のコンボ平均。 */
  den: Float64Array;
}

/**
 * @param oppProb  相手クラスの枝確率（call なら callProb, push なら pushProb）0..1
 * @param value    value[i*N + j] = アクションクラス i vs 相手クラス j の価値（実払い pt）
 */
function accumulate(oppProb: Float64Array, value: Float64Array): Accum {
  // SA[card] = Σ_{相手コンボ d が card を含む} oppProb[cls d]
  const SA = new Float64Array(52);
  let totalDen = 0;
  for (let j = 0; j < N; j++) {
    const p = oppProb[j]!;
    if (p !== 0) totalDen += COMBO_COUNT[j]! * p;
    for (const [a, b] of CLASS_COMBOS[j]!) {
      SA[a]! += p;
      SA[b]! += p;
    }
  }

  const num = new Float64Array(N);
  const den = new Float64Array(N);
  const NAi = new Float64Array(52); // カード別 Σ oppProb·value（クラス i ごとに再構築）

  for (let i = 0; i < N; i++) {
    // totalNum_i = Σ_j COMBO_COUNT[j]·oppProb[j]·value[i][j]
    let totalNum = 0;
    NAi.fill(0);
    const rowBase = i * N;
    for (let j = 0; j < N; j++) {
      const p = oppProb[j]!;
      if (p === 0) continue;
      const v = value[rowBase + j]!;
      const pv = p * v;
      totalNum += COMBO_COUNT[j]! * pv;
      for (const [a, b] of CLASS_COMBOS[j]!) {
        NAi[a]! += pv;
        NAi[b]! += pv;
      }
    }
    const pI = oppProb[i]!;
    const vII = value[rowBase + i]!;
    let sumNum = 0;
    let sumDen = 0;
    for (const [a, b] of CLASS_COMBOS[i]!) {
      // 衝突（a か b を含む相手コンボ）を除外。(a,b) 自身は二重計上ぶんを戻す。
      const collNum = NAi[a]! + NAi[b]! - pI * vII;
      const collDen = SA[a]! + SA[b]! - pI;
      sumNum += totalNum - collNum;
      sumDen += totalDen - collDen;
    }
    num[i] = sumNum / COMBO_COUNT[i]!;
    den[i] = sumDen / COMBO_COUNT[i]!;
  }
  return { num, den };
}

// ---- 盤面から HU の金額・終局価値を復元 ----

interface HuTerminals {
  Tsb: number;
  Tbb: number;
  /** SB fold: [SB, BB] equity */
  vSbFold: number; // SB
  vBbAfterSbFold: number; // BB（SB fold 時の BB equity）
  vSbPushBbFold: number; // SB（push 通し）
  vBbFold: number; // BB（BB fold）
  vSbWin: number; // SB が called で勝ち
  vSbLose: number; // SB が called で負け
  vBbWin: number; // BB が called で勝ち
  vBbLose: number; // BB が called で負け
  eqPre: { sb: number; bb: number };
}

/**
 * 残り2人のペイアウト。**HU の戦略はモードに依らない**（2着払いは必ずアフィン等価で、
 * ICM エクイティが b + (a−b)·s/S ＝ スタックの線形関数になるため）。それでも表示 pt の単位を
 * 他人数とそろえるためモードのペイアウトを使う（事前計算 HU 表もそのまま流用できる）。
 */
function payoutsHu(state: BoardState): number[] {
  return payoutsForPlayers(2, state.gameMode);
}

function antePaid(state: BoardState, pos: 'SB' | 'BB'): number {
  const { scheme, amount } = state.ante;
  if (scheme === 'none') return 0;
  if (scheme === 'all') return amount; // 全員が amount を支払う
  // 'bb': アンティ総額は BB 相当が支払う扱い
  return pos === 'BB' ? amount : 0;
}

function buildTerminals(state: BoardState): HuTerminals {
  const sbSeat = state.seats.find((s) => s.pos === 'SB' && s.state !== 'empty');
  const bbSeat = state.seats.find((s) => s.pos === 'BB' && s.state !== 'empty');
  if (!sbSeat || !bbSeat) throw new Error('HU solver requires active SB and BB seats');

  const anteSB = antePaid(state, 'SB');
  const anteBB = antePaid(state, 'BB');
  const { sb, bb } = state.blinds;

  // ハンド開始時の総スタック（EQPre はこれで計算し HRC と一致することを M1 で確認済み）
  const Tsb = sbSeat.stack + sbSeat.bet + anteSB;
  const Tbb = bbSeat.stack + bbSeat.bet + anteBB;
  const bSB = Tsb - sb - anteSB; // SB fold 時に残る額
  const bBB = Tbb - bb - anteBB; // BB fold 時に残る額
  const E = Math.min(Tsb, Tbb); // 実効オールイン額

  const payouts = payoutsHu(state);
  const eqi = (a: number, b: number): [number, number] => {
    const e = icmEquities([a, b], payouts);
    return [e[0]!, e[1]!];
  };

  const [preSb, preBb] = eqi(Tsb, Tbb);
  const [sbFoldSb, sbFoldBb] = eqi(bSB, Tbb + sb + anteSB);
  const [bbFoldSb, bbFoldBb] = eqi(Tsb + bb + anteBB, bBB);
  const [sbWinSb] = eqi(Tsb + E, Tbb - E);
  const [sbLoseSb, sbLoseBbForWin] = eqi(Tsb - E, Tbb + E);

  return {
    Tsb,
    Tbb,
    vSbFold: sbFoldSb,
    vBbAfterSbFold: sbFoldBb,
    vSbPushBbFold: bbFoldSb,
    vBbFold: bbFoldBb,
    vSbWin: sbWinSb,
    vSbLose: sbLoseSb,
    vBbWin: sbLoseBbForWin, // SB が負ける = BB が勝つ の同一終局 [Tsb-E, Tbb+E]
    vBbLose: eqi(Tsb + E, Tbb - E)[1],
    eqPre: { sb: preSb, bb: preBb },
  };
}

// ---- ソルバー本体 ----

export interface HuSolveOptions {
  maxIters?: number;
  /** exploitability 早期停止しきい値（実払い pt）。 */
  targetExploitabilityPt?: number;
  checkEvery?: number;
  table?: LoadedHuTable;
}

export interface HuSolveResult {
  nodes: SolutionNode[];
  iterations: number;
  exploitabilityPt: number;
  converged: boolean;
  pushProb: Float64Array;
  callProb: Float64Array;
  eqPre: { sb: number; bb: number };
  eqPost: { sb: number; bb: number };
}

/** SB push 価値行列 value[i*N+j] = SB クラス i が push し BB クラス j に called の SB equity。 */
function buildShowdownSB(term: HuTerminals, table: LoadedHuTable): Float64Array {
  const v = new Float64Array(N * N);
  const K = term.vSbWin - term.vSbLose;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const eq = table.equity[i * table.dims + j]!; // SB(i) vs BB(j) スカラー equity
      v[i * N + j] = term.vSbLose + K * eq;
    }
  }
  return v;
}

/** BB call 価値行列 value[i*N+j] = BB クラス i が call し SB クラス j の push に対する BB equity。 */
function buildShowdownBB(term: HuTerminals, table: LoadedHuTable): Float64Array {
  const v = new Float64Array(N * N);
  const K = term.vBbWin - term.vBbLose;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      // BB(i) vs SB(j) の BB equity = 1 - equity[SB=j vs BB=i]
      const eqBB = 1 - table.equity[j * table.dims + i]!;
      v[i * N + j] = term.vBbLose + K * eqBB;
    }
  }
  return v;
}

export function solveHu(state: BoardState, opts: HuSolveOptions = {}): HuSolveResult {
  if (state.playersLeft !== 2) {
    throw new Error(`solveHu requires playersLeft=2, got ${state.playersLeft}`);
  }
  const table = resolveHuTable(opts.table);
  const term = buildTerminals(state);
  const showdownSB = buildShowdownSB(term, table);
  const showdownBB = buildShowdownBB(term, table);

  const maxIters = opts.maxIters ?? 1000;
  const checkEvery = opts.checkEvery ?? 25;
  // 既定の収束目標は実払い pt。SPEC §3.1 のゲート（プール比 0.05% = pool16 で 0.008pt）を
  // 十分下回る 1e-3pt を既定にする（余裕を持って品質担保）。
  // しきい値は pt の絶対値なので、**ペイアウトの振れ幅に比例させないとモードで厳しさが変わる**
  // （レジェンドは 2 人ぶんの振れ幅が club の 12.5 倍＝同じ 1e-3 では 12.5 倍厳しく、収束前に
  // 反復上限へ張り付く）。club は比 1 なので**従来の挙動は変わらない**。
  const huPayouts = payoutsHu(state);
  const clubHu = payoutsForPlayers(2, 'club');
  const spanRatio = (huPayouts[0]! - huPayouts[1]!) / (clubHu[0]! - clubHu[1]!);
  const targetExpl = opts.targetExploitabilityPt ?? 1e-3 * spanRatio;

  // EV_SBpush(i) = (numCall[i] + vSbPushBbFold·(AVAIL - denCall[i])) / AVAIL
  const evSbPush = (acc: Accum, i: number): number =>
    (acc.num[i]! + term.vSbPushBbFold * (AVAIL - acc.den[i]!)) / AVAIL;
  // EV_BBcall 条件付き（SB が push した前提）= numPush[i]/denPush[i]
  const evBbCallCond = (acc: Accum, i: number): number =>
    acc.den[i]! > 0 ? acc.num[i]! / acc.den[i]! : term.vBbFold;

  const avgPush = new Float64Array(N).fill(1);
  const avgCall = new Float64Array(N).fill(1);
  const brPush = new Float64Array(N);
  const brCall = new Float64Array(N);

  let iterations = 0;
  let exploitabilityPt = Number.POSITIVE_INFINITY;
  let converged = false;
  let eqPost = { sb: term.eqPre.sb, bb: term.eqPre.bb };

  /** 現在の平均戦略の exploitability（実払い pt）を返し、eqPost を更新する。 */
  const computeExploitability = (): number => {
    const accCall = accumulate(avgCall, showdownSB); // SB 視点（相手=BB call）
    const accPush = accumulate(avgPush, showdownBB); // BB 視点（相手=SB push）
    let valueSB = 0;
    let brValueSB = 0;
    let valueBB = 0;
    let brValueBB = 0;
    for (let i = 0; i < N; i++) {
      const w = COMBO_COUNT[i]!;
      // SB
      const evPush = evSbPush(accCall, i);
      valueSB += w * (avgPush[i]! * evPush + (1 - avgPush[i]!) * term.vSbFold);
      brValueSB += w * Math.max(evPush, term.vSbFold);
      // BB
      const dp = accPush.den[i]!;
      const pushShare = dp / AVAIL;
      const cond = dp > 0 ? accPush.num[i]! / dp : term.vBbFold;
      const vbb =
        (1 - pushShare) * term.vBbAfterSbFold +
        avgCall[i]! * (accPush.num[i]! / AVAIL) +
        pushShare * (1 - avgCall[i]!) * term.vBbFold;
      valueBB += w * vbb;
      const brvbb =
        (1 - pushShare) * term.vBbAfterSbFold + pushShare * Math.max(cond, term.vBbFold);
      brValueBB += w * brvbb;
    }
    valueSB /= TOTAL_COMBOS;
    brValueSB /= TOTAL_COMBOS;
    valueBB /= TOTAL_COMBOS;
    brValueBB /= TOTAL_COMBOS;
    eqPost = { sb: valueSB, bb: valueBB };
    return brValueSB - valueSB + (brValueBB - valueBB);
  };

  for (let t = 1; t <= maxIters; t++) {
    iterations = t;
    // 現在の平均戦略に対する最良応答
    const accCall = accumulate(avgCall, showdownSB);
    const accPush = accumulate(avgPush, showdownBB);
    for (let i = 0; i < N; i++) {
      brPush[i] = evSbPush(accCall, i) >= term.vSbFold ? 1 : 0;
      brCall[i] = evBbCallCond(accPush, i) >= term.vBbFold ? 1 : 0;
    }
    const w = 1 / (t + 1);
    for (let i = 0; i < N; i++) {
      avgPush[i]! += w * (brPush[i]! - avgPush[i]!);
      avgCall[i]! += w * (brCall[i]! - avgCall[i]!);
    }
    if (t % checkEvery === 0 || t === maxIters) {
      exploitabilityPt = computeExploitability();
      if (exploitabilityPt <= targetExpl) {
        converged = true;
        break;
      }
    }
  }
  // 最終 exploitability / eqPost を確定
  exploitabilityPt = computeExploitability();

  // ---- 解ノード組み立て ----
  const accCall = accumulate(avgCall, showdownSB);
  const accPush = accumulate(avgPush, showdownBB);

  // PU ノード（SB）
  const puFreq: Record<string, number> = {};
  const puEv: Record<string, number> = {};
  const puHands: string[] = [];
  let puWeighted = 0;
  for (let i = 0; i < N; i++) {
    const f = avgPush[i]!;
    puFreq[HAND_CLASS_ORDER[i]!] = f;
    puEv[HAND_CLASS_ORDER[i]!] = evSbPush(accCall, i) - term.vSbFold;
    if (f >= 0.5) puHands.push(HAND_CLASS_ORDER[i]!);
    puWeighted += COMBO_COUNT[i]! * f;
  }
  const puPct = (puWeighted / TOTAL_COMBOS) * 100;

  // CA ノード（BB）
  const caFreq: Record<string, number> = {};
  const caEv: Record<string, number> = {};
  const caHands: string[] = [];
  let caWeighted = 0;
  for (let i = 0; i < N; i++) {
    const f = avgCall[i]!;
    caFreq[HAND_CLASS_ORDER[i]!] = f;
    caEv[HAND_CLASS_ORDER[i]!] = evBbCallCond(accPush, i) - term.vBbFold;
    if (f >= 0.5) caHands.push(HAND_CLASS_ORDER[i]!);
    caWeighted += COMBO_COUNT[i]! * f;
  }
  const caPct = (caWeighted / TOTAL_COMBOS) * 100;

  const equity = {
    SB: { pre: term.eqPre.sb, post: eqPost.sb },
    BB: { pre: term.eqPre.bb, post: eqPost.bb },
  } as SolutionNode['equity'];
  const quality = {
    exploitability: exploitabilityPt,
    converged,
    iterations,
  };

  const puNode: SolutionNode = {
    key: normalizeKey(2, {}), // "SB:-,BB:-"
    actor: 'SB',
    actionType: 'PU',
    pct: puPct,
    range: formatRange(puHands),
    hands: puHands,
    freq: puFreq,
    ev: puEv,
    equity,
    quality,
  };
  const caNode: SolutionNode = {
    key: normalizeKey(2, { SB: 'P' }), // "SB:P,BB:-"
    actor: 'BB',
    actionType: 'CA',
    pct: caPct,
    range: formatRange(caHands),
    hands: caHands,
    freq: caFreq,
    ev: caEv,
    equity,
    quality,
  };

  return {
    nodes: [puNode, caNode],
    iterations,
    exploitabilityPt,
    converged,
    pushProb: avgPush,
    callProb: avgCall,
    eqPre: term.eqPre,
    eqPost,
  };
}

/** 照合ハーネス互換の Solver。 */
export function huSolver(state: BoardState): SolutionNode[] {
  return solveHu(state).nodes;
}

export interface HuStrategyEval {
  /** 両者の最良応答ゲイン和（実払い pt, >=0）。 */
  exploitabilityPt: number;
  /** SB 単独の最良応答ゲイン。 */
  brGainSbPt: number;
  /** BB 単独の最良応答ゲイン。 */
  brGainBbPt: number;
  eqPost: { sb: number; bb: number };
}

/**
 * 任意の戦略プロファイル (pushProb, callProb) の exploitability を評価する。
 * exploitability 自己検証（IMPLEMENTATION_PLAN 1-7）のテストに使う。
 * @param pushProb SB の各クラス push 頻度 [0,1]（長さ 169）
 * @param callProb BB の各クラス call 頻度 [0,1]（長さ 169）
 */
export function evaluateHuStrategy(
  state: BoardState,
  pushProb: ArrayLike<number>,
  callProb: ArrayLike<number>,
  opts: { table?: LoadedHuTable } = {},
): HuStrategyEval {
  if (state.playersLeft !== 2) throw new Error('evaluateHuStrategy requires playersLeft=2');
  if (pushProb.length !== N || callProb.length !== N) {
    throw new Error(`strategy vectors must have length ${N}`);
  }
  const table = resolveHuTable(opts.table);
  const term = buildTerminals(state);
  const showdownSB = buildShowdownSB(term, table);
  const showdownBB = buildShowdownBB(term, table);

  const push = Float64Array.from(pushProb);
  const call = Float64Array.from(callProb);
  const accCall = accumulate(call, showdownSB);
  const accPush = accumulate(push, showdownBB);

  let valueSB = 0;
  let brValueSB = 0;
  let valueBB = 0;
  let brValueBB = 0;
  for (let i = 0; i < N; i++) {
    const w = COMBO_COUNT[i]!;
    const evPush = (accCall.num[i]! + term.vSbPushBbFold * (AVAIL - accCall.den[i]!)) / AVAIL;
    valueSB += w * (push[i]! * evPush + (1 - push[i]!) * term.vSbFold);
    brValueSB += w * Math.max(evPush, term.vSbFold);

    const dp = accPush.den[i]!;
    const pushShare = dp / AVAIL;
    const cond = dp > 0 ? accPush.num[i]! / dp : term.vBbFold;
    const vbb =
      (1 - pushShare) * term.vBbAfterSbFold +
      call[i]! * (accPush.num[i]! / AVAIL) +
      pushShare * (1 - call[i]!) * term.vBbFold;
    valueBB += w * vbb;
    brValueBB +=
      w * ((1 - pushShare) * term.vBbAfterSbFold + pushShare * Math.max(cond, term.vBbFold));
  }
  valueSB /= TOTAL_COMBOS;
  brValueSB /= TOTAL_COMBOS;
  valueBB /= TOTAL_COMBOS;
  brValueBB /= TOTAL_COMBOS;
  const brGainSbPt = brValueSB - valueSB;
  const brGainBbPt = brValueBB - valueBB;
  return {
    exploitabilityPt: brGainSbPt + brGainBbPt,
    brGainSbPt,
    brGainBbPt,
    eqPost: { sb: valueSB, bb: valueBB },
  };
}
