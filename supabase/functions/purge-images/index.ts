// purge-images: スクショ（spot-images）の保持期限・総量上限に基づく削除 ＋ 孤児ファイルの回収
// （service_role・cron専用）。SPEC §7.2 / §12。GitHub Actions（週1 warm-ping と同じワークフロー）から
// Authorization: Bearer <PURGE_TOKEN>（env・secret）で呼ぶ。ユーザーセッションは使わない。
//
// images 行は利用者が作れるので、行に書かれた値は信じない:
//   - 消してよいのは「持ち主のスクショフォルダのファイル」を指す行だけ
//   - 大きさ・古さは Storage が記録した実物の値を使う
//   - 総量上限の削除は「取り分を超えて使っている人」の分だけ（purgePlan.ts）。1人が大量に上げても
//     他の人のスクショが消えないように
import { preflight, json } from '../_shared/cors.ts';
import { serviceClient } from '../_shared/util.ts';
import { planEviction } from '../_shared/purgePlan.ts';
import {
  findOrphans,
  listAllObjects,
  referencedPathFromRef,
  removePaths,
  type StorageLike,
  type StoredObject,
} from '../_shared/userFiles.ts';

// 総量上限（超えたら取り分を超えている人の非保護画像を古い順に削除）。§7.2 の 700MB。
const TOTAL_LIMIT_BYTES = 700 * 1024 * 1024;
// 保護画像（OCR失敗・低信頼）だけでこれを超えたら警告を立てる。§7.2 の 300MB。
const PROTECTED_WARN_BYTES = 300 * 1024 * 1024;
// 孤児（どこからも参照されないファイル）・ファイルの無い行とみなす最低経過時間。
// アップロード直後で DB 行がまだ無い／行を作った直後、を消さないため。
const ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;
// 読み出しのページ幅。PostgREST は1回に最大1000行しか返さないので、これ以上はページングする
// （以前は limit(20000) と書いていたが実際は1000行で打ち切られていた）。
const PAGE = 1000;

interface ImageRow {
  id: string;
  owner: string;
  bucket: string;
  path: string;
  expires_at: string | null;
  protected: boolean;
  created_at: string;
}

type Page<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

/** 全行をページングで読む。1ページでも失敗したらエラー（呼び出し側は何も消さない）。 */
async function fetchAll<T>(page: (from: number, to: number) => Page<T>): Promise<{ rows: T[] } | { error: string }> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error || !data) return { error: error?.message ?? 'no data' };
    rows.push(...data);
    if (data.length < PAGE) return { rows };
  }
}

/** 文字列を一定時間で比較する（トークン照合の所要時間から中身を推測されないように）。 */
function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

type Svc = ReturnType<typeof serviceClient>;

/**
 * 孤児ファイルの回収。DB から消えたのにファイル本体だけ残ったもの（他人の返信画像つきの投稿が
 * 消えた・差し替え前のアイコンを消し損ねた等）を消す。参照の読み出しに1つでも失敗したら
 * 何も消さない（参照中のファイルを誤って消さないため）。
 */
