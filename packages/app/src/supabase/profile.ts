// 自分のプロフィール読み書き（設定画面用）。すべて RLS 下で本人のみ。
// - 表示名 / 公開既定: public.profiles を直接 update（profiles_update ポリシー = id=auth.uid()）。
// - パスワード: supabase.auth.updateUser（Auth API・バックエンド不要）。
// ※ handle 変更は synthetic email の付け替えが要り Edge Function 未実装 → 本モジュール対象外。
import { supabase } from './client';
import type { FnResult } from './api';

export type MyProfile = {
  id: string;
  handle: string;
  display_name: string;
  avatar_url: string | null;
  is_admin: boolean;
  default_public: boolean;
};

function fail(message: string): { ok: false; error: string; message: string } {
  return { ok: false, error: 'profile_error', message };
}

/** ログイン中ユーザー自身のプロフィールを取得。 */
export async function getMyProfile(): Promise<FnResult<MyProfile>> {
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth.user?.id;
  if (!uid) return fail('ログインしていません');
  const { data, error } = await supabase
    .from('profiles')
    .select('id, handle, display_name, avatar_url, is_admin, default_public')
    .eq('id', uid)
    .single();
  if (error || !data) return fail('プロフィールを取得できませんでした');
  return { ok: true, data: data as MyProfile };
}

/** 表示名を更新（1〜40文字はサーバ constraint でも担保）。 */
export async function updateDisplayName(displayName: string): Promise<FnResult<{ display_name: string }>> {
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth.user?.id;
  if (!uid) return fail('ログインしていません');
  const dn = displayName.trim();
  const { error } = await supabase.from('profiles').update({ display_name: dn }).eq('id', uid);
  if (error) return fail('表示名を更新できませんでした');
  return { ok: true, data: { display_name: dn } };
}

/** 公開既定（計算したら最初から公開する）を更新。 */
export async function updateDefaultPublic(value: boolean): Promise<FnResult<{ default_public: boolean }>> {
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth.user?.id;
  if (!uid) return fail('ログインしていません');
  const { error } = await supabase.from('profiles').update({ default_public: value }).eq('id', uid);
  if (error) return fail('公開設定を更新できませんでした');
  return { ok: true, data: { default_public: value } };
}

/** パスワードを変更（8文字以上）。Auth のセッションが必要。 */
export async function changePassword(newPassword: string): Promise<FnResult<Record<string, never>>> {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) {
    // Supabase は「同じパスワード」等を 422 で返すことがある。メッセージは日本語に丸める。
    return fail('パスワードを変更できませんでした（時間をおいて再度お試しください）');
  }
  return { ok: true, data: {} };
}
