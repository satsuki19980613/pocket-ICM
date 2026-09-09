/**
 * 記録の永続化層（IndexedDB, ブラウザ専用, SPEC v3 §5.4 / §9.4）。
 *
 * 依存ゼロ方針のため idb 等は使わず、生 IndexedDB を薄く Promise でラップする。
 * Node（Vitest）には IndexedDB が無いので、この層は**ブラウザ実機（preview）で検証**する
 * （decodeImage.ts と同様の browser-only グルー）。純ロジックは model.ts 側でテスト済み。
 *
 * v3: サーバ（results）が正・ここはキャッシュ（§9.3/§9.4）。DB は v2 へ上げ、
 * `clientId`（サーバ再送の冪等キー）に索引を張る。v1 の既存レコード（`heroAction` 必須・
 * `status` 無し・`clientId` 無し）は読み出し時に `status:'done'`, `clientId:id`,
 * `pendingSync:false` を補って返す（マイグレーション。書き戻しはしない＝副作用ゼロで
 * 既存データを壊さない）。
 */

import type { SpotRecord } from './model';

const DB_NAME = 'blackops-icm';
const STORE = 'spots';
const VERSION = 2;

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
      const os = db.objectStoreNames.contains(STORE)
        ? req.transaction!.objectStore(STORE)
        : db.createObjectStore(STORE, { keyPath: 'id' });
      if (!os.indexNames.contains('createdAt')) {
        os.createIndex('createdAt', 'createdAt', { unique: false });
      }
      // v2: clientId 索引（v1 の既存行は clientId を持たないため索引には乗らないが、
      // getAll() による一覧取得・id 指定の get/delete には影響しない）。
      if (!os.indexNames.contains('clientId')) {
        os.createIndex('clientId', 'clientId', { unique: false });
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

/**
 * v1 レコード（`heroAction` 必須・`status`/`clientId` 無し）を v2 形へ補完する
 * （読み出し時マイグレーション）。v2 で保存済みのレコードはそのまま通す。
 */
function migrateV1(raw: unknown): SpotRecord {
  const rec = raw as SpotRecord;
  if (typeof rec.status === 'string' && typeof rec.clientId === 'string') return rec;
  return {
    ...rec,
    status: rec.status ?? 'done',
    clientId: rec.clientId ?? rec.id,
    pendingSync: rec.pendingSync ?? false,
  };
}

/** レコードを保存（同一 id は上書き）。 */
export function putRecord(rec: SpotRecord): Promise<void> {
  return tx('readwrite', async (os) => {
    await reqToPromise(os.put(rec));
  });
}

/** 全レコードを createdAt 降順（新しい順）で取得。v1 データは読み出し時に補完する。 */
export function listRecords(): Promise<SpotRecord[]> {
  return tx('readonly', async (os) => {
    const all = (await reqToPromise(os.getAll())) as unknown[];
    return all.map(migrateV1).sort((a, b) => b.createdAt - a.createdAt);
  });
}

/** id 指定でレコードを削除。 */
export function deleteRecord(id: string): Promise<void> {
  return tx('readwrite', async (os) => {
    await reqToPromise(os.delete(id));
  });
}
