/**
 * プロフィールアイコンのアップロード（設定画面）。
 *
 * 元の解像度のまま上げると、34px / 88px でしか表示しないアイコンに数MBの画像を置くことになり、
 * 無料枠（Storage 1GB・§7）にも表示速度にも効いてくる。ここで**正方形に切り出して 256px へ縮小**し、
 * WebP へ再圧縮してから送る。元画像は端末外へ出さない（`images.ts` の圧縮方針と同じ）。
 *
 * 保存先は既存の `avatars` バケット（0004_storage.sql・public・2MB 上限・画像 MIME のみ）。
 * パス規約は `<uid>/<filename>` で、RLS が先頭フォルダ＝本人 uid のみ書き込み可にしている。
 * 追加の SQL は不要。
 *
 * 表示は公開 URL（フィードで他のメンバーにも見える必要があるため署名 URL は使わない）。
 * パスを固定して上書きするので、URL に `?v=<epoch>` を付けてキャッシュを外す。
 */

import { supabase } from './client';
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

/** MIME → 保存ファイル名。パスを固定し、上書き（upsert）で世代を増やさない。 */
export function avatarFileName(mime: string): string {
  return mime === 'image/jpeg' ? 'avatar.jpg' : 'avatar.webp';
}

/** 公開 URL にキャッシュ外しのクエリを付ける（パス固定＝URL が変わらないため）。 */
export function withCacheBuster(url: string, version: number): string {
  return `${url}${url.includes('?') ? '&' : '?'}v=${version}`;
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

/**
 * アイコンを差し替える。圧縮 → Storage へ上書き → `profiles.avatar_url` を更新。
 * 成功時は表示に使う URL（キャッシュ外し付き）を返す。
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

  const name = avatarFileName(blob.type);
  const path = `${uid}/${name}`;
  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(path, blob, { contentType: blob.type, upsert: true, cacheControl: '3600' });
  if (upErr) return fail('アイコンをアップロードできませんでした');

  // WebP と JPEG を行き来したときに前の形式が残らないよう、もう一方は消しておく（失敗は無視）。
  const other = name === 'avatar.webp' ? 'avatar.jpg' : 'avatar.webp';
  await supabase.storage.from(BUCKET).remove([`${uid}/${other}`]).catch(() => undefined);

  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);
  const url = withCacheBuster(pub.publicUrl, Date.now());
  const { error: dbErr } = await supabase.from('profiles').update({ avatar_url: url }).eq('id', uid);
  if (dbErr) return fail('アイコンを保存できませんでした');
  return { ok: true, data: { avatar_url: url } };
}

/** アイコンを消して頭文字表示に戻す。 */
export async function removeAvatar(): Promise<FnResult<Record<string, never>>> {
  const uid = await currentUid();
  if (!uid) return fail('ログインしていません');
  await supabase.storage.from(BUCKET).remove([`${uid}/avatar.webp`, `${uid}/avatar.jpg`]).catch(() => undefined);
  const { error } = await supabase.from('profiles').update({ avatar_url: null }).eq('id', uid);
  if (error) return fail('アイコンを削除できませんでした');
  return { ok: true, data: {} };
}
