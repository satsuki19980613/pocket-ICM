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

/** check_invite / claim_invite / register_member の結果 → 利用者向けのエラー応答。 */
function inviteError(status: unknown): Response {
  switch (status) {
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

const HANDLE_TAKEN = (): Response =>
  json({ error: 'handle_taken', message: 'このユーザー名は既に使われています' }, 409);

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

  // 1) 招待キーを先に確かめる（消費はしない）。キーが無効ならアカウントを作らずにここで止める。
  //    以前はアカウントを先に作っていたため、招待キーを持たない人でも「このユーザー名は既に
  //    使われています」の応答から、実在するユーザー名を調べられた。
  //    check_invite が「存在しない」（0008 未適用）ときだけ、下見を飛ばして旧経路で判定する。
  //    一時的なエラーで旧経路へ落ちると、旧経路の弱さ（後始末の失敗・ユーザー名の露出）が戻るので、
  //    それ以外のエラーはここで止める。
  const pre = await svc.rpc('check_invite', { p_code_hash: codeHash });
  const hardened = !pre.error;
  if (pre.error) {
    const missing =
      pre.error.code === 'PGRST202' || /could not find the function|does not exist/i.test(pre.error.message ?? '');
    if (!missing) return json({ error: 'signup_failed', message: 'アカウント作成に失敗しました（時間をおいてお試しください）' }, 503);
  }
  if (hardened && pre.data !== 'ok') return inviteError(pre.data);

  // 2) Auth ユーザー作成（メール送信なし = email_confirm）。
  const created = await svc.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (created.error || !created.data.user) {
    const msg = created.error?.message ?? '';
    if (/already|registered|exist/i.test(msg)) return HANDLE_TAKEN();
    return json({ error: 'signup_failed', message: 'アカウント作成に失敗しました' }, 400);
  }
  const uid = created.data.user.id;

  // 失敗時に作成済みの Auth ユーザーを片付ける。消せなかった場合もプロフィールは無い
  // （＝メンバーではないので何も読めない・書けない）。
  const rollback = async (): Promise<void> => {
    const { error } = await svc.auth.admin.deleteUser(uid);
    if (error) console.error('signup rollback: auth user を削除できませんでした', uid, error.message);
  };

  if (hardened) {
    // 3) プロフィール作成と招待キーの消費を1つのトランザクションで（0008 の register_member）。
    //    'ok' 以外ならプロフィールも作られていない。
    const reg = await svc.rpc('register_member', {
      p_user: uid,
      p_handle: handle,
      p_display_name: displayName,
      p_code_hash: codeHash,
    });
    if (reg.error || reg.data !== 'ok') {
      await rollback();
      if (reg.data === 'handle_taken') return HANDLE_TAKEN();
      if (reg.error) return json({ error: 'signup_failed', message: 'アカウント作成に失敗しました' }, 500);
      return inviteError(reg.data);
    }
    return json({ ok: true, user_id: uid, handle });
  }

  // --- 旧経路（0008 未適用のときだけ通る） ---
  const prof = await svc
    .from('profiles')
    .insert({ id: uid, handle, display_name: displayName });
  if (prof.error) {
    await rollback();
    if (prof.error.code === '23505') return HANDLE_TAKEN();
    return json({ error: 'profile_failed', message: 'プロフィール作成に失敗しました' }, 400);
  }
  const claim = await svc.rpc('claim_invite', {
    p_code_hash: codeHash,
    p_user: uid,
  });
  if (claim.error || claim.data !== 'ok') {
    await rollback();
    return inviteError(claim.data);
  }

  return json({ ok: true, user_id: uid, handle });
});
