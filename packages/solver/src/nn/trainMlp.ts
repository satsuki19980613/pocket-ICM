/**
 * MLP 学習（backprop + Adam, dev/オフライン専用・依存ゼロ）。
 *
 * push/fold NN 蒸留の student を、教師（solveMultiway）が生成した (スタック → EV差+eqPost) の
 * データから回帰学習する。推論コアは mlp.ts（出荷対象）。本モジュールは学習のみで、
 * ブラウザバンドルには含めない（scripts/ とテストからのみ import）。
 *
 * - 標準化空間で学習する: X,Y を各次元の平均/標準偏差で標準化し、MSE を最小化。
 *   標準化パラメータは MlpModel に格納され、mlpForward が入力標準化・出力逆標準化する。
 * - 隠れ層 ReLU（He 初期化）、出力層 線形。ミニバッチ Adam。決定的（seed 指定）。
 */
import type { Activation, DenseLayer, MlpModel, Standardizer } from './mlp.js';
import { mlpForward } from './mlp.js';

/** 決定的 RNG（mulberry32）。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 標準正規乱数（Box–Muller）。 */
function gaussian(rng: () => number): number {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** 列ごとの平均・標準偏差を求める（flat row-major, rows×cols）。 */
function standardizerOf(flat: Float32Array | Float64Array, rows: number, cols: number): Standardizer {
  const mean = new Float32Array(cols);
  const std = new Float32Array(cols);
  for (let r = 0; r < rows; r++) {
    const base = r * cols;
    for (let c = 0; c < cols; c++) mean[c]! += flat[base + c]!;
  }
  for (let c = 0; c < cols; c++) mean[c]! /= rows;
  for (let r = 0; r < rows; r++) {
    const base = r * cols;
    for (let c = 0; c < cols; c++) {
      const d = flat[base + c]! - mean[c]!;
      std[c]! += d * d;
    }
  }
  for (let c = 0; c < cols; c++) {
    const s = Math.sqrt(std[c]! / Math.max(1, rows));
    std[c] = s > 1e-8 ? s : 1; // 定数列は 1 で割る（標準化後 0）
  }
  return { mean, std };
}

function standardize(flat: Float32Array | Float64Array, rows: number, cols: number, s: Standardizer): Float32Array {
  const out = new Float32Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    const base = r * cols;
    for (let c = 0; c < cols; c++) out[base + c] = (flat[base + c]! - s.mean[c]!) / s.std[c]!;
  }
  return out;
}

export interface TrainConfig {
  /** 隠れ層の幅（例 [256, 256]）。出力層は自動で outDim・線形。 */
  hidden: number[];
  epochs: number;
  batchSize: number;
  /** Adam 学習率。 */
  lr: number;
  seed?: number;
  /** L2 正則化係数（weight decay, 既定 0）。 */
  weightDecay?: number;
  /** エポックごとに (epoch, trainLoss, valLoss?) を受け取るコールバック。 */
  onEpoch?: (epoch: number, trainLoss: number, valLoss: number | undefined) => void;
  /** 検証分割（0..1, 末尾をホールドアウト）。0 なら分割しない。 */
  valFraction?: number;
}

/** Adam の状態を持つ学習用の層。 */
interface TrainLayer extends DenseLayer {
  mW: Float64Array; vW: Float64Array;
  mB: Float64Array; vB: Float64Array;
}

function initLayer(inDim: number, outDim: number, activation: Activation, rng: () => number): TrainLayer {
  const weight = new Float32Array(outDim * inDim);
  // He 初期化（ReLU）/ 線形層は 1/inDim スケール。
  const scale = Math.sqrt((activation === 'relu' ? 2 : 1) / inDim);
  for (let i = 0; i < weight.length; i++) weight[i] = gaussian(rng) * scale;
  return {
    inDim, outDim, weight, bias: new Float32Array(outDim), activation,
    mW: new Float64Array(outDim * inDim), vW: new Float64Array(outDim * inDim),
    mB: new Float64Array(outDim), vB: new Float64Array(outDim),
  };
}

