import { describe, it, expect } from 'vitest';
import type { BoardState } from '@oshihiki/core';
import { positionsForPlayersLeft } from '@oshihiki/core';
import { encodeFloat16 } from '../src/halfFloat.js';
import { mlpForward, type MlpModel } from '../src/nn/mlp.js';
import { decodeNnModel, buildNnTable, nnInRange, lookupNn, type NnMeta } from '../src/nnTable.js';

/** trainNwayNN と同じ形式で MlpModel を単一 bin へシリアライズする（テスト用ライタ）。 */
function serialize(model: MlpModel, inDim: number, outDim: number): ArrayBuffer {
  const normFloats = inDim * 2 + outDim * 2;
  const norm = new Float32Array(normFloats);
  let p = 0;
  norm.set(model.inputNorm.mean, p); p += inDim;
  norm.set(model.inputNorm.std, p); p += inDim;
  norm.set(model.outputNorm.mean, p); p += outDim;
  norm.set(model.outputNorm.std, p); p += outDim;
  let wCount = 0;
  for (const l of model.layers) wCount += l.weight.length + l.bias.length;
  const wf32 = new Float32Array(wCount);
  let q = 0;
  for (const l of model.layers) { wf32.set(l.weight, q); q += l.weight.length; wf32.set(l.bias, q); q += l.bias.length; }
  const wf16 = encodeFloat16(wf32);
  const buf = new ArrayBuffer(normFloats * 4 + wCount * 2);
  new Uint8Array(buf).set(new Uint8Array(norm.buffer, 0, normFloats * 4), 0);
  new Uint8Array(buf).set(new Uint8Array(wf16.buffer, 0, wCount * 2), normFloats * 4);
  return buf;
}

describe('decodeNnModel', () => {
  it('シリアライズ→復号で前進計算が一致する（f16 許容）', () => {
    const inDim = 3, outDim = 4;
    const ref: MlpModel = {
      layers: [
        { inDim: 3, outDim: 5, weight: Float32Array.from(Array.from({ length: 15 }, (_, i) => (i - 7) * 0.05)), bias: Float32Array.from([0.1, -0.2, 0.3, 0, 0.05]), activation: 'relu' },
        { inDim: 5, outDim: 4, weight: Float32Array.from(Array.from({ length: 20 }, (_, i) => (i % 5 - 2) * 0.1)), bias: Float32Array.from([0.2, -0.1, 0, 0.4]), activation: 'linear' },
      ],
      inputNorm: { mean: Float32Array.from([10, 12, 8]), std: Float32Array.from([4, 4, 4]) },
      outputNorm: { mean: Float32Array.from([0.5, -0.5, 0, 1]), std: Float32Array.from([2, 2, 2, 2]) },
    };
    const layerShapes = ref.layers.map((l) => ({ inDim: l.inDim, outDim: l.outDim, activation: l.activation }));
    const buf = serialize(ref, inDim, outDim);
    const meta = { inDim, outDim, normFloats: inDim * 2 + outDim * 2, weightCount: 15 + 5 + 20 + 4, layerShapes } as unknown as NnMeta;
    const dec = decodeNnModel(meta, buf);

    for (const x of [[9, 13, 7], [15, 15, 15], [2, 25, 10]]) {
      const a = mlpForward(ref, Float32Array.from(x));
      const b = mlpForward(dec, Float32Array.from(x));
      for (let i = 0; i < outDim; i++) expect(b[i]).toBeCloseTo(a[i]!, 2);
    }
  });
});

