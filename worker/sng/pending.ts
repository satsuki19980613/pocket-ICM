/**
 * DB 書き込み失敗の再送キュー（Table DO の `ctx.storage` に置く）。docs/SNG_DESIGN.md §2。
 *
 * ハンド確定・試合終了のたびに Supabase へ upsert するが、失敗（ネットワーク・一時的な
 * Supabase 障害）したら諦めずここに積み、alarm のたびに先頭から再送する。24 時間を過ぎたものは
 * 捨てる（`dropExpired` は純関数・単体テスト対象）。
 *
 * `encodeHand` 自体が失敗するケース（実装が無い・バグ）はここでは扱わない
 * （table.ts 側で握りつぶしてログするだけ＝リトライしても直らないため）。
 */
import type { SngGameResult, SngHandRecord } from '@oshihiki/sng';

export type PendingWrite =
  | {
      readonly kind: 'hand';
      readonly record: SngHandRecord;
      readonly encoded: string;
      readonly holes: Readonly<Record<string, readonly [string, string]>>;
      readonly queuedAt: number;
    }
  | { readonly kind: 'game'; readonly result: SngGameResult; readonly queuedAt: number };

const KEY = 'pendingWrites';
export const PENDING_TTL_MS = 24 * 60 * 60_000;

export async function loadPending(storage: DurableObjectStorage): Promise<PendingWrite[]> {
  return (await storage.get<PendingWrite[]>(KEY)) ?? [];
}

export async function savePending(storage: DurableObjectStorage, items: readonly PendingWrite[]): Promise<void> {
  await storage.put(KEY, items);
}

export async function enqueuePending(storage: DurableObjectStorage, item: PendingWrite): Promise<void> {
  const items = await loadPending(storage);
  items.push(item);
  await savePending(storage, items);
}

/** `queuedAt` から `ttlMs`（既定 24h）を過ぎたものを捨てる（純関数）。 */
export function dropExpired(items: readonly PendingWrite[], now: number, ttlMs: number = PENDING_TTL_MS): readonly PendingWrite[] {
  return items.filter((it) => now - it.queuedAt <= ttlMs);
}
