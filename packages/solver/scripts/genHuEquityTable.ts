/**
 * HU 169×169 all-in equity テーブルの厳密生成 CLI（成果物の書き出し）。
 *
 * 使い方:
 *   node --import tsx packages/solver/scripts/genHuEquityTable.ts            # 並列生成（既定 24 プロセス）
 *   node --import tsx packages/solver/scripts/genHuEquityTable.ts --jobs 8   # 並列数を指定
 *   node --import tsx packages/solver/scripts/genHuEquityTable.ts --serial   # 単一プロセス（低速・デバッグ用）
 *   （内部）--shard k/N                                                       # シャード worker
 *
 * 出力（packages/solver/artifacts/）:
 *   hu-equity-169.f32.bin   Float32 169×169 行優先。equity[i*169+j] = hero i vs villain j
 *   hu-equity-169.meta.json スキーマ・順序・生成情報
 *
 * 厳密性の根拠は huTable.ts を参照（hero 固定 + villain suit 正規化 + 零和上三角）。
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { HAND_CLASS_ORDER } from '../src/huEquity.js';
import { classEquityCanonical } from '../src/huTable.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_DIR = join(HERE, '..', 'artifacts');
const N = HAND_CLASS_ORDER.length; // 169

/** スモーク用の行制限（--rows R）。既定は全 169。両モードで一致させる。 */
function parseRows(): number {
  const a = process.argv.slice(2);
  const i = a.indexOf('--rows');
  return i >= 0 ? Number(a[i + 1]) : N;
}
const ROWS = parseRows();

/** 上三角（i<=j）ペアを決定的順序で列挙。ROWS 制限つき。 */
function upperTrianglePairs(): [number, number][] {
  const pairs: [number, number][] = [];
  for (let i = 0; i < ROWS; i++) for (let j = i; j < ROWS; j++) pairs.push([i, j]);
  return pairs;
}

function equityForPair(i: number, j: number): number {
  if (i === j) return 0.5; // 零和対称
  return classEquityCanonical(HAND_CLASS_ORDER[i]!, HAND_CLASS_ORDER[j]!);
}

