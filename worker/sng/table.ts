/**
 * SngTable（Durable Object・部屋ごとに 1 インスタンス）。docs/SNG_DESIGN.md §2/§6。
 *
 * 状態は `ctx.storage.get('state')` で毎回読み、`apply` のたびに `put` する
 * （**メモリに状態を持たない**。Hibernation で消える）。タイマーは Alarms 1 本だが、
 * このファイルは 3 種類の締切を同じ 1 本に相乗りさせる:
 *   1. エンジンの `state.wake`（手番のタイムアウト・ハンド間・募集/一時停止の期限）
 *   2. DB 書き込みの再送（`pending.ts`）。`state.wake` が無いときだけ own の +60s を積む
 *   3. WS の認証締切（`wsAuth.ts`）。5 秒以内に auth が来ない接続を閉じる
 * `scheduleAlarm` がこの 3 つの最小値を毎回計算して 1 本の alarm に反映する。
 */
import { encodeHand, engine, parseClientMsg } from '@oshihiki/sng';
import type { EngineCommand, EngineEffect, Rng, ServerMsg, SngConfig, SngGameResult, SngHandRecord, TableState } from '@oshihiki/sng';

import * as db from './db';
import type { Env } from './env';
import { verifyToken } from './auth';
import { dropExpired, enqueuePending, loadPending, savePending } from './pending';
import type { PendingWrite } from './pending';
import { addAuthDeadline, clearAuthDeadline, earliestAuthDeadline, getAttachment, send, sweepExpired } from './wsAuth';
import type { ConnAttachment } from './wsAuth';

const TAG = 'sng-table';
const RETRY_INTERVAL_MS = 60_000;

const rng: Rng = () => crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32;

async function scheduleAlarm(ctx: DurableObjectState, state: TableState | null): Promise<void> {
  const candidates: number[] = [];
  if (state?.wake) {
    candidates.push(state.wake.at);
  } else {
    const pending = await loadPending(ctx.storage);
    if (pending.length > 0) candidates.push(Date.now() + RETRY_INTERVAL_MS);
  }
  const authAt = await earliestAuthDeadline(ctx.storage);
  if (authAt !== null) candidates.push(authAt);

  if (candidates.length === 0) {
    await ctx.storage.deleteAlarm();
  } else {
    await ctx.storage.setAlarm(Math.min(...candidates));
  }
}

export class SngTable implements DurableObject {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  private async loadState(): Promise<TableState | null> {
    return (await this.ctx.storage.get<TableState>('state')) ?? null;
  }

  private async persist(state: TableState): Promise<void> {
    await this.ctx.storage.put('state', state);
  }

