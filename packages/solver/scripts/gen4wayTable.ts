/**
 * 4人 push or fold / AOF 事前計算テーブルの本生成（オフライン, dev専用）。
 *
 * 固定条件（ポーカーチェイス クラブマッチ）: blinds SB0.5/BB1, ante0.25 all,
 * payouts=payoutsForPlayers(4)。bb単位では全レベル同一ゲームなので「スタック深さ(bb)」
 * だけが変数。4人の各スタック(CO/BU/SB/BB)を格子化し、各格子点をGOLDで解いて
 * 「EV差（アグレッシブEV−フォールドEV, クラス別169）」と eqPost を格納する。
 *
 * ランタイムは pfTable.ts がこの表をクアッドリニア補間して即時解を返す（4人PoCで
 * 刻み4bbの補間超過損を実証済み）。3人 gen3wayTable.ts と同型（次元のみ4に拡張）。
 *
 * 出力: artifacts/pf4way.meta.json, artifacts/pf4way.f32.bin
 * 実行: node --import tsx scripts/gen4wayTable.ts [samples] [axisCsv]
 *   既定 samples=100000, axis=2,6,10,14,18,22,25。axisCsv は小格子スモークテスト用。
 */
import { writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { BoardState } from '@oshihiki/core';
import { positionsForPlayersLeft } from '@oshihiki/core';
import { HAND_CLASS_ORDER } from '../src/huEquity.js';
import { solveMultiway, maxWorkerCap, type MultiwayNSolveOptions } from '../src/nwaySolver.js';

const log = (s: string): void => void process.stderr.write(s + '\n');
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'artifacts');

const SB = 0.5, BB = 1, ANTE = 0.25;
const ORDER = positionsForPlayersLeft(4); // ['CO','BU','SB','BB']
const D = ORDER.length; // 4
const N_CLASSES = HAND_CLASS_ORDER.length; // 169

// 格子: 各軸 2..25bb, 刻み4bb（末尾は25で打ち切り）。PoCで4bbが十分と実証。
// argv[3] に CSV を渡すと軸を上書き（小格子スモークテスト用）。
const AXIS = (process.argv[3] ? process.argv[3].split(',').map(Number) : [2, 6, 10, 14, 18, 22, 25]);
const G = AXIS.length;

function buildState(stacks: number[]): BoardState {
  const seats = ORDER.map((pos, i) => {
    const bet = pos === 'SB' ? SB : pos === 'BB' ? BB : 0;
    return { pos, stack: stacks[i]! - bet - ANTE, state: 'live' as const, bet };
  });
  return {
    street: 'preflop', blinds: { sb: SB, bb: BB }, ante: { scheme: 'all', amount: ANTE },
    heroHand: 'KQo', playersLeft: 4, seats, heroPos: 'CO',
    pot: seats.reduce((a, s) => a + s.bet, 0) + ANTE * D,
  } as BoardState;
}

/** 格子を隣接訪問するスネーク順（ウォームスタートを最大化, D次元反射グレイ）。 */
function* snake(): Generator<number[]> {
  const ix = new Array<number>(D).fill(0);
  const dir = new Array<number>(D).fill(1);
  // 反射スネーク: 各軸を折り返しながら走査し、隣接格子点へ最小移動で進む。
  const total = G ** D;
  for (let count = 0; count < total; count++) {
    yield ix.slice();
    // 最下位軸から桁上げ（折り返し）
    let d = D - 1;
    while (d >= 0) {
      const next = ix[d]! + dir[d]!;
      if (next >= 0 && next < G) { ix[d] = next; break; }
      dir[d] = -dir[d]!; // 折り返して上位軸へ桁上げ
      d--;
    }
  }
}
const idx = (ix: number[]): number => ix.reduce((acc, v) => acc * G + v, 0);

