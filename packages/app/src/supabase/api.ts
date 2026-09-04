// Edge Function 呼び出し ＋ 認証ヘルパ。
// 関数のエラーボディ（{ error, message }）を確実に読むため fetch を直接使う。
import {
  supabase,
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  handleToEmail,
} from './client';

export type FnResult<T> = { ok: true; data: T } | { ok: false; error: string; message: string };

// Edge Function を呼ぶ。ログイン中ならセッション JWT を Authorization に載せる。
async function callFunction<T>(name: string, body: unknown): Promise<FnResult<T>> {
  const { data: sess } = await supabase.auth.getSession();
  const token = sess.session?.access_token;
  let res: Response;
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token ?? SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, error: 'network', message: '通信に失敗しました' };
  }
  let payload: Record<string, unknown> = {};
  try {
    payload = await res.json();
  } catch {
    /* 空ボディ */
  }
  if (!res.ok || payload.error) {
    return {
      ok: false,
      error: String(payload.error ?? `http_${res.status}`),
      message: String(payload.message ?? 'エラーが発生しました'),
    };
  }
  return { ok: true, data: payload as T };
}

// ---- サインアップ（招待キー） ----
export async function signUpWithInvite(input: {
  handle: string;
  display_name: string;
  password: string;
  invite_code: string;
}): Promise<FnResult<{ user_id: string; handle: string }>> {
  const created = await callFunction<{ user_id: string; handle: string }>('signup', input);
  if (!created.ok) return created;
  // 作成後、自動ログイン。
  const signedIn = await signIn(input.handle, input.password);
  if (!signedIn.ok) return signedIn as FnResult<{ user_id: string; handle: string }>;
  return created;
}

// ---- ログイン ----
export async function signIn(
  handle: string,
  password: string,
): Promise<FnResult<{ user_id: string }>> {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: handleToEmail(handle),
    password,
  });
  if (error || !data.user) {
    return { ok: false, error: 'signin_failed', message: 'ユーザー名またはパスワードが違います' };
  }
  return { ok: true, data: { user_id: data.user.id } };
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut();
}

// ---- アカウント削除（本人） ----
export async function deleteAccount(): Promise<FnResult<Record<string, never>>> {
  const r = await callFunction<Record<string, never>>('delete-account', {});
  if (r.ok) await supabase.auth.signOut();
  return r;
}

// ---- 管理: 招待キー発行 ----
export async function issueInvite(): Promise<
  FnResult<{ code: string; ref: string; id: string; expires_at: string }>
> {
  return callFunction('issue-invite', {});
}

// ---- 管理: 招待キー取消 ----
export async function revokeInvite(id: string): Promise<FnResult<{ id: string }>> {
  return callFunction('revoke-invite', { id });
}

// ---- 管理: 上限変更 ----
export async function setMaxAccounts(
  max: number,
): Promise<FnResult<{ max_accounts: number; current: number }>> {
  return callFunction('set-max-accounts', { max_accounts: max });
}
