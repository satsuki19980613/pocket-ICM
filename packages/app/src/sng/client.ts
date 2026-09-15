/**
 * SIT & GO の通信クライアント（React 非依存・テスト可能）。docs/SNG_DESIGN.md §2/§5（A3a 所有）。
 *
 * `TableClient` … 卓（`/api/sng/table/:roomId`）。`LobbyClient` … ロビー一覧（`/api/sng/lobby`）。
 * 共通の下地は `WsClientBase`:
 *   - 接続直後（open）に必ず最初のメッセージとして `{t:'auth', token}` を送る。
 *   - サーバーは毎回フルスナップショットを送るので、`seq` が既知以下のものは捨てる
 *     （`TableClient` の snapshot だけ。ロビーの `rooms` には seq が無いので素通し）。
 *   - ハートビート `ping` を 20 秒ごとに送る。
 *   - close/error（サーバーからの意図した終了 `closed` メッセージを除く）では
 *     指数バックオフ（1,2,4,8 秒で頭打ち）で再接続する。
 *   - `document.visibilitychange` で可視化されたら、繋がっていなければ即再接続を試みる
 *     （バックオフの待ちをリセットする）。
 *
 * WebSocket の実体はコンストラクタで注入できる（`wsFactory`）。`wsBase`（URL のベース）と
 * `getToken`（アクセストークンの取得）も注入できるので、vitest では本物の `window`/Supabase に
 * 触れずに固定した擬似実装で検証できる（client.test.ts）。
 */

import { supabase } from '../supabase/client';
import {
  LOBBY_WS_PATH,
  parseLobbyMsg,
  parseServerMsg,
  tableWsPath,
  type ClientMsg,
  type ErrorCode,
  type LobbyServerMsg,
  type PublicTable,
  type RoomSummary,
  type ServerMsg,
  type You,
} from '@oshihiki/sng';

/** ハートビート間隔（ms）。docs/SNG_DESIGN.md §2。 */
export const HEARTBEAT_MS = 20_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 8_000;

/** ブラウザの `WebSocket` と互換な最小インターフェース（テストでは擬似実装を渡す）。 */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

/** `WebSocket.OPEN` と同じ値（1）。テスト側の擬似実装もこれに合わせる。 */
export const WS_OPEN = 1;

export type WebSocketFactory = (url: string) => WebSocketLike;

function defaultWsFactory(url: string): WebSocketLike {
  return new WebSocket(url) as unknown as WebSocketLike;
}

function defaultWsBase(): string {
  return window.location.origin.replace(/^http/, 'ws');
}

/** 再接続の待ち時間（ms）。attempt は 0 始まり（1,2,4,8 秒で頭打ち）。 */
export function backoffDelayMs(attempt: number): number {
  return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, attempt));
}

/** アクセストークンを取る。期限 60 秒前なら `refreshSession`。未ログインなら null。 */
export async function defaultGetToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  let session = data.session;
  if (!session) return null;
  const expiresAtMs = (session.expires_at ?? 0) * 1000;
  if (expiresAtMs > 0 && expiresAtMs - Date.now() < 60_000) {
    const { data: refreshed } = await supabase.auth.refreshSession();
    if (refreshed.session) session = refreshed.session;
  }
  return session.access_token;
}

export interface ClientOptions {
  readonly wsFactory?: WebSocketFactory;
  readonly getToken?: () => Promise<string | null>;
  /** ws(s):// のベース URL（既定は `location.origin` から作る）。テストで固定する用。 */
  readonly wsBase?: () => string;
}

/** 両クライアント共通の下地。 */
abstract class WsClientBase<TMsg> {
  private ws: WebSocketLike | null = null;
  private path: string | null = null;
  private closing = false; // close() された（以後は再接続しない）
  private serverClosed = false; // サーバーが意図して終えた（以後は再接続しない）
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private timeOffset = 0; // serverTime - Date.now()（受信のたびに更新）
  private readonly wsFactory: WebSocketFactory;
  private readonly getToken: () => Promise<string | null>;
  private readonly wsBase: () => string;
  private readonly onVisible = (): void => {
    if (typeof document === 'undefined' || document.visibilityState !== 'visible') return;
    if (this.closing || this.serverClosed) return;
    if (this.ws && this.ws.readyState === WS_OPEN) return;
    this.clearReconnectTimer();
    this.attempt = 0;
    this.openSocket();
  };

