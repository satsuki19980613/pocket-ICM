/**
 * 3-way オールイン・ショーダウン結果テーブルの生成 CLI（フィージビリティ・スパイク）。
 *
 * 169 ハンドクラスの**昇順ソート済み三つ組**(c1<=c2<=c3, 169*170*171/6 = 818,805 通り)
 * ごとに、3人オールインの弱順位分布（13パターン, src/wintie3Index.ts の PATTERNS 参照）を
 * Monte Carlo で見積もり、あわせて衝突のない具体コンボ三つ組の**厳密**個数（validCount）を
 * 全列挙で求める。
 *
 * ## サンプリング方法
 * 各クラスの具体コンボ（ペア=6/スーテッド=4/オフスート=12）を全列挙し、3クラス間で
 * カードが衝突しない組（i,j,k）だけを事前に集めておく（最大 12*12*12=1728 通りの
 * チェックで済む）。この「衝突なしコンボ三つ組」のリストから一様に 1 本引けば、それは
 * そのまま「衝突しない具体コンボ三つ組から一様抽出」と等価（棄却サンプリングと同じ分布を
 * 前計算で先取りしているだけ）。ボードは残りカードから 5 枚をビットマスクで衝突回避しつつ
 * 一様抽出する。validCount=0（例: AA-AA-AA は 4 枚しか無いエースを 3 人×2枚=6枚に配れない
 * ので不可能）の三つ組は MC をスキップし、確率は全 0 で埋める。
 *
 * ## CLI
 *   node --import tsx packages/solver/scripts/gen3wayOutcomeTable.ts \
 *     [--samples 40000] [--jobs 8] [--limit 300] [--out <dir>]
 *   （内部）--shard k/N
 *
 * --limit を指定した場合は本生成ではなくスモーク実行とみなし、アーティファクトは
 * 書き出さず統計（処理三つ組数・総サンプル数・経過時間・samples/sec）だけを表示する。
 *
 * ## 出力（--limit 無指定時, packages/solver/artifacts/）
 *   wintie3-169.u16.bin   uint16 LE。三つ組 index の昇順に、
 *                         [12個の確率(0..1を65535倍で丸め, PATTERNS[0..11])][validCount] の
 *                         13 uint16 を並べる（PATTERNS[12]=[0,0,0]の確率は 1-他11個の和で復元）。
 *   wintie3-169.meta.json
 */

import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { HAND_CLASS_ORDER, HAND_CLASS_INDEX, handClassToCombos } from '../src/huEquity.js';
import { eval7 } from '../src/evaluator.js';
import { DeterministicRng } from '../src/placement.js';
import { MC_SEED } from '../src/mcConfig.js';
import { N_CLASSES3, N_TRIPLES3, PATTERNS, patternIndexOf, sortedTripleIndex } from '../src/wintie3Index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ARTIFACT_DIR = join(HERE, '..', 'artifacts');
const N = N_CLASSES3; // 169
const PROBS_STORED = PATTERNS.length - 1; // 12（13個目は 1-sum で復元）

// ---- CLI 引数 ----
function argVal(flag: string): string | undefined {
  const a = process.argv.slice(2);
  const i = a.indexOf(flag);
  return i >= 0 ? a[i + 1] : undefined;
}
const SAMPLES = Number(argVal('--samples') ?? 40_000);
const JOBS = Number(argVal('--jobs') ?? 1);
const LIMIT_ARG = argVal('--limit');
const LIMIT = LIMIT_ARG !== undefined ? Number(LIMIT_ARG) : undefined;
const OUT_DIR = argVal('--out') ?? DEFAULT_ARTIFACT_DIR;
const ALL_COUNT = LIMIT !== undefined ? Math.min(LIMIT, N_TRIPLES3) : N_TRIPLES3;

// ---- クラス→コンボ（カード id ペア）の事前展開 ----
const CLASS_COMBOS: [number, number][][] = HAND_CLASS_ORDER.map((label) => handClassToCombos(label));

