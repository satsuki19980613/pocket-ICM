/**
 * HU 169×169「勝ち率・引き分け率」テーブルの厳密生成 CLI。
 *
 * 既存の hu-equity-169（equity = win + tie/2 の1値）では ICM に不十分。
 * 勝ち／引き分け（スプリット）／負けで**最終スタックが別物**になるため 3 通りを分離する
 * （例: AA vs AA は tie 95.7% ＝ ほぼチョップ。equity 0.5 を「五分の勝負」と扱うと大間違い）。
 * 盤面全列挙は exactEquityVsHands が既に win/tie/lose を数えるので追加コストは無い。
 *
 * 使い方:
 *   node --import tsx packages/solver/scripts/genHuWinTieTable.ts            # 並列生成（既定 24）
 *   node --import tsx packages/solver/scripts/genHuWinTieTable.ts --jobs 12
 *   node --import tsx packages/solver/scripts/genHuWinTieTable.ts --rows 20  # スモーク（書き出さない）
 *   （内部）--shard k/N
 *
 * 出力（packages/solver/artifacts/）:
 *   hu-wintie-169.f32.bin   Float32。前半 169² = win, 後半 169² = tie（行優先, hero i vs villain j）
 *   hu-wintie-169.meta.json
 *
 * 厳密性の根拠は huTable.ts と同じ（hero 代表コンボ + villain suit 正規化）。
 * 対称性: win[j][i] = 1 − win[i][j] − tie[i][j], tie[j][i] = tie[i][j] → 上三角のみ評価。
 */

import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { HAND_CLASS_ORDER } from '../src/huEquity.js';
import { classWinTieCanonical } from '../src/huTable.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_DIR = join(HERE, '..', 'artifacts');
const N = HAND_CLASS_ORDER.length; // 169

function argVal(flag: string): string | undefined {
  const a = process.argv.slice(2);
  const i = a.indexOf(flag);
  return i >= 0 ? a[i + 1] : undefined;
}
const ROWS = Number(argVal('--rows') ?? N);

/** 上三角（i<=j）ペアを決定的順序で列挙。 */
function upperTrianglePairs(): [number, number][] {
  const pairs: [number, number][] = [];
  for (let i = 0; i < ROWS; i++) for (let j = i; j < ROWS; j++) pairs.push([i, j]);
  return pairs;
}

function pairWinTie(i: number, j: number): [number, number] {
  const r = classWinTieCanonical(HAND_CLASS_ORDER[i]!, HAND_CLASS_ORDER[j]!);
  return [r.win, r.tie];
}