describe('lookupNn', () => {
  const order = positionsForPlayersLeft(3); // ['BU','SB','BB'] 等
  const classOrder = ['AA', 'KK', 'QQ'];
  const NC = classOrder.length;
  const nNodes = 2;
  const inDim = order.length; // 3
  const outDim = nNodes * NC + order.length; // 2*3+3 = 9

  // 重み 0・バイアスに出力値を直書きした線形1層（前進 = バイアス）。標準化は恒等。
  // 出力並び: [node0 evDiff(3)][node1 evDiff(3)][eqPost(3)]
  const outVals = [1, -1, 1, /*node1*/ -1, 1, -1, /*eqPost*/ 2.0, 3.0, 1.5];
  const model: MlpModel = {
    layers: [{ inDim, outDim, weight: new Float32Array(outDim * inDim), bias: Float32Array.from(outVals), activation: 'linear' }],
    inputNorm: { mean: new Float32Array(inDim), std: Float32Array.from([1, 1, 1]) },
    outputNorm: { mean: new Float32Array(outDim), std: Float32Array.from(outVals.map(() => 1)) },
  };
  const meta: NnMeta = {
    kind: 'nn3way-nnmodel', players: 3, order, axis: [2, 25],
    blinds: { sb: 0.5, bb: 1 }, ante: { scheme: 'all', amount: 0.25 },
    nodeKeys: ['k0', 'k1'], nodeActors: [order[0]!, order[1]!], nodeTypes: ['PU', 'PU'],
    classOrder, inDim, outDim, floatsPerNode: NC,
    layerShapes: [{ inDim, outDim, activation: 'linear' }],
    normFloats: inDim * 2 + outDim * 2, weightCount: outDim * inDim + outDim, weightDtype: 'f16',
    interpExplBound: 0.05,
  };
  const buf = serialize(model, inDim, outDim);
  const table = buildNnTable(meta, buf);

  const stateOf = (totals: number[]): BoardState => ({
    street: 'preflop', blinds: { sb: 0.5, bb: 1 }, ante: { scheme: 'all', amount: 0.25 },
    heroHand: 'KQo', playersLeft: 3, heroPos: order[0]!,
    seats: order.map((pos, i) => {
      const bet = pos === 'SB' ? 0.5 : pos === 'BB' ? 1 : 0;
      return { pos, stack: totals[i]! - bet - 0.25, state: 'live' as const, bet };
    }),
    pot: 0,
  } as BoardState);

  it('nnInRange が人数・条件・レンジで判定する', () => {
    expect(nnInRange(table, stateOf([15, 12, 10]))).toBe(true);
    // 上限超え
    expect(nnInRange(table, stateOf([30, 12, 10]))).toBe(false);
    // 人数不一致
    const s4 = { ...stateOf([15, 12, 10]), playersLeft: 4 } as BoardState;
    expect(nnInRange(table, s4)).toBe(false);
  });

  it('ゼロ交差で純戦略レンジ化し eqPost を order にマップする', () => {
    const res = lookupNn(table, stateOf([15, 12, 10]));
    expect(res.nodes).toHaveLength(2);
    // node0 evDiff=[+,-,+] → AA,QQ をプッシュ
    expect(new Set(res.nodes[0]!.hands)).toEqual(new Set(['AA', 'QQ']));
    expect(res.nodes[0]!.freq['AA']).toBe(1);
    expect(res.nodes[0]!.freq['KK']).toBe(0);
    // node1 evDiff=[-,+,-] → KK のみ
    expect(res.nodes[1]!.hands).toEqual(['KK']);
    // eqPost が order 順にマップされる
    expect(res.equity[order[0]!]!.post).toBeCloseTo(2.0, 2);
    expect(res.equity[order[1]!]!.post).toBeCloseTo(3.0, 2);
    expect(res.equity[order[2]!]!.post).toBeCloseTo(1.5, 2);
    // eqPre はスタックから再計算されている（有限）
    expect(Number.isFinite(res.equity[order[0]!]!.pre)).toBe(true);
    expect(res.exploitabilityPt).toBeCloseTo(0.05, 6);
  });

  it('範囲外スタックは学習レンジにクランプして解く（例外を投げない）', () => {
    const res = lookupNn(table, stateOf([50, 1, 10])); // 50>25, 1<2
    expect(res.nodes).toHaveLength(2);
  });
});
