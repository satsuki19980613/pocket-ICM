// M6 ホーム/スレッドのデータ層（公開フィード・スレッド詳細・公開・コメント・♡・画像）。
// すべて RLS 下（threads/comments/likes = authenticated 全員閲覧, 書込みは本人）。
// バックエンド（テーブル/RLS/Storage）は M1 で適用済み。ここは PostgREST/Storage 配線のみ。
//
// 保存形（サンプルで実証した「解を持ち歩く」形）:
//   results.spot     = BoardState（入力局面のスナップショット）
//   results.solution = SolveResultDto（表示に必要な解＝結果画面がそのまま描ける）
// これで公開結果のタップは求解せず即座に全結果を表示できる。
import type { BoardState } from '@oshihiki/core';
import type { SolveResultDto } from '../solverProtocol';
import { headlineNode, verdictOf, type HeroAction } from '../records/model';
import type { SampleCard, Suit } from '../data/cardTypes';
import { supabase } from './client';
import type { FnResult } from './api';

// ---------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------
export interface FeedAuthor {
  id: string;
  handle: string;
  display_name: string;
  avatar_url: string | null;
}

export interface FeedResult {
  id: string;
  owner: string;
  spot: BoardState;
  solution: SolveResultDto;
  hero_action: 'ALL_IN' | 'FOLD' | null;
  ev_loss: number | null;
  created_at: string;
}

/** フィード1件（スレッド＝公開結果への投稿）。 */
export interface FeedPost {
  thread_id: string;
  created_at: string;
  author: FeedAuthor;
  result: FeedResult;
  /** 投稿者の先頭コメント（公開時の一言）。無ければ null。 */
  lead_comment: string | null;
  comment_count: number;
  like_count: number;
  liked_by_me: boolean;
}

export interface ThreadComment {
  id: string;
  author: FeedAuthor;
  body: string | null;
  image_url: string | null;
  created_at: string;
  updated_at: string | null;
  /** 自分のコメントか（編集/削除可否）。 */
  mine: boolean;
}

export interface ThreadDetail {
  thread_id: string;
  created_at: string;
  author: FeedAuthor;
  result: FeedResult;
  like_count: number;
  liked_by_me: boolean;
  comments: ThreadComment[];
}

/** 結果カードの表示値（Home/Thread/userpub 共通）。 */
export interface FeedCard {
  heroHand: string;
  heroPos: string;
  playersLeft: number;
  bb: number | null;
  verdict: HeroAction;
  /** レンジ%（見出しノード pct）。 */
  pu: number;
  /** 見出しノード heroEv（実払い pt）。 */
  ev: number;
  cards: [SampleCard, SampleCard];
}

function fail(message: string): { ok: false; error: string; message: string } {
  return { ok: false, error: 'feed_error', message };
}

// ---------------------------------------------------------------------------
// 純ヘルパ（単体テスト対象）
// ---------------------------------------------------------------------------

/** PostgREST の集約 `col(count)` は [{count}] で返る。安全に数に落とす。 */
export function countOf(arr: unknown): number {
  if (Array.isArray(arr) && arr[0] && typeof (arr[0] as { count?: unknown }).count === 'number') {
    return (arr[0] as { count: number }).count;
  }
  return 0;
}

const RANK_RE = /^(10|[2-9TJQKA])/;

/**
 * 正規化ハンド（"K9s"/"A8o"/"TT"）→表示用の4色デッキ2枚。
 * 解の heroHand はスートを持たないので、見た目のため代表スートを割り当てる
 * （スーテッド=両方♠, オフスート=♠+♥, ペア=♠+♥）。色はカードコンポーネントが付ける。
 */
export function handToDisplayCards(hand: string): [SampleCard, SampleCard] {
  const h = hand.trim();
  const r1: string = RANK_RE.exec(h)?.[1] ?? h[0] ?? '?';
  const rest = h.slice(r1.length);
  const r2: string = RANK_RE.exec(rest)?.[1] ?? rest[0] ?? '?';
  const suited = h.endsWith('s');
  const s1: Suit = 'spade';
  const s2: Suit = suited ? 'spade' : 'heart';
  return [
    { r: r1 === '10' ? 'T' : r1, s: s1 },
    { r: r2 === '10' ? 'T' : r2, s: s2 },
  ];
}

