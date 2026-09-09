// purge-images: images の保持期限・総量上限に基づく削除ジョブ（service_role・cron専用）。
// SPEC §7.2 / §12。GitHub Actions（週1 warm-ping と同じワークフロー）から
// Authorization: Bearer <PURGE_TOKEN>（env・secret）で呼ぶ。ユーザーセッションは使わない。
import { preflight, json } from '../_shared/cors.ts';
import { serviceClient } from '../_shared/util.ts';

// 総量上限（超えたら非保護画像を古い順に削除）。§7.2 の 700MB。
const TOTAL_LIMIT_BYTES = 700 * 1024 * 1024;
// 保護画像（OCR失敗・低信頼）だけでこれを超えたら削除はせず警告のみ。§7.2 の 300MB。
const PROTECTED_WARN_BYTES = 300 * 1024 * 1024;

interface ImageRow {
  id: string;
  bucket: string;
  path: string;
  bytes: number | null;
  expires_at: string | null;
  protected: boolean;
  created_at: string;
}

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const expected = Deno.env.get('PURGE_TOKEN');
  if (!expected) {
    return json({ error: 'not_configured', message: 'PURGE_TOKEN が未設定です' }, 500);
  }
  const auth = req.headers.get('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token !== expected) return json({ error: 'unauthorized' }, 401);

  const svc = serviceClient();

  // クラブは最大25人・画像は圧縮版のみのため全件取得で十分（保険として上限を付ける）。
  const all = await svc
    .from('images')
    .select('id, bucket, path, bytes, expires_at, protected, created_at')
    .order('created_at', { ascending: true })
    .limit(20000);
  if (all.error) {
    return json({ error: 'query_failed', message: all.error.message }, 500);
  }

  const rows = (all.data ?? []) as ImageRow[];
  const bytesOf = (r: ImageRow) => r.bytes ?? 0;

  const totalBytesBefore = rows.reduce((sum, r) => sum + bytesOf(r), 0);
  const protectedBytes = rows
    .filter((r) => r.protected)
    .reduce((sum, r) => sum + bytesOf(r), 0);

  const now = Date.now();
  const toDelete: ImageRow[] = [];
  const markedIds = new Set<string>();

  // 1) 期限切れ（非保護）画像を削除対象へ。§7.2-2。
  for (const r of rows) {
    if (!r.protected && r.expires_at && new Date(r.expires_at).getTime() < now) {
      toDelete.push(r);
      markedIds.add(r.id);
    }
  }

  // 2) 総量が上限を超える場合、非保護画像を古い順（rows は created_at asc）に追加削除。§7.2-3。
  let projectedTotal = totalBytesBefore - toDelete.reduce((sum, r) => sum + bytesOf(r), 0);
  if (projectedTotal > TOTAL_LIMIT_BYTES) {
    for (const r of rows) {
      if (projectedTotal <= TOTAL_LIMIT_BYTES) break;
      if (r.protected || markedIds.has(r.id)) continue;
      toDelete.push(r);
      markedIds.add(r.id);
      projectedTotal -= bytesOf(r);
    }
  }

  // Storage から削除（バケットごとにまとめて呼ぶ）。
  const pathsByBucket = new Map<string, string[]>();
  for (const r of toDelete) {
    const list = pathsByBucket.get(r.bucket) ?? [];
    list.push(r.path);
    pathsByBucket.set(r.bucket, list);
  }
  for (const [bucket, paths] of pathsByBucket) {
    if (paths.length === 0) continue;
    const rm = await svc.storage.from(bucket).remove(paths);
    if (rm.error) {
      return json({ error: 'storage_delete_failed', message: rm.error.message }, 500);
    }
  }

  // DB から削除。
  let freedBytes = 0;
  if (toDelete.length > 0) {
    freedBytes = toDelete.reduce((sum, r) => sum + bytesOf(r), 0);
    const del = await svc
      .from('images')
      .delete()
      .in('id', toDelete.map((r) => r.id));
    if (del.error) {
      return json({ error: 'db_delete_failed', message: del.error.message }, 500);
    }
  }

  const totalBytes = totalBytesBefore - freedBytes;
  // 保護画像だけで300MB超なら、削除はせず警告のみ立てる（自動では消さない）。§7.2-3。
  const warnProtectedOver = protectedBytes > PROTECTED_WARN_BYTES;

  return json({
    deleted: toDelete.length,
    freedBytes,
    totalBytes,
    protectedBytes,
    warn_protected_over: warnProtectedOver,
  });
});
