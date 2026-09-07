/**
 * N人 push/fold NN 蒸留の学習（オフライン, dev専用・依存ゼロ）。
 *
 * genNwayTrainData.ts が出力した (スタック → EV差+eqPost) を読み、手書き MLP（src/nn）を
 * 回帰学習して重みを配信形式に書き出す。推論ランタイムは src/nnTable.ts。
 *
 * 出力: artifacts/nn{N}way.model.{meta.json,bin}
 *   bin = [標準化 f32 セクション][重み f16 セクション]（norm は精度維持で f32, 重みは容量半減で f16）
 * 実行: node --import tsx scripts/trainNwayNN.ts <players> [epochs] [hiddenCsv] [lr] [batch] [weightDecay]
 *   例: trainNwayNN.ts 5 400 256,256 0.01 64 0
 *   ※ 3125点の粗い格子（軸5点）に対し大容量MLP＋正則化ゼロは過学習する（val 発散）。
 *      小型ネット（例 64,64）＋ weightDecay（例 5e-4）＋控えめ epochs で汎化させる。
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { encodeFloat16 } from '../src/halfFloat.js';
import { trainMlp, evalMse } from '../src/nn/trainMlp.js';
import type { MlpModel } from '../src/nn/mlp.js';

const log = (s: string): void => void process.stderr.write(s + '\n');
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'artifacts');

interface TrainMeta {
  players: number; order: string[]; axis: number[];
  blinds: { sb: number; bb: number }; ante: { scheme: string; amount: number };
  nodeKeys: string[]; nodeActors: string[]; nodeTypes: string[]; classOrder: string[];
  inDim: number; outDim: number; rowStride: number; floatsPerNode: number; rows: number; samples: number;
}

async function main(): Promise<void> {
  const N = Number(process.argv[2] ?? 5);
  const epochs = Number(process.argv[3] ?? 400);
  const hidden = (process.argv[4] ?? '256,256').split(',').map(Number);
  const lr = Number(process.argv[5] ?? 0.01);
  const batch = Number(process.argv[6] ?? 64);
  const weightDecay = Number(process.argv[7] ?? 0);
  const TAG = `nn${N}way`;

  const trainMetaPath = join(OUT_DIR, `${TAG}.train.meta.json`);
  const trainBinPath = join(OUT_DIR, `${TAG}.train.f32.bin`);
  if (!existsSync(trainMetaPath) || !existsSync(trainBinPath)) {
    log(`学習データが無い: ${trainMetaPath}. 先に genNwayTrainData.ts ${N} を実行`);
    process.exit(1);
  }
  const meta = JSON.parse(readFileSync(trainMetaPath, 'utf8')) as TrainMeta;
  const { inDim, outDim, rowStride, rows } = meta;
  const bin = readFileSync(trainBinPath);
  const flat = new Float32Array(bin.buffer, bin.byteOffset, bin.byteLength / 4);
  const gotRows = Math.floor(flat.length / rowStride);
  if (gotRows < rows) log(`  警告: 行数 ${gotRows} < meta.rows ${rows}（未完データ？）＝あるだけ使う`);
  const useRows = Math.min(rows, gotRows);

  // 行 [D 入力][outDim 出力] を X,Y に分離
  const X = new Float32Array(useRows * inDim);
  const Y = new Float32Array(useRows * outDim);
  for (let r = 0; r < useRows; r++) {
    const b = r * rowStride;
    for (let i = 0; i < inDim; i++) X[r * inDim + i] = flat[b + i]!;
    for (let o = 0; o < outDim; o++) Y[r * outDim + o] = flat[b + inDim + o]!;
  }
  log(`# ${N}人 NN 学習: rows=${useRows}, inDim=${inDim}, outDim=${outDim}, hidden=[${hidden}], epochs=${epochs}, lr=${lr}, batch=${batch}, weightDecay=${weightDecay}`);

  const t0 = Date.now();
  const model: MlpModel = trainMlp(X, Y, useRows, inDim, outDim, {
    hidden, epochs, batchSize: batch, lr, weightDecay, seed: 1234, valFraction: 0.1,
    onEpoch: (e, tl, vl) => {
      if (e === 1 || e % 10 === 0 || e === epochs) {
        log(`  epoch ${e}/${epochs}  train=${tl.toExponential(3)}  val=${vl !== undefined ? vl.toExponential(3) : 'n/a'}`);
      }
    },
  });
  const rawMse = evalMse(model, X, Y, useRows, inDim, outDim);
  log(`  学習完了: ${((Date.now() - t0) / 1000 / 60).toFixed(1)}分, 生空間MSE=${rawMse.toExponential(3)}`);

  // --- シリアライズ ---
  // norm セクション（f32）: inputNorm.mean/std, outputNorm.mean/std
  const normFloats = inDim * 2 + outDim * 2;
  const norm = new Float32Array(normFloats);
  let p = 0;
  norm.set(model.inputNorm.mean, p); p += inDim;
  norm.set(model.inputNorm.std, p); p += inDim;
  norm.set(model.outputNorm.mean, p); p += outDim;
  norm.set(model.outputNorm.std, p); p += outDim;

  // weights セクション（f16）: 各層 weight, bias を順に連結
  const layerShapes = model.layers.map((l) => ({ inDim: l.inDim, outDim: l.outDim, activation: l.activation }));
  let wCount = 0;
  for (const l of model.layers) wCount += l.weight.length + l.bias.length;
  const wf32 = new Float32Array(wCount);
  let q = 0;
  for (const l of model.layers) { wf32.set(l.weight, q); q += l.weight.length; wf32.set(l.bias, q); q += l.bias.length; }
  const wf16 = encodeFloat16(wf32); // Uint16Array

  // 単一 bin: [norm f32 (normFloats*4 byte)][weights f16 (wCount*2 byte)]
  const buf = Buffer.alloc(normFloats * 4 + wCount * 2);
  Buffer.from(norm.buffer, 0, normFloats * 4).copy(buf, 0);
  Buffer.from(wf16.buffer, 0, wCount * 2).copy(buf, normFloats * 4);

  const modelMeta = {
    kind: `${TAG}-nnmodel`,
    createdAt: new Date().toISOString(),
    players: N, order: meta.order, axis: meta.axis,
    blinds: meta.blinds, ante: meta.ante,
    nodeKeys: meta.nodeKeys, nodeActors: meta.nodeActors, nodeTypes: meta.nodeTypes, classOrder: meta.classOrder,
    inDim, outDim, floatsPerNode: meta.floatsPerNode,
    layerShapes, normFloats, weightCount: wCount, weightDtype: 'f16',
    trainRows: useRows, trainSamples: meta.samples, rawMse,
    // interpExplBound は validateNwayNN の実測後に手動設定（未設定時 nnTable は既定 0.06）。
  };
  writeFileSync(join(OUT_DIR, `${TAG}.model.meta.json`), JSON.stringify(modelMeta, null, 2));
  writeFileSync(join(OUT_DIR, `${TAG}.model.bin`), buf);
  log(`保存: artifacts/${TAG}.model.bin = ${(buf.byteLength / 1024 / 1024).toFixed(2)}MB + meta.json`);
}
void main();
