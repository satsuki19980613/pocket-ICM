/**
 * Training「Slumbot HU」の通算成績（supabase/migrations/0007_hu_stats.sql）。
 *
 * 保存するのは通算ハンド数と通算収支（チップ）だけ。ハンド履歴は持たない。
 * 書き込みは RPC `hu_add_result` 経由（テーブル直書きは RLS が拒否する）。
 *
 * 圏外でも対局は続けられるようにしたいので、送れなかったぶんは端末に足し込んで
 * 溜めておき、次に送れたときにまとめて加算する（＝1 ハンドも取りこぼさない）。
 */

import { supabase } from './client';
import type { FnResult } from './api';

/** まだサーバへ送れていない加算分。 */
export interface PendingStats {
  readonly hands: number;
  readonly netChips: number;
}

export const ZERO_PENDING: PendingStats = { hands: 0, netChips: 0 };

const PENDING_KEY = 'icm.slumbot.pending.v1';
/** RPC 側の上限（0007_hu_stats.sql）。これを超える分は複数回に分けて送る。 */
const MAX_HANDS_PER_CALL = 500;

type ReadStore = Pick<Storage, 'getItem'>;
type WriteStore = Pick<Storage, 'setItem'>;

export function readPending(store: (ReadStore & WriteStore) | null): PendingStats {
  if (!store) return ZERO_PENDING;
  try {
    const raw = store.getItem(PENDING_KEY);
    if (!raw) return ZERO_PENDING;
    const o = JSON.parse(raw) as Record<string, unknown>;
    const hands = typeof o.hands === 'number' && Number.isFinite(o.hands) ? Math.trunc(o.hands) : 0;
    const netChips =
      typeof o.netChips === 'number' && Number.isFinite(o.netChips) ? Math.trunc(o.netChips) : 0;
    return hands > 0 ? { hands, netChips } : ZERO_PENDING;
  } catch {
    return ZERO_PENDING;
  }
}

export function writePending(store: (ReadStore & WriteStore) | null, p: PendingStats): void {
  if (!store) return;
  try {
    store.setItem(PENDING_KEY, JSON.stringify(p));
  } catch {
    /* 保存できない環境でも対局自体は続けられるようにする。 */
  }
}

/** 1 ハンド分を溜める（純粋な足し算。送信はしない）。 */
export function addPending(p: PendingStats, netChips: number): PendingStats {
  return { hands: p.hands + 1, netChips: p.netChips + Math.trunc(netChips) };
}

/**
 * 実行中の送信。複数箇所から同時に呼ばれても 1 本にまとめるための番人。
 *
 * これが無いと二重加算する: 対局中にランキング（RankingModal）を開くと、その
 * load() が flushPending を呼ぶ。ハンド終了直後の recordHand も flushPending を
 * 呼んでいるので、両者が「送信前の同じ pending」を読んでから別々に RPC を投げ、
 * サーバで同じハンドが 2 回加算されてしまう。しかもローカルは最終的に 0 に
 * 落ち着くため、端末側に痕跡が残らない。
 */
let inFlight: Promise<boolean> | null = null;
/** 送信中に追加の要求が来たことを覚えておき、終わったらもう一度だけ送る。 */
let queued = false;

/**
 * 溜まっている分をサーバへ加算する。
 * 送信中に新しく溜まった分を消さないよう、「送った分だけを引く」形で書き戻す。
 * 同時に呼ばれた場合は先行する送信に相乗りする（二重加算を防ぐ）。
 * 戻り値は「サーバに届いたか」。
 *
 * 既知の限界: RPC にべき等キーが無いので、「サーバでは加算されたが応答が届かない」
 * ときの再送は二重加算になる。招待制クラブ内の自己申告成績（厳密な競技記録ではない）
 * という前提のもと、スキーマを増やしてまで塞がない判断。
 */
