/**
 * 記録（履歴）の純ロジック層（SPEC v3 §5.3/§5.4/§5.7/§9.2, BETA_PLAN WP-B2）。
 *
 * ここには **IndexedDB を持ち込まない**（永続化は store.ts / ブラウザ実機で検証）。
 * hero の決定ノード選択・判定（PUSH/FOLD）・EV loss 導出・集計を集約し、
 * 結果画面（Result.tsx）と記録の両方が**同じ真実**を使う。Node で単体テストする。
 *
 * v3 で記録は「計算中 → 完了/失敗/中断」の状態を持ち、サーバ（results）が正になる
 * （§9.4）。旧 `buildRecord`（求解直後に heroAction を確定させて1発で保存する形）は
 * 後方互換のため残すが、非同期フローでは `startRecord`（計算開始時）→
 * `finishRecord`（計算完了時）の2段に分けて使う。自分の選択（heroAction）は
 * finishRecord の後、任意のタイミングで別途セットする（サーバ側は setHeroAction）。
 */

import type { BoardState } from '@oshihiki/core';
import type { SolveNodeDto, SolveResultDto } from '../solverProtocol';

/** 押し引きの2択。UI 表記は PU/CA/OC いずれでも "ALL IN"（SPEC §7.4）だが内部は PUSH。 */
export type HeroAction = 'PUSH' | 'FOLD';

/**
 * 未開（先手プッシュ）ノードか。上流にプッシュ/コールが無い＝自分が最初に動く決定。
 * Result.tsx の見出しノード選択と一致させるための単一の真実。
 */
export function isUnopened(n: SolveNodeDto): boolean {
  return n.actionType === 'PU' && !n.key.includes(':P') && !n.key.includes(':C');
}

/** hero の見出し決定ノード（未開プッシュ優先、無ければ先頭）。決定が無ければ null。 */
export function headlineNode(result: SolveResultDto): SolveNodeDto | null {
  const heroNodes = result.nodes.filter((n) => n.actor === result.heroPos);
  return heroNodes.find(isUnopened) ?? heroNodes[0] ?? null;
}

/** ノードの推奨判定（純化後頻度 ≥ 0.5 で PUSH）。Result 見出しと同一規則。 */
export function verdictOf(n: SolveNodeDto): HeroAction {
  return n.heroFreq >= 0.5 ? 'PUSH' : 'FOLD';
}

/**
 * 実際に取った行動の EV loss（実払い pt, ≥0）。
 * heroEv = EV(アグレッシブ) − EV(フォールド)。
 * - PUSH した: heroEv<0 なら本来フォールドが良く、|heroEv| を損した。
 * - FOLD した: heroEv>0 なら本来プッシュが良く、heroEv を損した。
 * 最適な選択なら 0。混合境界では |heroEv|≈0 なのでどちらでも損は≈0。
 */
export function evLossOf(heroEv: number, heroAction: HeroAction): number {
  return heroAction === 'PUSH' ? Math.max(0, -heroEv) : Math.max(0, heroEv);
}

/** 記録の状態（SPEC §5.7・§9.2 `results.status`）。 */
export type RecordStatus = 'solving' | 'done' | 'failed' | 'aborted';

/**
 * 1 局面の保存レコード。一覧表示用に非正規化し、再表示用に完全スナップショットを持つ。
 *
 * v3: 記録は自動・計算は非同期（§5.7）。`status` が `solving` の間は `result` が無く、
 * `heroAction`（自分の選択）は任意になった（未選択可）。サーバ（`results`）が正データで、
 * `clientId` はオフライン作成・再送の冪等キー（§9.4）。`verdict`/`heroEv` は見出しノードから
 * 導出できるまでの間（solving 中）は暫定値（'FOLD' / 0）を持つ（UI は `status` を見て
 * solving 行を別扱いするため実害はない）。
 */
export interface SpotRecord {
  id: string;
  createdAt: number;
  status: RecordStatus;
  // --- 一覧表示用（非正規化）---
  heroHand: string;
  heroPos: string;
  playersLeft: number;
  /** 推奨判定（見出しノード）。result 未確定の間は暫定 'FOLD'。 */
  verdict: HeroAction;
  /** 利用者が実際に取った行動。任意（未選択なら null, v3）。 */
  heroAction: HeroAction | null;
  /** 見出しノードの heroEv（アグレッシブ−フォールド, 実払い pt）。result 未確定の間は 0。 */
  heroEv: number;
  /** EV loss（≥0, 実払い pt）。heroAction が無ければ null（v3）。 */
  evLoss: number | null;
  /** ホームで公開するか（既定 false）。 */
  published: boolean;
  // --- 再表示用スナップショット ---
  state: BoardState;
  /** 求解結果。`status==='solving'` の間は null（v3）。 */
  result: SolveResultDto | null;
  ms: number;
  // --- サーバ同期（v3・§9.4）---
  /** サーバ側 `results.id`。ローカル専用でまだ同期していなければ未設定。 */
  serverId?: string;
  /** 端末が採番する冪等キー（オフライン作成・再送用）。 */
  clientId: string;
  /** サーバへの書込みが未完了（オフライン等）。 */
  pendingSync?: boolean;
  /** 失敗理由（`status==='failed'`）。 */
  error?: string;
  /** 解析元スクショ（`images.id`）。手入力なら未設定。 */
  imageId?: string;
  /** OCR 読み取り記録（`ocr_reads.id`）。 */
  ocrReadId?: string;
  /** ハンド履歴（SIT & GO）から投げた計算の出どころ。手入力・スクショなら未設定。
   *  この端末のローカル専用（サーバの `results` には送らない）。 */
  sngSource?: { readonly gameId: string; readonly handNo: number };
}