async function purgeOrphans(svc: Svc, spotObjects: readonly StoredObject[]): Promise<{ removed: number; error?: string }> {
  const storage = svc.storage as unknown as StorageLike;
  const refs: Record<string, Set<string>> = {
    'thread-images': new Set(),
    avatars: new Set(),
    'spot-images': new Set(),
  };

  const threads = await fetchAll<{ image_url: string | null }>((a, b) =>
    svc.from('threads').select('image_url').not('image_url', 'is', null).order('id').range(a, b),
  );
  const comments = await fetchAll<{ image_url: string | null }>((a, b) =>
    svc.from('comments').select('image_url').not('image_url', 'is', null).order('id').range(a, b),
  );
  const profiles = await fetchAll<{ avatar_url: string | null }>((a, b) =>
    svc.from('profiles').select('avatar_url').not('avatar_url', 'is', null).order('id').range(a, b),
  );
  const images = await fetchAll<{ bucket: string; path: string }>((a, b) =>
    svc.from('images').select('bucket, path').order('id').range(a, b),
  );
  if ('error' in threads || 'error' in comments || 'error' in profiles || 'error' in images) {
    return { removed: 0, error: '参照を読めませんでした（安全のため何も消していません）' };
  }

  for (const r of threads.rows) {
    const p = referencedPathFromRef(r.image_url, 'thread-images');
    if (p) refs['thread-images'].add(p);
  }
  for (const r of comments.rows) {
    const p = referencedPathFromRef(r.image_url, 'thread-images');
    if (p) refs['thread-images'].add(p);
  }
  for (const r of profiles.rows) {
    const p = referencedPathFromRef(r.avatar_url, 'avatars');
    if (p) refs.avatars.add(p);
  }
  for (const r of images.rows) {
    (refs[r.bucket] ??= new Set()).add(r.path);
  }

  let removed = 0;
  for (const bucket of ['thread-images', 'avatars', 'spot-images']) {
    let objects: readonly StoredObject[];
    if (bucket === 'spot-images') {
      objects = spotObjects;
    } else {
      const listed = await listAllObjects(storage, bucket);
      if ('error' in listed) return { removed, error: listed.error };
      objects = listed.objects;
    }
    const orphans = findOrphans(objects, refs[bucket] ?? new Set(), Date.now(), ORPHAN_MIN_AGE_MS);
    const r = await removePaths(storage, bucket, orphans);
    if ('error' in r) return { removed, error: r.error };
    removed += r.removed;
  }
  return { removed };
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
  if (!safeEqual(token, expected)) return json({ error: 'unauthorized' }, 401);

  const svc = serviceClient();
  const storage = svc.storage as unknown as StorageLike;

  // 実物のファイル一覧（大きさ・作成時刻は Storage の値）。読めなければ何も消さない。
  const spotListed = await listAllObjects(storage, 'spot-images');
  if ('error' in spotListed) {
    return json({ error: 'list_failed', message: spotListed.error }, 500);
  }
  const fileByPath = new Map(spotListed.objects.map((o) => [o.path, o]));

  const all = await fetchAll<ImageRow>((a, b) =>
    svc
      .from('images')
      .select('id, owner, bucket, path, expires_at, protected, created_at')
      .order('id')
      .range(a, b),
  );
  if ('error' in all) {
    return json({ error: 'query_failed', message: all.error }, 500);
  }

  const now = Date.now();
  // 消してよいのは「持ち主のスクショフォルダ」を指す行だけ。
  const isOwnSpot = (r: ImageRow): boolean =>
    r.bucket === 'spot-images' && r.path.startsWith(`${r.owner}/`) && !r.path.includes('..');
  const ownRows = all.rows.filter(isOwnSpot);
  const skippedSuspicious = all.rows.length - ownRows.length;
  const rows = ownRows.filter((r) => fileByPath.has(r.path));
  // ファイルが無くなった行（作成日時はサーバの時刻＝0008 で固定）。1日以上経ったものは行ごと片付ける。
  const danglingIds = ownRows
    .filter((r) => !fileByPath.has(r.path) && now - Date.parse(r.created_at) >= ORPHAN_MIN_AGE_MS)
    .map((r) => r.id);

  const sizeOf = (r: ImageRow): number => fileByPath.get(r.path)?.size ?? 0;
  const createdOf = (r: ImageRow): string => fileByPath.get(r.path)?.createdAt ?? r.created_at;

  const totalBytesBefore = rows.reduce((sum, r) => sum + sizeOf(r), 0);
  const protectedBytes = rows.filter((r) => r.protected).reduce((sum, r) => sum + sizeOf(r), 0);

  // 1) 期限切れ（非保護）画像を削除対象へ。§7.2-2。期限は持ち主本人しか書けない（自分の画像にしか効かない）。
  const expired = rows.filter((r) => !r.protected && r.expires_at && new Date(r.expires_at).getTime() < now);
  const expiredIds = new Set(expired.map((r) => r.id));

  // 2) 総量が上限を超える場合、取り分を超えて使っている人の非保護画像を古い順に。§7.2-3。
  const remaining = rows.filter((r) => !expiredIds.has(r.id));
  const evictIds = new Set(
    planEviction(
      remaining.map((r) => ({
        id: r.id,
        owner: r.owner,
        size: sizeOf(r),
        createdAt: createdOf(r),
        protected: r.protected,
      })),
      TOTAL_LIMIT_BYTES,
    ),
  );
  const toDelete = rows.filter((r) => expiredIds.has(r.id) || evictIds.has(r.id));

  // Storage から削除 → DB から削除（in 句が長くなりすぎないよう分割）。
  const rm = await removePaths(
    storage,
    'spot-images',
    toDelete.map((r) => r.path),
  );
  if ('error' in rm) {
    return json({ error: 'storage_delete_failed', message: rm.error }, 500);
  }
  const ids = [...toDelete.map((r) => r.id), ...danglingIds];
  for (let i = 0; i < ids.length; i += 200) {
    const del = await svc.from('images').delete().in('id', ids.slice(i, i + 200));
    if (del.error) {
      return json({ error: 'db_delete_failed', message: del.error.message }, 500);
    }
  }
  const freedBytes = toDelete.reduce((sum, r) => sum + sizeOf(r), 0);
  const deletedPaths = new Set(toDelete.map((r) => r.path));

  // 3) 孤児ファイルの回収（失敗しても上の削除結果は返す）。
  const orphans = await purgeOrphans(
    svc,
    spotListed.objects.filter((o) => !deletedPaths.has(o.path)),
  );

  const totalBytes = totalBytesBefore - freedBytes;
  return json({
    deleted: toDelete.length,
    freedBytes,
    totalBytes,
    protectedBytes,
    // 保護画像だけで300MB超 or 取り分の範囲では上限まで減らせなかった → 手動で確認する目印。
    warn_protected_over: protectedBytes > PROTECTED_WARN_BYTES,
    warn_over_limit: totalBytes > TOTAL_LIMIT_BYTES,
    dangling_rows_removed: danglingIds.length,
    orphans_removed: orphans.removed,
    orphans_error: orphans.error ?? null,
    skipped_suspicious_rows: skippedSuspicious,
  });
});