export function flushPending(store: (ReadStore & WriteStore) | null): Promise<boolean> {
  if (inFlight) {
    // いま送っている分の後にもう一度だけ走らせる（この呼び出しぶんを取り残さないため）。
    queued = true;
    return inFlight;
  }
  queued = false;
  inFlight = (async () => {
    let ok = await runFlush(store);
    while (queued) {
      queued = false;
      ok = (await runFlush(store)) && ok;
    }
    return ok;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runFlush(store: (ReadStore & WriteStore) | null): Promise<boolean> {
  const pending = readPending(store);
  if (pending.hands <= 0) return true;

  // RPC は「1 回の加算は 500 ハンドまで・収支は 1 ハンドあたり ±20000 まで」を検査する。
  // 溜まりすぎた場合は上限まで切り出し、残りは次回にまわす（実運用ではまず来ない）。
  const hands = Math.min(pending.hands, MAX_HANDS_PER_CALL);
  const bound = 20_000 * hands;
  const netChips = Math.max(-bound, Math.min(bound, pending.netChips));

  const { error } = await supabase.rpc('hu_add_result', {
    p_hands: hands,
    p_net_chips: netChips,
  });
  if (error) return false;

  const after = readPending(store); // 送信中に増えているかもしれない。
  writePending(store, { hands: after.hands - hands, netChips: after.netChips - netChips });
  return true;
}

export interface MyStats {
  readonly hands: number;
  readonly netChips: number;
}

/** 自分の通算成績（サーバ確定分）。行が無ければゼロ。 */
export async function fetchMyStats(): Promise<FnResult<MyStats>> {
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth.user?.id;
  if (!uid) return { ok: false, error: 'unauthenticated', message: 'ログインしていません' };
  const { data, error } = await supabase
    .from('hu_stats')
    .select('hands, net_chips')
    .eq('owner', uid)
    .maybeSingle();
  if (error) return { ok: false, error: 'stats_error', message: '成績を取得できませんでした' };
  return {
    ok: true,
    data: { hands: data?.hands ?? 0, netChips: Number(data?.net_chips ?? 0) },
  };
}

export interface RankRow {
  readonly userId: string;
  readonly handle: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
  /** アバター枠＋バッジ（avatarDeco.ts の AvatarDecoInput と同じ3列）。 */
  readonly frameColor: string;
  readonly specialFrame: string | null;
  readonly badge: string | null;
  readonly hands: number;
  readonly netChips: number;
  /** 自分の行か（一覧で強調する）。 */
  readonly isMe: boolean;
}

interface RankQueryRow {
  owner: string;
  hands: number;
  net_chips: number | string;
  profiles: {
    handle: string;
    display_name: string;
    avatar_url: string | null;
    frame_color: string | null;
    special_frame: string | null;
    badge: string | null;
  } | null;
}

/** ランキング（通算収支の降順）。同点はハンド数の多い順。 */
export async function fetchRanking(limit = 100): Promise<FnResult<RankRow[]>> {
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth.user?.id ?? '';
  const { data, error } = await supabase
    .from('hu_stats')
    .select('owner, hands, net_chips, profiles!inner(handle, display_name, avatar_url, frame_color, special_frame, badge)')
    .order('net_chips', { ascending: false })
    .order('hands', { ascending: false })
    .limit(limit);
  if (error) return { ok: false, error: 'rank_error', message: 'ランキングを取得できませんでした' };

  const rows = (data ?? []) as unknown as RankQueryRow[];
  return {
    ok: true,
    data: rows.map((r) => ({
      userId: r.owner,
      handle: r.profiles?.handle ?? '',
      displayName: r.profiles?.display_name ?? '(不明)',
      avatarUrl: r.profiles?.avatar_url ?? null,
      frameColor: r.profiles?.frame_color ?? 'steel',
      specialFrame: r.profiles?.special_frame ?? null,
      badge: r.profiles?.badge ?? null,
      hands: r.hands,
      netChips: Number(r.net_chips),
      isMe: r.owner === uid,
    })),
  };
}
