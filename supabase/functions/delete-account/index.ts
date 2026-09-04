// delete-account: ログイン中の本人が自分のアカウントを削除。
// auth.users の削除には service_role が要る（クライアントからは不可）。
// profiles→results/threads/comments/likes は FK cascade で連鎖削除される。SPEC §2。
import { preflight, json } from '../_shared/cors.ts';
import { serviceClient, getCaller } from '../_shared/util.ts';

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const caller = await getCaller(req);
  if (!caller) return json({ error: 'unauthorized' }, 401);

  const svc = serviceClient();
  const del = await svc.auth.admin.deleteUser(caller.id);
  if (del.error) return json({ error: 'delete_failed', message: '削除に失敗しました' }, 500);

  return json({ ok: true });
});
