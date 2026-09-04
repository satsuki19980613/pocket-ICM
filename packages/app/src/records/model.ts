/**
 * 記録（履歴）の純ロジック層（SPEC §7.3, Phase 3-2）。
 *
 * ここには **IndexedDB を持ち込まない**（永続化は store.ts / ブラウザ実機で検証）。
 * hero の決定ノード選択・判定（PUSH/FOLD）・EV loss 導出・集計を集約し、
 * 結果画面（Result.tsx）と記録の両方が**同じ真実**を使う。Node で単体テストする。
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

/** 1 局面の保存レコード。一覧表示用に非正規化し、再表示用に完全スナップショットを持つ。 */
export interface SpotRecord {
  id: string;
  createdAt: number;
  // --- 一覧表示用（非正規化）---
  heroHand: string;
  heroPos: string;
  playersLeft: number;
  /** 推奨判定（見出しノード）。 */
  verdict: HeroAction;
  /** 利用者が実際に取った行動。 */
  heroAction: HeroAction;
  /** 見出しノードの heroEv（アグレッシブ−フォールド, 実払い pt）。 */
  heroEv: number;
  /** EV loss（≥0, 実払い pt）。 */
  evLoss: number;
  /** ホームで公開するか（既定 false）。M4 ではローカルフラグ、クラウド反映は M6。 */
  published: boolean;
  // --- 再表示用スナップショット ---
  state: BoardState;
  result: SolveResultDto;
  ms: number;
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

/** 求解結果＋実行動から保存レコードを構築（純関数）。 */
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
  };
}

export interface RecordStats {
  count: number;
  /** EV loss の累計（実払い pt）。 */
  totalEvLoss: number;
}

/** 記録一覧の集計（件数・EV loss 累計）。 */
export function aggregate(records: readonly SpotRecord[]): RecordStats {
  let totalEvLoss = 0;
  for (const r of records) totalEvLoss += r.evLoss;
  return { count: records.length, totalEvLoss };
}