/**
 * MLP を学習して MlpModel を返す。X: rows×inDim, Y: rows×outDim（いずれも生値, row-major）。
 */
export function trainMlp(
  X: Float32Array | Float64Array, Y: Float32Array | Float64Array,
  rows: number, inDim: number, outDim: number,
  cfg: TrainConfig,
): MlpModel {
  const rng = mulberry32(cfg.seed ?? 12345);
  const wd = cfg.weightDecay ?? 0;
  const beta1 = 0.9, beta2 = 0.999, eps = 1e-8;

  const inputNorm = standardizerOf(X, rows, inDim);
  const outputNorm = standardizerOf(Y, rows, outDim);
  const Xs = standardize(X, rows, inDim, inputNorm);
  const Ys = standardize(Y, rows, outDim, outputNorm);

  // 検証分割（末尾）
  const valFrac = cfg.valFraction ?? 0;
  const nVal = Math.floor(rows * valFrac);
  const nTrain = rows - nVal;

  // 層構築
  const dims = [inDim, ...cfg.hidden, outDim];
  const layers: TrainLayer[] = [];
  for (let l = 0; l < dims.length - 1; l++) {
    const act: Activation = l < dims.length - 2 ? 'relu' : 'linear';
    layers.push(initLayer(dims[l]!, dims[l + 1]!, act, rng));
  }

  // 前進で各層の出力（活性後）を保持するスクラッチ
  const acts: Float32Array[] = layers.map((l) => new Float32Array(l.outDim));
  const gradOut: Float32Array[] = layers.map((l) => new Float32Array(l.outDim)); // 各層出力に対する勾配

  // 勾配バッファ（バッチ集約）
  const gW = layers.map((l) => new Float64Array(l.weight.length));
  const gB = layers.map((l) => new Float64Array(l.bias.length));

  const forwardTrain = (x: Float32Array): Float32Array => {
    let cur = x;
    for (let l = 0; l < layers.length; l++) {
      const layer = layers[l]!;
      const out = acts[l]!;
      for (let o = 0; o < layer.outDim; o++) {
        let acc = layer.bias[o]!;
        const base = o * layer.inDim;
        for (let i = 0; i < layer.inDim; i++) acc += layer.weight[base + i]! * cur[i]!;
        out[o] = layer.activation === 'relu' && acc < 0 ? 0 : acc;
      }
      cur = out;
    }
    return cur;
  };

  const idxOrder = new Int32Array(nTrain);
  for (let i = 0; i < nTrain; i++) idxOrder[i] = i;

  let adamT = 0;
  const rowLoss = (pred: Float32Array, base: number): number => {
    let s = 0;
    for (let c = 0; c < outDim; c++) { const d = pred[c]! - Ys[base + c]!; s += d * d; }
    return s / outDim;
  };

  for (let epoch = 1; epoch <= cfg.epochs; epoch++) {
    // シャッフル（Fisher–Yates）
    for (let i = nTrain - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = idxOrder[i]!; idxOrder[i] = idxOrder[j]!; idxOrder[j] = t;
    }
    let trainLoss = 0;
    for (let start = 0; start < nTrain; start += cfg.batchSize) {
      const end = Math.min(start + cfg.batchSize, nTrain);
      const bs = end - start;
      for (let l = 0; l < layers.length; l++) { gW[l]!.fill(0); gB[l]!.fill(0); }

      for (let bi = start; bi < end; bi++) {
        const r = idxOrder[bi]!;
        const xBase = r * inDim, yBase = r * outDim;
        const x = Xs.subarray(xBase, xBase + inDim);
        const pred = forwardTrain(x);
        trainLoss += rowLoss(pred, yBase);

        // 出力層勾配 dL/dout = 2/outDim * (pred - y)（活性は線形）
        const gLast = gradOut[layers.length - 1]!;
        for (let c = 0; c < outDim; c++) gLast[c] = (2 / outDim) * (pred[c]! - Ys[yBase + c]!);

        // 逆伝播
        for (let l = layers.length - 1; l >= 0; l--) {
          const layer = layers[l]!;
          const g = gradOut[l]!;
          // ReLU の勾配ゲート（出力が 0 の位置は勾配 0）
          if (layer.activation === 'relu') {
            const out = acts[l]!;
            for (let o = 0; o < layer.outDim; o++) if (out[o]! <= 0) g[o] = 0;
          }
          const prev = l === 0 ? x : acts[l - 1]!;
          const gwL = gW[l]!, gbL = gB[l]!;
          for (let o = 0; o < layer.outDim; o++) {
            const go = g[o]!;
            if (go !== 0) {
              const base = o * layer.inDim;
              for (let i = 0; i < layer.inDim; i++) gwL[base + i]! += go * prev[i]!;
            }
            gbL[o]! += go;
          }
          // 前層への勾配
          if (l > 0) {
            const gPrev = gradOut[l - 1]!;
            gPrev.fill(0);
            for (let o = 0; o < layer.outDim; o++) {
              const go = g[o]!;
              if (go === 0) continue;
              const base = o * layer.inDim;
              for (let i = 0; i < layer.inDim; i++) gPrev[i]! += go * layer.weight[base + i]!;
            }
          }
        }
      }

      // Adam 更新（バッチ平均勾配）
      adamT++;
      const bc1 = 1 - Math.pow(beta1, adamT);
      const bc2 = 1 - Math.pow(beta2, adamT);
      for (let l = 0; l < layers.length; l++) {
        const layer = layers[l]!;
        const gwL = gW[l]!, gbL = gB[l]!;
        const { mW, vW, mB, vB, weight, bias } = layer;
        for (let k = 0; k < weight.length; k++) {
          let g = gwL[k]! / bs + wd * weight[k]!;
          mW[k] = beta1 * mW[k]! + (1 - beta1) * g;
          vW[k] = beta2 * vW[k]! + (1 - beta2) * g * g;
          weight[k] = weight[k]! - cfg.lr * (mW[k]! / bc1) / (Math.sqrt(vW[k]! / bc2) + eps);
        }
        for (let k = 0; k < bias.length; k++) {
          const g = gbL[k]! / bs;
          mB[k] = beta1 * mB[k]! + (1 - beta1) * g;
          vB[k] = beta2 * vB[k]! + (1 - beta2) * g * g;
          bias[k] = bias[k]! - cfg.lr * (mB[k]! / bc1) / (Math.sqrt(vB[k]! / bc2) + eps);
        }
      }
    }
    trainLoss /= nTrain;

    let valLoss: number | undefined;
    if (nVal > 0) {
      let s = 0;
      for (let r = nTrain; r < rows; r++) {
        const pred = forwardTrain(Xs.subarray(r * inDim, r * inDim + inDim));
        s += rowLoss(pred, r * outDim);
      }
      valLoss = s / nVal;
    }
    cfg.onEpoch?.(epoch, trainLoss, valLoss);
  }

  const model: MlpModel = {
    layers: layers.map((l) => ({
      inDim: l.inDim, outDim: l.outDim, weight: l.weight, bias: l.bias, activation: l.activation,
    })),
    inputNorm, outputNorm,
  };
  return model;
}

/** 生値空間の MSE（検証用, mlpForward を通して評価）。 */
export function evalMse(
  model: MlpModel, X: Float32Array | Float64Array, Y: Float32Array | Float64Array,
  rows: number, inDim: number, outDim: number,
): number {
  let s = 0;
  const xin = new Float32Array(inDim);
  for (let r = 0; r < rows; r++) {
    for (let i = 0; i < inDim; i++) xin[i] = X[r * inDim + i]!;
    const pred = mlpForward(model, xin);
    for (let c = 0; c < outDim; c++) { const d = pred[c]! - Y[r * outDim + c]!; s += d * d; }
  }
  return s / (rows * outDim);
}
