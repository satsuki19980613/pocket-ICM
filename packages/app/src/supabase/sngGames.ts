/**
 * SIT & GO 試合そのもの（席順・設定）のサーバ側の控え（supabase/migrations/0011_sng.sql,
 * docs/SNG_DESIGN.md §3）。
 *
 * `sng_games` は試合が終わるたびに1回、サーバー（DO）だけが書く。フロントは読むだけ
 * （`created_at` のカーソルで差分を引く。historySync.ts）。参加者なら select できる
 * （RLS: `auth.uid() = any(participants)`）ので自分の試合以外は返らない。
 *
 * `seats` 列（`[{seat, user_id, name}]`）が、ハンド履歴で相手の表示名を「Seat n」ではなく
 * 実名で出すための唯一の材料（`sng_hands` / `sng_hole_cards` は自分の分しか分からない）。
 * `config` は `@oshihiki/sng` の `parseConfig`（zod）でそのまま検証する（作成 API と同じ形）。
 */

import { parseConfig, type SngConfig } from '@oshihiki/sng';

import type { FnResult } from './api';
import { supabase } from './client';

export interface SngGameRow {
  id: string;
  config: unknown;
  status: string;
  started_at: string | null;
  ended_at: string;
  hands: number;
  seats: unknown;
  created_at: string;
}

export interface SngGameSeat {
  readonly seat: number;
  readonly userId: string;
  readonly name: string;
}

/** サーバ由来ぶんの試合記録（`historyStore.ts` の `games` ストアの値と同じ形）。 */
export interface SngGameRecord {
  readonly gameId: string;
  readonly config: SngConfig;
  /** 席順の表示名。古い行（このカラム追加前に終わった試合）は空配列。 */
  readonly seats: readonly SngGameSeat[];
  readonly status: 'finished' | 'cancelled';
  readonly startedAt: number | null;
  readonly endedAt: number;
  readonly hands: number;
}

function isStatus(v: unknown): v is SngGameRecord['status'] {
  return v === 'finished' || v === 'cancelled';
}

/** `seats` jsonb → 記録。個々の要素が壊れていればその要素だけ読み飛ばす。 */
function toSeats(v: unknown): readonly SngGameSeat[] {
  if (!Array.isArray(v)) return [];
  const out: SngGameSeat[] = [];
  for (const item of v) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    if (!Number.isInteger(o.seat) || (o.seat as number) < 0) continue;
    if (typeof o.user_id !== 'string' || o.user_id.length === 0) continue;
    if (typeof o.name !== 'string' || o.name.length === 0) continue;
    out.push({ seat: o.seat as number, userId: o.user_id, name: o.name });
  }
  return out;
}

/** サーバの行 → 記録。形が崩れていれば null。 */
export function rowToGame(row: SngGameRow): SngGameRecord | null {
  if (typeof row.id !== 'string' || row.id.length === 0) return null;
  if (!isStatus(row.status)) return null;
  if (!Number.isInteger(row.hands) || row.hands < 0) return null;
  const config = parseConfig(row.config);
  if (!config) return null;
  const endedAt = Date.parse(row.ended_at);
  if (!Number.isFinite(endedAt)) return null;
  let startedAt: number | null = null;
  if (row.started_at !== null && row.started_at !== undefined) {
    const t = Date.parse(row.started_at);
    if (!Number.isFinite(t)) return null;
    startedAt = t;
  }
  return {
    gameId: row.id,
    config,
    seats: toSeats(row.seats),
    status: row.status,
    startedAt,
    endedAt,
    hands: row.hands,
  };
}

export interface PulledGame {
  readonly rec: SngGameRecord;
  readonly createdAt: string;
}

/**
 * `sng_games` を差分で引く（`created_at` 昇順・カーソルより後）。
 * select 自体は RLS が `participants` で絞る（自分が参加した試合のぶんだけ）。
 */
export async function fetchGamesAfter(cursor: string | null, limit = 1000): Promise<FnResult<PulledGame[]>> {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user?.id) return { ok: false, error: 'unauthenticated', message: 'ログインしていません' };
  let q = supabase
    .from('sng_games')
    .select('id, config, status, started_at, ended_at, hands, seats, created_at')
    .order('created_at', { ascending: true })
    .limit(limit);
  if (cursor) q = q.gt('created_at', cursor);
  const { data, error } = await q;
  if (error) return { ok: false, error: 'pull_error', message: '試合の記録を読めませんでした' };
  const out: PulledGame[] = [];
  for (const row of (data ?? []) as SngGameRow[]) {
    const rec = rowToGame(row);
    if (rec && row.created_at) out.push({ rec, createdAt: row.created_at });
  }
  return { ok: true, data: out };
}

/** 今ログインしている人の uid（`sng_games.seats` から自分の席を引き当てるのに使う）。 */
export async function fetchCurrentUserId(): Promise<string | null> {
  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}
