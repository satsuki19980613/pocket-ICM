// set-max-accounts: 管理者がアカウント上限を変更。現登録数を下回る値は拒否。
// SPEC §4.2 / §4.3。
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

  let body: { max_accounts?: number };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad_request' }, 400);
  }
  const max = Number(body.max_accounts);
  if (!Number.isInteger(max) || max < 1 || max > 1000) {
    return json({ error: 'invalid_value', message: '上限は 1〜1000 の整数です' }, 400);
  }

  // 現登録数を下回る上限は不可（既存アカウントを追い出さない）。
  const cnt = await svc.from('profiles').select('id', { count: 'exact', head: true });
  const current = cnt.count ?? 0;
  if (max < current) {
    return json(
      { error: 'below_current', message: `現在の登録数（${current}）以上にしてください` },
      409,
    );
  }

  const upd = await svc
    .from('app_config')
    .update({ max_accounts: max, updated_at: new Date().toISOString() })
    .eq('id', 1)
    .select('max_accounts')
    .single();
  if (upd.error) return json({ error: 'update_failed' }, 500);

  return json({ ok: true, max_accounts: upd.data.max_accounts, current });
});
