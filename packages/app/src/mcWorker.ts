/**
 * ショーダウン MC の下請け Web Worker（Phase 3-1x）。
 * 求解 Web Worker（solver.worker.ts）から入れ子で起動され、1 メッセージ =
 * ショーダウン集合 1 個分のジョブ。通常は computeShowdownMc を呼ぶだけの薄いラッパだが、
 * `exact3` / `exact3Chunk` ジョブは Node の nwayWorker.ts と同じ契約で
 * computeShowdown3Exact / computeShowdown3ExactDenseChunk に振り分ける
 * （3人ショーダウンの厳密計算を並列プールへ chunk 分割して投げる経路, nwaySolver.ts の
 * mcRunnerParallelism 参照）。
 *
 * 3-way テーブル（wintie3-169.*, 約21MB）は worker ごとに**遅延・1 回だけ** fetch する
 * （exact3/exact3Chunk ジョブが来て初めて読む。MC のみの求解では一切触らない。ブラウザの
 * HTTP キャッシュが効くため、worker 台数ぶん fetch しても実コストは軽い）。
 */

import {
  computeShowdownMc,
  computeShowdown3Exact,
  computeShowdown3ExactDenseChunk,
  loadWinTie3TableBrowser,
  type ShowdownMcJob,
  type ShowdownMcResult,
  type Exact3DenseChunk,
  type WinTie3Table,
} from '@oshihiki/solver';
// 3-way オールイン結果テーブル（同上の静的アセット、?url でハッシュ付き URL に解決）。
import wt3BinUrl from '../../solver/artifacts/wintie3-169.u16.bin?url';
import wt3MetaUrl from '../../solver/artifacts/wintie3-169.meta.json?url';

interface Req {
  job: ShowdownMcJob;
}

let winTie3Promise: Promise<WinTie3Table> | null = null;
function getWinTie3(): Promise<WinTie3Table> {
  winTie3Promise ??= loadWinTie3TableBrowser({ meta: wt3MetaUrl, bin: wt3BinUrl });
  return winTie3Promise;
}

self.onmessage = async (e: MessageEvent<Req>): Promise<void> => {
  const { job } = e.data;
  try {
    let res: ShowdownMcResult | Exact3DenseChunk;
    if (job.exact3Chunk) {
      const table = await getWinTie3();
      res = computeShowdown3ExactDenseChunk(job.node, job.ranges, table, job.exact3Chunk.lo, job.exact3Chunk.hi);
    } else if (job.exact3) {
      const table = await getWinTie3();
      res = computeShowdown3Exact(job.node, job.ranges, table);
    } else {
      res = computeShowdownMc(job.node, job.ranges, job.samples, job.seed, job.strat);
    }
    self.postMessage({ ok: true, res });
  } catch (err) {
    self.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
