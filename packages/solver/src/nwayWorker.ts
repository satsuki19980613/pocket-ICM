/**
 * ショーダウン MC の worker（M4 / nwaySolver の並列化）。
 *
 * コンパイル後の `dist/nwayWorker.js` として worker_threads から起動される。
 * 1 メッセージ = ショーダウン集合 1 個分のジョブ（node/ranges/samples/seed）。
 * computeShowdownMc をそのまま呼び、結果を返すだけの薄いラッパ。
 * tsx/vitest（TS ソース実行）では呼び出し側が単一スレッドを選ぶため未使用。
 */

import { parentPort } from 'node:worker_threads';
import { computeShowdownMc, type ShowdownMcResult, type StratSpec } from './showdownJob.js';
import type { ShowdownNode } from './showdownMc.js';

interface JobInput {
  node: ShowdownNode;
  ranges: Float64Array[];
  samples: number;
  seed: number;
  strat?: StratSpec;
}

if (parentPort) {
  parentPort.on('message', (input: JobInput) => {
    try {
      const result: ShowdownMcResult = computeShowdownMc(
        input.node,
        input.ranges,
        input.samples,
        input.seed,
        input.strat,
      );
      parentPort!.postMessage({ ok: true, result });
    } catch (e) {
      parentPort!.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
}
