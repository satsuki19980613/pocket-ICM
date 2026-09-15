/**
 * SIT & GO のクライアント ⇄ サーバー（Durable Object）プロトコル。docs/SNG_DESIGN.md §2。
 *
 * - WebSocket は接続後の **最初のメッセージが必ず `auth`**。それまで他は受け付けない。
 * - サーバー → クライアントは **毎回フルスナップショット**（差分は無い）。`seq` が小さいものは捨てる。
 * - 手札だけは `hole` で本人にだけ送る（スナップショットの `you.hole` にも同じものが入る）。
 * - `act` は `handNo` と `actSeq` を添える。ズレていれば `stale` エラーで捨てる（冪等化）。
 *
 * クライアント → サーバーは zod で検証する（不正な形は `bad_message` で捨てる）。
 */

import { z } from 'zod';

import { GAME_MODES } from '@oshihiki/core';

import { LEVEL_MINUTES, PLAYER_COUNTS, SPEEDS, START_BBS, type PublicTable, type SngConfig, type You } from './types';

// ---------------------------------------------------------------------------
// エンドポイント
// ---------------------------------------------------------------------------

export const SNG_PREFIX = '/api/sng/';
/** HTTP: POST 作成 / GET 一覧（どちらも Authorization: Bearer）。 */
export const ROOMS_PATH = '/api/sng/rooms';
/** WS: ロビーの一覧配信。 */
export const LOBBY_WS_PATH = '/api/sng/lobby';
/** WS: 卓。`/api/sng/table/<roomId>`。 */
export const tableWsPath = (roomId: string): string => `/api/sng/table/${roomId}`;

export const ROOM_ID_RE = /^sg_[0-9a-z]{8,24}$/;

// ---------------------------------------------------------------------------
// 設定の検証（作成 API の body）
// ---------------------------------------------------------------------------

export const sngConfigSchema = z.object({
  players: z.union([z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)]),
  startBb: z.union([z.literal(75), z.literal(100), z.literal(150), z.literal(200)]),
  speed: z.enum(SPEEDS),
  levelMin: z.union([z.literal(3), z.literal(4), z.literal(5)]),
  mode: z.enum(GAME_MODES),
});

// 定数配列とスキーマが食い違ったらここで型エラーにする。
const _check: readonly PlayerCountCheck[] = PLAYER_COUNTS;
type PlayerCountCheck = z.infer<typeof sngConfigSchema>['players'];
const _check2: readonly z.infer<typeof sngConfigSchema>['startBb'][] = START_BBS;
const _check3: readonly z.infer<typeof sngConfigSchema>['levelMin'][] = LEVEL_MINUTES;
void _check;
void _check2;
void _check3;

export function parseConfig(input: unknown): SngConfig | null {
  const r = sngConfigSchema.safeParse(input);
  return r.success ? r.data : null;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export interface RoomSummary {
  readonly roomId: string;
  readonly hostName: string;
  readonly config: SngConfig;
  /** 着席済みの人数。 */
  readonly seated: number;
  readonly status: 'waiting' | 'running';
  readonly createdAt: number;
}

/** GET /api/sng/rooms の応答。`mine` は自分が居る部屋（無ければ null）。 */
export interface RoomsResponse {
  readonly rooms: readonly RoomSummary[];
  readonly mine: string | null;
  readonly serverTime: number;
}

/** POST /api/sng/rooms の応答。 */
export interface CreateRoomResponse {
  readonly roomId: string;
}

// ---------------------------------------------------------------------------
// クライアント → サーバー
// ---------------------------------------------------------------------------

export const clientMsgSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('auth'), token: z.string().min(20).max(4096) }),
  z.object({ t: z.literal('ping') }),
  z.object({
    t: z.literal('act'),
    handNo: z.number().int().nonnegative(),
    actSeq: z.number().int().nonnegative(),
    kind: z.enum(['fold', 'check', 'call', 'bet', 'raise', 'allin']),
    /** bet / raise のときの「〜まで」（チップ）。 */
    betTo: z.number().int().nonnegative().optional(),
  }),
  z.object({ t: z.literal('sitin') }),
  z.object({ t: z.literal('leave') }),
]);

export type ClientMsg = z.infer<typeof clientMsgSchema>;

export function parseClientMsg(raw: unknown): ClientMsg | null {
  if (typeof raw !== 'string' || raw.length > 4096) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const r = clientMsgSchema.safeParse(json);
  return r.success ? r.data : null;
}

// ---------------------------------------------------------------------------
// サーバー → クライアント
// ---------------------------------------------------------------------------

export type ErrorCode =
  | 'unauthorized' // auth が通らない
  | 'bad_message' // 形が不正
  | 'stale' // handNo / actSeq がズレた
  | 'not_your_turn'
  | 'illegal' // 合法手でない
  | 'room_full'
  | 'room_closed' // 終了・取り消し済み
  | 'already_seated' // 別の部屋に居る（roomId に入る）
  | 'not_seated';

export type ServerMsg =
  | {
      readonly t: 'snapshot';
      readonly seq: number;
      readonly serverTime: number;
      readonly table: PublicTable;
      readonly you: You;
    }
  | { readonly t: 'hole'; readonly handNo: number; readonly cards: readonly [string, string] }
  | { readonly t: 'pong'; readonly serverTime: number }
  | { readonly t: 'error'; readonly code: ErrorCode; readonly message?: string; readonly roomId?: string }
  /** 部屋が閉じた（finished / cancelled）。以後この WS は閉じる。 */
  | { readonly t: 'closed'; readonly reason: 'finished' | 'cancelled' };

export type LobbyServerMsg =
  | { readonly t: 'rooms'; readonly rooms: readonly RoomSummary[]; readonly mine: string | null; readonly serverTime: number }
  | { readonly t: 'pong'; readonly serverTime: number }
  | { readonly t: 'error'; readonly code: ErrorCode; readonly message?: string };

/** サーバーからの文字列を型付きに戻す（形は信じる。サーバーは自前）。 */
export function parseServerMsg(raw: string): ServerMsg | null {
  try {
    const v = JSON.parse(raw) as { t?: unknown };
    return typeof v.t === 'string' ? (v as ServerMsg) : null;
  } catch {
    return null;
  }
}

export function parseLobbyMsg(raw: string): LobbyServerMsg | null {
  try {
    const v = JSON.parse(raw) as { t?: unknown };
    return typeof v.t === 'string' ? (v as LobbyServerMsg) : null;
  } catch {
    return null;
  }
}
