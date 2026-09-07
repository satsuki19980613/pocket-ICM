/**
 * ショーダウン MC の worker（M4 / nwaySolver の並列化）。
 *
 * コンパイル後の `dist/nwayWorker.js` として worker_threads から起動される。
 * 1 メッセージ = ショーダウン集合 1 個分のジョブ（node/ranges/samples/seed、または
 * `exact3:true` の 3 人厳密ジョブ node/ranges のみ）。
 * `exact3` が立っていれば `computeShowdown3Exact` を、それ以外は `computeShowdownMc` を
 * 呼んで結果を返すだけの薄いラッパ。tsx/vitest（TS ソース実行）では呼び出し側が
 * 単一スレッドを選ぶため未使用。
 *
 * 3-way テーブル（wintie3-169.*）は worker プロセスごとに**遅延・1 回だけ**ロードする
 * （exact3 ジョブが来て初めて `loadWinTie3Table()` を呼ぶ。MC のみの求解では一切触らない）。
 */

import { parentPort } from 'node:worker_threads';
import { computeShowdownMc, type ShowdownMcResult, type StratSpec } from './showdownJob.js';
import { computeShowdown3Exact, computeShowdown3ExactDenseChunk, type Exact3DenseChunk } from './showdownExact.js';
import { loadWinTie3Table, type WinTie3Table } from './wintie3Loader.js';
import type { ShowdownNode } from './showdownMc.js';

interface JobInput {
  node: ShowdownNode;
  ranges: Float64Array[];
  samples: number;
  seed: number;
  strat?: StratSpec;
  exact3?: boolean;
  /**
   * item1: 指定時は「dense sweep の 'a'（hero0 のクラス）範囲 [lo,hi) だけの部分和」
   * （`computeShowdown3ExactDenseChunk`）を計算して返す。node/ranges と併用し、
   * exact3/samples/seed/strat は無視する。1 つの exact3 集合を worker 台数ぶんに
   * 割って並列化する（nwaySolver.ts の refresh 参照）。
   */
  exact3Chunk?: { lo: number; hi: number };
}

let winTie3Table: WinTie3Table | null = null;
function ensureWinTie3Table(): WinTie3Table {
  winTie3Table ??= loadWinTie3Table();
  return winTie3Table;
}

if (parentPort) {
  parentPort.on('message', (input: JobInput) => {
    try {
      if (input.exact3Chunk) {
        const chunk: Exact3DenseChunk = computeShowdown3ExactDenseChunk(
          input.node,
          input.ranges,
          ensureWinTie3Table(),
          input.exact3Chunk.lo,
          input.exact3Chunk.hi,
        );
        // item3: 最小ペイロード。169 要素程度なのでコピーでも軽いが、構造化クローンの
        // コピーコストを避けられる場面では transferList で ArrayBuffer を転送する。
        parentPort!.postMessage(
          { ok: true, chunk },
          [chunk.s0.buffer, chunk.wsum0.buffer, chunk.s1.buffer, chunk.wsum1.buffer, chunk.s2.buffer, chunk.wsum2.buffer, chunk.pnMarg.buffer] as ArrayBuffer[],
        );
        return;
      }
      const result: ShowdownMcResult = input.exact3
        ? computeShowdown3Exact(input.node, input.ranges, ensureWinTie3Table())
        : computeShowdownMc(input.node, input.ranges, input.samples, input.seed, input.strat);
      parentPort!.postMessage({ ok: true, result });
    } catch (e) {
      parentPort!.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
}