  // ---------------------------------------------------------------------
  // HTTP（router.ts から）/ WS 入口
  // ---------------------------------------------------------------------

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
        await scheduleAlarm(this.ctx, await this.loadState());
        return new Response(null, { status: 101, webSocket: client });
      }
      if (url.pathname === '/internal/init' && request.method === 'POST') {
        return this.handleInit(await request.json());
      }
      return new Response('not found', { status: 404 });
    } catch (err) {
      return Response.json({ error: 'internal', message: String(err) }, { status: 500 });
    }
  }

  private async handleInit(body: unknown): Promise<Response> {
    const { roomId, hostId, hostName, config, now } = body as {
      roomId: string;
      hostId: string;
      hostName: string;
      config: SngConfig;
      now: number;
    };
    const state = engine.createTable(roomId, hostId, hostName, config, now);
    await this.persist(state);
    await scheduleAlarm(this.ctx, state);
    return Response.json({ ok: true });
  }

  // ---------------------------------------------------------------------
  // コマンド適用の共通処理
  // ---------------------------------------------------------------------

  /** state を読み、apply し、成功したら保存・スナップショット配信・効果処理・alarm 再計算まで行う。 */
  private async runCommand(ws: WebSocket | null, cmd: EngineCommand): Promise<TableState | null> {
    const state = await this.loadState();
    if (!state) {
      if (ws) send(ws, { t: 'error', code: 'room_closed' } satisfies ServerMsg);
      return null;
    }
    const result = engine.apply(state, cmd, Date.now(), rng);
    if (!result.ok) {
      if (ws) send(ws, { t: 'error', code: result.error } satisfies ServerMsg);
      return null;
    }
    await this.persist(result.state);
    this.broadcastSnapshot(result.state);
    await this.handleEffects(result.effects, result.state);
    await scheduleAlarm(this.ctx, await this.loadState());
    return result.state;
  }

  private async handleEffects(effects: readonly EngineEffect[], state: TableState): Promise<void> {
    for (const eff of effects) {
      if (eff.t === 'hole') {
        this.sendToUser(eff.userId, { t: 'hole', handNo: eff.handNo, cards: eff.cards });
      } else if (eff.t === 'hand_finished') {
        await this.writeHandWithRetry(eff.record, eff.holes);
      } else if (eff.t === 'game_over') {
        await this.writeGameWithRetry(eff.result);
        await this.notifyLobbyRelease(state.roomId);
        this.broadcastClosed(eff.result.status);
        this.closeAllConnections(1000, eff.result.status);
      } else if (eff.t === 'lobby_changed') {
        await this.notifyLobbyUpdate(state);
      }
    }
  }

  private async writeHandWithRetry(
    record: SngHandRecord,
    holes: Readonly<Record<string, readonly [string, string]>>,
  ): Promise<void> {
    let encoded: string;
    try {
      encoded = encodeHand(record);
    } catch (err) {
      // まだ実装されていない／バグ。リトライしても直らないのでログだけ残して諦める。
      console.error('sng: encodeHand failed, hand record dropped', err);
      return;
    }
    const ok = await db.writeHand(this.env, record, encoded, holes);
    if (!ok) {
      const item: PendingWrite = { kind: 'hand', record, encoded, holes, queuedAt: Date.now() };
      await enqueuePending(this.ctx.storage, item);
    }
  }

  private async writeGameWithRetry(result: SngGameResult): Promise<void> {
    const ok = await db.writeGame(this.env, result);
    if (!ok) {
      const item: PendingWrite = { kind: 'game', result, queuedAt: Date.now() };
      await enqueuePending(this.ctx.storage, item);
    }
  }

  private async flushPending(): Promise<void> {
    const items = dropExpired(await loadPending(this.ctx.storage), Date.now());
    const remaining: PendingWrite[] = [];
    for (const item of items) {
      const ok =
        item.kind === 'hand'
          ? await db.writeHand(this.env, item.record, item.encoded, item.holes)
          : await db.writeGame(this.env, item.result);
      if (!ok) remaining.push(item);
    }
    await savePending(this.ctx.storage, remaining);
  }

  private lobbyStub(): DurableObjectStub {
    return this.env.SNG_LOBBY.get(this.env.SNG_LOBBY.idFromName('lobby'));
  }

  private async notifyLobbyRelease(roomId: string): Promise<void> {
    try {
      await this.lobbyStub().fetch('https://do/internal/release', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomId }),
      });
    } catch (err) {
      console.error('sng: lobby release notify failed', err);
    }
  }

  private async notifyLobbyUpdate(state: TableState): Promise<void> {
    try {
      await this.lobbyStub().fetch('https://do/internal/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          roomId: state.roomId,
          seated: state.players.length,
          status: state.status === 'waiting' ? 'waiting' : 'running',
        }),
      });
    } catch (err) {
      console.error('sng: lobby update notify failed', err);
    }
  }

  // ---------------------------------------------------------------------
  // 配信
  // ---------------------------------------------------------------------

  private broadcastSnapshot(state: TableState): void {
    const table = engine.publicTable(state);
    const serverTime = Date.now();
    for (const ws of this.ctx.getWebSockets(TAG)) {
      const att = getAttachment(ws);
      if (!att.authed || !att.userId) continue;
      const you = engine.you(state, att.userId);
      send(ws, { t: 'snapshot', seq: state.seq, serverTime, table, you } satisfies ServerMsg);
    }
  }

  private broadcastClosed(reason: 'finished' | 'cancelled'): void {
    for (const ws of this.ctx.getWebSockets(TAG)) {
      send(ws, { t: 'closed', reason } satisfies ServerMsg);
    }
  }

  private sendToUser(userId: string, msg: ServerMsg): void {
    for (const ws of this.ctx.getWebSockets(TAG)) {
      const att = getAttachment(ws);
      if (att.userId === userId && att.authed) send(ws, msg);
    }
  }

  private closeUserConnections(userId: string, code: number, reason: string): void {
    for (const ws of this.ctx.getWebSockets(TAG)) {
      if (getAttachment(ws).userId === userId) {
        try {
          ws.close(code, reason);
        } catch {
          /* noop */
        }
      }
    }
  }

  private closeAllConnections(code: number, reason: string): void {
    for (const ws of this.ctx.getWebSockets(TAG)) {
      try {
        ws.close(code, reason);
      } catch {
        /* noop */
      }
    }
  }

  // ---------------------------------------------------------------------
  // WS メッセージ
  // ---------------------------------------------------------------------

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

        const state = await this.runCommand(ws, { t: 'join', userId: auth.userId, name: auth.name });
        if (state) {
          const you = engine.you(state, auth.userId);
          if (you.hole && state.hand) {
            send(ws, { t: 'hole', handNo: state.hand.handNo, cards: you.hole } satisfies ServerMsg);
          }
        }
        return;
      }

      if (!msg) {
        send(ws, { t: 'error', code: 'bad_message' } satisfies ServerMsg);
        return;
      }

      const userId = att.userId;
      if (!userId) {
        send(ws, { t: 'error', code: 'unauthorized' } satisfies ServerMsg);
        return;
      }

      if (msg.t === 'ping') {
        send(ws, { t: 'pong', serverTime: Date.now() } satisfies ServerMsg);
      } else if (msg.t === 'act') {
        await this.runCommand(ws, {
          t: 'act',
          userId,
          handNo: msg.handNo,
          actSeq: msg.actSeq,
          kind: msg.kind,
          betTo: msg.betTo,
        });
      } else if (msg.t === 'sitin') {
        await this.runCommand(ws, { t: 'sitin', userId });
      } else if (msg.t === 'leave') {
        await this.runCommand(ws, { t: 'leave', userId });
        this.closeUserConnections(userId, 1000, 'left');
      } else if (msg.t === 'auth') {
        // 認証済みなのに auth を再送してきた場合は無視する（形は正しいので bad_message にはしない）。
        return;
      } else {
        send(ws, { t: 'error', code: 'bad_message' } satisfies ServerMsg);
      }
    } catch (err) {
      try {
        send(ws, { t: 'error', code: 'bad_message', message: String(err) } satisfies ServerMsg);
      } catch {
        /* 送れなければ諦める */
      }
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.handleDisconnect(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.handleDisconnect(ws);
  }

  private async handleDisconnect(ws: WebSocket): Promise<void> {
    try {
      const att = getAttachment(ws);
      if (att.id) await clearAuthDeadline(this.ctx.storage, att.id);

      if (att.authed && att.userId) {
        const stillConnected = this.ctx
          .getWebSockets(TAG)
          .some((other) => other !== ws && getAttachment(other).userId === att.userId && getAttachment(other).authed);
        if (!stillConnected) {
          await this.runCommand(null, { t: 'connected', userId: att.userId, connected: false });
          return; // runCommand が alarm の再計算まで済ませている
        }
      }
      await scheduleAlarm(this.ctx, await this.loadState());
    } catch (err) {
      console.error('sng table: disconnect handling failed', err);
    }
  }

  // ---------------------------------------------------------------------
  // Alarm（エンジンの wake ・ DB 再送 ・ 認証締切の 3 つを 1 本で兼ねる）
  // ---------------------------------------------------------------------

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

    let state = await this.loadState();
    if (state?.wake && state.wake.at <= now) {
      state = await this.runCommand(null, { t: 'wake' });
    }

    await this.flushPending();

    state = state ?? (await this.loadState());
    await scheduleAlarm(this.ctx, state);
  }
}
