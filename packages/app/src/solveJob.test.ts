import { describe, it, expect } from 'vitest';
import {
  IDLE_JOB,
  abortJob,
  canStartSolve,
  completeJob,
  createStartLatch,
  failJob,
  resetJob,
  startJob,
  type SolveJob,
} from './solveJob';

describe('IDLE_JOB', () => {
  it('初期状態は idle・recordId なし', () => {
    expect(IDLE_JOB).toEqual({ status: 'idle', recordId: null });
  });
});

describe('startJob', () => {
  it('running に遷移し recordId を持つ', () => {
    expect(startJob('rec-1')).toEqual({ status: 'running', recordId: 'rec-1' });
  });
});

describe('completeJob / failJob / abortJob', () => {
  const running: SolveJob = { status: 'running', recordId: 'rec-1' };

  it('completeJob: running → done、recordId を引き継ぐ', () => {
    expect(completeJob(running)).toEqual({ status: 'done', recordId: 'rec-1' });
  });

  it('failJob: running → failed、recordId を引き継ぐ', () => {
    expect(failJob(running)).toEqual({ status: 'failed', recordId: 'rec-1' });
  });

  it('abortJob: running → aborted、recordId を引き継ぐ', () => {
    expect(abortJob(running)).toEqual({ status: 'aborted', recordId: 'rec-1' });
  });
});

describe('resetJob', () => {
  it('IDLE_JOB を返す', () => {
    expect(resetJob()).toEqual(IDLE_JOB);
  });
});

describe('canStartSolve（SPEC §5.7 の3: 同時1件の制約）', () => {
  it('running のときだけ新規計算を拒否する', () => {
    expect(canStartSolve({ status: 'idle', recordId: null })).toBe(true);
    expect(canStartSolve({ status: 'running', recordId: 'r' })).toBe(false);
    expect(canStartSolve({ status: 'done', recordId: 'r' })).toBe(true);
    expect(canStartSolve({ status: 'failed', recordId: 'r' })).toBe(true);
    expect(canStartSolve({ status: 'aborted', recordId: 'r' })).toBe(true);
  });

  it('idle → running → done のライフサイクルを通じて一貫する', () => {
    let job = IDLE_JOB;
    expect(canStartSolve(job)).toBe(true);
    job = startJob('rec-9');
    expect(canStartSolve(job)).toBe(false);
    job = completeJob(job);
    expect(canStartSolve(job)).toBe(true);
    expect(job.recordId).toBe('rec-9');
  });
});

describe('createStartLatch（Task2: 二重起動防止の同期ラッチ）', () => {
  it('1回目の acquire は true、未解放のまま連続で呼ぶと2回目以降は false', () => {
    const latch = createStartLatch();
    expect(latch.acquire()).toBe(true);
    expect(latch.acquire()).toBe(false);
    expect(latch.acquire()).toBe(false);
  });

  it('連打を模した3連続 acquire は最初の1回だけ通る', () => {
    const latch = createStartLatch();
    expect([latch.acquire(), latch.acquire(), latch.acquire()]).toEqual([true, false, false]);
  });

  it('release 後は再び acquire できる（計算が終われば次の計算を受け付ける）', () => {
    const latch = createStartLatch();
    expect(latch.acquire()).toBe(true);
    latch.release();
    expect(latch.acquire()).toBe(true);
  });

  it('release を余分に呼んでも安全（多重解放で状態が壊れない）', () => {
    const latch = createStartLatch();
    latch.release();
    latch.release();
    expect(latch.acquire()).toBe(true);
  });

  it('例外が起きても try/finally で release されていれば再取得できる（呼び出し側の使い方を模擬）', () => {
    const latch = createStartLatch();
    expect(latch.acquire()).toBe(true);
    expect(() => {
      try {
        throw new Error('boom');
      } finally {
        latch.release();
      }
    }).toThrow('boom');
    // 解除漏れがあればここで再取得できず false になる＝永久ロックのバグを検出する。
    expect(latch.acquire()).toBe(true);
  });
});