/** 32bit 整数ミックス（三つ組 index 固有のシード派生用, 決定的）。 */
function mixSeed(a: number, b: number): number {
  let h = (a ^ 0x9e3779b1) >>> 0;
  h = (Math.imul(h ^ b, 0x85ebca6b) + 0x165667b1) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * dense ranking（ギャップなしの弱順位, 0=1位）における「自分より真に強い"値"の個数」。
 *
 * 注意: 単純な strongerCount（自分より強い"人数"）ではダメ。例えば3人中2人が同点で1位、
 * 残り1人が最下位のケースでは、最下位のプレイヤーから見て「自分より強い人数」は2人だが、
 * 強い"値"は1種類しかない（1位タイの2人は同じ値）ので dense rank は 1（[0,0,1]）。
 * strongerCount で数えると 2（[0,0,2]）になってしまい、本テーブルが定義する 13 パターン
 * （dense ranking のみ, [0,0,2] のようなギャップ付きパターンは存在しない）と食い違う。
 * そのため「他2者の値のうち、自分より大きい"異なる値"の個数」を数える。
 */
function distinctGreaterCount(mine: number, otherA: number, otherB: number): number {
  const aGreater = otherA > mine;
  const bGreater = otherB > mine;
  if (aGreater && bGreater) return otherA === otherB ? 1 : 2;
  if (aGreater || bGreater) return 1;
  return 0;
}

/**
 * 3クラスの具体コンボから、カード衝突のない三つ組 (i,j,k)（各クラス内のコンボ index）を
 * 全列挙する。最大 12*12*12=1728 通りのチェック。これが validCount の厳密値そのもの。
 */
function buildValidCombos(
  a: readonly [number, number][],
  b: readonly [number, number][],
  c: readonly [number, number][],
): { vi: Uint8Array; vj: Uint8Array; vk: Uint8Array } {
  const vi: number[] = [];
  const vj: number[] = [];
  const vk: number[] = [];
  for (let i = 0; i < a.length; i++) {
    const [a0, a1] = a[i]!;
    for (let j = 0; j < b.length; j++) {
      const [b0, b1] = b[j]!;
      if (b0 === a0 || b0 === a1 || b1 === a0 || b1 === a1) continue;
      for (let k = 0; k < c.length; k++) {
        const [c0, c1] = c[k]!;
        if (c0 === a0 || c0 === a1 || c0 === b0 || c0 === b1) continue;
        if (c1 === a0 || c1 === a1 || c1 === b0 || c1 === b1) continue;
        vi.push(i);
        vj.push(j);
        vk.push(k);
      }
    }
  }
  return { vi: Uint8Array.from(vi), vj: Uint8Array.from(vj), vk: Uint8Array.from(vk) };
}

export interface TripleMcResult {
  /** PATTERNS[0..11] に対応する確率（PATTERNS[12]=全タイの確率は 1-sum で復元）。 */
  probs12: Float64Array;
  /** 衝突のない具体コンボ三つ組の厳密個数（0..1728）。 */
  validCount: number;
}

/**
 * ソート済み三つ組 (c1<=c2<=c3) の弱順位分布を MC 推定する（本モジュールの中核）。
 * validCount=0（配布不可能な組, 例 AA-AA-AA）なら MC をスキップし確率は全 0。
 * scripts 外（スポットチェック用スクリプト等）からも呼べるよう export する。
 */
export function mcTriple(c1: number, c2: number, c3: number, samples: number, rng: DeterministicRng): TripleMcResult {
  const a = CLASS_COMBOS[c1]!;
  const b = CLASS_COMBOS[c2]!;
  const c = CLASS_COMBOS[c3]!;
  const { vi, vj, vk } = buildValidCombos(a, b, c);
  const validCount = vi.length;
  const counts = new Float64Array(13);
  if (validCount > 0) {
    const bufA = [0, 0, 0, 0, 0, 0, 0];
    const bufB = [0, 0, 0, 0, 0, 0, 0];
    const bufC = [0, 0, 0, 0, 0, 0, 0];
    for (let s = 0; s < samples; s++) {
      const r = rng.nextInt(validCount);
      const [a0, a1] = a[vi[r]!]!;
      const [b0, b1] = b[vj[r]!]!;
      const [c0, c1v] = c[vk[r]!]!;
      bufA[0] = a0;
      bufA[1] = a1;
      bufB[0] = b0;
      bufB[1] = b1;
      bufC[0] = c0;
      bufC[1] = c1v;

      // 使用済みカードのビットマスク（0..31 / 32..51）でボード抽出時の衝突を回避。
      let uLo = 0;
      let uHi = 0;
      const mark = (card: number): void => {
        if (card < 32) uLo |= 1 << card;
        else uHi |= 1 << (card - 32);
      };
      mark(a0);
      mark(a1);
      mark(b0);
      mark(b1);
      mark(c0);
      mark(c1v);

      let filled = 0;
      while (filled < 5) {
        const x = rng.nextInt(52);
        if (x < 32) {
          if ((uLo >>> x) & 1) continue;
          uLo |= 1 << x;
        } else {
          if ((uHi >>> (x - 32)) & 1) continue;
          uHi |= 1 << (x - 32);
        }
        bufA[2 + filled] = x;
        bufB[2 + filled] = x;
        bufC[2 + filled] = x;
        filled++;
      }

      const sA = eval7(bufA);
      const sB = eval7(bufB);
      const sC = eval7(bufC);
      const pA = distinctGreaterCount(sA, sB, sC);
      const pB = distinctGreaterCount(sB, sA, sC);
      const pC = distinctGreaterCount(sC, sA, sB);
      counts[patternIndexOf(pA, pB, pC)]!++;
    }
    for (let n = 0; n < 13; n++) counts[n] = counts[n]! / samples;
  }
  return { probs12: counts.subarray(0, PROBS_STORED), validCount };
}

/** ソート済み三つ組一覧（辞書式順, sortedTripleIndex と同じ順序）を先頭 count 件だけ作る。 */
function buildTripleList(count: number): { c1: Uint8Array; c2: Uint8Array; c3: Uint8Array } {
  const c1 = new Uint8Array(count);
  const c2 = new Uint8Array(count);
  const c3 = new Uint8Array(count);
  let idx = 0;
  outer: for (let i = 0; i < N; i++) {
    for (let j = i; j < N; j++) {
      for (let k = j; k < N; k++) {
        if (idx >= count) break outer;
        c1[idx] = i;
        c2[idx] = j;
        c3[idx] = k;
        idx++;
      }
    }
  }
  if (idx !== count) throw new Error(`buildTripleList: 期待 ${count} 件, 実際 ${idx} 件`);
  return { c1, c2, c3 };
}

interface ShardStats {
  processed: number;
  totalSamples: number;
  elapsedMs: number;
}

/** 1 プロセス分の処理（シャード or シリアル共通）。out は 13 uint16 * mine.length。 */
function processShard(
  triples: { c1: Uint8Array; c2: Uint8Array; c3: Uint8Array },
  mineIdx: number[],
  onProgress?: (done: number, total: number, elapsedMs: number) => void,
): { out: Uint16Array; stats: ShardStats } {
  const out = new Uint16Array(mineIdx.length * 13);
  let totalSamples = 0;
  const t0 = Date.now();
  for (let m = 0; m < mineIdx.length; m++) {
    const t = mineIdx[m]!;
    const c1 = triples.c1[t]!;
    const c2 = triples.c2[t]!;
    const c3 = triples.c3[t]!;
    const rng = new DeterministicRng(mixSeed(MC_SEED, t));
    const { probs12, validCount } = mcTriple(c1, c2, c3, SAMPLES, rng);
    if (validCount > 0) totalSamples += SAMPLES;
    const base = m * 13;
    for (let n = 0; n < PROBS_STORED; n++) {
      out[base + n] = Math.round(probs12[n]! * 65535);
    }
    out[base + PROBS_STORED] = validCount;
    if (onProgress && (m & 63) === 0) onProgress(m, mineIdx.length, Date.now() - t0);
  }
  return { out, stats: { processed: mineIdx.length, totalSamples, elapsedMs: Date.now() - t0 } };
}

// ---- シャード worker（子プロセス）----
function runShard(shardIdx: number, jobs: number): void {
  const triples = buildTripleList(ALL_COUNT);
  const mineIdx: number[] = [];
  for (let t = 0; t < ALL_COUNT; t++) if (t % jobs === shardIdx) mineIdx.push(t);
  const { out, stats } = processShard(triples, mineIdx, (done, total, ms) => {
    process.stderr.write(`shard ${shardIdx}: ${done}/${total} (${(ms / 1000).toFixed(0)}s)\n`);
  });
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, `_wt3-partial-${shardIdx}-of-${jobs}.u16`), Buffer.from(out.buffer, out.byteOffset, out.byteLength));
  writeFileSync(join(OUT_DIR, `_wt3-stats-${shardIdx}-of-${jobs}.json`), JSON.stringify(stats));
  const rate = stats.totalSamples / (stats.elapsedMs / 1000);
  process.stderr.write(
    `shard ${shardIdx}: done ${stats.processed} triples in ${(stats.elapsedMs / 1000).toFixed(1)}s ` +
      `(${stats.totalSamples.toLocaleString()} samples, ${rate.toFixed(0)} samples/sec)\n`,
  );
}