/** 結果（解）→カード表示値。Home/Thread/userpub が同じ真実を使う。 */
export function feedCardOf(result: FeedResult): FeedCard {
  const sol = result.solution;
  const head = headlineNode(sol);
  const heroPos = sol.heroPos;
  const seat = result.spot?.seats?.find((s) => s.pos === heroPos);
  return {
    heroHand: sol.heroHand,
    heroPos,
    playersLeft: sol.playersLeft,
    bb: seat ? seat.stack : null,
    verdict: head ? verdictOf(head) : 'FOLD',
    pu: head ? head.pct : 0,
    ev: head ? head.heroEv : 0,
    cards: handToDisplayCards(sol.heroHand),
  };
}

/** hero の実行動（DB: ALL_IN/FOLD）→内部 HeroAction。 */
export function dbToHeroAction(v: string | null): HeroAction | null {
  if (v === 'ALL_IN') return 'PUSH';
  if (v === 'FOLD') return 'FOLD';
  return null;
}

/** 内部 HeroAction → DB 値（constraint: ALL_IN/FOLD）。 */
export function heroActionToDb(a: HeroAction | null | undefined): 'ALL_IN' | 'FOLD' | null {
  if (a === 'PUSH') return 'ALL_IN';
  if (a === 'FOLD') return 'FOLD';
  return null;
}

// 生の埋め込み行（PostgREST）。to-one は object, to-many は array。
interface RawThreadRow {
  id: string;
  created_at: string;
  author: FeedAuthor | null;
  result: FeedResult | null;
  comments?: unknown;
  likes?: unknown;
}

/**
 * threads 行＋補助データ → FeedPost（純）。
 * leadByThread: thread_id → 先頭コメント本文。likedThreads: 自分が♡したスレッド id 集合。
 */
export function mapFeedRow(
  row: RawThreadRow,
  leadByThread: Map<string, string | null>,
  likedThreads: Set<string>,
): FeedPost | null {
  if (!row.author || !row.result) return null;
  return {
    thread_id: row.id,
    created_at: row.created_at,
    author: row.author,
    result: row.result,
    lead_comment: leadByThread.get(row.id) ?? null,
    comment_count: countOf(row.comments),
    like_count: countOf(row.likes),
    liked_by_me: likedThreads.has(row.id),
  };
}

// ---------------------------------------------------------------------------
// クエリ（RLS 下）
// ---------------------------------------------------------------------------

const THREAD_SELECT =
  'id, created_at,' +
  ' author:profiles!threads_author_fkey(id, handle, display_name, avatar_url),' +
  ' result:results!inner(id, owner, spot, solution, hero_action, ev_loss, created_at),' +
  ' comments(count), likes(count)';

async function currentUid(): Promise<string | null> {
  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}

/**
 * 公開フィード（新しい順）。authorId 指定でその人の公開結果一覧（userpub）。
 */
export async function listFeed(opts?: {
  authorId?: string;
  limit?: number;
}): Promise<FnResult<FeedPost[]>> {
  const uid = await currentUid();
  if (!uid) return fail('ログインしていません');
  const limit = opts?.limit ?? 30;

  let q = supabase
    .from('threads')
    .select(THREAD_SELECT)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (opts?.authorId) q = q.eq('author', opts.authorId);

  const { data, error } = await q;
  if (error) return fail('フィードを取得できませんでした');
  const rows = (data ?? []) as unknown as RawThreadRow[];
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return { ok: true, data: [] };

  // 先頭コメント（投稿者の一言）と自分の♡を別クエリで補う。
  const [leadByThread, likedThreads] = await Promise.all([
    fetchLeadComments(ids),
    fetchMyLikes(uid, ids),
  ]);

  const posts: FeedPost[] = [];
  for (const row of rows) {
    const p = mapFeedRow(row, leadByThread, likedThreads);
    if (p) posts.push(p);
  }
  return { ok: true, data: posts };
}