  protected constructor(opts: ClientOptions) {
    this.wsFactory = opts.wsFactory ?? defaultWsFactory;
    this.getToken = opts.getToken ?? defaultGetToken;
    this.wsBase = opts.wsBase ?? defaultWsBase;
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisible);
    }
  }

  protected abstract parseMsg(raw: string): TMsg | null;
  protected abstract handleMsg(msg: TMsg): void;
  /** そのメッセージがサーバーからの意図した終了か（true なら以後再接続しない）。 */
  protected abstract isTerminal(msg: TMsg): boolean;
  /** そのメッセージから serverTime を取り出す（無ければ null）。 */
  protected abstract serverTimeOf(msg: TMsg): number | null;
  /** ソケットが開いた／閉じた（接続表示用のフック。既定は何もしない）。 */
  protected onSocketOpen(): void {}
  protected onSocketClose(): void {}

  protected connect(path: string): void {
    this.path = path;
    this.closing = false;
    this.serverClosed = false;
    this.attempt = 0;
    this.clearReconnectTimer();
    this.openSocket();
  }

  private openSocket(): void {
    if (!this.path) return;
    const url = `${this.wsBase()}${this.path}`;
    const ws = this.wsFactory(url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.onSocketOpen();
      // open 直後の最初のメッセージは必ず auth（サーバーは 5 秒以内に来なければ閉じる）。
      void this.getToken().then((token) => {
        if (this.ws !== ws) return; // 差し替わっていたら捨てる（古い接続への送信を防ぐ）。
        if (token) this.rawSend(ws, { t: 'auth', token });
      });
      this.startHeartbeat();
    };
    ws.onmessage = (ev) => {
      const msg = this.parseMsg(ev.data);
      if (!msg) return;
      const st = this.serverTimeOf(msg);
      if (st !== null) this.timeOffset = st - Date.now();
      if (this.isTerminal(msg)) this.serverClosed = true;
      this.handleMsg(msg);
    };
    ws.onclose = () => {
      this.stopHeartbeat();
      if (this.ws === ws) this.ws = null;
      this.onSocketClose();
      if (!this.closing && !this.serverClosed) this.scheduleReconnect();
    };
    ws.onerror = () => {
      // ブラウザの WebSocket・多くの擬似実装は error の後に close が続く前提（そちらで処理する）。
    };
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    const delay = backoffDelayMs(this.attempt);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WS_OPEN) this.rawSend(this.ws, { t: 'ping' });
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private rawSend(ws: WebSocketLike, msg: ClientMsg): void {
    ws.send(JSON.stringify(msg));
  }

  /** open 中だけ送る（そうでなければ黙って捨てる）。 */
  send(msg: ClientMsg): void {
    if (this.ws && this.ws.readyState === WS_OPEN) this.rawSend(this.ws, msg);
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WS_OPEN;
  }

  /** サーバー時刻で補正した「今」（epoch ms）。 */
  now(): number {
    return Date.now() + this.timeOffset;
  }

  /** 以後いっさい再接続しない。イベント購読・タイマーも片付ける。 */
  close(): void {
    this.closing = true;
    this.clearReconnectTimer();
    this.stopHeartbeat();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisible);
    }
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
    }
  }
}

// ---------------------------------------------------------------------------
// TableClient
// ---------------------------------------------------------------------------

export interface TableClientCallbacks {
  readonly onSnapshot: (table: PublicTable, you: You, seq: number) => void;
  readonly onHole: (handNo: number, cards: readonly [string, string]) => void;
  readonly onError: (code: ErrorCode, message: string | undefined, roomId: string | undefined) => void;
  readonly onClosed: (reason: 'finished' | 'cancelled') => void;
  /** ソケットの接続状態が変わった（auth の成否ではなく WS の open/close）。 */
  readonly onConnected?: (connected: boolean) => void;
}

export class TableClient extends WsClientBase<ServerMsg> {
  private lastSeq = -1;
  private readonly callbacks: TableClientCallbacks;

  constructor(callbacks: TableClientCallbacks, opts: ClientOptions = {}) {
    super(opts);
    this.callbacks = callbacks;
  }

  connectRoom(roomId: string): void {
    this.lastSeq = -1;
    this.connect(tableWsPath(roomId));
  }

  protected override parseMsg(raw: string): ServerMsg | null {
    return parseServerMsg(raw);
  }

  protected override serverTimeOf(msg: ServerMsg): number | null {
    return msg.t === 'snapshot' || msg.t === 'pong' ? msg.serverTime : null;
  }

  protected override isTerminal(msg: ServerMsg): boolean {
    return msg.t === 'closed';
  }

  protected override onSocketOpen(): void {
    this.callbacks.onConnected?.(true);
  }

  protected override onSocketClose(): void {
    this.callbacks.onConnected?.(false);
  }

  protected override handleMsg(msg: ServerMsg): void {
    switch (msg.t) {
      case 'snapshot':
        if (msg.seq <= this.lastSeq) return; // 既知以下は捨てる。
        this.lastSeq = msg.seq;
        this.callbacks.onSnapshot(msg.table, msg.you, msg.seq);
        return;
      case 'hole':
        this.callbacks.onHole(msg.handNo, msg.cards);
        return;
      case 'error':
        this.callbacks.onError(msg.code, msg.message, msg.roomId);
        return;
      case 'closed':
        this.callbacks.onClosed(msg.reason);
        return;
      case 'pong':
        return;
    }
  }
}

// ---------------------------------------------------------------------------
// LobbyClient
// ---------------------------------------------------------------------------

export interface LobbyClientCallbacks {
  readonly onRooms: (rooms: readonly RoomSummary[], mine: string | null) => void;
  readonly onError: (code: ErrorCode, message: string | undefined) => void;
  readonly onConnected?: (connected: boolean) => void;
}

export class LobbyClient extends WsClientBase<LobbyServerMsg> {
  private readonly callbacks: LobbyClientCallbacks;

  constructor(callbacks: LobbyClientCallbacks, opts: ClientOptions = {}) {
    super(opts);
    this.callbacks = callbacks;
  }

  connectLobby(): void {
    this.connect(LOBBY_WS_PATH);
  }

  protected override parseMsg(raw: string): LobbyServerMsg | null {
    return parseLobbyMsg(raw);
  }

  protected override serverTimeOf(msg: LobbyServerMsg): number | null {
    return msg.t === 'rooms' || msg.t === 'pong' ? msg.serverTime : null;
  }

  protected override isTerminal(): boolean {
    return false; // ロビーはサーバーから意図して閉じることが無い。
  }

  protected override onSocketOpen(): void {
    this.callbacks.onConnected?.(true);
  }

  protected override onSocketClose(): void {
    this.callbacks.onConnected?.(false);
  }

  protected override handleMsg(msg: LobbyServerMsg): void {
    switch (msg.t) {
      case 'rooms':
        this.callbacks.onRooms(msg.rooms, msg.mine);
        return;
      case 'error':
        this.callbacks.onError(msg.code, msg.message);
        return;
      case 'pong':
        return;
    }
  }
}
