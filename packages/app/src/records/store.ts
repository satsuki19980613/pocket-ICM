/**
 * 記録の永続化層（IndexedDB, ブラウザ専用, SPEC §7.3 / §8）。
 *
 * 依存ゼロ方針のため idb 等は使わず、生 IndexedDB を薄く Promise でラップする。
 * Node（Vitest）には IndexedDB が無いので、この層は**ブラウザ実機（preview）で検証**する
 * （decodeImage.ts と同様の browser-only グルー）。純ロジックは model.ts 側でテスト済み。
 */

import type { SpotRecord } from './model';

const DB_NAME = 'blackops-icm';
const STORE = 'spots';
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
        os.createIndex('createdAt', 'createdAt', { unique: false });
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

/** レコードを保存（同一 id は上書き）。 */
export function putRecord(rec: SpotRecord): Promise<void> {
  return tx('readwrite', async (os) => {
    await reqToPromise(os.put(rec));
  });
}

/** 全レコードを createdAt 降順（新しい順）で取得。 */
export function listRecords(): Promise<SpotRecord[]> {
  return tx('readonly', async (os) => {
    const all = (await reqToPromise(os.getAll())) as SpotRecord[];
    return all.sort((a, b) => b.createdAt - a.createdAt);
  });
}

/** id 指定でレコードを削除。 */
export function deleteRecord(id: string): Promise<void> {
  return tx('readwrite', async (os) => {
    await reqToPromise(os.delete(id));
  });
}
