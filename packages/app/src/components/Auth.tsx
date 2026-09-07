import { useState } from 'react';
import { signIn, signUpWithInvite } from '../supabase/api';
import { validateLogin, validateSignup } from '../auth/validate';

type Mode = 'login' | 'signup';

/**
 * 認証画面（モック s-auth 準拠・CP2077）。ログイン／アカウント作成のタブ切替。
 * サインアップは招待キー必須（サーバ側 signup Edge Function で最終検証）。
 * 成功すると supabase セッションが張られ、App の onAuthStateChange がゲートを解除する。
 */
export function Auth(props: {
  /** バックエンド（Supabase）が設定済みか。false なら送信不可＋設定不足バナー。 */
  configured: boolean;
}): JSX.Element {
  const [mode, setMode] = useState<Mode>('login');
  const [busy, setBusy] = useState(false);

  // 入力値（表示名は廃止＝識別子は handle 一本化）
  const [handle, setHandle] = useState('');
  const [password, setPassword] = useState('');
  const [invite, setInvite] = useState('');

  // 表示エラー（フィールド別＋送信全体）
  const [fieldErr, setFieldErr] = useState<Record<string, string | null>>({});
  const [formErr, setFormErr] = useState<string | null>(null);

  function switchMode(m: Mode): void {
    setMode(m);
    setFieldErr({});
    setFormErr(null);
  }

  async function onLogin(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setFormErr(null);
    const v = validateLogin({ handle, password });
    setFieldErr({ handle: v.handle, password: v.password });
    if (!v.ok) return;
    setBusy(true);
    try {
      const r = await signIn(handle.trim(), password);
      if (!r.ok) setFormErr(r.message);
      // 成功時は onAuthStateChange がゲートを解除するので、ここでは何もしない。
    } finally {
      setBusy(false);
    }
  }

  async function onSignup(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setFormErr(null);
    const v = validateSignup({
      handle,
      password,
      invite_code: invite,
    });
    setFieldErr({
      handle: v.handle,
      password: v.password,
      invite_code: v.invite_code,
    });
    if (!v.ok) return;
    setBusy(true);
    try {
      const normHandle = handle.trim().toLowerCase();
      const r = await signUpWithInvite({
        // 表示名は廃止したのでサーバ規則（1〜40文字必須）は handle で満たす。
        display_name: normHandle,
        handle: normHandle,
        password,
        invite_code: invite.trim(),
      });
      if (!r.ok) setFormErr(r.message);
      // 成功時は自動ログイン済み → onAuthStateChange がゲートを解除。
    } finally {
      setBusy(false);
    }
  }

  const disabled = busy || !props.configured;

  return (
    <div className="auth">
      <div className="logo">◢◤</div>
      <h2>Black Ops ICM</h2>
      <p className="lead">
        クラブマッチのオールイン、
        <br />
        あとから答え合わせする場所。
      </p>

      <div className="seg2">
        <button type="button" aria-pressed={mode === 'login'} onClick={() => switchMode('login')}>
          ログイン
        </button>
        <button type="button" aria-pressed={mode === 'signup'} onClick={() => switchMode('signup')}>
          アカウント作成
        </button>
      </div>

      {!props.configured && (
        <p className="auth-unconfigured">
          バックエンドが設定されていません（管理者向け: VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY）。
        </p>
      )}

      {mode === 'login' ? (
        <form className="form" onSubmit={onLogin} noValidate>
          <Field label="ユーザー名" err={fieldErr.handle}>
            <input
              className="inp"
              type="text"
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="username"
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
            />
          </Field>
          <Field label="パスワード" err={fieldErr.password}>
            <input
              className="inp"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          {formErr && <p className="auth-err">{formErr}</p>}
          <button className="btn" type="submit" disabled={disabled}>
            {busy ? 'ログイン中…' : 'ログイン'}
          </button>
        </form>
      ) : (
        <form className="form" onSubmit={onSignup} noValidate>
          <Field label="ユーザー名" err={fieldErr.handle}>
            <input
              className="inp"
              type="text"
              placeholder="@handle（英小文字・数字・_）"
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="username"
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
            />
          </Field>
          <Field label="パスワード" err={fieldErr.password}>
            <input
              className="inp"
              type="password"
              placeholder="8文字以上"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Field label="招待キー" err={fieldErr.invite_code} keyField>
            <input
              className="inp"
              type="text"
              placeholder="さつきから受け取ったキー"
              autoCapitalize="characters"
              autoCorrect="off"
              value={invite}
              onChange={(e) => setInvite(e.target.value)}
            />
          </Field>
          {formErr && <p className="auth-err">{formErr}</p>}
          <button className="btn cyan" type="submit" disabled={disabled}>
            {busy ? '作成中…' : 'アカウントを作成'}
          </button>
          <p className="note c">招待制です。キーが正しく、空き枠があるときだけ作成できます。</p>
        </form>
      )}
    </div>
  );
}

/** 認証フォームの1フィールド（ラベル＋入力＋エラー）。 */
function Field(props: {
  label: string;
  err?: string | null;
  keyField?: boolean;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <label className={`afield${props.keyField ? ' key' : ''}`}>
      <b>{props.label}</b>
      {props.children}
      {props.err && <em className="afield-err">{props.err}</em>}
    </label>
  );
}
