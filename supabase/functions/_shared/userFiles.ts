// Storage のファイル掃除（アカウント削除・孤児ファイルの回収・容量判定）。
// supabase-js に依存しない最小インターフェースで書き、Node の単体テスト（Vitest）から偽物を渡して検証する。
// Edge Function からは `svc.storage as unknown as StorageLike` で渡す。

/** 使う分だけを写した Storage の最小インターフェース（supabase-js の StorageFileApi 相当）。 */
export interface StorageLike {
  from(bucket: string): {
    list(
      prefix: string,
      opts: { limit: number; offset: number },
    ): Promise<{
      data:
        | {
            name: string;
            id: string | null;
            created_at?: string | null;
            metadata?: { size?: number | null } | null;
          }[]
        | null;
      error: { message: string } | null;
    }>;
    remove(paths: string[]): Promise<{ data: unknown; error: { message: string } | null }>;
  };
}

/** 利用者ごとの `<uid>/` フォルダを持つバケット（パス規約 `<uid>/<uuid>.<ext>`）。 */
export const USER_BUCKETS = ['spot-images', 'thread-images', 'avatars'] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$/;

/** list の1ページ。 */
const PAGE = 100;

export interface StoredObject {
  /** バケット内のパス（`<uid>/<file>`）。 */
  readonly path: string;
  /** Storage が記録した作成時刻（利用者が書ける DB の値ではない）。 */
  readonly createdAt: string | null;
  /** Storage が記録した実際の大きさ（バイト）。不明なら null。 */
  readonly size: number | null;
}

type Entry = { name: string; created_at?: string | null; metadata?: { size?: number | null } | null };
type ListResult = { objects: StoredObject[] } | { error: string };

/**
 * フォルダ直下を全部列挙する（ページング）。`folders=true` ならサブフォルダ名だけ、
 * false ならファイルだけを返す（Storage はフォルダを id=null の行で返す）。
 */
async function listEntries(
  storage: StorageLike,
  bucket: string,
  prefix: string,
  folders: boolean,
): Promise<{ entries: Entry[] } | { error: string }> {
  const entries: Entry[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await storage.from(bucket).list(prefix, { limit: PAGE, offset });
    if (error || !data) return { error: `${bucket}/${prefix} を列挙できませんでした: ${error?.message ?? 'no data'}` };
    for (const e of data) {
      if ((e.id === null) === folders) entries.push(e);
    }
    if (data.length < PAGE) return { entries };
  }
}

function toObject(prefix: string, e: Entry): StoredObject {
  const size = e.metadata?.size;
  return {
    path: `${prefix}/${e.name}`,
    createdAt: e.created_at ?? null,
    size: typeof size === 'number' && Number.isFinite(size) ? size : null,
  };
}

/** 1人分のフォルダ（`<uid>/`）のファイルを全部列挙する。 */
export async function listUserObjects(storage: StorageLike, bucket: string, uid: string): Promise<ListResult> {
  const r = await listEntries(storage, bucket, uid, false);
  if ('error' in r) return r;
  return { objects: r.entries.map((e) => toObject(uid, e)) };
}

/** バケット全体（全員の `<uid>/` フォルダ）のファイルを列挙する。 */
export async function listAllObjects(storage: StorageLike, bucket: string): Promise<ListResult> {
  const top = await listEntries(storage, bucket, '', true);
  if ('error' in top) return top;
  const objects: StoredObject[] = [];
  for (const folder of top.entries) {
    const r = await listUserObjects(storage, bucket, folder.name);
    if ('error' in r) return r;
    objects.push(...r.objects);
  }
  return { objects };
}

/** パスをまとめて消す（1回あたり PAGE 件ずつ）。 */
export async function removePaths(
  storage: StorageLike,
  bucket: string,
  paths: string[],
): Promise<{ removed: number } | { error: string }> {
  let removed = 0;
  for (let i = 0; i < paths.length; i += PAGE) {
    const chunk = paths.slice(i, i + PAGE);
    const { error } = await storage.from(bucket).remove(chunk);
    if (error) return { error: `${bucket} のファイルを消せませんでした: ${error.message}` };
    removed += chunk.length;
  }
  return { removed };
}

/**
 * アカウント削除時に、その人のファイル本体を全バケットから消す。
 * DB の連鎖削除（profiles → images 行など）では Storage のファイル本体は消えないため。
 * 列挙してから消す（消しながらページングすると offset がずれて取りこぼすため）。
 * 途中で失敗したらそこで止めてエラーを返す（呼び出し側はアカウントを消さずに再試行を促す）。
 */
export async function removeUserFiles(
  storage: StorageLike,
  uid: string,
): Promise<{ removed: number } | { error: string }> {
  if (!UUID_RE.test(uid)) return { error: 'uid の形が不正です' };
  let removed = 0;
  for (const bucket of USER_BUCKETS) {
    const listed = await listUserObjects(storage, bucket, uid);
    if ('error' in listed) return listed;
    const r = await removePaths(
      storage,
      bucket,
      listed.objects.map((o) => o.path),
    );
    if ('error' in r) return r;
    removed += r.removed;
  }
  return { removed };
}

/**
 * DB に保存された画像の参照（`…/object/public/<bucket>/<uid>/<uuid>.<ext>`）から、
 * バケット内のパスを取り出す。形が違えば null。
 */
export function pathFromRef(ref: string | null | undefined, bucket: string): string | null {
  if (!ref) return null;
  const marker = `/storage/v1/object/public/${bucket}/`;
  const i = ref.indexOf(marker);
  if (i < 0) return null;
  const path = ref.slice(i + marker.length);
  const [uid, file, ...rest] = path.split('/');
  if (rest.length > 0 || !uid || !file) return null;
  return UUID_RE.test(uid) && FILE_RE.test(file) ? path : null;
}

/**
 * 孤児判定用: DB の参照が指すパスを「形を問わず」取り出す（クエリは落とす）。
 * 表示用の pathFromRef と違い、多少形が違う古い参照でも「参照中」として守るため（誤って消さない側に倒す）。
 */
export function referencedPathFromRef(ref: string | null | undefined, bucket: string): string | null {
  if (!ref) return null;
  const marker = `/storage/v1/object/public/${bucket}/`;
  const i = ref.indexOf(marker);
  if (i < 0) return null;
  const raw = ref.slice(i + marker.length).split(/[?#]/)[0] ?? '';
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * どこからも参照されていない古いファイル（孤児）を選ぶ。
 * アップロード直後で DB 行がまだ無いだけのファイルを消さないよう、`minAgeMs` より新しいものは残す。
 * 作成時刻が分からないものも安全側で残す。
 */
export function findOrphans(
  objects: readonly StoredObject[],
  referenced: ReadonlySet<string>,
  nowMs: number,
  minAgeMs: number,
): string[] {
  const out: string[] = [];
  for (const o of objects) {
    if (referenced.has(o.path)) continue;
    if (!o.createdAt) continue;
    const t = Date.parse(o.createdAt);
    if (!Number.isFinite(t) || nowMs - t < minAgeMs) continue;
    out.push(o.path);
  }
  return out;
}
