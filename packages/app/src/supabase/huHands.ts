/**
 * Slumbot HU ハンド履歴のサーバ側の控え（supabase/migrations/0010_hu_hands.sql, SPEC §7.4.6）。
 *
 * 端末（IndexedDB・historyStore.ts）が正で、ここは控え。
 *   - 1 ハンド 1 行・本人だけが読み書きできる（RLS）
 *   - id は端末生成（`sb_…`）＝冪等キー。再送しても二重には入らない（upsert）
 *   - 端末を変えたときは created_at のカーソルで差分を引いて端末へ戻す
 * 行 ↔ 記録の写像は純関数（rowToRecord / recordToRow）に切り出してテストする。
 */

import { supabase } from './client';
import type { FnResult } from './api';
import { isHandRecord, type HuHandRecord } from '../slumbot/history';

export interface HuHandRow {
  id: string;
  played_at: string;
  hero_seat: number;
  action: string;
  hero_cards: string;
  bot_cards: string | null;
  board: string;
  winnings: number;
  showdown: boolean;
  ev_winnings: number | null;
  created_at?: string;
}

function splitCards(s: string | null): string[] | null {
  if (s === null) return null;
  const out: string[] = [];
  for (let i = 0; i + 1 < s.length; i += 2) out.push(s.slice(i, i + 2));
  return out;
}

/** サーバの行 → 記録。形が崩れていれば null。控えから戻したものなので synced=true。 */
export function rowToRecord(row: HuHandRow): HuHandRecord | null {
  const playedAt = Date.parse(row.played_at);
  if (!Number.isFinite(playedAt)) return null;
  const rec = {
    id: row.id,
    playedAt,
    heroSeat: row.hero_seat,
    action: row.action,
    heroCards: splitCards(row.hero_cards) ?? [],
    botCards: splitCards(row.bot_cards),
    board: splitCards(row.board) ?? [],
    winnings: Number(row.winnings),
    showdown: row.showdown,
    evWinnings: row.ev_winnings === null ? null : Number(row.ev_winnings),
    synced: true,
  };
  return isHandRecord(rec) ? rec : null;
}

/** 記録 → サーバの行（owner は DB 側の default auth.uid() に任せる）。 */
export function recordToRow(rec: HuHandRecord): HuHandRow {
  return {
    id: rec.id,
    played_at: new Date(rec.playedAt).toISOString(),
    hero_seat: rec.heroSeat,
    action: rec.action,
    hero_cards: rec.heroCards.join(''),
    bot_cards: rec.botCards ? rec.botCards.join('') : null,
    board: rec.board.join(''),
    winnings: Math.trunc(rec.winnings),
    showdown: rec.showdown,
    ev_winnings: rec.evWinnings === null ? null : Math.trunc(rec.evWinnings),
  };
}

const CHUNK = 200;

/** 控えを送る（upsert）。同じ id は上書きされる（EV の後埋めもこれで届く）。 */
export async function pushHands(recs: readonly HuHandRecord[]): Promise<FnResult<{ pushed: number }>> {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user?.id) return { ok: false, error: 'unauthenticated', message: 'ログインしていません' };
  let pushed = 0;
  for (let i = 0; i < recs.length; i += CHUNK) {
    const rows = recs.slice(i, i + CHUNK).map(recordToRow);
    const { error } = await supabase.from('hu_hands').upsert(rows, { onConflict: 'id' });
    if (error) return { ok: false, error: 'push_error', message: '履歴の控えを送れませんでした' };
    pushed += rows.length;
  }
  return { ok: true, data: { pushed } };
}

export interface PulledHand {
  readonly rec: HuHandRecord;
  readonly createdAt: string;
}

/**
 * 控えを差分で引く（created_at の昇順・カーソルより後）。
 * 1 回に limit 件まで。戻りが limit 件なら続きがある。
 */
export async function fetchHandsAfter(
  cursor: string | null,
  limit = 1000,
): Promise<FnResult<PulledHand[]>> {
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth.user?.id;
  if (!uid) return { ok: false, error: 'unauthenticated', message: 'ログインしていません' };
  let q = supabase
    .from('hu_hands')
    .select('id, played_at, hero_seat, action, hero_cards, bot_cards, board, winnings, showdown, ev_winnings, created_at')
    .eq('owner', uid)
    .order('created_at', { ascending: true })
    .limit(limit);
  if (cursor) q = q.gt('created_at', cursor);
  const { data, error } = await q;
  if (error) return { ok: false, error: 'pull_error', message: '履歴の控えを読めませんでした' };
  const out: PulledHand[] = [];
  for (const row of (data ?? []) as HuHandRow[]) {
    const rec = rowToRecord(row);
    if (rec && row.created_at) out.push({ rec, createdAt: row.created_at });
  }
  return { ok: true, data: out };
}
