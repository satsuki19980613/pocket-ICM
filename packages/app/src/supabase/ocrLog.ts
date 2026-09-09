/**
 * OCR 改善データ基盤（SPEC v3 §9.3 / §12, BETA_PLAN WP-B2）。
 *
 * OCR を通した画像は成功・失敗を問わず `ocr_reads` に1行記録する。`raw_reads` は
 * 席ごとの生読み取り（値＋信頼度）を固定スキーマで丸ごと保持するもので、その型は
 * WP-A2（`packages/ocr/src/readout.ts` の `OcrReadout`）が並行して定義中のため、
 * ここでは依存を作らず `unknown` として JSON にそのまま渡す（Supabase 側は jsonb なので
 * 型を問わない）。
 *
 * `corrections`（OCR 出力 → 実際に計算へ使われた最終入力の差分）は OCR 精度改善の
 * 暗黙の正解ラベルになるため、`diffStates` として純関数化しテストする（§12.1）。
 */

import type { BoardState, SeatState } from '@oshihiki/core';
import { supabase } from './client';
import type { FnResult } from './api';

function fail(message: string): { ok: false; error: string; message: string } {
  return { ok: false, error: 'ocr_log_error', message };
}

async function currentUid(): Promise<string | null> {
  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}

// ---------------------------------------------------------------------------
// 純ロジック（単体テスト対象）: OCR state → 最終 state の差分
// ---------------------------------------------------------------------------

/** 席ごとの差分（1フィールド1件）。`field:'state'` は在席/フォールド/オールイン等の変化を表す。 */
export interface SeatCorrection {
  pos: string;
  field: 'stack' | 'bet' | 'state';
  from: number | SeatState;
  to: number | SeatState;
}

interface ValueDiff<T> {
  from: T;
  to: T;
}

/** OCR 出力（`a`）→ 実際に計算に使われた最終入力（`b`）の差分。空なら無修正。 */
export interface OcrCorrections {
  playersLeft?: ValueDiff<number>;
  heroPos?: ValueDiff<string>;
  heroHand?: ValueDiff<string>;
  blinds?: { sb?: ValueDiff<number>; bb?: ValueDiff<number> };
  ante?: { scheme?: ValueDiff<string>; amount?: ValueDiff<number> };
  seats: SeatCorrection[];
}

/**
 * OCR が復元した `state`（a）と、実際に条件確認画面を経て計算に使われた `state`（b）を
 * 比較し、利用者がどこを直したかを構造化して返す（純関数）。
 * 人数・hero ポジション・ハンド・ブラインド・アンティ・各席の stack/bet/state
 * （在席=occupancy とアクションはこの `state` に含まれる）を取りこぼさず拾う。
 */
export function diffStates(a: BoardState, b: BoardState): OcrCorrections {
  const seats: SeatCorrection[] = [];
  const positions = new Set<string>([...a.seats.map((s) => s.pos), ...b.seats.map((s) => s.pos)]);
  for (const pos of positions) {
    const sa = a.seats.find((s) => s.pos === pos);
    const sb = b.seats.find((s) => s.pos === pos);
    const stateA: SeatState = sa?.state ?? 'empty';
    const stateB: SeatState = sb?.state ?? 'empty';
    if (stateA !== stateB) seats.push({ pos, field: 'state', from: stateA, to: stateB });
    const stackA = sa?.stack ?? 0;
    const stackB = sb?.stack ?? 0;
    if (stackA !== stackB) seats.push({ pos, field: 'stack', from: stackA, to: stackB });
    const betA = sa?.bet ?? 0;
    const betB = sb?.bet ?? 0;
    if (betA !== betB) seats.push({ pos, field: 'bet', from: betA, to: betB });
  }

  const out: OcrCorrections = { seats };
  if (a.playersLeft !== b.playersLeft) out.playersLeft = { from: a.playersLeft, to: b.playersLeft };
  if (a.heroPos !== b.heroPos) out.heroPos = { from: a.heroPos, to: b.heroPos };
  if (a.heroHand !== b.heroHand) out.heroHand = { from: a.heroHand, to: b.heroHand };

  const blinds: NonNullable<OcrCorrections['blinds']> = {};
  if (a.blinds.sb !== b.blinds.sb) blinds.sb = { from: a.blinds.sb, to: b.blinds.sb };
  if (a.blinds.bb !== b.blinds.bb) blinds.bb = { from: a.blinds.bb, to: b.blinds.bb };
  if (Object.keys(blinds).length > 0) out.blinds = blinds;

  const ante: NonNullable<OcrCorrections['ante']> = {};
  if (a.ante.scheme !== b.ante.scheme) ante.scheme = { from: a.ante.scheme, to: b.ante.scheme };
  if (a.ante.amount !== b.ante.amount) ante.amount = { from: a.ante.amount, to: b.ante.amount };
  if (Object.keys(ante).length > 0) out.ante = ante;

  return out;
}

// ---------------------------------------------------------------------------
// Supabase 配線
// ---------------------------------------------------------------------------

export interface OcrDevice {
  ua: string;
  dpr: number;
  w: number;
  h: number;
  aspect: number;
}

export interface LogOcrReadInput {
  /**
   * 解析に使った画像（`images.id`）。**任意**: 画像のアップロードに失敗しても
   * 読み取りログ自体は残す（失敗の統計を落とさないため。SPEC §12.1・`ocr_reads.image_id` は null 可）。
   */
  imageId?: string | null;
  ok: boolean;
  displayMode?: string;
  street?: string;
  issues: string[];
  issueCodes: string[];
  lowConfidence: string[];
  /** 席ごとの生読み取り全量（§12.2 固定スキーマ）。型は WP-A2 側で定義中のため unknown。 */
  rawReads: unknown;
  /** 復元できた state（成功時のみ）。 */
  state?: BoardState | null;
  device: OcrDevice;
  appVersion?: string;
  ocrVersion?: string;
}

/** OCR を通した画像1件を `ocr_reads` に記録する（成功・失敗を問わず呼ぶ）。 */
export async function logOcrRead(input: LogOcrReadInput): Promise<FnResult<{ id: string }>> {
  const uid = await currentUid();
  if (!uid) return fail('ログインしていません');
  const { data, error } = await supabase
    .from('ocr_reads')
    .insert({
      owner: uid,
      image_id: input.imageId ?? null,
      ok: input.ok,
      display_mode: input.displayMode ?? null,
      street: input.street ?? null,
      issues: input.issues,
      issue_codes: input.issueCodes,
      low_confidence: input.lowConfidence,
      raw_reads: input.rawReads,
      state: input.state ?? null,
      device: input.device,
      app_version: input.appVersion ?? null,
      ocr_version: input.ocrVersion ?? null,
    })
    .select('id')
    .single();
  if (error || !data) return fail('OCR 読み取りの記録に失敗しました');
  return { ok: true, data: { id: (data as { id: string }).id } };
}

/**
 * 実際に計算へ使われた最終入力と、OCR 出力からの差分を後追いで記録する
 * （条件確認画面で修正が確定した時点、または計算開始時に呼ぶ）。
 */
export async function attachFinalState(
  ocrReadId: string,
  finalState: BoardState,
  corrections: OcrCorrections,
): Promise<FnResult<Record<string, never>>> {
  const { error } = await supabase
    .from('ocr_reads')
    .update({ final_state: finalState, corrections })
    .eq('id', ocrReadId);
  if (error) return fail('最終入力の記録に失敗しました');
  return { ok: true, data: {} };
}
