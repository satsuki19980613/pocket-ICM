/**
 * ショーダウン MC を並列化する worker_threads プール（Node 専用, SPEC 運用: CPU 60% まで）。
 *
 * このモジュールは `node:worker_threads` / `node:module` / `node:fs` 等に依存するため
 * **ブラウザバンドルに含めてはならない**。`nwaySolver.ts` は本モジュールを
 * `await import(/* @vite-ignore *​/ './nwayWorkerPool.js')` で**動的**に読み込み、
 * 単一スレッド（workers<=1）時は一切参照しない。したがってブラウザ側の静的グラフには
 * Node 組み込みが入らない（App は求解を Web Worker 側で単一スレッド実行する想定）。
 */

import { createRequire } from 'node:module';
import type { ShowdownNode } from './showdownMc.js';
import type { ShowdownMcResult } from './showdownJob.js';

type F64 = Float64Array;

export interface ShowdownJobInput {
  node: ShowdownNode;
  ranges: F64[];
  samples: number;
  seed: number;
}

/**
 * worker_threads プール。worker が利用不可・失敗する環境では、呼び出し側が
 * workers<=1 を選ぶことで単一スレッドに退避する（テストは単一スレッド既定）。
 */
export class WorkerPool {
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
    // 呼び出し元がソース（tsx: .../src/nwayWorkerPool.ts）か dist（.../dist/nwayWorkerPool.js）かで
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
        `@oshihiki/core の dist が未生成（${coreDist}）。` + '`npx tsc -b` で core をビルドしてください。',
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
