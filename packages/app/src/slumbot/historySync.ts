/**
 * ハンド履歴の同期（端末 IndexedDB ⇄ サーバ hu_hands, SPEC §7.4.6）。
 *
 *   1. 端末で synced=false のものをサーバへ upsert → 印を付ける
 *   2. サーバの created_at カーソルより後の行を引いて端末へ入れる（別端末で打った分の復元）
 *
 * huStats.ts の flushPending と同じく、同時に呼ばれても 1 本に直列化する（対局中に
 * Stats を開くと、ハンド終了時の同期と画面の同期が重なるため）。失敗しても対局は
 * 続けられる——端末が正なので、次に送れたときにまとめて追いつく。
 */

import { fetchHandsAfter, pushHands } from '../supabase/huHands';
import { listHands, listUnsynced, markSynced, putHands } from './historyStore';
import type { HuHandRecord } from './history';

const CURSOR_KEY = 'icm.slumbot.hands.cursor.v1';
const PAGE = 1000;

type Store = Pick<Storage, 'getItem' | 'setItem'>;

export interface SyncResult {
  readonly pushed: number;
  readonly pulled: number;
  /** サーバに届かなかった（圏外・未ログイン等）。端末の履歴はそのまま。 */
  readonly offline: boolean;
}

function readCursor(store: Store | null): string | null {
  try {
    return store?.getItem(CURSOR_KEY) ?? null;
  } catch {
    return null;
  }
}

function writeCursor(store: Store | null, v: string): void {
  try {
    store?.setItem(CURSOR_KEY, v);
  } catch {
    /* 保存領域が使えなくても次回引き直すだけ。 */
  }
}

let inFlight: Promise<SyncResult> | null = null;
let queued = false;

export function syncHands(store: Store | null): Promise<SyncResult> {
  if (inFlight) {
    queued = true;
    return inFlight;
  }
  queued = false;
  inFlight = (async () => {
    let r = await runSync(store);
    while (queued) {
      queued = false;
      const again = await runSync(store);
      r = { pushed: r.pushed + again.pushed, pulled: r.pulled + again.pulled, offline: again.offline };
    }
    return r;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runSync(store: Store | null): Promise<SyncResult> {
  let pushed = 0;
  let pulled = 0;

  // ---- 1. push ----
  const unsynced = await listUnsynced();
  if (unsynced.length > 0) {
    const r = await pushHands(unsynced);
    if (!r.ok) return { pushed: 0, pulled: 0, offline: true };
    await markSynced(unsynced.map((x) => x.id));
    pushed = r.data.pushed;
  }

  // ---- 2. pull ----
  let cursor = readCursor(store);
  let known: Map<string, HuHandRecord> | null = null;
  for (;;) {
    const r = await fetchHandsAfter(cursor, PAGE);
    if (!r.ok) return { pushed, pulled, offline: true };
    if (r.data.length === 0) break;
    if (!known) known = new Map((await listHands()).map((x) => [x.id, x]));
    const toPut: HuHandRecord[] = [];
    for (const { rec } of r.data) {
      const local = known.get(rec.id);
      // 端末で計算済みの EV をサーバの null で潰さない。
      const merged: HuHandRecord =
        local && rec.evWinnings === null && local.evWinnings !== null
          ? { ...rec, evWinnings: local.evWinnings, synced: local.synced }
          : rec;
      if (!local || local.synced) {
        // 端末に未送信の変更が残っているものは、次の push で勝たせる（ここでは触らない）。
        toPut.push(merged);
        known.set(rec.id, merged);
        if (!local) pulled += 1;
      }
    }
    await putHands(toPut);
    cursor = r.data[r.data.length - 1]!.createdAt;
    writeCursor(store, cursor);
    if (r.data.length < PAGE) break;
  }

  return { pushed, pulled, offline: false };
}
