/**
 * 記録（`results`）のサーバ同期データ層（SPEC v3 §5.7 / §9.2 / §9.4, BETA_PLAN WP-B2）。
 *
 * サーバが正・IndexedDB（`records/store.ts`）はキャッシュ（§9.3）。計算は非同期になり、
 * 記録は `solving → done|failed|aborted` の状態を持つ（§5.7）。ここは PostgREST 配線に
 * 留め、行→`SpotRecord` の写像は純関数 `rowToRecord` に切り出してテストする
 * （`supabase/feed.ts` の流儀に合わせる）。
 */

import type { BoardState } from '@oshihiki/core';
import type { SolveResultDto } from '../solverProtocol';
import { type HeroAction, type RecordStatus, type SpotRecord } from '../records/model';
import { supabase } from './client';
import { deleteSpotImageUnlessProtected } from './images';
import type { FnResult } from './api';

function fail(message: string): { ok: false; error: string; message: string } {
  return { ok: false, error: 'records_error', message };
}

async function currentUid(): Promise<string | null> {
  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}

/** `results.hero_action` / `results.verdict`（DB: ALL_IN/FOLD）→内部 HeroAction。 */
export function dbToHeroAction(v: string | null | undefined): HeroAction | null {
  if (v === 'ALL_IN') return 'PUSH';
  if (v === 'FOLD') return 'FOLD';
  return null;
}

/** 内部 HeroAction → `results.hero_action` / `results.verdict`（constraint: ALL_IN/FOLD）。 */
export function heroActionToDb(a: HeroAction | null | undefined): 'ALL_IN' | 'FOLD' | null {
  if (a === 'PUSH') return 'ALL_IN';
  if (a === 'FOLD') return 'FOLD';
  return null;
}

// ---------------------------------------------------------------------------
// 純関数（単体テスト対象）: results 行 → SpotRecord
// ---------------------------------------------------------------------------

/** `results` の生行（PostgREST が返す形。jsonb 列はパース済みオブジェクトで来る）。 */
export interface RawResultRow {
  id: string;
  status: RecordStatus;
  client_id: string | null;
  hero_hand: string | null;
  hero_pos: string | null;
  players_left: number | null;
  verdict: string | null;
  hero_action: string | null;
  hero_ev: number | null;
  ev_loss: number | null;
  solve_ms: number | null;
  error: string | null;
  image_id: string | null;
  ocr_read_id: string | null;
  spot: BoardState;
  solution: SolveResultDto | null;
  is_public: boolean;
  created_at: string;
}

/**
 * `results` の1行 → `SpotRecord`（純関数）。非正規化列（`hero_hand`等）が欠けている
 * 旧データ（v3 移行前に作られた行）は `spot`（BoardState スナップショット）から補う。
 */
