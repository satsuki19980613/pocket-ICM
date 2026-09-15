/**
 * Supabase（PostgREST）への書き込み。service role キーで upsert する。docs/SNG_DESIGN.md §2/§3。
 *
 * ここに置く関数は**例外を投げない**（常に boolean を返す）。失敗判定は呼び出し側（table.ts）が
 * 再送キューに積むかどうかの判断に使う。行への変換（`recordToRows` / `gameResultToRows`）は
 * ネットワークを叩かない純関数にしてあり、単体テストの対象。
 */
import type { Env } from './env';
import type { SngGameResult, SngHandRecord } from '@oshihiki/sng';

const TIMEOUT_MS = 10_000;

export interface HandRow {
  readonly game_id: string;
  readonly hand_no: number;
  readonly played_at: string;
  readonly participants: readonly string[];
  readonly level: number;
  readonly sb: number;
  readonly bb: number;
  readonly ante: number;
  readonly hand: string;
}

export interface HoleRow {
  readonly game_id: string;
  readonly hand_no: number;
  readonly owner: string;
  readonly cards: string;
}

export interface SeatRow {
  readonly seat: number;
  readonly user_id: string;
  readonly name: string;
}

export interface GameRow {
  readonly id: string;
  readonly host: string;
  readonly config: unknown;
  readonly participants: readonly string[];
  readonly status: 'finished' | 'cancelled';
  readonly started_at: string | null;
  readonly ended_at: string;
  readonly hands: number;
  readonly seats: readonly SeatRow[];
}

export interface ResultRow {
  readonly game_id: string;
  readonly owner: string;
  readonly seat: number;
  readonly place: number | null;
  readonly pt: number | null;
  readonly players: number;
  readonly mode: string;
  readonly ended_at: string;
}

/**
 * `sng_hands` / `sng_hole_cards` への行に変換する（純関数）。`encoded` は呼び出し側が
 * 事前に `encodeHand(record)` で作っておく（このファイルはエンコードのロジックを知らない）。
 * `holesByUserId` に入っている userId が、そのハンドの参加者（`participants`）になる。
 */
export function recordToRows(
  record: SngHandRecord,
  encoded: string,
  holesByUserId: Readonly<Record<string, readonly [string, string]>>,
): { readonly hand: HandRow; readonly holes: readonly HoleRow[] } {
  const hand: HandRow = {
    game_id: record.gameId,
    hand_no: record.handNo,
    played_at: new Date(record.playedAt).toISOString(),
    participants: Object.keys(holesByUserId),
    level: record.level,
    sb: record.sb,
    bb: record.bb,
    ante: record.ante,
    hand: encoded,
  };
  const holes: HoleRow[] = Object.entries(holesByUserId).map(([owner, cards]) => ({
    game_id: record.gameId,
    hand_no: record.handNo,
    owner,
    cards: cards.join(''),
  }));
  return { hand, holes };
}

/** `sng_games` / `sng_results` への行に変換する（純関数）。 */
export function gameResultToRows(result: SngGameResult): { readonly game: GameRow; readonly results: readonly ResultRow[] } {
  const endedAt = new Date(result.endedAt).toISOString();
  const game: GameRow = {
    id: result.gameId,
    host: result.hostId,
    config: result.config,
    participants: result.players.map((p) => p.userId),
    status: result.status,
    started_at: result.startedAt === null ? null : new Date(result.startedAt).toISOString(),
    ended_at: endedAt,
    hands: result.hands,
    seats: [...result.players]
      .sort((a, b) => a.seat - b.seat)
      .map((p) => ({ seat: p.seat, user_id: p.userId, name: p.name })),
  };
  const results: ResultRow[] = result.players.map((p) => ({
    game_id: result.gameId,
    owner: p.userId,
    seat: p.seat,
    place: p.place,
    pt: p.pt,
    players: result.players.length,
    mode: result.config.mode,
    ended_at: endedAt,
  }));
  return { game, results };
}

async function upsert(env: Env, table: string, onConflict: string, rows: readonly unknown[]): Promise<boolean> {
  if (rows.length === 0) return true;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return false;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflict)}`, {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'content-type': 'application/json',
        prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(rows),
      signal: ctl.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** 1 ハンド分を upsert する（hand 行 → hole 行の順）。どちらかが失敗したら false（再送キュー行き）。 */
export async function writeHand(
  env: Env,
  record: SngHandRecord,
  encoded: string,
  holesByUserId: Readonly<Record<string, readonly [string, string]>>,
): Promise<boolean> {
  const { hand, holes } = recordToRows(record, encoded, holesByUserId);
  const handOk = await upsert(env, 'sng_hands', 'game_id,hand_no', [hand]);
  const holesOk = await upsert(env, 'sng_hole_cards', 'game_id,hand_no,owner', holes);
  return handOk && holesOk;
}

/** 試合の結果を upsert する（games 行 → results 行の順）。 */
export async function writeGame(env: Env, result: SngGameResult): Promise<boolean> {
  const { game, results } = gameResultToRows(result);
  const gameOk = await upsert(env, 'sng_games', 'id', [game]);
  const resultsOk = await upsert(env, 'sng_results', 'game_id,owner', results);
  return gameOk && resultsOk;
}
