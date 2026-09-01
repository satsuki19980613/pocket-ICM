/**
 * Web Worker への求解リクエストを Promise 化するクライアント（Phase 3-1a）。
 * 単一 Worker を使い回し、id で応答を突き合わせる。
 */

import type { BoardState } from '@oshihiki/core';
import type { SolveOpts, SolveRequest, SolveResponse, SolveResultDto } from './solverProtocol';

export interface SolveOutcome {
  result: SolveResultDto;
  ms: number;
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (o: SolveOutcome) => void; reject: (e: Error) => void }>();

function ensureWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./solver.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<SolveResponse>): void => {
      const msg = e.data;
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.ok) p.resolve({ result: msg.result, ms: msg.ms });
      else p.reject(new Error(msg.error));
    };
    worker.onerror = (e: ErrorEvent): void => {
      const err = new Error(e.message || 'worker error');
      for (const p of pending.values()) p.reject(err);
      pending.clear();
    };
  }
  return worker;
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