// ---- シャード worker ----
function runShard(shardIdx: number, jobs: number): void {
  const pairs = upperTrianglePairs();
  const mine = pairs.filter((_, idx) => idx % jobs === shardIdx);
  const out = new Float64Array(mine.length * 2);
  const t0 = Date.now();
  for (let m = 0; m < mine.length; m++) {
    const [w, t] = pairWinTie(mine[m]![0], mine[m]![1]);
    out[m * 2] = w;
    out[m * 2 + 1] = t;
    if ((m & 255) === 0) {
      process.stderr.write(`shard ${shardIdx}: ${m}/${mine.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)\n`);
    }
  }
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeFileSync(
    join(ARTIFACT_DIR, `_wt-partial-${shardIdx}-of-${jobs}.f64`),
    Buffer.from(out.buffer, out.byteOffset, out.byteLength),
  );
  process.stderr.write(`shard ${shardIdx}: done ${mine.length} pairs in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
}

/** 上三角の (win,tie) 列から 169×169 の win/tie を対称性で埋める。 */
function fill(pairs: [number, number][], get: (idx: number) => [number, number]): { win: Float64Array; tie: Float64Array } {
  const win = new Float64Array(N * N);
  const tie = new Float64Array(N * N);
  for (let idx = 0; idx < pairs.length; idx++) {
    const [i, j] = pairs[idx]!;
    const [w, t] = get(idx);
    win[i * N + j] = w;
    tie[i * N + j] = t;
    if (i !== j) {
      win[j * N + i] = 1 - w - t; // villain 視点の勝ち = hero の負け
      tie[j * N + i] = t;
    }
  }
  return { win, tie };
}

function runSerial(): { win: Float64Array; tie: Float64Array } {
  const pairs = upperTrianglePairs();
  const t0 = Date.now();
  const vals: [number, number][] = [];
  for (let p = 0; p < pairs.length; p++) {
    vals.push(pairWinTie(pairs[p]![0], pairs[p]![1]));
    if ((p & 255) === 0) process.stderr.write(`${p}/${pairs.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)\n`);
  }
  return fill(pairs, (i) => vals[i]!);
}

async function runParallel(jobs: number): Promise<{ win: Float64Array; tie: Float64Array }> {
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
        child.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`shard ${k} exited ${c}`))));
        child.on('error', reject);
      }),
    ),
  );
  const pairs = upperTrianglePairs();
  const partials: Float64Array[] = [];
  for (let k = 0; k < jobs; k++) {
    const raw = readFileSync(join(ARTIFACT_DIR, `_wt-partial-${k}-of-${jobs}.f64`));
    partials.push(new Float64Array(raw.buffer, raw.byteOffset, raw.byteLength / 8));
  }
  const cursors = new Array<number>(jobs).fill(0);
  const res = fill(pairs, (idx) => {
    const shard = idx % jobs;
    const c = cursors[shard]!;
    cursors[shard] = c + 1;
    return [partials[shard]![c * 2]!, partials[shard]![c * 2 + 1]!];
  });
  for (let k = 0; k < jobs; k++) rmSync(join(ARTIFACT_DIR, `_wt-partial-${k}-of-${jobs}.f64`), { force: true });
  return res;
}

function writeArtifact(win: Float64Array, tie: Float64Array): void {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const f32 = new Float32Array(N * N * 2);
  for (let i = 0; i < N * N; i++) f32[i] = win[i]!;
  for (let i = 0; i < N * N; i++) f32[N * N + i] = tie[i]!;
  writeFileSync(join(ARTIFACT_DIR, 'hu-wintie-169.f32.bin'), Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength));
  writeFileSync(
    join(ARTIFACT_DIR, 'hu-wintie-169.meta.json'),
    JSON.stringify(
      {
        version: 1,
        kind: 'hu-allin-wintie',
        dims: N,
        order: HAND_CLASS_ORDER,
        format: 'float32-le',
        layout: `row-major; win[i*${N}+j] then tie[(${N}*${N})+i*${N}+j] = hero class i vs villain class j`,
        note: 'lose = 1 - win - tie。ICM は勝ち/引き分け/負けで最終スタックが異なるため 3 分割が必要。',
        exact: true,
        method: 'canonical hero combo + villain suit-isomorphism grouping + symmetry on upper triangle',
      },
      null,
      2,
    ),
  );
}

function sanityCheck(win: Float64Array, tie: Float64Array): void {
  const idx = (l: string) => HAND_CLASS_ORDER.indexOf(l);
  const W = (a: string, b: string) => win[idx(a) * N + idx(b)]!;
  const T = (a: string, b: string) => tie[idx(a) * N + idx(b)]!;
  const eq = (a: string, b: string) => W(a, b) + T(a, b) / 2;
  // 1) equity 換算が既知値と整合
  const checks: [string, string, number, number][] = [
    ['AA', 'KK', 0.815, 0.825],
    ['AKs', 'QQ', 0.45, 0.475],
    ['72o', 'AA', 0.1, 0.14],
  ];
  for (const [a, b, lo, hi] of checks) {
    const v = eq(a, b);
    const ok = v >= lo && v <= hi;
    process.stderr.write(`sanity equity ${a} vs ${b} = ${v.toFixed(4)} [${lo},${hi}] ${ok ? 'OK' : 'FAIL'}\n`);
    if (!ok) throw new Error(`sanity failed: ${a} vs ${b}`);
  }
  // 2) 同クラス対決は tie が大きい
  const tAA = T('AA', 'AA');
  process.stderr.write(`sanity tie AA vs AA = ${tAA.toFixed(4)} (>0.9 期待) ${tAA > 0.9 ? 'OK' : 'FAIL'}\n`);
  if (!(tAA > 0.9)) throw new Error('sanity failed: AA vs AA tie');
  // 3) 全要素が確率として妥当（0<=win, 0<=tie, win+tie<=1）
  let bad = 0;
  for (let i = 0; i < N * N; i++) {
    const w = win[i]!, t = tie[i]!;
    if (!(w >= -1e-9 && t >= -1e-9 && w + t <= 1 + 1e-9)) bad++;
  }
  process.stderr.write(`sanity range: ${bad} 件の不正 ${bad === 0 ? 'OK' : 'FAIL'}\n`);
  if (bad !== 0) throw new Error('sanity failed: probability range');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const si = args.indexOf('--shard');
  if (si >= 0) {
    const [k, n] = args[si + 1]!.split('/').map(Number);
    runShard(k!, n!);
    return;
  }
  const jobs = Number(argVal('--jobs') ?? 24);
  const t0 = Date.now();
  const { win, tie } = args.includes('--serial') ? runSerial() : await runParallel(jobs);
  process.stderr.write(`生成完了: ${((Date.now() - t0) / 1000 / 60).toFixed(1)} 分\n`);
  if (ROWS === N) {
    sanityCheck(win, tie);
    writeArtifact(win, tie);
    process.stderr.write(`書き出し完了: ${ARTIFACT_DIR}/hu-wintie-169.f32.bin\n`);
  } else {
    process.stderr.write(`(rows=${ROWS} のスモークのため書き出さない)\n`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
