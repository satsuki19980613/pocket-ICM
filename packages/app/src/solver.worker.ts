/**
 * 求解 Web Worker（Phase 3-1a）。UI スレッドを固めないよう、ソルバーはここで実行する。
 * ブラウザでは単一スレッド（workers:0）で走る（node:worker_threads 経路は不使用）。
 * HU（2人）は同梱 169×169 equity テーブルを fetch して解く。3〜6人は N-way ソルバー。
 */

import type { GameMode } from '@oshihiki/core';
import { ptDisplayScale } from '@oshihiki/core';
import {
  solveMultiway,
  solveHu,
  loadHuTableBrowser,
  loadHuWinTieTableBrowser,
  loadWinTie3TableBrowser,
  loadPf3wayTableBrowser,
  lookupPf3way,
  loadPfTableBrowser,
  pfCoverage,
  lookupPf,
  loadNnTableBrowser,
  nnInRange,
  lookupNn,
  maxWorkerCap,
  type LoadedHuTable,
  type WinTieTable,
  type WinTie3Table,
  type Pf3wayTable,
  type PfTable,
  type NnTable,
  type McRunner,
  type ShowdownMcResult,
  type Exact3DenseChunk,
  type MultiwayNSolveOptions,
} from '@oshihiki/solver';
// HU equity テーブルは静的アセットとして同梱（?url でハッシュ付き URL に解決）。
import huBinUrl from '../../solver/artifacts/hu-equity-169.f32.bin?url';
import huMetaUrl from '../../solver/artifacts/hu-equity-169.meta.json?url';
// HU 勝ち/引き分け厳密テーブル（3〜6人の2人ショーダウンを厳密化するため, 同上の静的アセット）。
import wtBinUrl from '../../solver/artifacts/hu-wintie-169.f32.bin?url';
import wtMetaUrl from '../../solver/artifacts/hu-wintie-169.meta.json?url';
// 3-way オールイン結果テーブル（3人ショーダウンを厳密化するため, 約21MB・同上の静的アセット）。
import wt3BinUrl from '../../solver/artifacts/wintie3-169.u16.bin?url';
import wt3MetaUrl from '../../solver/artifacts/wintie3-169.meta.json?url';
// 3人 push or fold / AOF 事前計算テーブル（同上の静的アセット）。
import pf3wayBinUrl from '../../solver/artifacts/pf3way.f32.bin?url';
import pf3wayMetaUrl from '../../solver/artifacts/pf3way.meta.json?url';
// 4人 push or fold / AOF 事前計算テーブル（f16 量子化版・同上の静的アセット）。
import pf4wayBinUrl from '../../solver/artifacts/pf4way.f16.bin?url';
import pf4wayMetaUrl from '../../solver/artifacts/pf4way.meta.json?url';
// 5人 push or fold NN 蒸留モデル（GOLD 精度を学習した即時ルックアップ・約0.7MB・同上の静的アセット）。
import nn5wayBinUrl from '../../solver/artifacts/nn5way.model.bin?url';
import nn5wayMetaUrl from '../../solver/artifacts/nn5way.model.meta.json?url';
import type {
  McRequest,
  McResultMsg,
  SolveRequest,
  SolveResponse,
  SolveResultDto,
} from './solverProtocol';

// ショーダウン MC はメインスレッドの Web Worker プールで並列化する（入れ子 Worker は
// Vite で不安定なため）。ここではメインへジョブを投げ、結果を待つ mcRunner を組む。
// hero 自身が事前計算テーブルの上限(25bb)より深い＝push/fold(AOF)の前提が崩れる局面。
// 遅い MC を回さず、この文言を結果画面ではなくエラー画面に出して手入力修正へ促す。
const OUT_OF_SCOPE_MSG =
  '自分のスタックが深すぎます（25bb超）。押し引き（オールインか降り）で最適に近づくのは概ね25bb以下です。';

// mcPool.ts の `getMcRunner(size = maxWorkerCap())` と同じ既定値（CPU 60%, 最低 1）を
// ここでも計算する。Web Worker グローバルスコープでも navigator は利用可なので、
// SolveRequest 経由でプールサイズを渡さずに独立算出できる（両者は同じ純関数を呼ぶだけ）。
const MC_RUNNER_PARALLELISM = maxWorkerCap();

let mcReqId = 1;
const mcPending = new Map<
  number,
  { resolve: (r: (ShowdownMcResult | Exact3DenseChunk)[]) => void; reject: (e: Error) => void }
>();
const mcRunner: McRunner = (jobs) =>
  new Promise<(ShowdownMcResult | Exact3DenseChunk)[]>((resolve, reject) => {
    const reqId = mcReqId++;
    mcPending.set(reqId, { resolve, reject });
    const msg: McRequest = { kind: 'mc', reqId, jobs };
    self.postMessage(msg);
  });

let tablePromise: Promise<LoadedHuTable> | null = null;
function getHuTable(): Promise<LoadedHuTable> {
  tablePromise ??= loadHuTableBrowser({ meta: huMetaUrl, bin: huBinUrl });
  return tablePromise;
}

