/**
 * 求解 Web Worker（Phase 3-1a）。UI スレッドを固めないよう、ソルバーはここで実行する。
 * ブラウザでは単一スレッド（workers:0）で走る（node:worker_threads 経路は不使用）。
 * HU（2人）は同梱 169×169 equity テーブルを fetch して解く。3〜6人は N-way ソルバー。
 */

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
  maxWorkerCap,
  type LoadedHuTable,
  type WinTieTable,
  type WinTie3Table,
  type Pf3wayTable,
  type PfTable,
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

function toDto(r: CommonResult, playersLeft: number, heroPos: string, heroHand: string): SolveResultDto {
  const equity = r.nodes.length > 0 ? r.nodes[0]!.equity : {};
  return {
    playersLeft,
    heroPos,
    heroHand,
    iterations: r.iterations,
    exploitabilityPt: r.exploitabilityPt,
    converged: r.converged,
    equity,
    nodes: r.nodes.map((n) => ({
      key: n.key,
      actor: n.actor,
      actionType: n.actionType,
      pct: n.pct,
      range: n.range,
      hands: n.hands,
      heroFreq: n.freq[heroHand] ?? 0,
      heroEv: n.ev[heroHand] ?? 0,
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
      dto = toDto(r as unknown as CommonResult, 2, state.heroPos, state.heroHand);
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
      dto = toDto(r, 3, state.heroPos, state.heroHand);
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
      dto = toDto(r, 4, state.heroPos, state.heroHand);
    } else {
      const [winTie, winTie3] = await Promise.all([getWinTie(), getWinTie3()]);
      const r = await solveMultiway(state, {
        workers: 0, mcRunner, winTie, winTie3, avgPower: 1, refreshSchedule: 'geometric',
        mcRunnerParallelism: MC_RUNNER_PARALLELISM, ...opts,
      });
      dto = toDto(r as unknown as CommonResult, state.playersLeft, state.heroPos, state.heroHand);
    }
    const res: SolveResponse = { id, ok: true, result: dto, ms: performance.now() - t0 };
    self.postMessage(res);
  } catch (err) {
    const res: SolveResponse = { id, ok: false, error: err instanceof Error ? err.message : String(err) };
    self.postMessage(res);
  }
};