/** 各スレッドの先頭コメント本文（created_at 昇順の最初＝公開時の一言）。 */
async function fetchLeadComments(threadIds: string[]): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  const { data } = await supabase
    .from('comments')
    .select('thread_id, body, created_at')
    .in('thread_id', threadIds)
    .order('created_at', { ascending: true });
  for (const c of (data ?? []) as { thread_id: string; body: string | null }[]) {
    if (!map.has(c.thread_id)) map.set(c.thread_id, c.body);
  }
  return map;
}

/** 自分が♡したスレッド id 集合。 */
async function fetchMyLikes(uid: string, threadIds: string[]): Promise<Set<string>> {
  const { data } = await supabase
    .from('likes')
    .select('thread_id')
    .eq('user_id', uid)
    .in('thread_id', threadIds);
  return new Set(((data ?? []) as { thread_id: string }[]).map((l) => l.thread_id));
}

/** スレッド詳細（結果＋コメント一覧＋♡）。 */
export async function getThread(threadId: string): Promise<FnResult<ThreadDetail>> {
  const uid = await currentUid();
  if (!uid) return fail('ログインしていません');

  const { data: t, error } = await supabase
    .from('threads')
    .select(
      'id, created_at,' +
        ' author:profiles!threads_author_fkey(id, handle, display_name, avatar_url),' +
        ' result:results!inner(id, owner, spot, solution, hero_action, ev_loss, created_at),' +
        ' likes(count)',
    )
    .eq('id', threadId)
    .single();
  if (error || !t) return fail('スレッドを取得できませんでした');
  const row = t as unknown as RawThreadRow;
  if (!row.author || !row.result) return fail('スレッドの内容を取得できませんでした');

  const { data: cdata, error: cerr } = await supabase
    .from('comments')
    .select(
      'id, body, image_url, created_at, updated_at,' +
        ' author:profiles!comments_author_fkey(id, handle, display_name, avatar_url)',
    )
    .eq('thread_id', threadId)
    .order('created_at', { ascending: true });
  if (cerr) return fail('コメントを取得できませんでした');

  const likedThreads = await fetchMyLikes(uid, [threadId]);
  const comments: ThreadComment[] = ((cdata ?? []) as unknown as RawCommentRow[])
    .filter((c) => c.author)
    .map((c) => ({
      id: c.id,
      author: c.author as FeedAuthor,
      body: c.body,
      image_url: c.image_url,
      created_at: c.created_at,
      updated_at: c.updated_at,
      mine: (c.author as FeedAuthor).id === uid,
    }));

  return {
    ok: true,
    data: {
      thread_id: row.id,
      created_at: row.created_at,
      author: row.author,
      result: row.result,
      like_count: countOf(row.likes),
      liked_by_me: likedThreads.has(threadId),
      comments,
    },
  };
}

interface RawCommentRow {
  id: string;
  body: string | null;
  image_url: string | null;
  created_at: string;
  updated_at: string | null;
  author: FeedAuthor | null;
}

/**
 * 計算結果をホームに公開する。results(is_public)＋threads＋（一言があれば）先頭 comment を作る。
 * 途中失敗時は作成済み result を巻き戻す（フィードに出ない孤児を残さない）。
 */
export async function publishResult(input: {
  state: BoardState;
  result: SolveResultDto;
  heroAction: HeroAction | null;
  evLoss: number | null;
  comment: string;
}): Promise<FnResult<{ thread_id: string; result_id: string }>> {
  const uid = await currentUid();
  if (!uid) return fail('ログインしていません');

  const { data: r, error: rerr } = await supabase
    .from('results')
    .insert({
      owner: uid,
      spot: input.state,
      solution: input.result,
      hero_action: heroActionToDb(input.heroAction),
      ev_loss: input.evLoss,
      is_public: true,
    })
    .select('id')
    .single();
  if (rerr || !r) return fail('公開に失敗しました（結果の保存）');
  const resultId = (r as { id: string }).id;

  const { data: th, error: terr } = await supabase
    .from('threads')
    .insert({ result_id: resultId, author: uid })
    .select('id')
    .single();
  if (terr || !th) {
    // 巻き戻し（本人所有なので RLS で削除可）。
    await supabase.from('results').delete().eq('id', resultId);
    return fail('公開に失敗しました（スレッドの作成）');
  }
  const threadId = (th as { id: string }).id;

  const body = input.comment.trim();
  if (body) {
    await supabase.from('comments').insert({ thread_id: threadId, author: uid, body });
    // コメント失敗は致命でない（後から追記可能）。スレッド自体は成立している。
  }

  return { ok: true, data: { thread_id: threadId, result_id: resultId } };
}