// 3〜6人求解内の2人ショーダウンを厳密化する win/tie テーブル。読込失敗時は undefined を
// 返し（MC フォールバック）、一度だけ警告を出す。
let winTiePromise: Promise<WinTieTable | undefined> | null = null;
let winTieWarned = false;
function getWinTie(): Promise<WinTieTable | undefined> {
  winTiePromise ??= loadHuWinTieTableBrowser({ meta: wtMetaUrl, bin: wtBinUrl }).catch((err: unknown) => {
    if (!winTieWarned) {
      winTieWarned = true;
      console.warn('hu-wintie table load failed; falling back to MC for 2-player showdowns', err);
    }
    return undefined;
  });
  return winTiePromise;
}

// 4〜6人求解内の3人ショーダウンを厳密化する3-way オールイン結果テーブル（約21MB）。
// 初回の求解でのみ fetch（以後キャッシュ）。読込失敗時は undefined を返し（層化 MC への
// フォールバック）、一度だけ警告を出す（getWinTie と同じパターン）。
let winTie3Promise: Promise<WinTie3Table | undefined> | null = null;
let winTie3Warned = false;
function getWinTie3(): Promise<WinTie3Table | undefined> {
  winTie3Promise ??= loadWinTie3TableBrowser({ meta: wt3MetaUrl, bin: wt3BinUrl }).catch((err: unknown) => {
    if (!winTie3Warned) {
      winTie3Warned = true;
      console.warn('wintie3 table load failed; falling back to MC for 3-player showdowns', err);
    }
    return undefined;
  });
  return winTie3Promise;
}

let pf3wayPromise: Promise<Pf3wayTable> | null = null;
function getPf3wayTable(): Promise<Pf3wayTable> {
  pf3wayPromise ??= loadPf3wayTableBrowser({ meta: pf3wayMetaUrl, bin: pf3wayBinUrl });
  return pf3wayPromise;
}

// 4人テーブルは初回の4人求解でのみ fetch（~11MB を遅延ロード, 以後キャッシュ）。
let pf4wayPromise: Promise<PfTable> | null = null;
function getPf4wayTable(): Promise<PfTable> {
  pf4wayPromise ??= loadPfTableBrowser({ meta: pf4wayMetaUrl, bin: pf4wayBinUrl });
  return pf4wayPromise;
}

// 5人 NN モデルは初回の5人求解でのみ fetch（~0.7MB, 以後キャッシュ）。
let nn5wayPromise: Promise<NnTable> | null = null;
function getNn5way(): Promise<NnTable> {
  nn5wayPromise ??= loadNnTableBrowser({ meta: nn5wayMetaUrl, bin: nn5wayBinUrl });
  return nn5wayPromise;
}

interface CommonNode {
  key: string;
  actor: string;
  actionType: string;
  pct: number;
  range: string;
  hands: string[];
  freq: Record<string, number>;
  ev: Record<string, number>;
  equity: Record<string, { pre: number; post: number }>;
}
interface CommonResult {
  nodes: CommonNode[];
  iterations: number;
  exploitabilityPt: number;
  converged: boolean;
}

/**
 * 求解結果 → 画面 DTO。
 *
 * **pt はここでクラブマッチの尺度にそろえる**（さつき決定 2026-09-12 の (b) 案）。求解自体は
 * モードの実払い pt で行うが、モードごとに pt の桁が変わると（クラブの振れ幅6に対し
 * レジェンドは75）記録一覧の EV ロスを並べても比較にならない。表示・保存する数値をここで
 * 一度だけ換算しておけば、下流（結果画面・記録一覧・ドリル・フィード・DB の ev_loss）は
 * 何も知らなくてよい。戦略・収束判定は換算前の値で行っているので影響しない。
 */
function toDto(
  r: CommonResult,
  playersLeft: number,
  heroPos: string,
  heroHand: string,
  mode: GameMode | undefined,
): SolveResultDto {
  const k = ptDisplayScale(mode);
  const equity = r.nodes.length > 0 ? r.nodes[0]!.equity : {};
  const scaledEquity: Record<string, { pre: number; post: number }> = {};
  for (const [pos, e] of Object.entries(equity)) {
    scaledEquity[pos] = { pre: e.pre * k, post: e.post * k };
  }
  return {
    playersLeft,
    heroPos,
    heroHand,
    iterations: r.iterations,
    exploitabilityPt: r.exploitabilityPt * k,
    converged: r.converged,
    equity: scaledEquity,
    nodes: r.nodes.map((n) => ({
      key: n.key,
      actor: n.actor,
      actionType: n.actionType,
      pct: n.pct,
      range: n.range,
      hands: n.hands,
      heroFreq: n.freq[heroHand] ?? 0,
      heroEv: (n.ev[heroHand] ?? 0) * k,
    })),
  };
}

