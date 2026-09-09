/**
 * 解析元スクショの圧縮アップロード（SPEC v3 §7.2 / §9.3, BETA_PLAN WP-B2）。
 *
 * - `compressForUpload` は Canvas 依存のブラウザ専用グルー（`ocr/decodeImage.ts` と同じ流儀）。
 *   サイズ計算だけを純関数 `fitWithin` に切り出し、Vitest でテストする。
 * - `spot-images` バケットは private（§8）。表示は署名 URL のみ（公開 URL は使わない）。
 * - **アップロード失敗はアプリを止めない**: 呼び出し側（App.tsx 側, WP-C）は
 *   `uploadSpotImage` が失敗を返しても計算・記録を続行し、`results.image_id` を
 *   null のままにする（この方針のため、失敗時に例外は投げず FnResult で返す）。
 */

import { supabase } from './client';
import type { FnResult } from './api';

function fail(message: string): { ok: false; error: string; message: string } {
  return { ok: false, error: 'image_error', message };
}

async function currentUid(): Promise<string | null> {
  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}

// ---------------------------------------------------------------------------
// 純ロジック（単体テスト対象）
// ---------------------------------------------------------------------------

/** 長辺を `max` 以内に収める幅・高さ（アスペクト比維持, 四捨五入）。すでに収まっていれば元のまま。 */
export function fitWithin(w: number, h: number, max: number): { width: number; height: number } {
  if (w <= max && h <= max) return { width: w, height: h };
  const scale = w >= h ? max / w : max / h;
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/** MIME → 拡張子（Storage のパス組み立て用）。未知の MIME は 'webp' 扱い（起こらない想定）。 */
export function extForMime(mime: string): string {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/png') return 'png';
  return 'webp';
}

// ---------------------------------------------------------------------------
// ブラウザ専用グルー（Canvas 圧縮）
// ---------------------------------------------------------------------------

/** 長辺の上限（§7.2）。 */
const MAX_EDGE = 1600;
const WEBP_QUALITY = 0.8;
const JPEG_QUALITY = 0.85;

/**
 * canvas.toBlob の Promise 化。要求した `type` で作れなかった場合（WebP 非対応環境は
 * 多くのブラウザが黙って PNG にフォールバックする）は null を返し、呼び出し側で
 * JPEG フォールバックへ回せるようにする。
 */
function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b && b.type === type ? b : null), type, quality);
  });
}

/**
 * スクショ（File）→ アップロード用に圧縮した Blob（§7.2: 長辺1600px以内・WebP q0.8、
 * 目標300KB以下）。WebP が作れない環境（Safari 旧版等）は JPEG q0.85 にフォールバックする。
 * 元のスクショ（無圧縮）は端末外へ送らない＝ここで作った Blob だけを送信する。
 */
export async function compressForUpload(file: File): Promise<{ blob: Blob; width: number; height: number }> {
  const bitmap = await createImageBitmap(file);
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height, MAX_EDGE);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D Canvas コンテキストを取得できませんでした');
    ctx.drawImage(bitmap, 0, 0, width, height);

    const webp = await canvasToBlob(canvas, 'image/webp', WEBP_QUALITY);
    if (webp) return { blob: webp, width, height };
    const jpeg = await canvasToBlob(canvas, 'image/jpeg', JPEG_QUALITY);
    if (!jpeg) throw new Error('画像の圧縮に失敗しました');
    return { blob: jpeg, width, height };
  } finally {
    bitmap.close();
  }
}

// ---------------------------------------------------------------------------
// Supabase 配線（薄い配線に留め、判断ロジックは持たない）
// ---------------------------------------------------------------------------

const SPOT_IMAGE_TTL_DAYS = 90;

export interface UploadSpotImageMeta {
  width: number;
  height: number;
}

/**
 * 圧縮済み Blob を `spot-images/<uid>/<uuid>.<ext>` へアップロードし、`images` 行を作る。
 * 既定は「OCR 成功画像」として 90 日後に失効（§7.2）。OCR 失敗・低信頼画像は呼び出し側が
 * 続けて `markImageProtected` を呼び、無期限保持へ切り替える。
 */
export async function uploadSpotImage(
  blob: Blob,
  meta: UploadSpotImageMeta,
): Promise<FnResult<{ imageId: string; path: string }>> {
  const uid = await currentUid();
  if (!uid) return fail('ログインしていません');

  const path = `${uid}/${crypto.randomUUID()}.${extForMime(blob.type)}`;
  const { error: upErr } = await supabase.storage.from('spot-images').upload(path, blob, {
    contentType: blob.type,
    upsert: false,
  });
  if (upErr) return fail('画像のアップロードに失敗しました');

  const expiresAt = new Date(Date.now() + SPOT_IMAGE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('images')
    .insert({
      owner: uid,
      kind: 'spot',
      bucket: 'spot-images',
      path,
      bytes: blob.size,
      width: meta.width,
      height: meta.height,
      mime: blob.type,
      expires_at: expiresAt,
      protected: false,
    })
    .select('id')
    .single();
  if (error || !data) {
    // DB 行が作れなかった場合、孤児化した Storage オブジェクトを掃除する。
    await supabase.storage.from('spot-images').remove([path]).catch(() => {});
    return fail('画像の登録に失敗しました');
  }
  return { ok: true, data: { imageId: (data as { id: string }).id, path } };
}

/** OCR 失敗・低信頼画像を無期限保持に切り替える（§7.2・§12: OCR 強化の資産として保持）。 */
export async function markImageProtected(imageId: string): Promise<FnResult<Record<string, never>>> {
  const { error } = await supabase
    .from('images')
    .update({ expires_at: null, protected: true })
    .eq('id', imageId);
  if (error) return fail('画像の保護設定に失敗しました');
  return { ok: true, data: {} };
}

/**
 * 記録の削除に伴う画像削除（SPEC §5.4 の連鎖削除）。ただし **`protected` の画像は消さない**。
 * 保護画像＝OCR が読めなかった／低信頼だった画像で、精度改善の資産として無期限保持する対象
 * （§7.2・§12）。保持することは設定画面の「保存について」で利用者に明示する。
 * 画像行が消えても `ocr_reads.image_id` は `on delete set null` なので解析ログは残る。
 */
export async function deleteSpotImageUnlessProtected(
  imageId: string,
): Promise<FnResult<{ deleted: boolean }>> {
  const { data, error } = await supabase
    .from('images')
    .select('bucket, path, protected')
    .eq('id', imageId)
    .single();
  if (error || !data) return fail('画像情報を取得できませんでした');
  const row = data as { bucket: string; path: string; protected: boolean };
  if (row.protected) return { ok: true, data: { deleted: false } };

  // Storage の削除に失敗しても DB 行は消す（孤児オブジェクトは purge-images の総量上限側で回収）。
  await supabase.storage.from(row.bucket).remove([row.path]);
  const del = await supabase.from('images').delete().eq('id', imageId);
  if (del.error) return fail('画像を削除できませんでした');
  return { ok: true, data: { deleted: true } };
}

/** private バケット `spot-images` の署名 URL（既定 60 秒）。表示のたびに取り直す想定。 */
export async function signedSpotImageUrl(path: string, sec = 60): Promise<FnResult<{ url: string }>> {
  const { data, error } = await supabase.storage.from('spot-images').createSignedUrl(path, sec);
  if (error || !data) return fail('画像の表示 URL を取得できませんでした');
  return { ok: true, data: { url: data.signedUrl } };
}
