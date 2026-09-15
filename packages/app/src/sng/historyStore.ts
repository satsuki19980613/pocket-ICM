/**
 * SIT & GO ハンド履歴・成績の端末側の保存（IndexedDB・ブラウザ専用, docs/SNG_DESIGN.md §3）。
 *
 * `slumbot/historyStore.ts` と同じ流儀（依存ゼロ・生 IndexedDB を薄く Promise で包む）。
 * DB は Slumbot 用（`blackops-icm-hu`）とは別にする。
 *
 * Slumbot 版と向きが逆: SIT & GO は**サーバー（DO）だけが書く**ので、端末は
 * サーバの控えを引いて溜めるだけ（push は無い。historySync.ts）。ここではキー付けと
 * 読み書きだけを担い、同期のロジックは持たない。
 *
 * ハンドの値はサーバの列をほぼそのまま並べたもの＋分かれば自分の席・手札。圧縮表現
 * （`encoded`）のデコードはここでは行わない（表示時に `@oshihiki/sng` の `decodeHand` を
 * 呼ぶ。担当 A1 の実装待ちなので、呼び出し側は失敗を許容すること）。
 *
 * Node（Vitest）には IndexedDB が無いので、この層はブラウザ実機（preview）で検証する
 * （Slumbot 版と同じ理由でテストを持たない）。
 */

import type { GameMode } from '@oshihiki/core';
import type { SngConfig } from '@oshihiki/sng';

const DB_NAME = 'blackops-icm-sng';
const HANDS_STORE = 'hands';
const RESULTS_STORE = 'results';
const GAMES_STORE = 'games';
/** v2: `games` ストアを追加（`sng_games` の控え。席の表示名の唯一の材料）。 */
const VERSION = 2;

export interface SngHandLocal {
  readonly gameId: string;
  readonly handNo: number;
  readonly playedAt: number;
  readonly level: number;
  readonly sb: number;
  readonly bb: number;
  readonly ante: number;
  /** 圧縮表現 v1（`@oshihiki/sng` の decodeHand で戻す）。 */
  readonly encoded: string;
  /** 分かっていれば自分の席（`sng_results` の seat から。参加順の推測はしない）。 */
  readonly mySeat: number | null;
  /** `sng_hole_cards` の自分の手札（ショーダウンで公開された分とは別）。 */
  readonly myCards: readonly [string, string] | null;
}

export interface SngResultLocal {
  readonly gameId: string;
  readonly owner: string;
  readonly seat: number;
  readonly place: number;
  readonly pt: number;
  readonly players: number;
  readonly mode: GameMode;
  readonly endedAt: number;
}

/** 席順の表示名（`sng_games.seats` の 1 要素）。 */
export interface SngGameSeatLocal {
  readonly seat: number;
  readonly userId: string;
  readonly name: string;
}

/**
 * `sng_games` の控え（`supabase/sngGames.ts` の `SngGameRecord` と同じ形）。相手の
 * 表示名・試合の設定（人数・開始bb・構造・上昇間隔・モード）の唯一の材料。
 */
export interface SngGameLocal {
  readonly gameId: string;
  readonly config: SngConfig;
  /** このカラム追加前に終わった試合は空配列（表示側は `Seat n` にフォールバックする）。 */
  readonly seats: readonly SngGameSeatLocal[];
  readonly status: 'finished' | 'cancelled';
  readonly startedAt: number | null;
  readonly endedAt: number;
  readonly hands: number;
}

