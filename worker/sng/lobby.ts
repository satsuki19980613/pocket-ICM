/**
 * SngLobby（Durable Object・単一インスタンス "lobby"）。docs/SNG_DESIGN.md §2/§6。
 *
 * 待機中・進行中の部屋の一覧と「1 人 1 部屋」を管理する。状態は `ctx.storage` の 2 キーだけ
 * （メモリに持たない。Hibernation で消える）: `rooms`（roomId → RoomSummary + hostId）と
 * `userRoom`（userId → roomId）。Table DO から `/internal/*` で更新を受ける。
 *
 * WebSocket は Hibernation API（`ctx.acceptWebSocket`）。接続ごとの認証状態は
 * `serializeAttachment` に持つ（DO が眠って起きても復元される）。最初のメッセージは必ず
 * `auth`。5 秒以内に来なければ閉じる（`wsAuth.ts` が Alarm ベースで面倒を見る）。
 */
import { parseClientMsg } from '@oshihiki/sng';
import type { LobbyServerMsg, RoomSummary, SngConfig } from '@oshihiki/sng';

import type { Env } from './env';
import { verifyToken } from './auth';
import { addAuthDeadline, clearAuthDeadline, earliestAuthDeadline, getAttachment, send, sweepExpired } from './wsAuth';
import type { ConnAttachment } from './wsAuth';

interface RoomEntry extends RoomSummary {
  readonly hostId: string;
}

interface LobbyStorage {
  rooms: Record<string, RoomEntry>;
  userRoom: Record<string, string>;
}

const TAG = 'sng-lobby';

// ---------------------------------------------------------------------------
// 純関数（テスト対象）: userRoom マップの更新ロジック。
//
// 「1 人 1 部屋」は元々 `/internal/create`（部屋作成時）でしか userRoom に登録していなかった
// ため、参加者（ホスト以外）が WS で直接別の部屋に join しても弾かれない穴があった
// （2026-09-15 QA で発見）。`/internal/seat` を「join のたびに毎回」呼ぶことで、参加者も
// 同じ台帳に載せる。
// ---------------------------------------------------------------------------

export type SeatResult = { readonly ok: true; readonly userRoom: Record<string, string> } | { readonly ok: false; readonly roomId: string };

/** userId を roomId に登録する。別の部屋に既に登録済みなら拒否（その roomId を返す）。同じ部屋なら何もしない（冪等）。 */
export function seatUser(userRoom: Readonly<Record<string, string>>, userId: string, roomId: string): SeatResult {
  const existing = userRoom[userId];
  if (existing !== undefined && existing !== roomId) {
    return { ok: false, roomId: existing };
  }
  if (existing === roomId) {
    return { ok: true, userRoom: userRoom as Record<string, string> };
  }
  return { ok: true, userRoom: { ...userRoom, [userId]: roomId } };
}

/**
 * userId の登録を外す。`expectRoomId` を渡した場合、現在の登録がそれと一致するときだけ外す
 * （既に別の部屋へ移っていたら何もしない＝安全側）。
 */
export function unseatUser(userRoom: Readonly<Record<string, string>>, userId: string, expectRoomId?: string): Record<string, string> {
  if (!(userId in userRoom)) return userRoom as Record<string, string>;
  if (expectRoomId !== undefined && userRoom[userId] !== expectRoomId) return userRoom as Record<string, string>;
  const next = { ...userRoom };
  delete next[userId];
  return next;
}

export class SngLobby implements DurableObject {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  private async load(): Promise<LobbyStorage> {
    const rooms = (await this.ctx.storage.get<Record<string, RoomEntry>>('rooms')) ?? {};
    const userRoom = (await this.ctx.storage.get<Record<string, string>>('userRoom')) ?? {};
    return { rooms, userRoom };
  }

  private async save(s: LobbyStorage): Promise<void> {
    await this.ctx.storage.put('rooms', s.rooms);
    await this.ctx.storage.put('userRoom', s.userRoom);
  }

