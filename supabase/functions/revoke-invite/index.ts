// revoke-invite: 管理者が未使用キーを取消。使用済みキーは取消不可（既に消費済み）。
// SPEC §4.2。
import { preflight, json } from '../_shared/cors.ts';
import { serviceClient, getCaller, isAdmin } from '../_shared/util.ts';

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const caller = await getCaller(req);
  if (!caller) return json({ error: 'unauthorized' }, 401);

  const svc = serviceClient();
  if (!(await isAdmin(svc, caller.id))) {
    return json({ error: 'forbidden', message: '管理者のみ実行できます' }, 403);
  }

  let body: { id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad_request' }, 400);
  }
  const id = (body.id ?? '').trim();
  if (!id) return json({ error: 'missing_id', message: 'キー ID が必要です' }, 400);

  // 未使用のものだけ取消（used/revoked は変更しない）。
  const upd = await svc
    .from('invite_codes')
    .update({ status: 'revoked' })
    .eq('id', id)
    .eq('status', 'unused')
    .select('id')
    .maybeSingle();

  if (upd.error) return json({ error: 'revoke_failed' }, 500);
  if (!upd.data) {
    return json({ error: 'not_revocable', message: '未使用のキーのみ取消できます' }, 409);
  }
  return json({ ok: true, id: upd.data.id });
});
