// 診断ログ（管理者専用, 0009）の読み出し。すべて管理者専用のサーバ関数（admin_*）を通す。
// 関数の中で is_admin を確かめ、管理者以外は 42501 で拒否される（画面を無理に開いても中身は届かない）。
// results の閲覧ポリシーは広げていないので、全員分の計算の記録はここからしか見えない。
import { supabase } from './client';
import type { FnResult } from './api';

/** 1回に読む件数（「もっと見る」で続きを読む）。 */
export const DIAG_PAGE = 30;

export interface DiagSummary {
  runs_total: number;
  runs_failed: number;
  runs_aborted: number;
  /** solving のまま10分以上（期間を問わず）。 */
  runs_stuck: number;
  last_run_at: string | null;
  last_run_handle: string | null;
  ocr_total: number;
  ocr_failed: number;
  ocr_corrected: number;
  errors_total: number;
}

export interface DiagRun {
  id: string;
  created_at: string;
  updated_at: string;
  owner_handle: string;
  owner_name: string;
  status: string;
  error: string | null;
  solve_ms: number | null;
  players_left: number | null;
  hero_pos: string | null;
  hero_hand: string | null;
  verdict: string | null;
  hero_action: string | null;
  is_public: boolean;
  image_path: string | null;
  ocr_ok: boolean | null;
  ocr_issues: unknown;
  corrections: unknown;
}

export interface DiagOcrRead {
  id: string;
  created_at: string;
  owner_handle: string;
  owner_name: string;
  ok: boolean;
  display_mode: string | null;
  street: string | null;
  issues: unknown;
  issue_codes: unknown;
  low_confidence: unknown;
  corrections: unknown;
  result_id: string | null;
  image_path: string | null;
  device: unknown;
  app_version: string | null;
  ocr_version: string | null;
}

export interface DiagClientError {
  id: string;
  created_at: string;
  owner_handle: string;
  owner_name: string;
  kind: string;
  message: string;
  detail: string | null;
  screen: string | null;
  app_version: string | null;
  device: unknown;
}

function fail(error: { code?: string } | null, what: string): { ok: false; error: string; message: string } {
  const code = error?.code ?? '';
  const message =
    code === '42501'
      ? '管理者だけが見られます'
      : code === 'PGRST202' || code === '42883'
        ? 'サーバの準備（0009 の SQL）がまだです'
        : `${what}を読み込めませんでした`;
  return { ok: false, error: 'diag_error', message };
}

/** 直近 sinceDays 日の件数と、最後に計算した人・時刻。 */
export async function getDiagSummary(sinceDays: number): Promise<FnResult<DiagSummary>> {
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase.rpc('admin_diag_summary', { p_since: since });
  const row = Array.isArray(data) ? (data[0] as DiagSummary | undefined) : undefined;
  if (error || !row) return fail(error, '件数');
  return { ok: true, data: row };
}

/** 全員の計算の記録（非公開を含む・新しい順）。before より前の分を DIAG_PAGE 件。 */
export async function listDiagRuns(opts: {
  before: string | null;
  problemsOnly: boolean;
}): Promise<FnResult<DiagRun[]>> {
  const { data, error } = await supabase.rpc('admin_list_runs', {
    p_limit: DIAG_PAGE,
    p_before: opts.before,
    p_problems_only: opts.problemsOnly,
  });
  if (error || !Array.isArray(data)) return fail(error, '計算の記録');
  return { ok: true, data: data as DiagRun[] };
}

/** 全員の OCR 読み取り（新しい順）。 */
export async function listDiagOcrReads(opts: {
  before: string | null;
  problemsOnly: boolean;
}): Promise<FnResult<DiagOcrRead[]>> {
  const { data, error } = await supabase.rpc('admin_list_ocr_reads', {
    p_limit: DIAG_PAGE,
    p_before: opts.before,
    p_problems_only: opts.problemsOnly,
  });
  if (error || !Array.isArray(data)) return fail(error, 'OCR の読み取り');
  return { ok: true, data: data as DiagOcrRead[] };
}

/** アプリのエラー（新しい順）。 */
export async function listDiagClientErrors(opts: { before: string | null }): Promise<FnResult<DiagClientError[]>> {
  const { data, error } = await supabase.rpc('admin_list_client_errors', {
    p_limit: DIAG_PAGE,
    p_before: opts.before,
  });
  if (error || !Array.isArray(data)) return fail(error, 'アプリのエラー');
  return { ok: true, data: data as DiagClientError[] };
}