self.onmessage = async (e: MessageEvent<SolveRequest | McResultMsg>): Promise<void> => {
  const data = e.data;
  // メインから返る MC 結果はここで受けて mcRunner の Promise を解決する
  // （SolveRequest には kind が無いため、'kind' の有無で判別できる）。
  if ('kind' in data) {
    const p = mcPending.get(data.reqId);
    if (!p) return;
    mcPending.delete(data.reqId);
    if (data.error) p.reject(new Error(data.error));
    else p.resolve(data.results ?? []);
    return;
  }

  const { id, state, opts } = data;
  const t0 = performance.now();
  try {
    let dto: SolveResultDto;
    if (state.playersLeft === 2) {
      const table = await getHuTable();
      const r = solveHu(state, { table, ...(opts?.maxIters ? { maxIters: opts.maxIters } : {}) });
      dto = toDto(r as unknown as CommonResult, 2, state.heroPos, state.heroHand, state.gameMode);
    } else if (state.playersLeft === 3) {
      // 3人は事前計算テーブル（GOLD精度）を補間して即時解。相手だけが25bb超なら
      // その席を25bbにクランプして即時。hero自身が25bb超なら対象外。条件不一致・
      // 読込失敗時は N-way ソルバーへフォールバック。
      // 全席25bb以下なら事前計算テーブルで即時。相手が深い('off')は厳密 MC へ。
      // hero 自身が深い('heroDeep')は AOF 対象外。
      let r: CommonResult | null = null;
      const pf = await getPf3wayTable().catch(() => null);
      if (pf) {
        const cov = pfCoverage(pf, state);
        if (cov === 'heroDeep') throw new Error(OUT_OF_SCOPE_MSG);
        if (cov === 'in') r = lookupPf3way(pf, state) as unknown as CommonResult;
      }
      if (!r) {
        const [winTie, winTie3] = await Promise.all([getWinTie(), getWinTie3()]);
        r = (await solveMultiway(state, {
          workers: 0, mcRunner, winTie, winTie3, avgPower: 1, refreshSchedule: 'geometric',
          mcRunnerParallelism: MC_RUNNER_PARALLELISM, ...opts,
        })) as unknown as CommonResult;
      }
      dto = toDto(r, 3, state.heroPos, state.heroHand, state.gameMode);
    } else if (state.playersLeft === 4) {
      let r: CommonResult | null = null;
      const pf = await getPf4wayTable().catch(() => null);
      if (pf) {
        const cov = pfCoverage(pf, state);
        if (cov === 'heroDeep') throw new Error(OUT_OF_SCOPE_MSG);
        if (cov === 'in') r = lookupPf(pf, state) as unknown as CommonResult;
      }
      if (!r) {
        const [winTie, winTie3] = await Promise.all([getWinTie(), getWinTie3()]);
        r = (await solveMultiway(state, {
          workers: 0, mcRunner, winTie, winTie3, avgPower: 1, refreshSchedule: 'geometric',
          mcRunnerParallelism: MC_RUNNER_PARALLELISM, ...opts,
        })) as unknown as CommonResult;
      }
      dto = toDto(r, 4, state.heroPos, state.heroHand, state.gameMode);
    } else if (state.playersLeft === 5) {
      // 5人は蒸留 NN（GOLD 解を学習した即時ルックアップ）。範囲内（標準ブラインド/アンティ・
      // 全席25bb以下）なら即時解、範囲外（深いスタック等）や読込失敗は N-way ソルバーへ
      // フォールバック（pf3way/pf4way と同型）。
      let r: CommonResult | null = null;
      const nn = await getNn5way().catch(() => null);
      if (nn && nnInRange(nn, state)) {
        r = lookupNn(nn, state) as unknown as CommonResult;
      }
      if (!r) {
        const [winTie, winTie3] = await Promise.all([getWinTie(), getWinTie3()]);
        r = (await solveMultiway(state, {
          workers: 0, mcRunner, winTie, winTie3, avgPower: 1, refreshSchedule: 'geometric',
          mcRunnerParallelism: MC_RUNNER_PARALLELISM, ...opts,
        })) as unknown as CommonResult;
      }
      dto = toDto(r, 5, state.heroPos, state.heroHand, state.gameMode);
    } else {
      // 6人（nn6way 未生成）＝直接求解。
      const [winTie, winTie3] = await Promise.all([getWinTie(), getWinTie3()]);
      const r = await solveMultiway(state, {
        workers: 0, mcRunner, winTie, winTie3, avgPower: 1, refreshSchedule: 'geometric',
        mcRunnerParallelism: MC_RUNNER_PARALLELISM, ...opts,
      });
      dto = toDto(r as unknown as CommonResult, state.playersLeft, state.heroPos, state.heroHand, state.gameMode);
    }
    const res: SolveResponse = { id, ok: true, result: dto, ms: performance.now() - t0 };
    self.postMessage(res);
  } catch (err) {
    const res: SolveResponse = { id, ok: false, error: err instanceof Error ? err.message : String(err) };
    self.postMessage(res);
  }
};
