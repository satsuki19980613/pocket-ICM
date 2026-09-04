// 管理画面のデータ取得（管理者のみ・RLS で強制）。
// 上限変更/発行/取消は Edge Function（supabase/api.ts の setMaxAccounts/issueInvite/revokeInvite）。
// ここは閲覧系（app_config / profiles 件数 / invite_codes 一覧）を担う。
import { supabase } from './client';
import type { FnResult } from './api';
import type { InviteStatus } from '../admin/format';

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