export interface BuildRecordInput {
  state: BoardState;
  result: SolveResultDto;
  ms: number;
  heroAction: HeroAction;
  /** ホームで公開するか（既定 false）。 */
  published?: boolean;
  /** 省略時は createdAt から採番（テストでは固定可）。 */
  id?: string;
  /** 省略時 Date.now()。 */
  createdAt?: number;
}

/**
 * 求解結果＋実行動から保存レコードを構築（純関数・後方互換）。
 * v2 までの「計算直後に heroAction を確定させて1発で保存する」経路。v3 の非同期フロー
 * （計算開始時に記録を作り、完了時に確定し、自分の選択は後から任意に選ぶ）では
 * `startRecord` / `finishRecord` を使う。この関数は常に `status:'done'` の完成レコードを返す。
 */
export function buildRecord(input: BuildRecordInput): SpotRecord {
  const { state, result, ms, heroAction } = input;
  const createdAt = input.createdAt ?? Date.now();
  const id = input.id ?? `spot-${createdAt}-${Math.random().toString(36).slice(2, 7)}`;
  const head = headlineNode(result);
  const heroEv = head?.heroEv ?? 0;
  const verdict = head ? verdictOf(head) : 'FOLD';
  const evLoss = evLossOf(heroEv, heroAction);
  return {
    id,
    createdAt,
    status: 'done',
    heroHand: result.heroHand,
    heroPos: result.heroPos,
    playersLeft: result.playersLeft,
    verdict,
    heroAction,
    heroEv,
    evLoss,
    published: input.published ?? false,
    state,
    result,
    ms,
    clientId: id,
    pendingSync: false,
  };
}

export interface StartRecordInput {
  /** 端末が採番する冪等キー（サーバの `results.client_id` と同じ値）。 */
  clientId: string;
  state: BoardState;
  heroHand: string;
  heroPos: string;
  playersLeft: number;
  imageId?: string;
  ocrReadId?: string;
  /** ハンド履歴（SIT & GO）から投げた計算の出どころ。手入力・スクショなら未設定。 */
  sngSource?: { readonly gameId: string; readonly handNo: number };
  /** 省略時は createdAt から採番（テストでは固定可）。 */
  id?: string;
  /** 省略時 Date.now()。 */
  createdAt?: number;
}

/**
 * 計算開始時点の「計算中」レコードを構築（純関数, v3・§5.7）。
 * `createSolvingRecord` でサーバへ挿入した直後、同じ内容をローカルにも書くために使う
 * （サーバの `id` が返ってくれば呼び出し側で `serverId` を埋める）。
 */
export function startRecord(input: StartRecordInput): SpotRecord {
  const createdAt = input.createdAt ?? Date.now();
  const id = input.id ?? `spot-${createdAt}-${Math.random().toString(36).slice(2, 7)}`;
  return {
    id,
    createdAt,
    status: 'solving',
    heroHand: input.heroHand,
    heroPos: input.heroPos,
    playersLeft: input.playersLeft,
    verdict: 'FOLD',
    heroAction: null,
    heroEv: 0,
    evLoss: null,
    published: false,
    state: input.state,
    result: null,
    ms: 0,
    clientId: input.clientId,
    pendingSync: false,
    imageId: input.imageId,
    ocrReadId: input.ocrReadId,
    sngSource: input.sngSource,
  };
}

export interface FinishRecordInput {
  result: SolveResultDto;
  ms: number;
}

/**
 * 「計算中」レコードに求解結果を確定させる（純関数, v3・§5.7）。
 * `heroAction`/`evLoss`/`published` はここでは触らない（自分の選択・公開は別操作で
 * 後から確定するため。§5.3）。
 */
export function finishRecord(rec: SpotRecord, input: FinishRecordInput): SpotRecord {
  const head = headlineNode(input.result);
  return {
    ...rec,
    status: 'done',
    result: input.result,
    ms: input.ms,
    verdict: head ? verdictOf(head) : 'FOLD',
    heroEv: head?.heroEv ?? 0,
  };
}

export interface RecordStats {
  count: number;
  /** EV loss の累計（実払い pt）。 */
  totalEvLoss: number;
}

/**
 * 記録一覧の集計（SPEC §5.4）。
 * 件数は `status==='done'` の記録のみ。EV loss 累計は「done かつ自分の選択がある」
 * 記録のみを足し込む（未選択・計算中/失敗は集計に入れない）。
 */
export function aggregate(records: readonly SpotRecord[]): RecordStats {
  let count = 0;
  let totalEvLoss = 0;
  for (const r of records) {
    if (r.status !== 'done') continue;
    count++;
    if (r.heroAction != null && r.evLoss != null) totalEvLoss += r.evLoss;
  }
  return { count, totalEvLoss };
}
