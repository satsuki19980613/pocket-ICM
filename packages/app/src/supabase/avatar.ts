/**
 * プロフィールアイコンのアップロード（設定画面）。
 *
 * 元の解像度のまま上げると、34px / 88px でしか表示しないアイコンに数MBの画像を置くことになり、
 * 無料枠（Storage 1GB・§7）にも表示速度にも効いてくる。ここで**正方形に切り出して 256px へ縮小**し、
 * WebP へ再圧縮してから送る。元画像は端末外へ出さない（`images.ts` の圧縮方針と同じ）。
 *
 * 保存先は既存の `avatars` バケット（0004_storage.sql・public・2MB 上限・画像 MIME のみ）。
 * パス規約は `<uid>/<filename>` で、RLS が先頭フォルダ＝本人 uid のみ書き込み可にしている。
 * 追加の SQL は不要。表示は公開 URL（フィードで他のメンバーにも見えるため署名 URL は使わない）。
 *
 * パスは**毎回ユニーク**（`<uid>/<uuid>.<ext>`）にし、`upsert: false` で入れる。
 * 固定パス＋`upsert: true` は使わない: `avatars` バケットには select ポリシーが無く
 * （公開バケットなので読みは公開 URL 経路）、Storage の upsert は既存オブジェクトを見に行くため
 * RLS で弾かれて「アイコンをアップロードできませんでした」になる。既に動いている
 * `spot-images` / `thread-images` と同じ「ユニークパス＋upsert:false」に揃えてある。
 * URL が毎回変わるのでキャッシュ外しのクエリも要らず、差し替え後に前のファイルを消す。
 */

import { supabase } from './client';
import { extForMime } from './images';
import type { FnResult } from './api';

const BUCKET = 'avatars';

function fail(message: string): { ok: false; error: string; message: string } {
  return { ok: false, error: 'avatar_error', message };
}

async function currentUid(): Promise<string | null> {
  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}

// ---------------------------------------------------------------------------
// 純ロジック（単体テスト対象）
// ---------------------------------------------------------------------------

/** アイコンの一辺（px）。表示は最大 88px（設定画面）なので 3倍 DPR を見込んで 256 で足りる。 */
export const AVATAR_EDGE = 256;

/** 中央の最大正方形を切り出す矩形。長辺側を均等に落とす。 */
export function squareCropRect(w: number, h: number): { sx: number; sy: number; size: number } {
  const size = Math.max(1, Math.min(w, h));
  return { sx: Math.round((w - size) / 2), sy: Math.round((h - size) / 2), size };
}

/**
 * 出力する一辺。元が 256px より小さいときは**拡大しない**（引き伸ばしてぼやけるだけで、
 * ファイルサイズだけ増えるため）。
 */
export function avatarOutputEdge(sourceSquare: number, max = AVATAR_EDGE): number {
  return Math.max(1, Math.min(sourceSquare, max));
}

/**
 * 公開 URL から Storage のパス（`<uid>/<file>`）を取り出す。差し替え時に前のファイルを消すため。
 * 形が違う（別バケット・URL でない等）ときは null を返し、呼び出し側は削除をあきらめる
 * （消せなくてもアイコン自体は正しく差し替わる＝孤児が 1 個残るだけ）。
 */
export function avatarPathFromUrl(url: string | null): string | null {
  if (!url) return null;
  const marker = `/object/public/${BUCKET}/`;
  const i = url.indexOf(marker);
  if (i < 0) return null;
  const path = url.slice(i + marker.length).split('?')[0] ?? '';
  return path.length > 0 ? decodeURIComponent(path) : null;
}

// ---------------------------------------------------------------------------
// ブラウザ専用グルー（Canvas 圧縮）
// ---------------------------------------------------------------------------

const WEBP_QUALITY = 0.85;
const JPEG_QUALITY = 0.85;

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b && b.type === type ? b : null), type, quality);
  });
}

/**
 * File → アイコン用に正方形へ切り出して縮小した Blob。
 * WebP が作れない環境（Safari 旧版等）は JPEG にフォールバックする。
 */
export async function compressAvatar(file: File): Promise<{ blob: Blob; edge: number }> {
  const bitmap = await createImageBitmap(file);
  try {
    const { sx, sy, size } = squareCropRect(bitmap.width, bitmap.height);
    const edge = avatarOutputEdge(size);
    const canvas = document.createElement('canvas');
    canvas.width = edge;
    canvas.height = edge;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D Canvas コンテキストを取得できませんでした');
    ctx.drawImage(bitmap, sx, sy, size, size, 0, 0, edge, edge);

    const webp = await canvasToBlob(canvas, 'image/webp', WEBP_QUALITY);
    if (webp) return { blob: webp, edge };
    const jpeg = await canvasToBlob(canvas, 'image/jpeg', JPEG_QUALITY);
    if (jpeg) return { blob: jpeg, edge };
    throw new Error('画像を変換できませんでした');
  } finally {
    bitmap.close?.();
  }
}

/** 前のアイコンファイルを消す（失敗は無視＝孤児が 1 個残るだけで実害は無い）。 */
async function removeObject(path: string | null): Promise<void> {
  if (!path) return;
  try {
    await supabase.storage.from(BUCKET).remove([path]);
  } catch {
    /* noop */
  }
}

/**
 * アイコンを差し替える。圧縮 → Storage へ新規アップロード → `profiles.avatar_url` を更新 →
 * 前のファイルを削除。成功時は表示に使う URL を返す。
 */
export async function uploadAvatar(file: File): Promise<FnResult<{ avatar_url: string }>> {
  const uid = await currentUid();
  if (!uid) return fail('ログインしていません');

  let blob: Blob;
  try {
    ({ blob } = await compressAvatar(file));
  } catch {
    return fail('画像を読み込めませんでした（別の画像でお試しください）');
  }

  // 差し替え前の URL を先に控える（更新に成功したら消す）。
  const before = await supabase.from('profiles').select('avatar_url').eq('id', uid).single();
  const oldPath = avatarPathFromUrl((before.data as { avatar_url: string | null } | null)?.avatar_url ?? null);

  const path = `${uid}/${crypto.randomUUID()}.${extForMime(blob.type)}`;
  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(path, blob, { contentType: blob.type, upsert: false });
  if (upErr) return fail(`アイコンをアップロードできませんでした（${upErr.message}）`);

  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);
  const url = pub.publicUrl;
  const { error: dbErr } = await supabase.from('profiles').update({ avatar_url: url }).eq('id', uid);
  if (dbErr) {
    // 参照されないオブジェクトを残さない。
    await removeObject(path);
    return fail(`アイコンを保存できませんでした（${dbErr.message}）`);
  }

  await removeObject(oldPath);
  return { ok: true, data: { avatar_url: url } };
}

/** アイコンを消して頭文字表示に戻す。 */
export async function removeAvatar(): Promise<FnResult<Record<string, never>>> {
  const uid = await currentUid();
  if (!uid) return fail('ログインしていません');
  const before = await supabase.from('profiles').select('avatar_url').eq('id', uid).single();
  const oldPath = avatarPathFromUrl((before.data as { avatar_url: string | null } | null)?.avatar_url ?? null);

  const { error } = await supabase.from('profiles').update({ avatar_url: null }).eq('id', uid);
  if (error) return fail(`アイコンを削除できませんでした（${error.message}）`);
  await removeObject(oldPath);
  return { ok: true, data: {} };
}
