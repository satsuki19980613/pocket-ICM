/**
 * 3人 push or fold / AOF 事前計算テーブルの本生成（オフライン, dev専用）。
 *
 * 固定条件（ポーカーチェイス クラブマッチ）: blinds SB0.5/BB1, ante0.25 all,
 * payouts=payoutsForPlayers(3)。bb単位では全レベル同一ゲームなので「スタック深さ(bb)」
 * だけが変数。3人の各スタック(BU/SB/BB)を格子化し、各格子点をGOLDで解いて
 * 「EV差（アグレッシブEV−フォールドEV, クラス別169）」と eqPost を格納する。
 *
 * ランタイムは pf3wayTable.ts がこの表をトリリニア補間して即時解を返す（PoCで
 * 補間の超過損 ≈0.04pt/プール比0.4% を実証済み。刻み4bbで十分）。
 *
 * 出力: artifacts/pf3way.meta.json, artifacts/pf3way.f32.bin
 * 実行: node --import tsx scripts/gen3wayTable.ts
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { BoardState, Position } from '@oshihiki/core';
import { positionsForPlayersLeft } from '@oshihiki/core';
import { HAND_CLASS_ORDER } from '../src/huEquity.js';
import { solveMultiway, maxWorkerCap, type MultiwayNSolveOptions } from '../src/nwaySolver.js';

const log = (s: string): void => void process.stderr.write(s + '\n');
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'artifacts');

const SB = 0.5, BB = 1, ANTE = 0.25;
const ORDER = positionsForPlayersLeft(3); // ['BU','SB','BB']
const N_CLASSES = HAND_CLASS_ORDER.length; // 169

// 格子: 各軸 2..25bb, 刻み4bb（末尾は25で打ち切り）。PoCで4bbが十分と実証。
const AXIS = [2, 6, 10, 14, 18, 22, 25];
const G = AXIS.length;

function buildState(stacks: [number, number, number]): BoardState {
  const seats = ORDER.map((pos, i) => {
    const bet = pos === 'SB' ? SB : pos === 'BB' ? BB : 0;
    return { pos, stack: stacks[i]! - bet - ANTE, state: 'live' as const, bet };
  });
  return {
    street: 'preflop', blinds: { sb: SB, bb: BB }, ante: { scheme: 'all', amount: ANTE },
    heroHand: 'KQo', playersLeft: 3, seats, heroPos: 'BU',
    pot: seats.reduce((a, s) => a + s.bet, 0) + ANTE * 3,
  } as BoardState;
}

/** 格子を隣接訪問するスネーク順（ウォームスタートを最大化）。 */
function* snake(): Generator<[number, number, number]> {
  for (let i = 0; i < G; i++) {
    const js = i % 2 === 0 ? range(G) : range(G).reverse();
    for (const j of js) {
      const ks = (i * G + j) % 2 === 0 ? range(G) : range(G).reverse();
      for (const k of ks) yield [i, j, k];
    }
  }
}
const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);
const idx = (i: number, j: number, k: number): number => (i * G + j) * G + k;

async function main(): Promise<void> {
  const workers = maxWorkerCap();
  const S = 100_000; // オフライン生成は高サンプルでノイズを抑える
  const gold: MultiwayNSolveOptions = {
    samples: S, maxIters: 800, refreshEvery: 60, workers, commonRandom: true, plateauStopFrac: 0.02,
  };
  const total = G ** 3;
  log(`# 3人テーブル本生成: 各軸 ${AXIS.join('/')}bb (${G}点/軸, ${total}点), samples=${S}, workers=${workers}`);

  // レイアウト: 点ごとに [6ノード×169 EV差][3 eqPost] = 6*169+3 = 1017 float
  let nodeKeys: string[] = [];
  let nodeActors: string[] = [];
  let nodeTypes: string[] = [];
  const FLOATS_PER_NODE = N_CLASSES;
  let stride = 0;
  let buf: Float32Array | null = null;

  let warm: Map<string, Float64Array> | undefined;
  let done = 0, tMs = 0;
  const t0 = Date.now();
  for (const [i, j, k] of snake()) {
    const st = buildState([AXIS[i]!, AXIS[j]!, AXIS[k]!]);
    const opts = warm ? { ...gold, initStrategy: warm, initIterations: 120 } : gold;
    const s0 = Date.now();
    const res = await solveMultiway(st, opts);
    tMs += Date.now() - s0;
    warm = res.strategies;

    if (!buf) {
      // 最初の解からノード順を確定（全格子点で同一の木・同一キー順）
      nodeKeys = res.nodes.map((n) => n.key);
      nodeActors = res.nodes.map((n) => n.actor);
      nodeTypes = res.nodes.map((n) => n.actionType);
      stride = nodeKeys.length * FLOATS_PER_NODE + 3;
      buf = new Float32Array(total * stride);
      log(`  ノード数=${nodeKeys.length} / stride=${stride} float / 総容量=${((total * stride * 4) / 1024 / 1024).toFixed(2)}MB`);
    }
    const base = idx(i, j, k) * stride;
    for (let n = 0; n < res.nodes.length; n++) {
      const ev = res.nodes[n]!.ev;
      const off = base + n * FLOATS_PER_NODE;
      for (let c = 0; c < N_CLASSES; c++) buf[off + c] = ev[HAND_CLASS_ORDER[c]!]!;
    }
    // eqPost（3席, order順）
    const eqOff = base + nodeKeys.length * FLOATS_PER_NODE;
    for (let s = 0; s < 3; s++) buf[eqOff + s] = res.equity[ORDER[s]!]!.post;

    done++;
    if (done % 25 === 0 || done === total) {
      const eta = (tMs / done) * (total - done) / 1000;
      log(`  ${done}/${total} 完了 (平均${(tMs / done / 1000).toFixed(2)}s/点, 残り約${(eta / 60).toFixed(1)}分)`);
    }
  }

  const meta = {
    kind: 'pf3way-evdiff',
    createdAt: new Date().toISOString(),
    blinds: { sb: SB, bb: BB }, ante: { scheme: 'all', amount: ANTE },
    order: ORDER, axis: AXIS,
    nodeKeys, nodeActors, nodeTypes,
    classOrder: HAND_CLASS_ORDER,
    stride, floatsPerNode: FLOATS_PER_NODE,
    layout: '[G*G*G points] each: [nodeKeys.length * 169 evDiff][3 eqPost(order)]',
    samples: S,
  };
  writeFileSync(join(OUT_DIR, 'pf3way.meta.json'), JSON.stringify(meta, null, 2));
  writeFileSync(join(OUT_DIR, 'pf3way.f32.bin'), Buffer.from(buf!.buffer, 0, buf!.byteLength));
  const gz = gzipSync(Buffer.from(buf!.buffer, 0, buf!.byteLength)).length;
  log(`\n生成完了: ${total}点 / ${((Date.now() - t0) / 1000 / 60).toFixed(1)}分`);
  log(`保存: artifacts/pf3way.f32.bin = ${(buf!.byteLength / 1024 / 1024).toFixed(2)}MB (gzip ${(gz / 1024 / 1024).toFixed(2)}MB) + meta.json`);
}
void main();
