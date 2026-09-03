import { describe, it, expect } from 'vitest';
import { mlpForward, mlpParamCount, type MlpModel } from '../src/nn/mlp.js';
import { trainMlp, evalMse } from '../src/nn/trainMlp.js';

describe('mlpForward', () => {
  it('恒等標準化の単層線形で W·x+b を計算する', () => {
    const model: MlpModel = {
      layers: [{
        inDim: 2, outDim: 1,
        weight: Float32Array.from([1, 2]), bias: Float32Array.from([0.5]),
        activation: 'linear',
      }],
      inputNorm: { mean: Float32Array.from([0, 0]), std: Float32Array.from([1, 1]) },
      outputNorm: { mean: Float32Array.from([0]), std: Float32Array.from([1]) },
    };
    const out = mlpForward(model, Float32Array.from([1, 1]));
    expect(out[0]).toBeCloseTo(3.5, 6);
  });

  it('入力標準化・出力逆標準化を往復適用する', () => {
    // 標準化空間で out = x（恒等）。生空間では out = ((x-mean)/std)*ostd + omean。
    const model: MlpModel = {
      layers: [{
        inDim: 1, outDim: 1,
        weight: Float32Array.from([1]), bias: Float32Array.from([0]),
        activation: 'linear',
      }],
      inputNorm: { mean: Float32Array.from([10]), std: Float32Array.from([2]) },
      outputNorm: { mean: Float32Array.from([5]), std: Float32Array.from([3]) },
    };
    // x=14 → (14-10)/2=2 → *3+5 = 11
    expect(mlpForward(model, Float32Array.from([14]))[0]).toBeCloseTo(11, 6);
  });

  it('ReLU が負をゼロに切る', () => {
    const model: MlpModel = {
      layers: [
        { inDim: 1, outDim: 2, weight: Float32Array.from([1, -1]), bias: Float32Array.from([0, 0]), activation: 'relu' },
        { inDim: 2, outDim: 1, weight: Float32Array.from([1, 1]), bias: Float32Array.from([0]), activation: 'linear' },
      ],
      inputNorm: { mean: Float32Array.from([0]), std: Float32Array.from([1]) },
      outputNorm: { mean: Float32Array.from([0]), std: Float32Array.from([1]) },
    };
    // x=3: 層1=[3, relu(-3)=0] → 層2 = 3
    expect(mlpForward(model, Float32Array.from([3]))[0]).toBeCloseTo(3, 6);
    // x=-3: 層1=[relu(-3)=0, relu(3)=3] → 3
    expect(mlpForward(model, Float32Array.from([-3]))[0]).toBeCloseTo(3, 6);
  });
});

describe('trainMlp', () => {
  // 合成の非線形関数を学習できることを確認（蒸留の基本能力）。
  const inDim = 3, outDim = 2, rows = 1000;
  const f = (x0: number, x1: number, x2: number): [number, number] => [
    x0 * x0 - x1,          // 非線形
    x0 * x2 + 0.5 * x1,    // 双線形
  ];
  function makeData(seed: number, n: number): { X: Float64Array; Y: Float64Array } {
    let a = seed >>> 0;
    const rng = (): number => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const X = new Float64Array(n * inDim), Y = new Float64Array(n * outDim);
    for (let r = 0; r < n; r++) {
      const x0 = rng() * 2 - 1, x1 = rng() * 2 - 1, x2 = rng() * 2 - 1;
      X[r * inDim] = x0; X[r * inDim + 1] = x1; X[r * inDim + 2] = x2;
      const [y0, y1] = f(x0, x1, x2);
      Y[r * outDim] = y0; Y[r * outDim + 1] = y1;
    }
    return { X, Y };
  }

  it('非線形関数を低 MSE で回帰する（ホールドアウトで汎化）', () => {
    const { X, Y } = makeData(1, rows);
    const model = trainMlp(X, Y, rows, inDim, outDim, {
      hidden: [48, 48], epochs: 250, batchSize: 32, lr: 0.01, seed: 7,
    });
    const train = evalMse(model, X, Y, rows, inDim, outDim);
    // ベースライン（平均予測）の MSE = 出力の分散平均。それより大幅に良いこと。
    expect(train).toBeLessThan(0.01);

    // 独立生成のホールドアウト
    const ho = makeData(999, 300);
    const val = evalMse(model, ho.X, ho.Y, 300, inDim, outDim);
    expect(val).toBeLessThan(0.02);

    // 具体点の予測が真値に近い
    const pred = mlpForward(model, Float32Array.from([0.5, -0.3, 0.8]));
    const [t0, t1] = f(0.5, -0.3, 0.8);
    expect(pred[0]).toBeCloseTo(t0, 1);
    expect(pred[1]).toBeCloseTo(t1, 1);
    expect(mlpParamCount(model)).toBeGreaterThan(0);
  });

  it('同一 seed で決定的（重み一致）', () => {
    const { X, Y } = makeData(2, 400);
    const cfg = { hidden: [16], epochs: 30, batchSize: 32, lr: 0.01, seed: 42 } as const;
    const m1 = trainMlp(X, Y, 400, inDim, outDim, { ...cfg });
    const m2 = trainMlp(X, Y, 400, inDim, outDim, { ...cfg });
    expect(Array.from(m1.layers[0]!.weight)).toEqual(Array.from(m2.layers[0]!.weight));
    expect(Array.from(m1.layers[1]!.weight)).toEqual(Array.from(m2.layers[1]!.weight));
  });
});
