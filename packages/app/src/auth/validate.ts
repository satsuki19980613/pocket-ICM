// 認証フォームの入力検証（純ロジック・Node テスト可）。
// サーバ側（supabase/functions/signup）の規則をミラーして、往復前にクライアントで弾く。
//   handle: /^[a-z0-9_]{3,20}$/ ／ 表示名: 1〜40文字 ／ パスワード: 8文字以上 ／ 招待キー: 必須
// これらはあくまで先出しの UX 補助。最終判定は常にサーバ側（Edge Function / claim_invite）。

export const HANDLE_RE = /^[a-z0-9_]{3,20}$/;

/** 表示名の検証（1〜40文字, trim 後）。null=OK。サーバ constraint と一致。 */
export function validateDisplayName(v: string): string | null {
  const dn = v.trim();
  return dn.length < 1 || dn.length > 40 ? '表示名は1〜40文字で入力してください' : null;
}

/** パスワードの検証（8文字以上）。null=OK。サーバ signup と一致。 */
export function validatePassword(v: string): string | null {
  return v.length < 8 ? 'パスワードは8文字以上にしてください' : null;
}

/** ログインの入力検証。返す文字列は表示用の日本語エラー（null=OK）。 */
export function validateLogin(input: { handle: string; password: string }): {
  handle: string | null;
  password: string | null;
  ok: boolean;
} {
  const handle = input.handle.trim() ? null : 'ユーザー名を入力してください';
  const password = input.password ? null : 'パスワードを入力してください';
  return { handle, password, ok: !handle && !password };
}

/** サインアップの入力検証。サーバ規則に一致。 */
export function validateSignup(input: {
  display_name: string;
  handle: string;
  password: string;
  invite_code: string;
}): {
  display_name: string | null;
  handle: string | null;
  password: string | null;
  invite_code: string | null;
  ok: boolean;
} {
  const display_name = validateDisplayName(input.display_name);

  const h = input.handle.trim().toLowerCase();
  let handle: string | null = null;
  if (!h) handle = 'ユーザー名を入力してください';
  else if (!HANDLE_RE.test(h)) handle = 'ユーザー名は英小文字・数字・_ の3〜20文字です';

  const password = validatePassword(input.password);

  const invite_code = input.invite_code.trim() ? null : '招待キーを入力してください';

  return {
    display_name,
    handle,
    password,
    invite_code,
    ok: !display_name && !handle && !password && !invite_code,
  };
}
