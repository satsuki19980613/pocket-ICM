// signup: 招待キー検証 ＋ 上限チェック ＋ アカウント作成（原子的にキー消費）。
// SPEC §3.2 / §2。判定はすべてサーバ側（service_role）。
import { preflight, json } from '../_shared/cors.ts';
import {
  serviceClient,
  normalizeCode,
  sha256Hex,
  EMAIL_DOMAIN,
} from '../_shared/util.ts';

const HANDLE_RE = /^[a-z0-9_]{3,20}$/;

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  let body: {
    handle?: string;
    display_name?: string;
    password?: string;
    invite_code?: string;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad_request', message: 'JSON を解釈できません' }, 400);
  }

  const handle = (body.handle ?? '').trim().toLowerCase();
  const displayName = (body.display_name ?? '').trim();
  const password = body.password ?? '';
  const inviteCode = body.invite_code ?? '';

  // 入力検証（サーバ側）
  if (!HANDLE_RE.test(handle)) {
    return json(
      { error: 'invalid_handle', message: 'ユーザー名は英小文字・数字・_ の3〜20文字です' },
      400,
    );
  }
  if (displayName.length < 1 || displayName.length > 40) {
    return json({ error: 'invalid_display_name', message: '表示名は1〜40文字です' }, 400);
  }
  if (password.length < 8) {
    return json({ error: 'weak_password', message: 'パスワードは8文字以上にしてください' }, 400);
  }
  if (!inviteCode.trim()) {
    return json({ error: 'missing_invite', message: '招待キーを入力してください' }, 400);
  }

  const svc = serviceClient();
  const codeHash = await sha256Hex(normalizeCode(inviteCode));
  const email = `${handle}@${EMAIL_DOMAIN}`;

  // 1) Auth ユーザー作成（メール送信なし = email_confirm）。
  const created = await svc.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (created.error || !created.data.user) {
    const msg = created.error?.message ?? '';
    if (/already|registered|exist/i.test(msg)) {
      return json({ error: 'handle_taken', message: 'このユーザー名は既に使われています' }, 409);
    }
    return json({ error: 'signup_failed', message: 'アカウント作成に失敗しました' }, 400);
  }
  const uid = created.data.user.id;

  // 失敗時に作成済みユーザーを片付けるヘルパ（cascade で profile も消える）。
  const rollback = async () => {
    await svc.auth.admin.deleteUser(uid);
  };

  // 2) プロフィール挿入。
  const prof = await svc
    .from('profiles')
    .insert({ id: uid, handle, display_name: displayName });
  if (prof.error) {
    await rollback();
    if (prof.error.code === '23505') {
      return json({ error: 'handle_taken', message: 'このユーザー名は既に使われています' }, 409);
    }
    return json({ error: 'profile_failed', message: 'プロフィール作成に失敗しました' }, 400);
  }

  // 3) 招待キーを原子的に検証＋消費（上限も同時強制）。
  const claim = await svc.rpc('claim_invite', {
    p_code_hash: codeHash,
    p_user: uid,
  });
  if (claim.error || claim.data !== 'ok') {
    await rollback();
    switch (claim.data) {
      case 'invalid':
        return json({ error: 'invalid_invite', message: '招待キーが無効です' }, 400);
      case 'expired':
        return json({ error: 'expired_invite', message: '招待キーの期限が切れています' }, 400);
      case 'used':
        return json({ error: 'used_invite', message: 'この招待キーは既に使用されています' }, 400);
      case 'full':
        return json({ error: 'account_full', message: '定員に達しています' }, 403);
      default:
        return json({ error: 'invite_failed', message: '招待キーの処理に失敗しました' }, 400);
    }
  }

  return json({ ok: true, user_id: uid, handle });
});
