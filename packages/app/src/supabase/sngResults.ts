/**
 * SIT & GO 試合結果のサーバ側の控え（supabase/migrations/0011_sng.sql, docs/SNG_DESIGN.md §3）。
 *
 * `sng_results` は 1 試合・1 人 1 行（本人ぶんだけ RLS で読める）。書くのはサーバー（DO）だけで、
 * フロントは読むだけ（差分は `ended_at` のカーソルで引く。historySync.ts）。
 * 行 ↔ ローカル型の写像は純関数（rowToResult）に切り出してテストする。
 */

import { GAME_MODES, type GameMode } from '@oshihiki/core';

import type { FnResult } from './api';
import { supabase } from './client';

export interface SngResultRow {
  game_id: string;
  owner: string;
  seat: number;
  place: number;
  /** numeric 列は PostgREST が文字列で返すことがある。 */
  pt: number | string;
  players: number;
  mode: string;
  ended_at: string;
}

/** 端末に持つ形（historyStore.ts の `results` ストアの値）。 */
export interface SngResultRecord {
  readonly gameId: string;
  readonly owner: string;
  readonly seat: number;
  readonly place: number;
  readonly pt: number;
  readonly players: number;
  readonly mode: GameMode;
  readonly endedAt: number;
}

function isGameMode(v: string): v is GameMode {
  return (GAME_MODES as readonly string[]).includes(v);
}

/** サーバの行 → 記録。形が崩れていれば null。 */
export function rowToResult(row: SngResultRow): SngResultRecord | null {
  if (typeof row.game_id !== 'string' || row.game_id.length === 0) return null;
  if (typeof row.owner !== 'string' || row.owner.length === 0) return null;
  if (!Number.isInteger(row.seat) || row.seat < 0) return null;
  if (!Number.isInteger(row.place) || row.place < 1) return null;
  if (!Number.isInteger(row.players) || row.players < 2) return null;
  if (typeof row.mode !== 'string' || !isGameMode(row.mode)) return null;
  const pt = Number(row.pt);
  if (!Number.isFinite(pt)) return null;
  const endedAt = Date.parse(row.ended_at);
  if (!Number.isFinite(endedAt)) return null;
  return {
    gameId: row.game_id,
    owner: row.owner,
    seat: row.seat,
    place: row.place,
    pt,
    players: row.players,
    mode: row.mode,
    endedAt,
  };
}

export interface PulledResult {
  readonly rec: SngResultRecord;
  readonly endedAt: string;
}

/**
 * 控えを差分で引く（`ended_at` 昇順・カーソルより後）。1 回に limit 件まで。
 * 戻りが limit 件なら続きがある（呼び出し側でループする）。
 */
export async function fetchResultsAfter(cursor: string | null, limit = 1000): Promise<FnResult<PulledResult[]>> {
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth.user?.id;
  if (!uid) return { ok: false, error: 'unauthenticated', message: 'ログインしていません' };
  let q = supabase
    .from('sng_results')
    .select('game_id, owner, seat, place, pt, players, mode, ended_at')
    .eq('owner', uid)
    .order('ended_at', { ascending: true })
    .limit(limit);
  if (cursor) q = q.gt('ended_at', cursor);
  const { data, error } = await q;
  if (error) return { ok: false, error: 'pull_error', message: '成績を読めませんでした' };
  const out: PulledResult[] = [];
  for (const row of (data ?? []) as SngResultRow[]) {
    const rec = rowToResult(row);
    if (rec && row.ended_at) out.push({ rec, endedAt: row.ended_at });
  }
  return { ok: true, data: out };
}
