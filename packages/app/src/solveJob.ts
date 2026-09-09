/**
 * 計算ジョブの状態機械（純ロジック, SPEC v3 §5.7, BETA_PLAN WP-C）。
 *
 * v3 では「計算中」画面（solving）を廃止し、計算開始と同時に記録タブへ遷移する。計算自体は
 * 端末内 Web Worker でバックグラウンド継続し、他タブの操作を妨げない。この状態機械は
 * 「今どこにいるか」（idle/running/done/failed/aborted）と「新規入力を受け付けてよいか」
 * （同時1件の制約, §5.7 の3）を App のトップレベル state から追い出し、UI 側から判断ロジックを
 * 消すために置く。App.tsx は結果を反映するだけにする。
 *
 * ジョブは1つの JS プロセス（1タブ）でしか進行しない。ページを閉じる/リロードすると
 * running のまま消え、次回ログイン時に `abortStaleSolving()`（サーバ側）で aborted に落とす
 * （§5.7 の5）。ここでの `abortJob` はその「見た目」を idle 相当（同時1件の制約解除）へ戻す用途。
 */

/** ジョブの状態。idle=何も計算していない。running の間だけ新規計算を受け付けない。 */
export type SolveJobStatus = 'idle' | 'running' | 'done' | 'failed' | 'aborted';

/**
 * 進行中/直近の計算ジョブ。`recordId` は対象記録のローカル id（`SpotRecord.id`）で、
 * idle のときは null。done/failed/aborted になっても直近の recordId は残す
 * （トースト経由の遷移・記録タブでのハイライト等に使える）。
 */
export interface SolveJob {
  readonly status: SolveJobStatus;
  readonly recordId: string | null;
}

/** 初期状態（未計算・何も進行していない）。 */
export const IDLE_JOB: SolveJob = { status: 'idle', recordId: null };

/**
 * 新規の計算を開始してよいか（SPEC §5.7 の3: 同時1件の制約）。
 * running のときだけ不可。done/failed/aborted（直近の結果を保持したまま）は次を始められる。
 */
export function canStartSolve(job: SolveJob): boolean {
  return job.status !== 'running';
}

/** 計算開始（idle/done/failed/aborted → running）。 */
export function startJob(recordId: string): SolveJob {
  return { status: 'running', recordId };
}

/** 計算完了（running → done）。recordId は引き継ぐ。 */
export function completeJob(job: SolveJob): SolveJob {
  return { ...job, status: 'done' };
}

/** 計算失敗（running → failed）。recordId は引き継ぐ。 */
export function failJob(job: SolveJob): SolveJob {
  return { ...job, status: 'failed' };
}

/**
 * 中断（起動時、`solving` のまま残っていた記録をサーバ側で `aborted` に落とすのに合わせて使う。
 * 通常はアプリを再読込した直後＝job は既に idle に戻っているため実UIでは稀だが、状態機械の
 * 完全性のため running からの遷移として定義する）。
 */
export function abortJob(job: SolveJob): SolveJob {
  return { ...job, status: 'aborted' };
}

/** 完全にリセット（idle に戻す）。 */
export function resetJob(): SolveJob {
  return IDLE_JOB;
}