function runSerial(): { full: Uint16Array; stats: ShardStats } {
  const triples = buildTripleList(ALL_COUNT);
  const mineIdx = Array.from({ length: ALL_COUNT }, (_, i) => i);
  const { out, stats } = processShard(triples, mineIdx, (done, total, ms) => {
    process.stderr.write(`${done}/${total} (${(ms / 1000).toFixed(0)}s)\n`);
  });
  return { full: out, stats };
}

async function runParallel(jobs: number): Promise<{ full: Uint16Array | null; stats: ShardStats }> {
  const scriptPath = fileURLToPath(import.meta.url);
  mkdirSync(OUT_DIR, { recursive: true });
  const childArgs = ['--samples', String(SAMPLES), '--out', OUT_DIR];
  if (LIMIT !== undefined) childArgs.push('--limit', String(LIMIT));
  await Promise.all(
    Array.from({ length: jobs }, (_, k) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--import', 'tsx', scriptPath, '--shard', `${k}/${jobs}`, ...childArgs],
          { stdio: ['ignore', 'inherit', 'inherit'] },
        );
        child.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`shard ${k} exited ${c}`))));
        child.on('error', reject);
      }),
    ),
  );

  // 各シャードの統計を集計。
  let processed = 0;
  let totalSamples = 0;
  let maxElapsed = 0;
  const partials: Uint16Array[] = [];
  for (let k = 0; k < jobs; k++) {
    const statsRaw = JSON.parse(readFileSync(join(OUT_DIR, `_wt3-stats-${k}-of-${jobs}.json`), 'utf8')) as ShardStats;
    processed += statsRaw.processed;
    totalSamples += statsRaw.totalSamples;
    maxElapsed = Math.max(maxElapsed, statsRaw.elapsedMs);
    const raw = readFileSync(join(OUT_DIR, `_wt3-partial-${k}-of-${jobs}.u16`));
    partials.push(new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2));
  }

  let full: Uint16Array | null = null;
  if (LIMIT === undefined) {
    // 本生成時のみ、全 index 順に組み直したフル配列を作る（--limit のスモークでは不要）。
    full = new Uint16Array(ALL_COUNT * 13);
    const cursors = new Array<number>(jobs).fill(0);
    for (let t = 0; t < ALL_COUNT; t++) {
      const shard = t % jobs;
      const c = cursors[shard]!;
      cursors[shard] = c + 1;
      const src = partials[shard]!;
      for (let n = 0; n < 13; n++) full[t * 13 + n] = src[c * 13 + n]!;
    }
  }

  for (let k = 0; k < jobs; k++) {
    rmSync(join(OUT_DIR, `_wt3-partial-${k}-of-${jobs}.u16`), { force: true });
    rmSync(join(OUT_DIR, `_wt3-stats-${k}-of-${jobs}.json`), { force: true });
  }
  return { full, stats: { processed, totalSamples, elapsedMs: maxElapsed } };
}