export function rowToRecord(row: RawResultRow): SpotRecord {
  return {
    id: row.id,
    createdAt: new Date(row.created_at).getTime(),
    status: row.status,
    heroHand: row.hero_hand ?? row.spot.heroHand,
    heroPos: row.hero_pos ?? row.spot.heroPos,
    playersLeft: row.players_left ?? row.spot.playersLeft,
    verdict: dbToHeroAction(row.verdict) ?? 'FOLD',
    heroAction: dbToHeroAction(row.hero_action),
    heroEv: row.hero_ev ?? 0,
    evLoss: row.ev_loss,
    published: row.is_public,
    state: row.spot,
    result: row.solution,
    ms: row.solve_ms ?? 0,
    serverId: row.id,
    clientId: row.client_id ?? row.id,
    pendingSync: false,
    error: row.error ?? undefined,
    imageId: row.image_id ?? undefined,
    ocrReadId: row.ocr_read_id ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Supabase 配線（薄い配線。判断ロジックは持たない）
// ---------------------------------------------------------------------------

const RESULT_SELECT =
  'id, status, client_id, hero_hand, hero_pos, players_left, verdict, hero_action, hero_ev,' +
  ' ev_loss, solve_ms, error, image_id, ocr_read_id, spot, solution, is_public, created_at';

export interface CreateSolvingRecordInput {
  /** 端末が採番する冪等キー（オフライン再送用, `results.client_id`）。 */
  clientId: string;
  spot: BoardState;
  imageId?: string;
  ocrReadId?: string;
  heroHand: string;
  heroPos: string;
  playersLeft: number;
}

/** 計算開始時に「計算中」の記録をサーバへ作る（§5.7 の1）。 */
export async function createSolvingRecord(
  input: CreateSolvingRecordInput,
): Promise<FnResult<{ id: string }>> {
  const uid = await currentUid();
  if (!uid) return fail('ログインしていません');
  const { data, error } = await supabase
    .from('results')
    .insert({
      owner: uid,
      status: 'solving',
      client_id: input.clientId,
      spot: input.spot,
      hero_hand: input.heroHand,
      hero_pos: input.heroPos,
      players_left: input.playersLeft,
      image_id: input.imageId ?? null,
      ocr_read_id: input.ocrReadId ?? null,
    })
    .select('id')
    .single();
  if (error || !data) return fail('計算記録の作成に失敗しました');
  return { ok: true, data: { id: (data as { id: string }).id } };
}

export interface CompleteRecordInput {
  solution: SolveResultDto;
  ms: number;
  verdict: HeroAction;
  heroEv: number;
}

/** 計算完了時に記録を確定する（§5.7 の4）。 */
export async function completeRecord(
  id: string,
  input: CompleteRecordInput,
): Promise<FnResult<Record<string, never>>> {
  const { error } = await supabase
    .from('results')
    .update({
      status: 'done',
      solution: input.solution,
      // `results.solve_ms` は int 列。performance.now() 由来の小数をそのまま送ると
      // PostgREST が 400（invalid input syntax for type integer）を返し、記録が
      // 「計算中」のまま残る。ミリ秒は整数に丸めて送る。
      solve_ms: Math.round(input.ms),
      verdict: heroActionToDb(input.verdict),
      hero_ev: input.heroEv,
    })
    .eq('id', id);
  if (error) return fail('計算結果の保存に失敗しました');
  return { ok: true, data: {} };
}

/** 計算失敗時に記録へ理由を記す（§5.7 の4）。 */
export async function failRecord(id: string, message: string): Promise<FnResult<Record<string, never>>> {
  const { error } = await supabase.from('results').update({ status: 'failed', error: message }).eq('id', id);
  if (error) return fail('失敗記録の保存に失敗しました');
  return { ok: true, data: {} };
}

/**
 * 起動時、自分の「計算中」のまま残っている記録を「中断」に落とす（§5.7 の5:
 * ページを閉じる/リロードで Worker が止まった記録は再計算に回す）。
 */
export async function abortStaleSolving(): Promise<FnResult<{ ids: string[] }>> {
  const uid = await currentUid();
  if (!uid) return fail('ログインしていません');
  const { data, error } = await supabase
    .from('results')
    .update({ status: 'aborted' })
    .eq('owner', uid)
    .eq('status', 'solving')
    .select('id');
  if (error) return fail('中断処理に失敗しました');
  const ids = ((data ?? []) as { id: string }[]).map((r) => r.id);
  return { ok: true, data: { ids } };
}

/** 自分の選択（ALL IN/FOLD/未選択）と、それに伴う EV loss を保存する（§5.3, 任意）。 */
export async function setHeroAction(
  id: string,
  action: HeroAction | null,
  evLoss: number | null,
): Promise<FnResult<Record<string, never>>> {
  const { error } = await supabase
    .from('results')
    .update({ hero_action: heroActionToDb(action), ev_loss: evLoss })
    .eq('id', id);
  if (error) return fail('選択の保存に失敗しました');
  return { ok: true, data: {} };
}

/**
 * 冪等キー（`client_id`）から自分の記録 id を引く（§9.4 の再送用）。
 * オフライン中に作られた記録を再送したとき、`unique(owner, client_id)` 違反で挿入が
 * 弾かれた＝**既にサーバにある**ケースを見分けるために使う（二重登録を防ぐ）。
 */
export async function findMyRecordIdByClientId(
  clientId: string,
): Promise<FnResult<{ id: string | null }>> {
  const uid = await currentUid();
  if (!uid) return fail('ログインしていません');
  const { data, error } = await supabase
    .from('results')
    .select('id')
    .eq('owner', uid)
    .eq('client_id', clientId)
    .maybeSingle();
  if (error) return fail('記録を照会できませんでした');
  return { ok: true, data: { id: (data as { id: string } | null)?.id ?? null } };
}

/** 自分の記録一覧（新しい順）。記録タブがサーバを正として描く（§5.4/§9.4）。 */
export async function listMyRecords(limit = 100): Promise<FnResult<SpotRecord[]>> {
  const uid = await currentUid();
  if (!uid) return fail('ログインしていません');
  const { data, error } = await supabase
    .from('results')
    .select(RESULT_SELECT)
    .eq('owner', uid)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return fail('記録を取得できませんでした');
  const rows = (data ?? []) as unknown as RawResultRow[];
  return { ok: true, data: rows.map(rowToRecord) };
}

/**
 * 記録をホームに公開する（SPEC §5.3 の公開レバー ON）。
 *
 * v2 は「結果画面で記録と公開を同時に行う」経路で公開のたびに新しい `results` 行を作っていたが
 * （旧 `feed.ts` の `publishResult`・v3 で削除）、v3 は計算開始時点で `results` 行が既に存在するため
 * それでは二重登録になる。ここでは既存の result 行を `is_public=true` に更新し、`threads` に1行
 * 挿入する（公開時の一言は `threads.body` に持たせる。§5.7 バグ修正の後日追記: 以前はこの一言を
 * `comments` 行として挿入していたため、フィードの `lead_comment`（スレッドの投稿者を問わず最初の
 * コメント）がスレッド内の**他人の返信**を拾ってしまうバグがあった。`threads.body` は投稿者本人
 * にしか書けない列なので、この経路のバグは構造的に起きない）。スレッド作成に失敗したら
 * `is_public` を戻し、公開されていないのに「公開中」に見える孤児状態を残さない。
 */
export async function publishRecord(
  resultId: string,
  comment: string,
): Promise<FnResult<{ thread_id: string }>> {
  const uid = await currentUid();
  if (!uid) return fail('ログインしていません');

  const { error: uerr } = await supabase.from('results').update({ is_public: true }).eq('id', resultId);
  if (uerr) return fail('公開に失敗しました');

  const { data: th, error: terr } = await supabase
    .from('threads')
    .insert({ kind: 'result', result_id: resultId, author: uid, body: comment.trim() || null })
    .select('id')
    .single();
  if (terr || !th) {
    // 巻き戻し（本人所有なので RLS で更新可）。
    await supabase.from('results').update({ is_public: false }).eq('id', resultId);
    return fail('公開に失敗しました（スレッドの作成）');
  }
  const threadId = (th as { id: string }).id;

  return { ok: true, data: { thread_id: threadId } };
}

/**
 * 記録の公開を取り消す（SPEC §5.3 の公開レバー OFF）。
 * その result に紐づく `threads` を削除する（コメント・♡は FK cascade で連動して消える）。
 * 記録自体（`results` 行）は残す。
 */
export async function unpublishRecord(resultId: string): Promise<FnResult<Record<string, never>>> {
  const { error: derr } = await supabase.from('threads').delete().eq('result_id', resultId);
  if (derr) return fail('公開の取り消しに失敗しました');
  const { error: uerr } = await supabase.from('results').update({ is_public: false }).eq('id', resultId);
  if (uerr) return fail('公開の取り消しに失敗しました');
  return { ok: true, data: {} };
}

/**
 * 失敗・中断した記録を再計算に回す（SPEC §5.4 の「再計算」）。
 * `status` を `solving` に戻し `error` を消す。呼び出し側（App.tsx）は保存済み `spot`
 * （`SpotRecord.state`）から Web Worker で解き直し、完了/失敗を `completeRecord`/`failRecord`
 * で書き戻す（新規の計算開始と同じ経路）。
 */
export async function retryRecord(id: string): Promise<FnResult<Record<string, never>>> {
  const { error } = await supabase.from('results').update({ status: 'solving', error: null }).eq('id', id);
  if (error) return fail('再計算の開始に失敗しました');
  return { ok: true, data: {} };
}

/**
 * 記録を削除。サーバ側の外部キーで `threads`（公開スレッド）は on delete cascade
 * のため連動して消える。`images`/`ocr_reads` 自体は削除されない（結果が消えても
 * OCR 改善データ基盤としての画像・読み取りログは残す方針, §12）。
 */
export async function deleteMyRecord(id: string): Promise<FnResult<Record<string, never>>> {
  // 連鎖削除する画像を先に控える（削除後は行が引けないため）。
  const { data: row } = await supabase.from('results').select('image_id').eq('id', id).single();
  const imageId = (row as { image_id: string | null } | null)?.image_id ?? null;

  const { error } = await supabase.from('results').delete().eq('id', id);
  if (error) return fail('記録を削除できませんでした');

  // 解析元スクショも消す（SPEC §5.4）。ただし OCR 失敗・低信頼の保護画像は
  // 精度改善の資産として残す（§7.2/§12。設定画面の「保存について」で明示する）。
  if (imageId) await deleteSpotImageUnlessProtected(imageId).catch(() => undefined);
  return { ok: true, data: {} };
}
