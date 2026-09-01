/**
 * ショーダウン MC の下請け Web Worker（Phase 3-1x）。
 * 求解 Web Worker（solver.worker.ts）から入れ子で起動され、1 メッセージ =
 * ショーダウン集合 1 個分の MC ジョブ。computeShowdownMc を呼ぶだけの薄いラッパ。
 * Node の nwayWorker.ts のブラウザ版に相当する。
 */

import { computeShowdownMc, type ShowdownMcJob, type ShowdownMcResult } from '@oshihiki/solver';

interface Req {
  job: ShowdownMcJob;
}

self.onmessage = (e: MessageEvent<Req>): void => {
  const { job } = e.data;
  try {
    const res: ShowdownMcResult = computeShowdownMc(job.node, job.ranges, job.samples, job.seed);
    self.postMessage({ ok: true, res });
  } catch (err) {
    self.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
