import { describe, it, expect } from 'vitest';
import type { BoardState } from '@oshihiki/core';
import type { SolveNodeDto, SolveResultDto } from '../solverProtocol';
import {
  aggregate,
  buildRecord,
  evLossOf,
  finishRecord,
  headlineNode,
  isUnopened,
  startRecord,
  verdictOf,
  type SpotRecord,
} from './model';

function node(over: Partial<SolveNodeDto>): SolveNodeDto {
  return {
    key: 'root',
    actor: 'BTN',
    actionType: 'PU',
    pct: 20,
    range: '',
    hands: [],
    heroFreq: 0,
    heroEv: 0,
    ...over,
  };
}

function result(over: Partial<SolveResultDto>): SolveResultDto {
  return {
    playersLeft: 3,
    heroPos: 'BTN',
    heroHand: 'A5s',
    iterations: 500,
    exploitabilityPt: 0.001,
    converged: true,
    equity: {},
    nodes: [],
    ...over,
  };
}

const state = { heroPos: 'BTN' } as unknown as BoardState;

describe('isUnopened', () => {
  it('未開の先手プッシュ（上流に P/C なし）を真とする', () => {
    expect(isUnopened(node({ actionType: 'PU', key: 'root' }))).toBe(true);
  });
  it('上流にプッシュ/コールがある枝は偽', () => {
    expect(isUnopened(node({ actionType: 'PU', key: 'root:P' }))).toBe(false);
    expect(isUnopened(node({ actionType: 'OC', key: 'root:C' }))).toBe(false);
  });
});

describe('headlineNode', () => {
  it('hero の未開プッシュノードを優先して選ぶ', () => {
    const r = result({
      nodes: [
        node({ actor: 'SB', actionType: 'PU', key: 'root' }),
        node({ actor: 'BTN', actionType: 'CA', key: 'root:P' }),
        node({ actor: 'BTN', actionType: 'PU', key: 'root', heroEv: 1.2 }),
      ],
    });
    expect(headlineNode(r)?.heroEv).toBe(1.2);
  });
  it('hero の決定ノードが無ければ null（BB ウォーク等）', () => {
    expect(headlineNode(result({ nodes: [node({ actor: 'SB' })] }))).toBeNull();
  });
});

describe('verdictOf', () => {
  it('頻度 ≥ 0.5 で PUSH、未満で FOLD', () => {
    expect(verdictOf(node({ heroFreq: 0.5 }))).toBe('PUSH');
    expect(verdictOf(node({ heroFreq: 0.49 }))).toBe('FOLD');
  });
});

describe('evLossOf', () => {
  it('PUSH: heroEv<0 なら |heroEv| を損、≥0 なら 0', () => {
    expect(evLossOf(-0.3, 'PUSH')).toBeCloseTo(0.3);
    expect(evLossOf(0.4, 'PUSH')).toBe(0);
  });
  it('FOLD: heroEv>0 なら heroEv を損、≤0 なら 0', () => {
    expect(evLossOf(0.25, 'FOLD')).toBeCloseTo(0.25);
    expect(evLossOf(-0.1, 'FOLD')).toBe(0);
  });
  it('最適な選択なら損は 0（PUSH推奨をPUSH / FOLD推奨をFOLD）', () => {
    expect(evLossOf(0.5, 'PUSH')).toBe(0);
    expect(evLossOf(-0.5, 'FOLD')).toBe(0);
  });
});

describe('buildRecord', () => {
  const r = result({
    heroHand: 'KQo',
    heroPos: 'BTN',
    playersLeft: 4,
    nodes: [node({ actor: 'BTN', actionType: 'PU', key: 'root', heroFreq: 0.8, heroEv: 0.6 })],
  });

  it('推奨=PUSH の局面で FOLD したら EV loss=|heroEv| を記録', () => {
    const rec = buildRecord({ state, result: r, ms: 1200, heroAction: 'FOLD', id: 'x', createdAt: 100 });
    expect(rec).toMatchObject({
      id: 'x',
      createdAt: 100,
      heroHand: 'KQo',
      heroPos: 'BTN',
      playersLeft: 4,
      verdict: 'PUSH',
      heroAction: 'FOLD',
      ms: 1200,
    });
    expect(rec.evLoss).toBeCloseTo(0.6);
    expect(rec.state).toBe(state);
    expect(rec.result).toBe(r);
  });

  it('推奨どおり PUSH したら EV loss=0', () => {
    const rec = buildRecord({ state, result: r, ms: 1, heroAction: 'PUSH', id: 'y', createdAt: 1 });
    expect(rec.evLoss).toBe(0);
  });

  it('published は既定 false、指定時はその値（M4 公開フラグ）', () => {
    expect(buildRecord({ state, result: r, ms: 0, heroAction: 'PUSH', createdAt: 1 }).published).toBe(false);
    expect(buildRecord({ state, result: r, ms: 0, heroAction: 'PUSH', published: true, createdAt: 1 }).published).toBe(true);
  });

  it('id 省略時は自動採番（createdAt を含む一意 id）', () => {
    const a = buildRecord({ state, result: r, ms: 0, heroAction: 'PUSH', createdAt: 42 });
    const b = buildRecord({ state, result: r, ms: 0, heroAction: 'PUSH', createdAt: 42 });
    expect(a.id).toContain('42');
    expect(a.id).not.toBe(b.id);
  });

  it('hero 決定ノードが無くても壊れない（evLoss=0, verdict=FOLD）', () => {
    const rec = buildRecord({
      state,
      result: result({ nodes: [node({ actor: 'SB' })] }),
      ms: 0,
      heroAction: 'FOLD',
      id: 'z',
      createdAt: 0,
    });
    expect(rec.evLoss).toBe(0);
    expect(rec.verdict).toBe('FOLD');
    expect(rec.heroEv).toBe(0);
  });
});