// ---- シャード worker ----
function runShard(shardIdx: number, jobs: number): void {
  const pairs = upperTrianglePairs();
  const mine = pairs.filter((_, idx) => idx % jobs === shardIdx);
  const out = new Float64Array(mine.length);
  const t0 = Date.now();
  for (let m = 0; m < mine.length; m++) {
    out[m] = equityForPair(mine[m]![0], mine[m]![1]);
    if ((m & 1023) === 0) {
      process.stderr.write(
        `shard ${shardIdx}: ${m}/${mine.length} (${(((Date.now() - t0) / 1000)).toFixed(0)}s)\n`,
      );
    }
  }
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const buf = Buffer.from(out.buffer, out.byteOffset, out.byteLength);
  writeFileSync(join(ARTIFACT_DIR, `_partial-${shardIdx}-of-${jobs}.f64`), buf);
  process.stderr.write(`shard ${shardIdx}: done ${mine.length} pairs in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
}

// ---- 単一プロセス生成 ----
function runSerial(): Float64Array {
  const equity = new Float64Array(N * N);
  const pairs = upperTrianglePairs();
  const t0 = Date.now();
  for (let p = 0; p < pairs.length; p++) {
    const [i, j] = pairs[p]!;
    const eij = equityForPair(i, j);
    equity[i * N + j] = eij;
    equity[j * N + i] = 1 - eij;
    if ((p & 511) === 0) {
      process.stderr.write(`${p}/${pairs.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)\n`);
    }
  }
  return equity;
}

// ---- 並列オーケストレーション ----
async function runParallel(jobs: number): Promise<Float64Array> {
  const scriptPath = fileURLToPath(import.meta.url);
  mkdirSync(ARTIFACT_DIR, { recursive: true });

  await Promise.all(
    Array.from({ length: jobs }, (_, k) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--import', 'tsx', scriptPath, '--shard', `${k}/${jobs}`, '--rows', String(ROWS)],
          { stdio: ['ignore', 'inherit', 'inherit'] },
        );
        child.on('exit', (code) =>
          code === 0 ? resolve() : reject(new Error(`shard ${k} exited ${code}`)),
        );
        child.on('error', reject);
      }),
    ),
  );

  // マージ
  const equity = new Float64Array(N * N);
  const pairs = upperTrianglePairs();
  const cursors = new Array<number>(jobs).fill(0);
  const partials: Float64Array[] = [];
  for (let k = 0; k < jobs; k++) {
    const raw = readFileSync(join(ARTIFACT_DIR, `_partial-${k}-of-${jobs}.f64`));
    partials.push(new Float64Array(raw.buffer, raw.byteOffset, raw.byteLength / 8));
  }
  for (let idx = 0; idx < pairs.length; idx++) {
    const shard = idx % jobs;
    const eij = partials[shard]![cursors[shard]!]!;
    cursors[shard]!++;
    const [i, j] = pairs[idx]!;
    equity[i * N + j] = eij;
    equity[j * N + i] = 1 - eij;
  }
  // 後片付け
  for (let k = 0; k < jobs; k++) {
    rmSync(join(ARTIFACT_DIR, `_partial-${k}-of-${jobs}.f64`), { force: true });
  }
  return equity;
}

function writeArtifact(equity: Float64Array): void {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const f32 = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) f32[i] = equity[i]!;
  const buf = Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
  writeFileSync(join(ARTIFACT_DIR, 'hu-equity-169.f32.bin'), buf);

  const meta = {
    version: 1,
    kind: 'hu-allin-equity',
    dims: N,
    order: HAND_CLASS_ORDER,
    format: 'float32-le',
    layout: 'row-major; equity[i*169+j] = equity of hero class i vs villain class j (win+tie/2)',
    exact: true,
    method: 'canonical hero combo + villain suit-isomorphism grouping + zero-sum upper triangle',
    generatedAtNote: 'run `npm run gen:hu-equity` to regenerate',
  };
  writeFileSync(join(ARTIFACT_DIR, 'hu-equity-169.meta.json'), JSON.stringify(meta, null, 2));
}

function sanityCheck(equity: Float64Array): void {
  const idx = (label: string) => HAND_CLASS_ORDER.indexOf(label);
  const get = (a: string, b: string) => equity[idx(a) * N + idx(b)]!;
  const checks: [string, string, number, number][] = [
    ['AA', 'KK', 0.815, 0.825],
    ['AA', '22', 0.8, 0.83],
    ['72o', 'AA', 0.1, 0.14],
    ['AKs', 'QQ', 0.45, 0.475],
  ];
  for (const [a, b, lo, hi] of checks) {
    const v = get(a, b);
    const ok = v >= lo && v <= hi;
    process.stderr.write(`sanity ${a} vs ${b} = ${v.toFixed(4)} [${lo}, ${hi}] ${ok ? 'OK' : 'FAIL'}\n`);
    if (!ok) throw new Error(`sanity check failed: ${a} vs ${b} = ${v}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const shardArg = args.indexOf('--shard');
  if (shardArg >= 0) {
    const [k, n] = args[shardArg + 1]!.split('/').map(Number);
    runShard(k!, n!);
    return;
  }

  let jobs = 24;
  const jobsArg = args.indexOf('--jobs');
  if (jobsArg >= 0) jobs = Number(args[jobsArg + 1]);
  const serial = args.includes('--serial');

  // --verify: 並列とシリアルが一致するかを ROWS 範囲で確認（成果物は書かない）
  if (args.includes('--verify')) {
    const par = await runParallel(jobs);
    const ser = runSerial();
    let maxDiff = 0;
    for (let i = 0; i < N * N; i++) maxDiff = Math.max(maxDiff, Math.abs(par[i]! - ser[i]!));
    process.stderr.write(`verify(rows=${ROWS}): parallel vs serial maxDiff = ${maxDiff.toExponential(2)}\n`);
    if (maxDiff > 0) throw new Error('parallel != serial');
    process.stderr.write('verify OK\n');
    return;
  }

  const t0 = Date.now();
  const equity = serial ? runSerial() : await runParallel(jobs);
  process.stderr.write(`生成完了: ${((Date.now() - t0) / 1000 / 60).toFixed(1)} 分\n`);
  if (ROWS === N) {
    sanityCheck(equity);
    writeArtifact(equity);
    process.stderr.write(`書き出し完了: ${ARTIFACT_DIR}\n`);
  } else {
    process.stderr.write(`(rows=${ROWS} の部分生成のため成果物は書き出さない)\n`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

void existsSync; // (reserved for future resumability)
