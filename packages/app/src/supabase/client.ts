// Supabase クライアント（フロント）。anon key のみ使用（秘密鍵はフロントに置かない）。
// 値は .env.local（gitignore）から Vite が注入する。未設定なら isConfigured=false。
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

// synthetic email のドメイン（Edge Function の EMAIL_DOMAIN と一致させる）。
export const EMAIL_DOMAIN = 'users.pocket-icm.app';

export const isConfigured = Boolean(url && anonKey);

export const SUPABASE_URL = url ?? '';
export const SUPABASE_ANON_KEY = anonKey ?? '';

// isConfigured=false のときはダミー値でクライアントを作る（呼ぶと失敗する＝設定漏れを明示）。
export const supabase: SupabaseClient = createClient(
  url ?? 'http://localhost:54321',
  anonKey ?? 'anon-key-not-set',
  { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } },
);

export function handleToEmail(handle: string): string {
  return `${handle.trim().toLowerCase()}@${EMAIL_DOMAIN}`;
}