describe('startRecord', () => {
  it('計算中レコードを構築する（result=null, heroAction=null, status=solving）', () => {
    const rec = startRecord({
      clientId: 'c1',
      state,
      heroHand: 'AKs',
      heroPos: 'BTN',
      playersLeft: 5,
      id: 'r1',
      createdAt: 10,
    });
    expect(rec).toMatchObject({
      id: 'r1',
      createdAt: 10,
      status: 'solving',
      heroHand: 'AKs',
      heroPos: 'BTN',
      playersLeft: 5,
      heroAction: null,
      evLoss: null,
      result: null,
      published: false,
      clientId: 'c1',
      pendingSync: false,
    });
  });
  it('imageId/ocrReadId を渡せば保持する（省略時は undefined）', () => {
    const withRefs = startRecord({
      clientId: 'c2',
      state,
      heroHand: 'AKs',
      heroPos: 'BTN',
      playersLeft: 5,
      imageId: 'img-1',
      ocrReadId: 'ocr-1',
    });
    expect(withRefs.imageId).toBe('img-1');
    expect(withRefs.ocrReadId).toBe('ocr-1');
    const withoutRefs = startRecord({ clientId: 'c3', state, heroHand: 'AKs', heroPos: 'BTN', playersLeft: 5 });
    expect(withoutRefs.imageId).toBeUndefined();
    expect(withoutRefs.ocrReadId).toBeUndefined();
  });
});

describe('finishRecord', () => {
  const solving = startRecord({
    clientId: 'c1',
    state,
    heroHand: 'KQo',
    heroPos: 'BTN',
    playersLeft: 4,
    id: 'r1',
    createdAt: 10,
  });
  const r = result({
    heroHand: 'KQo',
    heroPos: 'BTN',
    playersLeft: 4,
    nodes: [node({ actor: 'BTN', actionType: 'PU', key: 'root', heroFreq: 0.8, heroEv: 0.6 })],
  });

  it('求解結果を確定させる（status=done, verdict/heroEv を反映）', () => {
    const done = finishRecord(solving, { result: r, ms: 900 });
    expect(done.status).toBe('done');
    expect(done.result).toBe(r);
    expect(done.ms).toBe(900);
    expect(done.verdict).toBe('PUSH');
    expect(done.heroEv).toBeCloseTo(0.6);
  });

  it('heroAction/published/id 等の既存フィールドは変えない', () => {
    const done = finishRecord(solving, { result: r, ms: 0 });
    expect(done.id).toBe(solving.id);
    expect(done.clientId).toBe(solving.clientId);
    expect(done.heroAction).toBeNull();
    expect(done.evLoss).toBeNull();
    expect(done.published).toBe(false);
  });

  it('hero 決定ノードが無くても壊れない（verdict=FOLD, heroEv=0）', () => {
    const done = finishRecord(solving, { result: result({ nodes: [node({ actor: 'SB' })] }), ms: 0 });
    expect(done.verdict).toBe('FOLD');
    expect(done.heroEv).toBe(0);
  });
});

describe('aggregate', () => {
  function rec(over: Partial<SpotRecord>): SpotRecord {
    return {
      id: 'x',
      createdAt: 0,
      status: 'done',
      heroHand: 'AA',
      heroPos: 'BTN',
      playersLeft: 4,
      verdict: 'PUSH',
      heroAction: 'PUSH',
      heroEv: 0,
      evLoss: 0,
      published: false,
      state,
      result: null,
      ms: 0,
      clientId: 'x',
      ...over,
    };
  }

  it('done かつ自分の選択がある記録だけ EV loss 累計に入れる', () => {
    const recs = [
      rec({ evLoss: 0.6, heroAction: 'FOLD' }),
      rec({ evLoss: 0, heroAction: 'PUSH' }),
      rec({ evLoss: 0.15, heroAction: 'FOLD' }),
      // 未選択（heroAction=null）は件数に入るが EV loss には入らない。
      rec({ evLoss: null, heroAction: null }),
    ];
    const s = aggregate(recs);
    expect(s.count).toBe(4);
    expect(s.totalEvLoss).toBeCloseTo(0.75);
  });

  it('計算中/失敗/中断の記録は件数にも EV loss にも入れない', () => {
    const recs = [
      rec({ status: 'solving', evLoss: null, heroAction: null }),
      rec({ status: 'failed', evLoss: null, heroAction: null }),
      rec({ status: 'aborted', evLoss: null, heroAction: null }),
      rec({ status: 'done', evLoss: 0.3, heroAction: 'FOLD' }),
    ];
    const s = aggregate(recs);
    expect(s.count).toBe(1);
    expect(s.totalEvLoss).toBeCloseTo(0.3);
  });

  it('空配列で count=0 / totalEvLoss=0', () => {
    expect(aggregate([])).toEqual({ count: 0, totalEvLoss: 0 });
  });
});