function writeArtifact(full: Uint16Array): void {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'wintie3-169.u16.bin'), Buffer.from(full.buffer, full.byteOffset, full.byteLength));
  writeFileSync(
    join(OUT_DIR, 'wintie3-169.meta.json'),
    JSON.stringify(
      {
        version: 1,
        kind: 'wintie3-allin-outcome',
        dims: N,
        order: HAND_CLASS_ORDER,
        nTriples: N_TRIPLES3,
        samples: SAMPLES,
        format: 'uint16-le',
        patterns: PATTERNS,
        patternsNote:
          'PATTERNS[n] = [p0,p1,p2] はソート済みスロット0/1/2（c1<=c2<=c3の各クラス側）の弱順位' +
          '(dense ranking, 0=1位, 同着は同値)。PATTERNS[0..11]の確率を格納し、PATTERNS[12]=[0,0,0]' +
          '（3者タイ）の確率は 1 - sum(他11個) で復元する。',
        layout:
          '三つ組 index（sortedTripleIndex, 辞書式順: 外側c1昇順→c2昇順(c1..168)→c3昇順(c2..168)）の' +
          '昇順に、各 index で [12 uint16 = round(prob*65535), PATTERNS[0..11]順][1 uint16 = validCount] ' +
          'の計 13 uint16 を並べる。',
        tripleIndexing:
          'index(c1,c2,c3) [c1<=c2<=c3] = BLOCK_START[c1] + rowOffset(c1,c2) + (c3-c2)。' +
          '実装は src/wintie3Index.ts の sortedTripleIndex / tripleIndex を参照（任意順の' +
          '(x,y,z)からの index と、確率をプレイヤー順へ戻す perm も同モジュールで提供）。',
        validCountNote:
          'validCount = 3クラスの具体コンボからカード衝突のない三つ組の厳密個数（0..1728）。' +
          'MCではなく全列挙。0の場合（配布不可能, 例 AA-AA-AA）は確率も全0。',
        method: 'monte-carlo (uniform draw over precomputed collision-free combo triples) + exact validCount by enumeration',
      },
      null,
      2,
    ),
  );
}

