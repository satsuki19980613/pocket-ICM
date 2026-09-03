/**
 * 手書き多層パーセプトロン（MLP）の推論コア（env 非依存・依存ゼロ・出荷対象）。
 *
 * push/fold NN 蒸留の student。入力＝正規化スタック(bb) D 個、出力＝各決定ノードのクラス別
 * EV差(169) を平坦化したもの ＋ 席ごとの eqPost（＝pfTable と同じ並び）。隠れ層は ReLU、
 * 出力層は線形。前進計算は行列×ベクトルの積和のみで、クライアント CPU は数百 µs〜数 ms。
 *
 * 学習（backprop/Adam）は dev 専用の trainMlp.ts に分離し、ここには載せない
 * （ブラウザバンドルは推論のみ＝ツリーシェイクで学習コードが混入しない）。
 * 重みは halfFloat で f16 量子化して配信し、読込時に一度だけ f32 展開する（テーブルと同様）。
 */

export type Activation = 'relu' | 'linear';

/** 1 全結合層（row-major: weight[o*inDim + i]）。 */
export interface DenseLayer {
  inDim: number;
  outDim: number;
  /** 長さ outDim*inDim（row-major）。 */
  weight: Float32Array;
  /** 長さ outDim。 */
  bias: Float32Array;
  activation: Activation;
}

/** 入力の標準化パラメータ（学習データの平均・標準偏差）。 */
export interface Standardizer {
  /** 長さ = 入力次元。 */
  mean: Float32Array;
  /** 長さ = 入力次元（0 は 1 に丸めて割る）。 */
  std: Float32Array;
}

/** MLP モデル（推論用）。層 + 入出力の標準化。 */
export interface MlpModel {
  layers: DenseLayer[];
  /** 入力の標準化（(x-mean)/std）。 */
  inputNorm: Standardizer;
  /** 出力の逆標準化（out*std+mean）。学習を標準化空間で行うため。 */
  outputNorm: Standardizer;
}

/** ReLU を配列にインプレース適用。 */
function reluInPlace(v: Float32Array): void {
  for (let i = 0; i < v.length; i++) if (v[i]! < 0) v[i] = 0;
}

/**
 * 1 層の前進計算 out = act(W·x + b)。out は呼び出し側が確保（長さ outDim）。
 * row-major の weight を outDim×inDim として積和する。
 */
export function forwardLayer(layer: DenseLayer, x: Float32Array, out: Float32Array): void {
  const { inDim, outDim, weight, bias } = layer;
  for (let o = 0; o < outDim; o++) {
    let acc = bias[o]!;
    const base = o * inDim;
    for (let i = 0; i < inDim; i++) acc += weight[base + i]! * x[i]!;
    out[o] = acc;
  }
  if (layer.activation === 'relu') reluInPlace(out);
}

/**
 * MLP の前進計算（標準化つき）。生スタック(bb) → 生の出力（EV差＋eqPost）。
 * 入力を inputNorm で標準化 → 各層 → 出力を outputNorm で逆標準化して返す。
 */
export function mlpForward(model: MlpModel, input: Float32Array): Float32Array {
  const { layers, inputNorm, outputNorm } = model;
  const inDim = layers[0]!.inDim;
  // 入力標準化
  let cur = new Float32Array(inDim);
  for (let i = 0; i < inDim; i++) cur[i] = (input[i]! - inputNorm.mean[i]!) / inputNorm.std[i]!;
  // 各層
  for (const layer of layers) {
    const next = new Float32Array(layer.outDim);
    forwardLayer(layer, cur, next);
    cur = next;
  }
  // 出力逆標準化
  for (let o = 0; o < cur.length; o++) cur[o] = cur[o]! * outputNorm.std[o]! + outputNorm.mean[o]!;
  return cur;
}

/** モデルの総パラメータ数（重み＋バイアス）。 */
export function mlpParamCount(model: MlpModel): number {
  let n = 0;
  for (const l of model.layers) n += l.weight.length + l.bias.length;
  return n;
}
