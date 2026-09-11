/**
 * Storage の画像（スレッド画像・アイコン）を「このアプリが上げた画像だけ」「メンバーだけ」に
 * 見せるための部品（2026-09-11 セキュリティ強化・supabase/migrations/0008_security.sql と対）。
 *
 * - DB（threads/comments.image_url・profiles.avatar_url）には、アップロード時の公開 URL 形式の
 *   文字列が「どのファイルか」を指す参照として入っている。表示前に必ず形を検証し、このアプリ自身が
 *   作った形（`<Supabase URL>/storage/v1/object/public/<bucket>/<uid>/<uuid>.<ext>`）以外は表示しない。
 *   `javascript:` や外部サイトの URL をリンク・画像にしないため（DB 側にも同じ形の制約がある）。
 * - バケットは非公開。表示は期限付きの署名 URL（1時間）。同じ描画で要る分をまとめて署名し、期限まで使い回す。
 * - 署名できなかったときは公開 URL を使う（0008 適用前＝バケットがまだ公開の間の移行用。適用後は
 *   署名できない＝見る権限が無いので、公開 URL も表示されない）。
 */
import { useEffect, useState } from 'react';

import { supabase, SUPABASE_URL } from './client';

export type ImageBucket = 'thread-images' | 'avatars';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PATH_RE = new RegExp(`^${UUID}/${UUID}\\.(png|jpg|webp)$`);
/**
 * 2026-09 初めの版（e1f1dce）が保存したアイコンの形 `<uid>/avatar.(webp|jpg)?v=<数字>`。
 * その版で設定したまま変えていない人のアイコンを表示し続けるために、アイコンだけ認める
 * （DB の制約 0008 も同じ形を認めている）。
 */
const LEGACY_AVATAR_RE = new RegExp(`^${UUID}/avatar\\.(webp|jpg)$`);

function publicPrefix(bucket: ImageBucket, base: string): string {
  return `${base.replace(/\/+$/, '')}/storage/v1/object/public/${bucket}/`;
}

/**
 * DB の画像参照 → バケット内のパス（`<uid>/<uuid>.<ext>`）。このアプリの Supabase の、
 * 指定バケットの、規約どおりのファイル名でなければ null（＝表示しない）。
 */
export function storagePathFromRef(
  ref: string | null | undefined,
  bucket: ImageBucket,
  base: string = SUPABASE_URL,
): string | null {
  if (!ref || !base) return null;
  const prefix = publicPrefix(bucket, base);
  if (!ref.startsWith(prefix)) return null;
  const path = ref.slice(prefix.length);
  if (PATH_RE.test(path)) return path;
  if (bucket === 'avatars') {
    const legacy = path.replace(/\?v=[0-9]+$/, '');
    if (LEGACY_AVATAR_RE.test(legacy)) return legacy;
  }
  return null;
}

/** パス → 公開 URL 形式（移行期間のフォールバック表示用）。 */
export function publicUrlOf(bucket: ImageBucket, path: string, base: string = SUPABASE_URL): string {
  return publicPrefix(bucket, base) + path;
}

/** 署名 URL の有効期間（秒）。 */
export const SIGN_TTL_SEC = 60 * 60;
/** 期限のこれだけ前になったら取り直す。 */
const REFRESH_MARGIN_MS = 5 * 60_000;
/** 署名に失敗したとき、次に取り直すまでの間隔。 */
const RETRY_AFTER_MS = 60_000;
/**
 * 表示中の画像の URL を見直す間隔。期限内ならキャッシュを返すだけ（通信しない）で、期限が近ければ
 * 取り直す。開いたままの画面で「原寸を開く」リンクが期限切れにならないように、取り直しの余裕
 * （REFRESH_MARGIN_MS）より短くする。
 */
const REFRESH_CHECK_MS = 4 * 60_000;

/** まとめて署名する関数（パス → 署名 URL。署名できなかったパスは含めない）。 */
export type Signer = (bucket: ImageBucket, paths: string[], ttlSec: number) => Promise<Map<string, string>>;

export interface SignedUrlResolver {
  /** 署名 URL（期限内ならキャッシュ）。同じ tick の要求はまとめて1回で署名する。 */
  get(bucket: ImageBucket, path: string): Promise<string>;
  /** キャッシュにある期限内の URL（無ければ null）。描画のちらつきを防ぐ。 */
  peek(bucket: ImageBucket, path: string): string | null;
}

