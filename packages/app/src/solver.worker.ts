/**
 * 求解 Web Worker（Phase 3-1a）。UI スレッドを固めないよう、ソルバーはここで実行する。
 * ブラウザでは単一スレッド（workers:0）で走る（node:worker_threads 経路は不使用）。
 * HU（2人）は同梱 169×169 equity テーブルを fetch して解く。3〜6人は N-way ソルバー。
 */

import {
  solveMultiway,
  solveHu,
  loadHuTableBrowser,
  type LoadedHuTable,
} from '@oshihiki/solver';
// HU equity テーブルは静的アセットとして同梱（?url でハッシュ付き URL に解決）。
import huBinUrl from '../../solver/artifacts/hu-equity-169.f32.bin?url';
import huMetaUrl from '../../solver/artifacts/hu-equity-169.meta.json?url';
import type { SolveRequest, SolveResponse, SolveResultDto } from './solverProtocol';

let tablePromise: Promise<LoadedHuTable> | null = null;
function getHuTable(): Promise<LoadedHuTable> {
  tablePromise ??= loadHuTableBrowser({ meta: huMetaUrl, bin: huBinUrl });
  return tablePromise;
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

self.onmessage = async (e: MessageEvent<SolveRequest>): Promise<void> => {
  const { id, state, opts } = e.data;
  const t0 = performance.now();
  try {
    let dto: SolveResultDto;
    if (state.playersLeft === 2) {
      const table = await getHuTable();
      const r = solveHu(state, { table, ...(opts?.maxIters ? { maxIters: opts.maxIters } : {}) });
      dto = toDto(r as unknown as CommonResult, 2, state.heroPos, state.heroHand);
    } else {
      const r = await solveMultiway(state, { workers: 0, ...opts });
      dto = toDto(r as unknown as CommonResult, state.playersLeft, state.heroPos, state.heroHand);
    }
    const res: SolveResponse = { id, ok: true, result: dto, ms: performance.now() - t0 };
    self.postMessage(res);
  } catch (err) {
    const res: SolveResponse = { id, ok: false, error: err instanceof Error ? err.message : String(err) };
    self.postMessage(res);
  }
};
