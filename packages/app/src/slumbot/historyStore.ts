/**
 * Slumbot HU ハンド履歴の端末側の保存（IndexedDB・ブラウザ専用, SPEC §7.4.6）。
 *
 * records/store.ts と同じ流儀（依存ゼロ・生 IndexedDB を薄く Promise で包む）。
 * DB は記録タブ（`blackops-icm`）とは別にする——あちらの版番号や onupgradeneeded に
 * 手を入れずに済ませるため。**端末が正**で、サーバ（hu_hands）は控え（historySync.ts）。
 *
 * Node（Vitest）には IndexedDB が無いので、この層はブラウザ実機（preview）で検証する。
 */

import { isHandRecord, type HuHandRecord } from './history';

const DB_NAME = 'blackops-icm-hu';
const STORE = 'hands';
const VERSION = 1;

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'id' });
        os.createIndex('playedAt', 'playedAt', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (os: IDBObjectStore) => Promise<T>): Promise<T> {
  const db = await openDb();
  try {
    const store = db.transaction(STORE, mode).objectStore(STORE);
    return await fn(store);
  } finally {
    db.close();
  }
}

/** 1 件保存（同一 id は上書き）。 */
export function putHand(rec: HuHandRecord): Promise<void> {
  return tx('readwrite', async (os) => {
    await reqToPromise(os.put(rec));
  });
}

/** まとめて保存（1 トランザクション）。 */
export function putHands(recs: readonly HuHandRecord[]): Promise<void> {
  if (recs.length === 0) return Promise.resolve();
  return tx('readwrite', async (os) => {
    for (const r of recs) os.put(r);
    await new Promise<void>((resolve, reject) => {
      os.transaction.oncomplete = () => resolve();
      os.transaction.onerror = () => reject(os.transaction.error);
      os.transaction.onabort = () => reject(os.transaction.error);
    });
  });
}

/** 全件を playedAt 昇順で。形の崩れたものは読み飛ばす。 */
export function listHands(): Promise<HuHandRecord[]> {
  return tx('readonly', async (os) => {
    const all = (await reqToPromise(os.index('playedAt').getAll())) as unknown[];
    return all.filter(isHandRecord);
  });
}

/** まだサーバへ送っていないもの。 */
export async function listUnsynced(): Promise<HuHandRecord[]> {
  const all = await listHands();
  return all.filter((r) => !r.synced);
}

/** 送信済みの印を付ける。 */
export function markSynced(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return Promise.resolve();
  const want = new Set(ids);
  return tx('readwrite', async (os) => {
    const all = (await reqToPromise(os.getAll())) as unknown[];
    for (const r of all) {
      if (isHandRecord(r) && want.has(r.id) && !r.synced) os.put({ ...r, synced: true });
    }
    await new Promise<void>((resolve, reject) => {
      os.transaction.oncomplete = () => resolve();
      os.transaction.onerror = () => reject(os.transaction.error);
      os.transaction.onabort = () => reject(os.transaction.error);
    });
  });
}

export function countHands(): Promise<number> {
  return tx('readonly', (os) => reqToPromise(os.count()));
}

/** 端末の履歴を全部消す（サーバの控えは消さない）。 */
export function clearHands(): Promise<void> {
  return tx('readwrite', async (os) => {
    await reqToPromise(os.clear());
  });
}
