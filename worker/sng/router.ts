/**
 * SIT & GO の HTTP/WS 入口。`/api/sng/` 配下を Lobby/Table の Durable Object へ委譲する。
 * docs/SNG_DESIGN.md §2/§6（担当 A2 所有）。それ以外のパスには一切触らない。
 */
import { LOBBY_WS_PATH, ROOMS_PATH, ROOM_ID_RE, parseConfig } from '@oshihiki/sng';
import type { CreateRoomResponse, RoomSummary, RoomsResponse } from '@oshihiki/sng';

import type { Env } from './env';
import { verifyToken } from './auth';

const TABLE_WS_PREFIX = '/api/sng/table/';

/** 静的アセット配信を汚さないよう、既存の Slumbot 中継と同じヘッダー流儀に合わせる。 */
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function bearerToken(request: Request): string | null {
  const h = request.headers.get('authorization');
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m?.[1] ? m[1].trim() : null;
}

/** `/api/sng/table/<roomId>` からルーム ID を取り出す（形が違えば null）。純関数・テスト対象。 */
export function tableRoomIdFromPath(pathname: string): string | null {
  if (!pathname.startsWith(TABLE_WS_PREFIX)) return null;
  const roomId = pathname.slice(TABLE_WS_PREFIX.length);
  return ROOM_ID_RE.test(roomId) ? roomId : null;
}

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const ROOM_ID_LEN = 12;

/**
 * `sg_` + base36 12 文字。`ROOM_ID_RE`（`@oshihiki/sng`）を満たす。純関数・テスト対象
 * （`randomBytes` を注入できるようにして決定的にテストする）。
 * 256 % 36 ≠ 0 の偏りを避けるため、216 (=6*36) 以上のバイトは捨てる（棄却法）。
 */
export function genRoomId(randomBytes: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  let out = '';
  while (out.length < ROOM_ID_LEN) {
    const bytes = randomBytes(ROOM_ID_LEN);
    for (const b of bytes) {
      if (out.length >= ROOM_ID_LEN) break;
      if (b >= 216) continue;
      out += ALPHABET[b % 36];
    }
  }
  return `sg_${out}`;
}

function lobbyStub(env: Env): DurableObjectStub {
  return env.SNG_LOBBY.get(env.SNG_LOBBY.idFromName('lobby'));
}

function tableStub(env: Env, roomId: string): DurableObjectStub {
  return env.SNG_TABLE.get(env.SNG_TABLE.idFromName(roomId), { locationHint: 'apac' });
}

async function handleRooms(request: Request, env: Env): Promise<Response> {
  const token = bearerToken(request);
  if (!token) return json({ error: 'unauthorized' }, 401);
  const auth = await verifyToken(env, token);
  if (!auth) return json({ error: 'unauthorized' }, 401);

  if (request.method === 'GET') {
    const res = await lobbyStub(env).fetch(`https://do/internal/list?user=${encodeURIComponent(auth.userId)}`);
    if (!res.ok) return json({ error: 'internal' }, 502);
    const { rooms, mine } = (await res.json()) as { rooms: readonly RoomSummary[]; mine: string | null };
    const body: RoomsResponse = { rooms, mine, serverTime: Date.now() };
    return json(body, 200);
  }

  if (request.method === 'POST') {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return json({ error: 'bad_message' }, 400);
    }
    const config = parseConfig(raw);
    if (!config) return json({ error: 'bad_message' }, 400);

    // 衝突は 36^12 の空間なので天文学的にまれ。ロビーが 1人1部屋 を判定する。
    const roomId = genRoomId();
    const createRes = await lobbyStub(env).fetch('https://do/internal/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId, userId: auth.userId, name: auth.name, config }),
    });
    if (createRes.status === 409) {
      const err = (await createRes.json()) as { roomId?: string };
      return json({ error: 'already_seated', roomId: err.roomId ?? null }, 409);
    }
    if (!createRes.ok) return json({ error: 'internal' }, 502);

    const initRes = await tableStub(env, roomId).fetch('https://do/internal/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        roomId,
        hostId: auth.userId,
        hostName: auth.name,
        hostAvatarUrl: auth.avatarUrl,
        config,
        now: Date.now(),
      }),
    });
    if (!initRes.ok) {
      // 卓の初期化に失敗したらロビー登録を巻き戻す（1人1部屋の帳簿を狂わせない）。
      await lobbyStub(env).fetch('https://do/internal/release', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomId }),
      });
      return json({ error: 'internal' }, 502);
    }

    const body: CreateRoomResponse = { roomId };
    return json(body, 200);
  }

  return json({ error: 'method not allowed' }, 405);
}

function isWebSocketUpgrade(request: Request): boolean {
  return (request.headers.get('upgrade') ?? '').toLowerCase() === 'websocket';
}

/** `worker/index.ts` から `/api/sng/` 配下だけを渡してもらう入口。 */
export async function handleSng(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  // シークレット（SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY）が載っていない
  // Worker では認証も保存もできない。401 に紛れさせず 503 で「設定漏れ」と分かるようにする
  // （2026-09-15 の本番初回デプロイで、ダッシュボードの登録が反映されておらず 401 の原因調査に
  // 手間取ったため）。
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: 'not_configured', message: 'Worker secrets are missing (see DEPLOY.md)' }, 503);
  }

  if (url.pathname === ROOMS_PATH) {
    return handleRooms(request, env);
  }

  if (url.pathname === LOBBY_WS_PATH) {
    if (!isWebSocketUpgrade(request)) return json({ error: 'upgrade required' }, 426);
    return lobbyStub(env).fetch(request);
  }

  const roomId = tableRoomIdFromPath(url.pathname);
  if (roomId) {
    if (!isWebSocketUpgrade(request)) return json({ error: 'upgrade required' }, 426);
    return tableStub(env, roomId).fetch(request);
  }

  return json({ error: 'not found' }, 404);
}
