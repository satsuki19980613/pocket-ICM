/**
 * N人 push/fold NN 蒸留の教師データ生成（オフライン, dev専用）。
 *
 * 5〜6人は格子テーブルが容量的に不可（5人 7⁵×5075f16≈170MB）。代わりに教師 solveMultiway で
 * 「スタック格子 → EV差(169)＋eqPost」を生成し、これを学習データとして小型 MLP に蒸留する
 * （出荷はMLP重み数MBのみ＝学習点数と出荷サイズを分離できるのがNNの利点）。
 *
 * データ生成自体は gen4wayTable と同型（スネーク順でウォームスタート最大化・CRN・checkpoint/resume）。
 * 出力の1行 = [D 入力スタック(bb)][nNodes×169 EV差][D eqPost]。学習は scripts/trainNwayNN.ts。
 *
 * 出力: artifacts/nn{N}way.train.{meta.json,f32.bin}
 * 実行: node --import tsx scripts/genNwayTrainData.ts <players> [samples] [axisCsv] [ckptEvery]
 *   例: 5人スモーク（3点/軸=243点）  ... genNwayTrainData.ts 5 40000 2,14,25
 *       5人本生成（5点/軸=3125点）    ... genNwayTrainData.ts 5 40000 2,8,14,20,25
 */
import { writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { BoardState } from '@oshihiki/core';
import { positionsForPlayersLeft } from '@oshihiki/core';
import { HAND_CLASS_ORDER } from '../src/huEquity.js';
import { solveMultiway, maxWorkerCap, type MultiwayNSolveOptions } from '../src/nwaySolver.js';
import { loadHuWinTieTable } from '../src/huWinTieLoader.js';

const log = (s: string): void => void process.stderr.write(s + '\n');
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'artifacts');

const SB = 0.5, BB = 1, ANTE = 0.25;
const N_CLASSES = HAND_CLASS_ORDER.length; // 169

const N = Number(process.argv[2] ?? 5);
if (!Number.isInteger(N) || N < 3 || N > 6) { log(`players は 3..6（受領: ${process.argv[2]}）`); process.exit(1); }
const ORDER = positionsForPlayersLeft(N);
const D = ORDER.length;

// 格子軸（bb）。既定は各軸5点（2,8,14,20,25）。argv[4] の CSV で上書き（スモーク用）。
const AXIS = (process.argv[4] ? process.argv[4].split(',').map(Number) : [2, 8, 14, 20, 25]);
const G = AXIS.length;

function buildState(stacks: number[]): BoardState {
  const seats = ORDER.map((pos, i) => {
    const bet = pos === 'SB' ? SB : pos === 'BB' ? BB : 0;
    return { pos, stack: stacks[i]! - bet - ANTE, state: 'live' as const, bet };
  });
  return {
    street: 'preflop', blinds: { sb: SB, bb: BB }, ante: { scheme: 'all', amount: ANTE },
    heroHand: 'KQo', playersLeft: D, seats, heroPos: ORDER[0]!,
    pot: seats.reduce((a, s) => a + s.bet, 0) + ANTE * D,
  } as BoardState;
}

/** D 次元格子を隣接訪問する反射スネーク順（ウォームスタート最大化）。 */
function* snake(): Generator<number[]> {
  const ix = new Array<number>(D).fill(0);
  const dir = new Array<number>(D).fill(1);
  const total = G ** D;
  for (let count = 0; count < total; count++) {
    yield ix.slice();
    let d = D - 1;
    while (d >= 0) {
      const next = ix[d]! + dir[d]!;
      if (next >= 0 && next < G) { ix[d] = next; break; }
      dir[d] = -dir[d]!; d--;
    }
  }
}

