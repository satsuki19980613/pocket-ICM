// Edge Function 共通ユーティリティ（Deno ランタイム）。
// 版は固定する（`@2` のままだとデプロイのたびに最新の 2.x を取りに行き、中身が勝手に変わる）。
// アプリ（packages/app）と同じ版に揃える。
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.115.0';

// synthetic email のドメイン。メール送信はしない（email_confirm=true で確定）。
// handle をローカル部にして「handle@…」を Supabase Auth の識別子にする。
export const EMAIL_DOMAIN = 'users.pocket-icm.app';

// 曖昧文字（0/O/1/I/L）を除いた英大文字＋数字。招待キー生成に使う。
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

// service_role クライアント（RLS 迂回）。関数内で権限を必ず自前検証すること。
export function serviceClient(): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

// リクエストの Authorization: Bearer <jwt> から呼び出しユーザーを解決。
export async function getCaller(
  req: Request,
): Promise<{ id: string; token: string } | null> {
  const auth = req.headers.get('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  const svc = serviceClient();
  const { data, error } = await svc.auth.getUser(token);
  if (error || !data.user) return null;
  return { id: data.user.id, token };
}

// 呼び出しユーザーが管理者か（profiles.is_admin）。
export async function isAdmin(svc: SupabaseClient, uid: string): Promise<boolean> {
  const { data, error } = await svc
    .from('profiles')
    .select('is_admin')
    .eq('id', uid)
    .single();
  if (error || !data) return false;
  return data.is_admin === true;
}

// 招待キーの正規化: 大文字化して英数字以外を除去（ダッシュ/小文字/空白を許容）。
export function normalizeCode(raw: string): string {
  return (raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// SHA-256 hex（正規化キーのハッシュ = DB 保存値）。
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// 招待キーの生成: POCKET-XXXX-XXXX（曖昧文字なし・暗号乱数）。
export function generateInviteCode(): string {
  const rnd = new Uint32Array(8);
  crypto.getRandomValues(rnd);
  const chars = [...rnd].map((n) => CODE_ALPHABET[n % CODE_ALPHABET.length]);
  return `POCKET-${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}`;
}

// 非機密の短い識別子（管理一覧で未使用キーを見分ける用）。
export function generateRef(): string {
  const rnd = new Uint8Array(2);
  crypto.getRandomValues(rnd);
  return [...rnd].map((b) => b.toString(16).padStart(2, '0')).join('');
}
