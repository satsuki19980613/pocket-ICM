/**
 * SIT & GO ロビーの HTTP API（部屋の作成・一覧）。docs/SNG_DESIGN.md §2。
 *
 * `supabase/api.ts` の `FnResult` に合わせる（Edge Function と同じ「成功/失敗」の形）。
 * 通信先は同一オリジンの `ROOMS_PATH`（開発は vite.config.ts の proxy、本番は Worker が
 * 同じドメインで受ける）。
 */

import { ROOMS_PATH, type CreateRoomResponse, type RoomsResponse, type SngConfig } from '@oshihiki/sng';

import type { FnResult } from '../supabase/api';
import { supabase } from '../supabase/client';

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T>(method: 'GET' | 'POST', body?: unknown): Promise<FnResult<T>> {
  let res: Response;
  try {
    res = await fetch(ROOMS_PATH, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(await authHeaders()),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    return { ok: false, error: 'network', message: '通信に失敗しました' };
  }
  let payload: Record<string, unknown> = {};
  try {
    payload = await res.json();
  } catch {
    /* 空ボディ */
  }
  if (!res.ok || payload.error) {
    const error = String(payload.error ?? `http_${res.status}`);
    return { ok: false, error, message: String(payload.message ?? MESSAGES[error] ?? 'エラーが発生しました') };
  }
  return { ok: true, data: payload as T };
}

/** サーバーのエラーコード → 利用者向けの文言（本番で 409 が「エラーが発生しました」としか出なかった）。 */
const MESSAGES: Record<string, string> = {
  already_seated: '別の部屋に参加中です。「参加中の部屋へ戻る」から戻れます',
  unauthorized: 'ログインし直してください',
  not_configured: 'サーバーの設定が終わっていません',
  bad_message: '入力が正しくありません',
  internal: 'サーバーで問題が起きました。少し待ってやり直してください',
};

/** POST /api/sng/rooms（部屋を作る。作成者は着席済みで返る）。 */
export async function createRoom(config: SngConfig): Promise<FnResult<CreateRoomResponse>> {
  return request<CreateRoomResponse>('POST', config);
}

/** GET /api/sng/rooms（募集中・進行中の一覧＋自分が居る部屋）。 */
export async function listRooms(): Promise<FnResult<RoomsResponse>> {
  return request<RoomsResponse>('GET');
}