export function createSignedUrlResolver(opts: {
  signer: Signer;
  base?: string;
  now?: () => number;
  schedule?: (fn: () => void) => void;
}): SignedUrlResolver {
  const now = opts.now ?? Date.now;
  const schedule = opts.schedule ?? ((fn: () => void) => void setTimeout(fn, 0));
  const base = opts.base ?? SUPABASE_URL;
  const cache = new Map<string, { url: string; expiresAt: number; signed: boolean }>();
  const inflight = new Map<string, Promise<string>>();
  let queue = new Map<ImageBucket, Map<string, (url: string) => void>>();
  let scheduled = false;

  const keyOf = (bucket: ImageBucket, path: string): string => `${bucket}/${path}`;

  function peek(bucket: ImageBucket, path: string): string | null {
    const hit = cache.get(keyOf(bucket, path));
    return hit && hit.expiresAt - REFRESH_MARGIN_MS > now() ? hit.url : null;
  }

  async function flush(): Promise<void> {
    scheduled = false;
    const batches = queue;
    queue = new Map();
    for (const [bucket, waiters] of batches) {
      const paths = [...waiters.keys()];
      let signed = new Map<string, string>();
      try {
        signed = await opts.signer(bucket, paths, SIGN_TTL_SEC);
      } catch {
        // 下でフォールバック（公開 URL）に落とす。
      }
      for (const path of paths) {
        const s = signed.get(path);
        const prev = cache.get(keyOf(bucket, path));
        // 取り直しに失敗したときは、表示中の署名 URL をそのまま使い続ける（公開 URL に替えると
        // 非公開バケットでは壊れた画像になる）。公開 URL は一度も署名できていないときだけ（移行期間用）。
        const url = s ?? (prev?.signed ? prev.url : publicUrlOf(bucket, path, base));
        const ttlMs = s ? SIGN_TTL_SEC * 1000 : RETRY_AFTER_MS + REFRESH_MARGIN_MS;
        cache.set(keyOf(bucket, path), { url, expiresAt: now() + ttlMs, signed: s !== undefined || !!prev?.signed });
        inflight.delete(keyOf(bucket, path));
        waiters.get(path)?.(url);
      }
    }
  }

  function get(bucket: ImageBucket, path: string): Promise<string> {
    const fresh = peek(bucket, path);
    if (fresh) return Promise.resolve(fresh);
    const key = keyOf(bucket, path);
    const running = inflight.get(key);
    if (running) return running;
    const p = new Promise<string>((resolve) => {
      let waiters = queue.get(bucket);
      if (!waiters) {
        waiters = new Map();
        queue.set(bucket, waiters);
      }
      waiters.set(path, resolve);
    });
    inflight.set(key, p);
    if (!scheduled) {
      scheduled = true;
      schedule(() => void flush());
    }
    return p;
  }

  return { get, peek };
}

const supabaseSigner: Signer = async (bucket, paths, ttlSec) => {
  const out = new Map<string, string>();
  const { data, error } = await supabase.storage.from(bucket).createSignedUrls(paths, ttlSec);
  if (error || !data) return out;
  for (const d of data) {
    if (!d.error && d.path && d.signedUrl) out.set(d.path, d.signedUrl);
  }
  return out;
};

const resolver = createSignedUrlResolver({ signer: supabaseSigner });

/**
 * 画像参照 → 表示してよい URL（署名 URL）。形が不正なら常に null（＝表示しない）。
 * 署名が済むまでは null（キャッシュにあれば最初から URL）。
 */
export function useStorageImage(ref: string | null | undefined, bucket: ImageBucket): string | null {
  const path = storagePathFromRef(ref, bucket);
  const [url, setUrl] = useState<string | null>(() => (path ? resolver.peek(bucket, path) : null));
  useEffect(() => {
    if (!path) {
      setUrl(null);
      return;
    }
    let alive = true;
    const load = (): void => {
      void resolver.get(bucket, path).then((u) => {
        if (alive) setUrl(u);
      });
    };
    setUrl(resolver.peek(bucket, path));
    load();
    const timer = window.setInterval(load, REFRESH_CHECK_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [bucket, path]);
  return path ? url : null;
}
