/**
 * ショーダウン MC のブラウザ Web Worker プール（Phase 3-1x）。
 * `solveMultiway({ mcRunner })` に注入する並列ランナーを提供する。求解 Web Worker が
 * 入れ子で mcWorker を size 個起動し、各 refresh の全ジョブ（ショーダウン集合ごと）を
 * 空きワーカーへ流して並列に解く。Node の worker_threads プール相当（SPEC 運用: CPU 60%）。
 */

import {
  maxWorkerCap,
  type McRunner,
  type ShowdownMcJob,
  type ShowdownMcResult,
  type Exact3DenseChunk,
} from '@oshihiki/solver';

/** mcWorker が返す結果（通常 MC / exact3 全体 / exact3Chunk 部分和のいずれか）。 */
type McPoolResult = ShowdownMcResult | Exact3DenseChunk;

type WorkerMsg = { ok: true; res: McPoolResult } | { ok: false; error: string };

class McPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: { job: ShowdownMcJob; resolve: (r: McPoolResult) => void; reject: (e: Error) => void }[] = [];
  private pending = new Map<Worker, { resolve: (r: McPoolResult) => void; reject: (e: Error) => void }>();

  constructor(size: number) {
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL('./mcWorker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<WorkerMsg>): void => {
        const p = this.pending.get(w);
        this.pending.delete(w);
        this.idle.push(w);
        this.drain();
        if (!p) return;
        if (e.data.ok) p.resolve(e.data.res);
        else p.reject(new Error(e.data.error));
      };
      w.onerror = (e: ErrorEvent): void => {
        const detail = `mc worker error: ${e.message || '(no message)'} @ ${e.filename || '?'}:${e.lineno ?? '?'}`;
        // eslint-disable-next-line no-console
        console.error('[mcPool]', detail, e);
        const p = this.pending.get(w);
        this.pending.delete(w);
        if (p) p.reject(new Error(detail));
      };
      w.onmessageerror = (): void => {
        const p = this.pending.get(w);
        this.pending.delete(w);
        if (p) p.reject(new Error('mc worker messageerror (structured clone failed)'));
      };
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  private runOne(job: ShowdownMcJob): Promise<McPoolResult> {
    return new Promise((resolve, reject) => {
      this.queue.push({ job, resolve, reject });
      this.drain();
    });
  }

  private drain(): void {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const w = this.idle.pop()!;
      const item = this.queue.shift()!;
      this.pending.set(w, { resolve: item.resolve, reject: item.reject });
      // job（node/ranges 等）は構造化クローンでコピーされる。ArrayBuffer の transfer は
      // ranges（Float64Array、求解側で他ノードとも共有され得る）に対しては行わない
      // （転送すると呼び出し元の参照が detach される）。
      w.postMessage({ job: item.job });
    }
  }

  /** 全ジョブを並列に解いて入力順の結果を返す（McRunner 契約）。 */
  runAll = (jobs: ShowdownMcJob[]): Promise<McPoolResult[]> => Promise.all(jobs.map((j) => this.runOne(j)));

  dispose(): void {
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.idle = [];
  }
}

let shared: McPool | null = null;

/** 共有 MC プール（遅延生成・使い回し）を使う McRunner。size は既定で CPU の 60%。 */
export function getMcRunner(size = maxWorkerCap()): McRunner {
  if (!shared) shared = new McPool(Math.max(1, size));
  return shared.runAll;
}