async function main(): Promise<void> {
  const workers = maxWorkerCap();
  const S = Number(process.argv[2] ?? 100_000);
  const gold: MultiwayNSolveOptions = {
    samples: S, maxIters: 800, refreshEvery: 60, workers, commonRandom: true, plateauStopFrac: 0.02,
  };
  const total = G ** D;
  log(`# 4人テーブル本生成: 各軸 ${AXIS.join('/')}bb (${G}点/軸, ${total}点), samples=${S}, workers=${workers}`);

  // レイアウト: 点ごとに [14ノード×169 EV差][4 eqPost] = 14*169+4 float
  let nodeKeys: string[] = [];
  let nodeActors: string[] = [];
  let nodeTypes: string[] = [];
  const FLOATS_PER_NODE = N_CLASSES;
  let stride = 0;
  let buf: Float32Array | null = null;

  const BIN = join(OUT_DIR, 'pf4way.f32.bin');
  const META = join(OUT_DIR, 'pf4way.meta.json');
  const PROG = join(OUT_DIR, 'pf4way.progress.json'); // レジューム用の中間状態

  const buildMeta = (): object => ({
    kind: 'pf4way-evdiff',
    createdAt: new Date().toISOString(),
    blinds: { sb: SB, bb: BB }, ante: { scheme: 'all', amount: ANTE },
    order: ORDER, axis: AXIS,
    nodeKeys, nodeActors, nodeTypes,
    classOrder: HAND_CLASS_ORDER,
    stride, floatsPerNode: FLOATS_PER_NODE,
    layout: '[G^4 points] each: [nodeKeys.length * 169 evDiff][4 eqPost(order)]',
    samples: S,
    // interpExplBound は validate4wayTable の実測後に手動で設定（未設定時 pfTable は既定0.06）。
  });
  // 既定200点ごとに bin＋progress を保存（クラッシュ/スリープ耐性）。argv[4] で上書き可。
  const CKPT_EVERY = Number(process.argv[4] ?? 200);
  const saveCkpt = (doneN: number, final: boolean): void => {
    writeFileSync(BIN, Buffer.from(buf!.buffer, 0, buf!.byteLength));
    if (final) {
      writeFileSync(META, JSON.stringify(buildMeta(), null, 2));
      if (existsSync(PROG)) rmSync(PROG); // レジューム用の中間状態は完了時に削除
    } else {
      writeFileSync(PROG, JSON.stringify({ done: doneN, samples: S, stride, nodeKeys, nodeActors, nodeTypes }));
    }
  };

  // レジューム: pf4way.f32.bin＋progress.json があり samples 一致なら続きから。
  let resumeDone = 0;
  if (existsSync(BIN) && existsSync(PROG)) {
    try {
      const prog = JSON.parse(readFileSync(PROG, 'utf8')) as {
        done: number; samples: number; stride: number; nodeKeys: string[]; nodeActors: string[]; nodeTypes: string[];
      };
      if (prog.samples === S && prog.stride > 0) {
        stride = prog.stride; nodeKeys = prog.nodeKeys; nodeActors = prog.nodeActors; nodeTypes = prog.nodeTypes;
        const bin = readFileSync(BIN);
        const loaded = new Float32Array(bin.buffer, bin.byteOffset, bin.byteLength / 4);
        buf = new Float32Array(total * stride);
        buf.set(loaded.subarray(0, Math.min(loaded.length, buf.length)));
        resumeDone = prog.done;
        log(`  レジューム: ${resumeDone}/${total} 済（samples=${S}, stride=${stride}）から再開`);
      } else {
        log(`  progress.json は samples 不一致（${prog.samples}≠${S}）→ 最初から生成`);
      }
    } catch (e) {
      log(`  progress 読込失敗 → 最初から生成: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  let warm: Map<string, Float64Array> | undefined;
  let done = 0, tMs = 0;
  const t0 = Date.now();
  for (const ix of snake()) {
    // レジューム済みの点はスキップ（buf に読込済み・warm は境界で cold から）。
    if (done < resumeDone) { done++; continue; }

    const st = buildState(ix.map((i) => AXIS[i]!));
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
      stride = nodeKeys.length * FLOATS_PER_NODE + D;
      buf = new Float32Array(total * stride);
      log(`  ノード数=${nodeKeys.length} / stride=${stride} float / 総容量=${((total * stride * 4) / 1024 / 1024).toFixed(2)}MB`);
    }
    const base = idx(ix) * stride;
    for (let n = 0; n < res.nodes.length; n++) {
      const ev = res.nodes[n]!.ev;
      const off = base + n * FLOATS_PER_NODE;
      for (let c = 0; c < N_CLASSES; c++) buf[off + c] = ev[HAND_CLASS_ORDER[c]!]!;
    }
    // eqPost（D席, order順）
    const eqOff = base + nodeKeys.length * FLOATS_PER_NODE;
    for (let s = 0; s < D; s++) buf[eqOff + s] = res.equity[ORDER[s]!]!.post;

    done++;
    const solved = done - resumeDone;
    if (done % CKPT_EVERY === 0 && done < total) saveCkpt(done, false);
    if (done % 25 === 0 || done === total) {
      const eta = (tMs / solved) * (total - done) / 1000;
      log(`  ${done}/${total} 完了 (平均${(tMs / solved / 1000).toFixed(2)}s/点, 残り約${(eta / 60).toFixed(1)}分)`);
    }
  }

  saveCkpt(total, true); // 最終 bin＋meta を確定
  const gz = gzipSync(Buffer.from(buf!.buffer, 0, buf!.byteLength)).length;
  log(`\n生成完了: ${total}点 / ${((Date.now() - t0) / 1000 / 60).toFixed(1)}分`);
  log(`保存: artifacts/pf4way.f32.bin = ${(buf!.byteLength / 1024 / 1024).toFixed(2)}MB (gzip ${(gz / 1024 / 1024).toFixed(2)}MB) + meta.json`);
  log(`（pf4way.progress.json はレジューム用。完了後は削除して構いません）`);
}
void main();