/** コメント（返信）を追加。本文・画像 URL の少なくとも一方が要る（DB constraint）。 */
export async function addComment(
  threadId: string,
  input: { body?: string; imageUrl?: string | null },
): Promise<FnResult<ThreadComment>> {
  const uid = await currentUid();
  if (!uid) return fail('ログインしていません');
  const body = input.body?.trim() || null;
  const imageUrl = input.imageUrl || null;
  if (!body && !imageUrl) return fail('コメントか画像を入力してください');

  const { data, error } = await supabase
    .from('comments')
    .insert({ thread_id: threadId, author: uid, body, image_url: imageUrl })
    .select(
      'id, body, image_url, created_at, updated_at,' +
        ' author:profiles!comments_author_fkey(id, handle, display_name, avatar_url)',
    )
    .single();
  if (error || !data) return fail('コメントを投稿できませんでした');
  const c = data as unknown as RawCommentRow;
  if (!c.author) return fail('コメントを投稿できませんでした');
  return {
    ok: true,
    data: {
      id: c.id,
      author: c.author,
      body: c.body,
      image_url: c.image_url,
      created_at: c.created_at,
      updated_at: c.updated_at,
      mine: true,
    },
  };
}

/** 自分のコメント本文を編集。 */
export async function editComment(commentId: string, body: string): Promise<FnResult<{ body: string }>> {
  const b = body.trim();
  if (!b) return fail('本文を入力してください');
  const { error } = await supabase
    .from('comments')
    .update({ body: b, updated_at: new Date().toISOString() })
    .eq('id', commentId);
  if (error) return fail('コメントを編集できませんでした');
  return { ok: true, data: { body: b } };
}

/** 自分のコメントを削除。 */
export async function deleteComment(commentId: string): Promise<FnResult<Record<string, never>>> {
  const { error } = await supabase.from('comments').delete().eq('id', commentId);
  if (error) return fail('コメントを削除できませんでした');
  return { ok: true, data: {} };
}

/** ♡ の ON/OFF（1人1件）。 */
export async function setLike(threadId: string, on: boolean): Promise<FnResult<{ on: boolean }>> {
  const uid = await currentUid();
  if (!uid) return fail('ログインしていません');
  if (on) {
    const { error } = await supabase
      .from('likes')
      .upsert({ thread_id: threadId, user_id: uid }, { onConflict: 'thread_id,user_id', ignoreDuplicates: true });
    if (error) return fail('操作に失敗しました');
  } else {
    const { error } = await supabase
      .from('likes')
      .delete()
      .eq('thread_id', threadId)
      .eq('user_id', uid);
    if (error) return fail('操作に失敗しました');
  }
  return { ok: true, data: { on } };
}

const IMAGE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/** スレッド画像をアップロードし公開 URL を返す（パス規約 <uid>/<uuid>.<ext>）。 */
export async function uploadThreadImage(file: File): Promise<FnResult<{ url: string }>> {
  const uid = await currentUid();
  if (!uid) return fail('ログインしていません');
  const ext = IMAGE_EXT[file.type];
  if (!ext) return fail('画像は PNG / JPEG / WebP のみ対応です');
  if (file.size > 5 * 1024 * 1024) return fail('画像は 5MB 以下にしてください');

  const path = `${uid}/${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage.from('thread-images').upload(path, file, {
    contentType: file.type,
    upsert: false,
  });
  if (error) return fail('画像のアップロードに失敗しました');
  const { data } = supabase.storage.from('thread-images').getPublicUrl(path);
  return { ok: true, data: { url: data.publicUrl } };
}