/**
 * `--spot "AA,KK,QQ"` によるスポットチェック（フル生成なしで任意の三つ組を確認する）。
 * 3クラスをソートしてストレージのスロット順に割り当て、13パターンの確率と、
 * slot0/slot1 の周辺勝率（同着を除く「上位」判定の確率和）を表示する。
 */
function runSpotCheck(spec: string): void {
  const labels = spec.split(',').map((s) => s.trim());
  if (labels.length !== 3) throw new Error('--spot には "AA,KK,QQ" のように3クラスをカンマ区切りで指定する');
  const pairs = labels.map((label) => {
    const idx = HAND_CLASS_INDEX[label];
    if (idx === undefined) throw new Error(`unknown hand class: ${label}`);
    return { label, idx };
  });
  pairs.sort((p, q) => p.idx - q.idx);
  const [c1, c2, c3] = [pairs[0]!.idx, pairs[1]!.idx, pairs[2]!.idx];
  const index = sortedTripleIndex(c1, c2, c3);
  const rng = new DeterministicRng(mixSeed(MC_SEED, index));
  const { probs12, validCount } = mcTriple(c1, c2, c3, SAMPLES, rng);
  const sum12 = probs12.reduce((a, b) => a + b, 0);
  const probs13 = [...probs12, 1 - sum12];

  process.stderr.write(
    `spot check: slot0=${pairs[0]!.label}(cls${c1}) slot1=${pairs[1]!.label}(cls${c2}) slot2=${pairs[2]!.label}(cls${c3})\n` +
      `  tripleIndex=${index}, validCount=${validCount}, samples=${SAMPLES}\n`,
  );
  for (let n = 0; n < PATTERNS.length; n++) {
    process.stderr.write(`  P${JSON.stringify(PATTERNS[n])} = ${probs13[n]!.toFixed(6)}\n`);
  }
  // slot0 が slot1 より上位（同着でなく厳密に良い順位）のパターンの確率和 = 2-way 周辺勝率相当。
  let aboveSum = 0;
  for (let n = 0; n < PATTERNS.length; n++) {
    const [p0, p1] = PATTERNS[n]!;
    if (p0 < p1) aboveSum += probs13[n]!;
  }
  process.stderr.write(
    `  slot0(${pairs[0]!.label}) が slot1(${pairs[1]!.label}) より上位の確率（2-way周辺勝率相当） = ${aboveSum.toFixed(6)}\n`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const si = args.indexOf('--shard');
  if (si >= 0) {
    const [k, n] = args[si + 1]!.split('/').map(Number);
    runShard(k!, n!);
    return;
  }

  const SPOT = argVal('--spot');
  if (SPOT !== undefined) {
    runSpotCheck(SPOT);
    return;
  }

  process.stderr.write(
    `# gen3wayOutcomeTable: samples=${SAMPLES}, jobs=${JOBS}, limit=${LIMIT ?? '(none, full ' + N_TRIPLES3 + ')'}\n`,
  );
  const t0 = Date.now();
  const { full, stats } =
    JOBS <= 1
      ? (() => {
          const r = runSerial();
          return { full: LIMIT === undefined ? r.full : null, stats: r.stats };
        })()
      : await runParallel(JOBS);
  const wallMs = Date.now() - t0;
  const rate = stats.totalSamples / (stats.elapsedMs / 1000);
  const wallRate = stats.totalSamples / (wallMs / 1000);
  process.stderr.write(
    `\n完了: ${stats.processed.toLocaleString()} 三つ組 / ${stats.totalSamples.toLocaleString()} samples\n` +
      `  シャード内経過(最大): ${(stats.elapsedMs / 1000).toFixed(1)}s → ${rate.toFixed(0)} samples/sec/process\n` +
      `  壁時計経過: ${(wallMs / 1000).toFixed(1)}s → ${wallRate.toFixed(0)} samples/sec(全体)\n`,
  );

  if (LIMIT !== undefined) {
    process.stderr.write(`(--limit ${LIMIT} のスモークのためアーティファクトは書き出さない)\n`);
    return;
  }
  if (!full) throw new Error('internal: full array missing for non-limit run');
  writeArtifact(full);
  process.stderr.write(`書き出し完了: ${OUT_DIR}/wintie3-169.u16.bin\n`);
}

// エントリポイント判定: このファイルを `node --import tsx gen3wayOutcomeTable.ts ...` として
// 直接実行した場合だけ main() を起動する。`mcTriple` をテスト等から import しただけで
// 2 時間かかるフル生成が走り出す事故を防ぐ（実際に一度事故らせて発覚: import しただけで
// process.argv 由来の既定値 (samples=40000, jobs=1, limit無指定=フル 818,805 三つ組) で
// main() が起動していた）。`--shard` worker（runParallel が子プロセスとして spawn する側）は
// 直接実行なのでここを通る。
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
