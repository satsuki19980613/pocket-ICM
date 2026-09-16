/**
 * ICM 計算の順番待ち（計算キュー）。純ロジックのみ（`solveJob.ts` と同じ位置づけ）。
 *
 * **これは契約ファイル**（型・不変条件の定義）で、実装は下の TODO を埋めて完成させる。
 *
 * 背景: 求解は「同時に1件だけ」（SPEC §5.7 の3・`solveJob.ts`）。ハンド履歴から
 * 複数のハンドを続けて投げられるようにするため、**走らせるのは1件のまま**、順番待ちの
 * 行列だけを足す。`SolveJob` の単一スロットはそのまま（＝既存の「計算中は写真・手入力を
 * 受け付けない」挙動は変えない）。
 *
 * 行列は**メモリだけ**に持つ（IndexedDB にもサーバにも書かない）。リロードで計算中の
 * ジョブが消えるのと同じ理屈で、待ち行列も消えてよい（消えても記録は作られていないので
 * 中途半端な行が残らない＝むしろ安全）。
 */

import type { BoardState } from '@oshihiki/core';
import { icmSpotKey } from './history/icmSpot';

/** 1 ハンドの ICM 計算要求（キーを付ける前の形。画面側から渡ってくる）。 */
export interface IcmQueueRequest {
  readonly gameId: string;
  readonly handNo: number;
  /** ソルバーへの入力（`history/icmSpot.ts` の `sngIcmSpot` が組み立てたもの）。 */
  readonly state: BoardState;
  readonly heroHand: string;
  readonly heroPos: string;
  readonly playersLeft: number;
}

/** 行列の1要素。`key` は `icmSpotKey(gameId, handNo)`（同じハンドの二重登録を防ぐ）。 */
export interface IcmQueueItem extends IcmQueueRequest {
  readonly key: string;
}

/**
 * 1 ハンドの ICM 計算の状態（ボタンの見た目はこれだけで決まる）。
 *   none    … 未登録（押せる）
 *   queued  … 順番待ち
 *   running … いま計算中
 *   done    … 計算済み（記録がある＝押すと結果へ）
 */
export type IcmHandStatus = 'none' | 'queued' | 'running' | 'done';

/** 行列の上限（押し続けて無制限に溜まらないように）。 */
export const ICM_QUEUE_MAX = 20;

/**
 * 末尾に足す。同じ `key` が既にあれば足さない（`added:false`）。
 * 上限に達していたら足さず `full:true`（呼び出し側はトーストで知らせる）。
 * 純関数なので配列は常に新しく作る（引数の `queue` は書き換えない）。
 */
export function enqueueIcm(
  queue: readonly IcmQueueItem[],
  req: IcmQueueRequest,
): { queue: IcmQueueItem[]; added: boolean; full: boolean } {
  const key = icmSpotKey(req.gameId, req.handNo);
  if (queue.some((it) => it.key === key)) {
    return { queue: [...queue], added: false, full: false };
  }
  if (queue.length >= ICM_QUEUE_MAX) {
    return { queue: [...queue], added: false, full: true };
  }
  return { queue: [...queue, { ...req, key }], added: true, full: false };
}

/** 先頭を取り出す（空なら `item:null`）。 */
export function dequeueIcm(queue: readonly IcmQueueItem[]): {
  queue: IcmQueueItem[];
  item: IcmQueueItem | null;
} {
  const [item, ...rest] = queue;
  return { queue: rest, item: item ?? null };
}

/** その `key` が行列にいるか。 */
export function hasIcmKey(queue: readonly IcmQueueItem[], key: string): boolean {
  return queue.some((it) => it.key === key);
}

/**
 * 画面（`SngHistoryView`）に渡す ICM 計算の窓口。App 側が実体を持つ。
 * 画面は「対象かどうか」を `history/icmSpot.ts` で自分で判定し、対象なら `onQueue` を呼ぶ。
 */
export interface SngHistoryIcm {
  /** そのハンドの現在の状態（ボタンの表示はこれで決まる）。 */
  readonly statusOf: (gameId: string, handNo: number) => IcmHandStatus;
  /** 計算キューへ登録する。 */
  readonly onQueue: (req: IcmQueueRequest) => void;
  /** 計算済みハンドの結果画面を開く。 */
  readonly onOpenResult: (gameId: string, handNo: number) => void;
}
