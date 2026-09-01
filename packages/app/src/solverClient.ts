/**
 * Web Worker への求解リクエストを Promise 化するクライアント（Phase 3-1a/3-1x）。
 * 単一の求解 Worker を使い回し、id で応答を突き合わせる。
 *
 * ショーダウン MC の並列化（3-1x）: MC プールは**メインスレッド**が保持し、求解 Worker
 * から届く MC 要求（kind:'mc'）をプールに流して結果を返す。入れ子 Web Worker（Worker が
 * Worker を spawn）は Vite で不安定なため、この「メイン経由ルーティング」を採る。
 */

import type { BoardState } from '@oshihiki/core';
import type {
  McRequest,
  McResultMsg,
  SolveOpts,
  SolveRequest,
  SolveResponse,
  SolveResultDto,
} from './solverProtocol';
import { getMcRunner } from './mcPool';

export interface SolveOutcome {
  result: SolveResultDto;
  ms: number;
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (o: SolveOutcome) => void; reject: (e: Error) => void }>();

function ensureWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL('./solver.worker.ts', import.meta.url), { type: 'module' });
  const runMc = getMcRunner(); // メインスレッドが所有する mcWorker プール

  w.onmessage = (e: MessageEvent<SolveResponse | McRequest>): void => {
    const msg = e.data;
    // 求解 Worker からの MC 要求 → プールで並列実行 → 結果を返す
    // （SolveResponse には kind が無いため、'kind' の有無で判別できる）。
    if ('kind' in msg) {
      runMc(msg.jobs).then(
        (results) => w.postMessage({ kind: 'mcResult', reqId: msg.reqId, results } satisfies McResultMsg),
        (err: unknown) =>
          w.postMessage({
            kind: 'mcResult',
            reqId: msg.reqId,
            error: err instanceof Error ? err.message : String(err),
          } satisfies McResultMsg),
      );
      return;
    }
    // 求解応答。
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve({ result: msg.result, ms: msg.ms });
    else p.reject(new Error(msg.error));
  };
  w.onerror = (e: ErrorEvent): void => {
    const err = new Error(e.message || 'solver worker error');
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };
  worker = w;
  return w;
}

/** 盤面を Web Worker で解いて結果 DTO と所要時間を返す。 */
export function solveInWorker(state: BoardState, opts?: SolveOpts): Promise<SolveOutcome> {
  const w = ensureWorker();
  const id = nextId++;
  const req: SolveRequest = { id, state, opts };
  return new Promise<SolveOutcome>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage(req);
  });
}