/** IndexedDB のキー（ゲーム内の並びで自然にソートされるよう 0 埋め）。 */
export function handKey(gameId: string, handNo: number): string {
  return `${gameId}:${String(handNo).padStart(4, '0')}`;
}

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
      if (!db.objectStoreNames.contains(HANDS_STORE)) {
        const os = db.createObjectStore(HANDS_STORE);
        os.createIndex('playedAt', 'playedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(RESULTS_STORE)) {
        const os = db.createObjectStore(RESULTS_STORE);
        os.createIndex('endedAt', 'endedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(GAMES_STORE)) {
        const os = db.createObjectStore(GAMES_STORE);
        os.createIndex('endedAt', 'endedAt', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(store: string, mode: IDBTransactionMode, fn: (os: IDBObjectStore) => Promise<T>): Promise<T> {
  const db = await openDb();
  try {
    const os = db.transaction(store, mode).objectStore(store);
    return await fn(os);
  } finally {
    db.close();
  }
}

function waitDone(os: IDBObjectStore): Promise<void> {
  return new Promise((resolve, reject) => {
    os.transaction.oncomplete = () => resolve();
    os.transaction.onerror = () => reject(os.transaction.error);
    os.transaction.onabort = () => reject(os.transaction.error);
  });
}

function isHandLocal(v: unknown): v is SngHandLocal {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  const cardsOk = (x: unknown): boolean =>
    x === null || (Array.isArray(x) && x.length === 2 && x.every((c) => typeof c === 'string'));
  return (
    typeof o.gameId === 'string' &&
    o.gameId.length > 0 &&
    typeof o.handNo === 'number' &&
    Number.isInteger(o.handNo) &&
    typeof o.playedAt === 'number' &&
    Number.isFinite(o.playedAt) &&
    typeof o.level === 'number' &&
    typeof o.sb === 'number' &&
    typeof o.bb === 'number' &&
    typeof o.ante === 'number' &&
    typeof o.encoded === 'string' &&
    (o.mySeat === null || typeof o.mySeat === 'number') &&
    cardsOk(o.myCards)
  );
}

function isSeatLocal(v: unknown): v is SngGameSeatLocal {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.seat === 'number' && typeof o.userId === 'string' && typeof o.name === 'string';
}

function isGameLocal(v: unknown): v is SngGameLocal {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.gameId === 'string' &&
    o.gameId.length > 0 &&
    typeof o.config === 'object' &&
    o.config !== null &&
    Array.isArray(o.seats) &&
    o.seats.every(isSeatLocal) &&
    (o.status === 'finished' || o.status === 'cancelled') &&
    (o.startedAt === null || typeof o.startedAt === 'number') &&
    typeof o.endedAt === 'number' &&
    Number.isFinite(o.endedAt) &&
    typeof o.hands === 'number'
  );
}

function isResultLocal(v: unknown): v is SngResultLocal {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.gameId === 'string' &&
    o.gameId.length > 0 &&
    typeof o.owner === 'string' &&
    typeof o.seat === 'number' &&
    typeof o.place === 'number' &&
    typeof o.pt === 'number' &&
    typeof o.players === 'number' &&
    typeof o.mode === 'string' &&
    typeof o.endedAt === 'number' &&
    Number.isFinite(o.endedAt)
  );
}

/** まとめて保存（同じキーは上書き）。1 トランザクション。 */
export function putHands(recs: readonly SngHandLocal[]): Promise<void> {
  if (recs.length === 0) return Promise.resolve();
  return tx(HANDS_STORE, 'readwrite', async (os) => {
    for (const r of recs) os.put(r, handKey(r.gameId, r.handNo));
    await waitDone(os);
  });
}

/** 全件を playedAt 昇順で。形の崩れたものは読み飛ばす。 */
export function listHands(): Promise<SngHandLocal[]> {
  return tx(HANDS_STORE, 'readonly', async (os) => {
    const all = (await reqToPromise(os.index('playedAt').getAll())) as unknown[];
    return all.filter(isHandLocal);
  });
}

/** 1 件だけ読む（historySync.ts が既存のハンドへ手札・席をマージするときに使う）。 */
export function getHand(gameId: string, handNo: number): Promise<SngHandLocal | null> {
  return tx(HANDS_STORE, 'readonly', async (os) => {
    const v = await reqToPromise(os.get(handKey(gameId, handNo)));
    return isHandLocal(v) ? v : null;
  });
}

/** まとめて保存（同じ gameId は上書き）。1 トランザクション。 */
export function putResults(recs: readonly SngResultLocal[]): Promise<void> {
  if (recs.length === 0) return Promise.resolve();
  return tx(RESULTS_STORE, 'readwrite', async (os) => {
    for (const r of recs) os.put(r, r.gameId);
    await waitDone(os);
  });
}

/** 全件を endedAt 昇順で。 */
export function listResults(): Promise<SngResultLocal[]> {
  return tx(RESULTS_STORE, 'readonly', async (os) => {
    const all = (await reqToPromise(os.index('endedAt').getAll())) as unknown[];
    return all.filter(isResultLocal);
  });
}

/** まとめて保存（同じ gameId は上書き）。1 トランザクション。 */
export function putGames(recs: readonly SngGameLocal[]): Promise<void> {
  if (recs.length === 0) return Promise.resolve();
  return tx(GAMES_STORE, 'readwrite', async (os) => {
    for (const r of recs) os.put(r, r.gameId);
    await waitDone(os);
  });
}

/** 全件を endedAt 昇順で。形の崩れたものは読み飛ばす。 */
export function listGames(): Promise<SngGameLocal[]> {
  return tx(GAMES_STORE, 'readonly', async (os) => {
    const all = (await reqToPromise(os.index('endedAt').getAll())) as unknown[];
    return all.filter(isGameLocal);
  });
}

/** 1 件だけ読む。 */
export function getGame(gameId: string): Promise<SngGameLocal | null> {
  return tx(GAMES_STORE, 'readonly', async (os) => {
    const v = await reqToPromise(os.get(gameId));
    return isGameLocal(v) ? v : null;
  });
}

/** 各ストアの件数。 */
export async function count(): Promise<{ hands: number; results: number; games: number }> {
  const [hands, results, games] = await Promise.all([
    tx(HANDS_STORE, 'readonly', (os) => reqToPromise(os.count())),
    tx(RESULTS_STORE, 'readonly', (os) => reqToPromise(os.count())),
    tx(GAMES_STORE, 'readonly', (os) => reqToPromise(os.count())),
  ]);
  return { hands, results, games };
}

/** 端末の履歴を全部消す（サーバの控えは消さない）。 */
export async function clear(): Promise<void> {
  await Promise.all([
    tx(HANDS_STORE, 'readwrite', (os) => reqToPromise(os.clear())),
    tx(RESULTS_STORE, 'readwrite', (os) => reqToPromise(os.clear())),
    tx(GAMES_STORE, 'readwrite', (os) => reqToPromise(os.clear())),
  ]);
}
