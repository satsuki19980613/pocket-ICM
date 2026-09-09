// 管理画面のデータ取得（管理者のみ・RLS で強制）。
// 上限変更/発行/取消は Edge Function（supabase/api.ts の setMaxAccounts/issueInvite/revokeInvite）。
// ここは閲覧系（app_config / profiles 件数 / invite_codes 一覧）を担う。
import { supabase } from './client';
import type { FnResult } from './api';
import type { InviteStatus, ImageStatRow, OcrFailureRow } from '../admin/format';

export type AdminOverview = { max_accounts: number; current_count: number };

export type InviteRow = {
  id: string;
  ref: string;
  status: InviteStatus;
  created_at: string;
  expires_at: string;
  used_at: string | null;
};

function fail(message: string): { ok: false; error: string; message: string } {
  return { ok: false, error: 'admin_error', message };
}

/** 登録状況（上限・現在の登録数）。app_config は管理者のみ RLS 閲覧可。 */
export async function getAdminOverview(): Promise<FnResult<AdminOverview>> {
  const cfg = await supabase.from('app_config').select('max_accounts').eq('id', 1).single();
  if (cfg.error || !cfg.data) return fail('設定を取得できませんでした（管理者のみ）');
  const cnt = await supabase.from('profiles').select('id', { count: 'exact', head: true });
  if (cnt.error) return fail('登録数を取得できませんでした');
  return {
    ok: true,
    data: { max_accounts: cfg.data.max_accounts as number, current_count: cnt.count ?? 0 },
  };
}

/** 招待キー一覧（新しい順）。invite_codes は管理者のみ RLS 閲覧可。code_hash は取得しない。 */
export async function listInvites(): Promise<FnResult<InviteRow[]>> {
  const { data, error } = await supabase
    .from('invite_codes')
    .select('id, ref, status, created_at, expires_at, used_at')
    .order('created_at', { ascending: false });
  if (error || !data) return fail('招待キー一覧を取得できませんでした');
  return { ok: true, data: data as InviteRow[] };
}

/**
 * ストレージ使用量（SPEC §4.2/§7.2）の元データ。`images` は管理者が RLS で全件 select 可。
 * 合算・比率・警告判定は `admin/format.ts#summarizeStorage`（純関数）に委ねる。件数が
 * 少ない運用規模（β・数百枚オーダー）を前提に、生行を丸ごと取得してクライアント側で集計する。
 */
export async function listImageStats(): Promise<FnResult<ImageStatRow[]>> {
  const { data, error } = await supabase.from('images').select('bytes, protected');
  if (error) return fail('ストレージ使用量を取得できませんでした');
  return { ok: true, data: (data ?? []) as ImageStatRow[] };
}

/**
 * OCR 失敗（`ok=false`）の元データ（直近 `sinceDays` 日、既定30日）。`ocr_reads` は管理者が
 * RLS で全件 select 可。issue_codes 別・display_mode 別の内訳は
 * `admin/format.ts#summarizeOcrFailures`（純関数）に委ねる。
 * **画像そのものは取得しない**（プライバシー上、管理画面に一覧表示しない・§12.3）。
 */
export async function listOcrFailures(sinceDays = 30): Promise<FnResult<OcrFailureRow[]>> {
  const sinceIso = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('ocr_reads')
    .select('issue_codes, display_mode')
    .eq('ok', false)
    .gte('created_at', sinceIso);
  if (error) return fail('OCR 失敗の集計を取得できませんでした');
  return { ok: true, data: (data ?? []) as OcrFailureRow[] };
}