async function main(): Promise<void> {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const workers = maxWorkerCap();
  const S = Number(process.argv[3] ?? 40_000);
  // 教師は「2人厳密（winTie）＋3人以上は層化 MC＋同時オールイン最大3人」の新エンジンで、
  // 早期停止なしの 8000 反復（1点 約1.6s/16並列）。旧設定（800反復・plateau 停止）は収束不足の
  // 点が混ざることを実測（同一局面で BU 23%↔54%）したため廃止。docs/BATON_OC.md §10。
  const GOLD_ITERS = 8000;
  const gold: MultiwayNSolveOptions = {
    samples: S, maxIters: GOLD_ITERS, refreshEvery: 100, workers, commonRandom: true,
    targetExploitabilityPt: 0, winTie: loadHuWinTieTable(),
  };
  const total = G ** D;
  log(`# ${N}人 NN 学習データ生成: 各軸 ${AXIS.join('/')}bb (${G}点/軸, ${total}点), samples=${S}, workers=${workers}`);

  const FLOATS_PER_NODE = N_CLASSES;
  let nodeKeys: string[] = [];
  let nodeActors: string[] = [];
  let nodeTypes: string[] = [];
  let outDim = 0;   // nNodes*169 + D
  let rowStride = 0; // D + outDim
  let buf: Float32Array | null = null;

  const TAG = `nn${N}way`;
  const BIN = join(OUT_DIR, `${TAG}.train.f32.bin`);
  const META = join(OUT_DIR, `${TAG}.train.meta.json`);
  const PROG = join(OUT_DIR, `${TAG}.train.progress.json`);
  // ダッシュボード（genDashboard.ts）との file-based IPC。
  // control: {action:'run'|'pause'|'stop'} をダッシュボードが書き、本スクリプトが点間で読む。
  // status: 進捗/ETA を本スクリプトが点ごとに書き、ダッシュボードが表示する。
  const CONTROL = join(OUT_DIR, `${TAG}.control.json`);
  const STATUS = join(OUT_DIR, `${TAG}.status.json`);
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const readControl = (): 'run' | 'pause' | 'stop' => {
    try {
      const c = JSON.parse(readFileSync(CONTROL, 'utf8')) as { action?: string };
      return c.action === 'pause' || c.action === 'stop' ? c.action : 'run';
    } catch { return 'run'; }
  };
  const writeStatus = (
    doneN: number, solvedN: number, elapsedSolveMs: number, lastStacks: number[] | null,
    state: 'running' | 'paused' | 'stopped' | 'done',
  ): void => {
    const avgMs = solvedN > 0 ? elapsedSolveMs / solvedN : 0;
    const etaMs = avgMs * (total - doneN);
    try {
      writeFileSync(STATUS, JSON.stringify({
        tag: TAG, players: N, samples: S, axis: AXIS,
        done: doneN, total, resumeDone, solved: solvedN,
        avgMsPerPoint: avgMs, etaMs, state,
        lastStacks, updatedAt: new Date().toISOString(),
        pid: process.pid,
      }));
    } catch { /* status 書込み失敗は無視 */ }
  };

  const buildMeta = (): object => ({
    kind: `${TAG}-train`,
    createdAt: new Date().toISOString(),
    players: N, order: ORDER, axis: AXIS,
    blinds: { sb: SB, bb: BB }, ante: { scheme: 'all', amount: ANTE },
    nodeKeys, nodeActors, nodeTypes, classOrder: HAND_CLASS_ORDER,
    inDim: D, outDim, rowStride, floatsPerNode: FLOATS_PER_NODE,
    rows: total, samples: S,
    solver: { maxIters: GOLD_ITERS, earlyStop: false, winTie: true, stratifiedMc: true, maxActive: 3, commonRandom: true },
    layout: '[rows] each: [D input stacks(bb)][nNodes*169 evDiff][D eqPost(order)]',
  });

  const CKPT_EVERY = Number(process.argv[5] ?? 100);
  const saveCkpt = (doneN: number, final: boolean): void => {
    writeFileSync(BIN, Buffer.from(buf!.buffer, 0, buf!.byteLength));
    if (final) {
      writeFileSync(META, JSON.stringify(buildMeta(), null, 2));
      if (existsSync(PROG)) rmSync(PROG);
    } else {
      writeFileSync(PROG, JSON.stringify({ done: doneN, samples: S, rowStride, outDim, nodeKeys, nodeActors, nodeTypes }));
    }
  };

  // レジューム
  let resumeDone = 0;
  if (existsSync(BIN) && existsSync(PROG)) {
    try {
      const prog = JSON.parse(readFileSync(PROG, 'utf8')) as {
        done: number; samples: number; rowStride: number; outDim: number;
        nodeKeys: string[]; nodeActors: string[]; nodeTypes: string[];
      };
      if (prog.samples === S && prog.rowStride > 0) {
        rowStride = prog.rowStride; outDim = prog.outDim;
        nodeKeys = prog.nodeKeys; nodeActors = prog.nodeActors; nodeTypes = prog.nodeTypes;
        const bin = readFileSync(BIN);
        const loaded = new Float32Array(bin.buffer, bin.byteOffset, bin.byteLength / 4);
        buf = new Float32Array(total * rowStride);
        buf.set(loaded.subarray(0, Math.min(loaded.length, buf.length)));
        resumeDone = prog.done;
        log(`  レジューム: ${resumeDone}/${total} 済（samples=${S}）から再開`);
      } else {
        log(`  progress は samples 不一致（${prog.samples}≠${S}）→ 最初から生成`);
      }
    } catch (e) {
      log(`  progress 読込失敗 → 最初から生成: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  let warm: Map<string, Float64Array> | undefined;
  let done = 0, tMs = 0;
  const t0 = Date.now();
  let flatRow = 0; // スネーク訪問順に詰める（格子座標ではなく訪問順で行を並べる）
  for (const ix of snake()) {
    if (done < resumeDone) { done++; flatRow++; continue; }

    // 制御ポーリング（ダッシュボードからの pause / stop / CPU休憩）。点間でのみ効くので
    // 途中の点を壊さない。stop はチェックポイント保存して正常終了（次回レジューム可）。
    const nextStacks = ix.map((i) => AXIS[i]!);
    let ctl = readControl();
    while (ctl === 'pause') {
      writeStatus(done, done - resumeDone, tMs, nextStacks, 'paused');
      await sleep(1000);
      ctl = readControl();
    }
    if (ctl === 'stop') {
      if (buf) saveCkpt(done, false);
      writeStatus(done, done - resumeDone, tMs, nextStacks, 'stopped');
      log(`  停止要求で中断: ${done}/${total} 済（次回レジューム可）`);
      return;
    }

    const st = buildState(nextStacks);
    const opts = warm ? { ...gold, initStrategy: warm, initIterations: 120 } : gold;
    const s0 = Date.now();
    const res = await solveMultiway(st, opts);
    tMs += Date.now() - s0;
    warm = res.strategies;

    if (!buf) {
      nodeKeys = res.nodes.map((n) => n.key);
      nodeActors = res.nodes.map((n) => n.actor);
      nodeTypes = res.nodes.map((n) => n.actionType);
      outDim = nodeKeys.length * FLOATS_PER_NODE + D;
      rowStride = D + outDim;
      buf = new Float32Array(total * rowStride);
      log(`  ノード数=${nodeKeys.length} / outDim=${outDim} / rowStride=${rowStride} / 総容量=${((total * rowStride * 4) / 1024 / 1024).toFixed(2)}MB`);
    }

    const base = flatRow * rowStride;
    // 入力: D スタック(bb)
    for (let s = 0; s < D; s++) buf[base + s] = AXIS[ix[s]!]!;
    // 出力: ノードごと 169 EV差
    const outBase = base + D;
    for (let n = 0; n < res.nodes.length; n++) {
      const ev = res.nodes[n]!.ev;
      const off = outBase + n * FLOATS_PER_NODE;
      for (let c = 0; c < N_CLASSES; c++) buf[off + c] = ev[HAND_CLASS_ORDER[c]!]!;
    }
    // 出力末尾: D eqPost（order順）
    const eqOff = outBase + nodeKeys.length * FLOATS_PER_NODE;
    for (let s = 0; s < D; s++) buf[eqOff + s] = res.equity[ORDER[s]!]!.post;

    done++; flatRow++;
    const solved = done - resumeDone;
    if (done % CKPT_EVERY === 0 && done < total) saveCkpt(done, false);
    writeStatus(done, solved, tMs, nextStacks, done === total ? 'done' : 'running');
    if (done % 25 === 0 || done === total) {
      const eta = (tMs / solved) * (total - done) / 1000;
      log(`  ${done}/${total} 完了 (平均${(tMs / solved / 1000).toFixed(2)}s/点, 残り約${(eta / 60).toFixed(1)}分)`);
    }
  }

  saveCkpt(total, true);
  writeStatus(total, total - resumeDone, tMs, null, 'done');
  const gz = gzipSync(Buffer.from(buf!.buffer, 0, buf!.byteLength)).length;
  log(`\n生成完了: ${total}点 / ${((Date.now() - t0) / 1000 / 60).toFixed(1)}分`);
  log(`保存: artifacts/${TAG}.train.f32.bin = ${(buf!.byteLength / 1024 / 1024).toFixed(2)}MB (gzip ${(gz / 1024 / 1024).toFixed(2)}MB) + meta.json`);
}
void main();