  private toSummaries(s: LobbyStorage): readonly RoomSummary[] {
    return Object.values(s.rooms)
      .map(({ hostId: _hostId, ...rest }) => rest)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  private async rescheduleAuthAlarm(): Promise<void> {
    const next = await earliestAuthDeadline(this.ctx.storage);
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
  }

  private async broadcast(): Promise<void> {
    const s = await this.load();
    const rooms = this.toSummaries(s);
    for (const ws of this.ctx.getWebSockets(TAG)) {
      const att = getAttachment(ws);
      if (!att.authed || !att.userId) continue;
      const msg: LobbyServerMsg = { t: 'rooms', rooms, mine: s.userRoom[att.userId] ?? null, serverTime: Date.now() };
      send(ws, msg);
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if ((request.headers.get('upgrade') ?? '').toLowerCase() === 'websocket') {
        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];
        const id = crypto.randomUUID();
        this.ctx.acceptWebSocket(server, [TAG]);
        const attachment: ConnAttachment = { id, userId: null, name: null, authed: false };
        server.serializeAttachment(attachment);
        await addAuthDeadline(this.ctx.storage, id, Date.now());
        await this.rescheduleAuthAlarm();
        return new Response(null, { status: 101, webSocket: client });
      }

      if (url.pathname === '/internal/create' && request.method === 'POST') {
        return this.handleCreate(await request.json());
      }
      if (url.pathname === '/internal/update' && request.method === 'POST') {
        return this.handleUpdate(await request.json());
      }
      if (url.pathname === '/internal/release' && request.method === 'POST') {
        return this.handleRelease(await request.json());
      }
      if (url.pathname === '/internal/seat' && request.method === 'POST') {
        return this.handleSeat(await request.json());
      }
      if (url.pathname === '/internal/unseat' && request.method === 'POST') {
        return this.handleUnseat(await request.json());
      }
      if (url.pathname === '/internal/list' && request.method === 'GET') {
        const s = await this.load();
        const user = url.searchParams.get('user');
        return Response.json({ rooms: this.toSummaries(s), mine: user ? (s.userRoom[user] ?? null) : null });
      }
      return new Response('not found', { status: 404 });
    } catch (err) {
      return Response.json({ error: 'internal', message: String(err) }, { status: 500 });
    }
  }

  private async handleCreate(body: unknown): Promise<Response> {
    const { roomId, userId, name, config } = body as { roomId: string; userId: string; name: string; config: SngConfig };
    const s = await this.load();
    const existing = s.userRoom[userId];
    if (existing && s.rooms[existing]) {
      return Response.json({ error: 'already_seated', roomId: existing }, { status: 409 });
    }
    s.rooms[roomId] = {
      roomId,
      hostName: name,
      config,
      seated: 1,
      status: 'waiting',
      createdAt: Date.now(),
      hostId: userId,
    };
    s.userRoom[userId] = roomId;
    await this.save(s);
    await this.broadcast();
    return Response.json({ ok: true });
  }

  private async handleUpdate(body: unknown): Promise<Response> {
    const { roomId, seated, status } = body as { roomId: string; seated: number; status: 'waiting' | 'running' };
    const s = await this.load();
    const room = s.rooms[roomId];
    if (!room) return Response.json({ error: 'not_found' }, { status: 404 });
    s.rooms[roomId] = { ...room, seated, status };
    await this.save(s);
    await this.broadcast();
    return Response.json({ ok: true });
  }

  private async handleRelease(body: unknown): Promise<Response> {
    const { roomId } = body as { roomId: string };
    const s = await this.load();
    delete s.rooms[roomId];
    for (const [uid, rid] of Object.entries(s.userRoom)) {
      if (rid === roomId) delete s.userRoom[uid];
    }
    await this.save(s);
    await this.broadcast();
    return Response.json({ ok: true });
  }

