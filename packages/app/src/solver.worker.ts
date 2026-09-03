/**
 * 求解 Web Worker（Phase 3-1a）。UI スレッドを固めないよう、ソルバーはここで実行する。
 * ブラウザでは単一スレッド（workers:0）で走る（node:worker_threads 経路は不使用）。
 * HU（2人）は同梱 169×169 equity テーブルを fetch して解く。3〜6人は N-way ソルバー。
 */

import {
  solveMultiway,
  solveHu,
  loadHuTableBrowser,
  loadPf3wayTableBrowser,
  pf3wayInRange,
  lookupPf3way,
  type LoadedHuTable,
  type Pf3wayTable,
  type McRunner,
  type ShowdownMcResult,
} from '@oshihiki/solver';
// HU equity テーブルは静的アセットとして同梱（?url でハッシュ付き URL に解決）。
import huBinUrl from '../../solver/artifacts/hu-equity-169.f32.bin?url';
import huMetaUrl from '../../solver/artifacts/hu-equity-169.meta.json?url';
// 3人 push or fold / AOF 事前計算テーブル（同上の静的アセット）。
import pf3wayBinUrl from '../../solver/artifacts/pf3way.f32.bin?url';
import pf3wayMetaUrl from '../../solver/artifacts/pf3way.meta.json?url';
import type {
  McRequest,
  McResultMsg,
  SolveRequest,
  SolveResponse,
  SolveResultDto,
} from './solverProtocol';

// ショーダウン MC はメインスレッドの Web Worker プールで並列化する（入れ子 Worker は
// Vite で不安定なため）。ここではメインへジョブを投げ、結果を待つ mcRunner を組む。
let mcReqId = 1;
const mcPending = new Map<number, { resolve: (r: ShowdownMcResult[]) => void; reject: (e: Error) => void }>();
const mcRunner: McRunner = (jobs) =>
  new Promise<ShowdownMcResult[]>((resolve, reject) => {
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

let pf3wayPromise: Promise<Pf3wayTable> | null = null;
function getPf3wayTable(): Promise<Pf3wayTable> {
  pf3wayPromise ??= loadPf3wayTableBrowser({ meta: pf3wayMetaUrl, bin: pf3wayBinUrl });
  return pf3wayPromise;
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
      // 3人は事前計算テーブル（GOLD精度）を補間して即時解。範囲外(実効>maxbb 等)や
      // 条件不一致・読込失敗時は N-way ソルバーへフォールバック。
      let r: CommonResult | null = null;
      try {
        const pf = await getPf3wayTable();
        if (pf3wayInRange(pf, state)) r = lookupPf3way(pf, state) as unknown as CommonResult;
      } catch {
        r = null; // フォールバック
      }
      if (!r) r = (await solveMultiway(state, { workers: 0, mcRunner, ...opts })) as unknown as CommonResult;
      dto = toDto(r, 3, state.heroPos, state.heroHand);
    } else {
      const r = await solveMultiway(state, { workers: 0, mcRunner, ...opts });
      dto = toDto(r as unknown as CommonResult, state.playersLeft, state.heroPos, state.heroHand);
    }
    const res: SolveResponse = { id, ok: true, result: dto, ms: performance.now() - t0 };
    self.postMessage(res);
  } catch (err) {
    const res: SolveResponse = { id, ok: false, error: err instanceof Error ? err.message : String(err) };
    self.postMessage(res);
  }
};
