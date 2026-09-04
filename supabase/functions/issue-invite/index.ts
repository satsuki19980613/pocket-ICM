// issue-invite: 管理者が使い捨て招待キーを1つ発行。生キーは一度だけ返す（DB はハッシュのみ）。
// SPEC §3 / §4.2。
import { preflight, json } from '../_shared/cors.ts';
import {
  serviceClient,
  getCaller,
  isAdmin,
  sha256Hex,
  normalizeCode,
  generateInviteCode,
  generateRef,
} from '../_shared/util.ts';

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

  // TTL（既定7日）は app_config から。
  const cfg = await svc.from('app_config').select('invite_ttl_days').eq('id', 1).single();
  const ttlDays = cfg.data?.invite_ttl_days ?? 7;
  const expiresAt = new Date(Date.now() + ttlDays * 86400_000).toISOString();

  // 衝突（極稀）に備えて数回リトライ。
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateInviteCode();
    const codeHash = await sha256Hex(normalizeCode(code));
    const ref = generateRef();
    const ins = await svc.from('invite_codes').insert({
      code_hash: codeHash,
      ref,
      created_by: caller.id,
      expires_at: expiresAt,
      status: 'unused',
    }).select('id, ref, created_at, expires_at').single();

    if (!ins.error && ins.data) {
      // 生キーはここでしか返らない（コピーして相手に渡す）。
      return json({
        ok: true,
        code,
        ref: ins.data.ref,
        id: ins.data.id,
        expires_at: ins.data.expires_at,
      });
    }
    if (ins.error && ins.error.code !== '23505') {
      return json({ error: 'issue_failed', message: 'キー発行に失敗しました' }, 500);
    }
    // 23505（ハッシュ衝突）ならリトライ
  }
  return json({ error: 'issue_failed', message: 'キー発行に失敗しました（衝突）' }, 500);
});