  /**
   * Table DO が WS の join のたびに呼ぶ（ホストの再入室・参加者の新規着席のどちらも）。
   * 別の部屋に既に登録されていれば 409 + その roomId（`already_seated`）。同じ部屋なら
   * 何もしない（冪等）。これで「1人1部屋」が join 経路にも効くようになる
   * （元は `/internal/create` の時しか登録しておらず、参加者の直接 WS join が素通りしていた）。
   */
  private async handleSeat(body: unknown): Promise<Response> {
    const { roomId, userId } = body as { roomId: string; userId: string };
    const s = await this.load();
    const result = seatUser(s.userRoom, userId, roomId);
    if (!result.ok) {
      // 登録先が既に無い部屋（掃除漏れ）なら自己修復して通す。handleCreate と同じ安全網。
      if (!s.rooms[result.roomId]) {
        s.userRoom = { ...s.userRoom, [userId]: roomId };
        await this.save(s);
        await this.broadcast();
        return Response.json({ ok: true });
      }
      return Response.json({ error: 'already_seated', roomId: result.roomId }, { status: 409 });
    }
    if (result.userRoom !== s.userRoom) {
      s.userRoom = result.userRoom;
      await this.save(s);
      await this.broadcast();
    }
    return Response.json({ ok: true });
  }

  /**
   * 待機中に参加者（ホスト以外）が leave して席が空いたときに Table DO が呼ぶ。
   * ホストの leave（cancelled）や試合終了は `handleRelease` が部屋ごとまとめて片付けるので、
   * ここでは 1 ユーザーぶんだけを対象にする。
   */
  private async handleUnseat(body: unknown): Promise<Response> {
    const { userId, roomId } = body as { userId: string; roomId?: string };
    const s = await this.load();
    const next = unseatUser(s.userRoom, userId, roomId);
    if (next !== s.userRoom) {
      s.userRoom = next;
      await this.save(s);
      await this.broadcast();
    }
    return Response.json({ ok: true });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      const att = getAttachment(ws);
      const msg = typeof message === 'string' ? parseClientMsg(message) : null;

      if (!att.authed) {
        if (!msg || msg.t !== 'auth') {
          ws.close(4001, 'unauthorized');
          return;
        }
        const auth = await verifyToken(this.env, msg.token);
        if (!auth) {
          ws.close(4001, 'unauthorized');
          return;
        }
        const next: ConnAttachment = { id: att.id, userId: auth.userId, name: auth.name, authed: true };
        ws.serializeAttachment(next);
        await clearAuthDeadline(this.ctx.storage, att.id);
        await this.rescheduleAuthAlarm();
        const s = await this.load();
        send(ws, {
          t: 'rooms',
          rooms: this.toSummaries(s),
          mine: s.userRoom[auth.userId] ?? null,
          serverTime: Date.now(),
        } satisfies LobbyServerMsg);
        return;
      }

      if (!msg) {
        send(ws, { t: 'error', code: 'bad_message' } satisfies LobbyServerMsg);
        return;
      }
      if (msg.t === 'ping') {
        send(ws, { t: 'pong', serverTime: Date.now() } satisfies LobbyServerMsg);
        return;
      }
      // ロビーでは auth/ping 以外は意味を持たない（卓の操作は table.ts の担当）。
      send(ws, { t: 'error', code: 'bad_message' } satisfies LobbyServerMsg);
    } catch (err) {
      try {
        send(ws, { t: 'error', code: 'bad_message', message: String(err) } satisfies LobbyServerMsg);
      } catch {
        /* 送れなければ諦める */
      }
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.forgetConnection(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.forgetConnection(ws);
  }

  private async forgetConnection(ws: WebSocket): Promise<void> {
    try {
      const att = getAttachment(ws);
      if (att.id) {
        await clearAuthDeadline(this.ctx.storage, att.id);
        await this.rescheduleAuthAlarm();
      }
    } catch (err) {
      console.error('sng lobby: forgetConnection failed', err);
    }
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const expired = await sweepExpired(this.ctx.storage, now);
    if (expired.length > 0) {
      for (const ws of this.ctx.getWebSockets(TAG)) {
        const att = getAttachment(ws);
        if (expired.includes(att.id)) {
          try {
            ws.close(4001, 'auth timeout');
          } catch {
            /* noop */
          }
        }
      }
    }
    await this.rescheduleAuthAlarm();
  }
}
