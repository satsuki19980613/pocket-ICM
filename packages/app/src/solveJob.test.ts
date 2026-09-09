import { describe, it, expect } from 'vitest';
import {
  IDLE_JOB,
  abortJob,
  canStartSolve,
  completeJob,
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
