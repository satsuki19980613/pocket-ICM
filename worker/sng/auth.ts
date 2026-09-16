/**
 * SIT & GO の認証。Supabase の JWT を検証してユーザーを特定する。
 *
 * Worker には JWT の秘密鍵を置かない（docs/SNG_DESIGN.md §2）。まず anon key で
 * `GET /auth/v1/user` に問い合わせて本人確認し、続けて**本人の権限**（anon key + 同じ Bearer）で
 * `profiles` を読んで表示名を得る。service role はここでは一切使わない
 * （0008_security.sql の is_member ゲートを、本人の JWT でそのまま通す形）。
 *
 * プロフィール行が無い（＝招待で入ったメンバーではない）場合は、RLS で読めず空配列が返るので
 * unauthorized 扱いにする。
 */
import type { Env } from './env';

const TIMEOUT_MS = 5_000;

export interface AuthedUser {
  readonly userId: string;
  readonly name: string;
  /** profiles.avatar_url（アイコン画像の参照）。未設定なら null。 */
  readonly avatarUrl: string | null;
  /** profiles.frame_color（アバター枠の色。avatarDeco.ts と同じ列挙）。未取得なら null。 */
  readonly frameColor: string | null;
  /** profiles.special_frame（特別枠。管理者付与が無ければ null）。 */
  readonly specialFrame: string | null;
  /** profiles.badge（管理者付与のバッジ。無ければ null）。 */
  readonly badge: string | null;
}

async function fetchWithTimeout(url: string, headers: Record<string, string>, ms: number): Promise<Response | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { headers, signal: ctl.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyToken(env: Env, token: string): Promise<AuthedUser | null> {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return null;
  const authHeaders = { apikey: env.SUPABASE_ANON_KEY, authorization: `Bearer ${token}` };

  const userRes = await fetchWithTimeout(`${env.SUPABASE_URL}/auth/v1/user`, authHeaders, TIMEOUT_MS);
  if (!userRes || !userRes.ok) return null;

  let userId: string;
  try {
    const body = (await userRes.json()) as { id?: unknown };
    if (typeof body.id !== 'string' || body.id.length === 0) return null;
    userId = body.id;
  } catch {
    return null;
  }

  const profileRes = await fetchWithTimeout(
    `${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=display_name,avatar_url,frame_color,special_frame,badge`,
    authHeaders,
    TIMEOUT_MS,
  );
  if (!profileRes || !profileRes.ok) return null;

  try {
    const rows = (await profileRes.json()) as ReadonlyArray<{
      display_name?: unknown;
      avatar_url?: unknown;
      frame_color?: unknown;
      special_frame?: unknown;
      badge?: unknown;
    }>;
    const name = rows[0]?.display_name;
    if (typeof name !== 'string' || name.length === 0) return null;
    // avatar_url/frame_color/special_frame/badge はどれも無くても認証自体は成立させる
    // （アイコン・枠・バッジが無いだけの利用者なので落とさない。文字列以外は null に丸める）。
    const rawAvatar = rows[0]?.avatar_url;
    const avatarUrl = typeof rawAvatar === 'string' && rawAvatar.length > 0 ? rawAvatar : null;
    const rawFrame = rows[0]?.frame_color;
    const frameColor = typeof rawFrame === 'string' && rawFrame.length > 0 ? rawFrame : null;
    const rawSpecial = rows[0]?.special_frame;
    const specialFrame = typeof rawSpecial === 'string' && rawSpecial.length > 0 ? rawSpecial : null;
    const rawBadge = rows[0]?.badge;
    const badge = typeof rawBadge === 'string' && rawBadge.length > 0 ? rawBadge : null;
    return { userId, name, avatarUrl, frameColor, specialFrame, badge };
  } catch {
    return null;
  }
}
