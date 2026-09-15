/**
 * SIT & GO ハンド履歴・自分の手札のサーバ側の控え（supabase/migrations/0011_sng.sql, docs/SNG_DESIGN.md §3/§4）。
 *
 * 書くのはサーバー（DO）だけ。フロントは読むだけ（`created_at` のカーソルで差分を引く。
 * historySync.ts）。`hand` 列は圧縮表現 v1（`@oshihiki/sng` の encode.ts、担当 A1）。
 * ここでは中身をデコードせず、端末の historyStore.ts にそのまま持たせる
 * （デコードは表示時 = SngHistoryView が行う）。
 */

import type { FnResult } from './api';
import { supabase } from './client';

// ---------------------------------------------------------------------------
// sng_hands
// ---------------------------------------------------------------------------

export interface SngHandRow {
  game_id: string;
  hand_no: number;
  played_at: string;
  level: number;
  sb: number;
  bb: number;
  ante: number;
  hand: string;
  created_at: string;
}

/** サーバ由来ぶん（自分の手札・席は含まない。historySync.ts がマージする）。 */
export interface SngHandMeta {
  readonly gameId: string;
  readonly handNo: number;
  readonly playedAt: number;
  readonly level: number;
  readonly sb: number;
  readonly bb: number;
  readonly ante: number;
  /** 圧縮表現 v1（そのまま）。 */
  readonly encoded: string;
}

/** サーバの行 → 記録。形が崩れていれば null。 */
export function rowToHand(row: SngHandRow): SngHandMeta | null {
  if (typeof row.game_id !== 'string' || row.game_id.length === 0) return null;
  if (!Number.isInteger(row.hand_no) || row.hand_no < 1) return null;
  if (!Number.isInteger(row.level) || row.level < 1) return null;
  if (!Number.isInteger(row.sb) || row.sb < 0) return null;
  if (!Number.isInteger(row.bb) || row.bb <= 0) return null;
  if (!Number.isInteger(row.ante) || row.ante < 0) return null;
  if (typeof row.hand !== 'string' || row.hand.length === 0) return null;
  const playedAt = Date.parse(row.played_at);
  if (!Number.isFinite(playedAt)) return null;
  return {
    gameId: row.game_id,
    handNo: row.hand_no,
    playedAt,
    level: row.level,
    sb: row.sb,
    bb: row.bb,
    ante: row.ante,
    encoded: row.hand,
  };
}

export interface PulledHand {
  readonly rec: SngHandMeta;
  readonly createdAt: string;
}

/**
 * `sng_hands` を差分で引く（`created_at` 昇順・カーソルより後）。
 * select 自体は RLS が `participants` で絞る（自分が参加した試合のぶんだけ）。
 */
export async function fetchHandsAfter(cursor: string | null, limit = 1000): Promise<FnResult<PulledHand[]>> {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user?.id) return { ok: false, error: 'unauthenticated', message: 'ログインしていません' };
  let q = supabase
    .from('sng_hands')
    .select('game_id, hand_no, played_at, level, sb, bb, ante, hand, created_at')
    .order('created_at', { ascending: true })
    .limit(limit);
  if (cursor) q = q.gt('created_at', cursor);
  const { data, error } = await q;
  if (error) return { ok: false, error: 'pull_error', message: 'ハンド履歴を読めませんでした' };
  const out: PulledHand[] = [];
  for (const row of (data ?? []) as SngHandRow[]) {
    const rec = rowToHand(row);
    if (rec && row.created_at) out.push({ rec, createdAt: row.created_at });
  }
  return { ok: true, data: out };
}

// ---------------------------------------------------------------------------
// sng_hole_cards（自分の手札。本人行しか読めない）
// ---------------------------------------------------------------------------

export interface SngHoleCardRow {
  game_id: string;
  hand_no: number;
  owner: string;
  /** `"AhKd"` 形式 4 文字。 */
  cards: string;
  created_at: string;
}

export interface SngHoleCard {
  readonly gameId: string;
  readonly handNo: number;
  readonly cards: readonly [string, string];
}

export function rowToHoleCard(row: SngHoleCardRow): SngHoleCard | null {
  if (typeof row.game_id !== 'string' || row.game_id.length === 0) return null;
  if (!Number.isInteger(row.hand_no) || row.hand_no < 1) return null;
  if (typeof row.cards !== 'string' || row.cards.length !== 4) return null;
  return { gameId: row.game_id, handNo: row.hand_no, cards: [row.cards.slice(0, 2), row.cards.slice(2, 4)] };
}

export interface PulledHoleCard {
  readonly rec: SngHoleCard;
  readonly createdAt: string;
}

/** `sng_hole_cards` を差分で引く（`created_at` 昇順）。本人行しか返らない（RLS）。 */
export async function fetchHoleCardsAfter(cursor: string | null, limit = 1000): Promise<FnResult<PulledHoleCard[]>> {
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth.user?.id;
  if (!uid) return { ok: false, error: 'unauthenticated', message: 'ログインしていません' };
  let q = supabase
    .from('sng_hole_cards')
    .select('game_id, hand_no, owner, cards, created_at')
    .eq('owner', uid)
    .order('created_at', { ascending: true })
    .limit(limit);
  if (cursor) q = q.gt('created_at', cursor);
  const { data, error } = await q;
  if (error) return { ok: false, error: 'pull_error', message: '自分の手札を読めませんでした' };
  const out: PulledHoleCard[] = [];
  for (const row of (data ?? []) as SngHoleCardRow[]) {
    const rec = rowToHoleCard(row);
    if (rec && row.created_at) out.push({ rec, createdAt: row.created_at });
  }
  return { ok: true, data: out };
}
