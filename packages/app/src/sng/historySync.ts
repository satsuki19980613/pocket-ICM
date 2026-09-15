/**
 * SIT & GO ハンド履歴・成績の同期（端末 IndexedDB ← サーバ, docs/SNG_DESIGN.md §3）。
 *
 * 書き込みはサーバー（DO）だけなので、Slumbot 版（historySync.ts）と違って push は無い。
 * **引くだけ**:
 *   1. `sng_games` を `created_at` カーソルで引いて端末へ（席順の表示名・試合の設定。
 *      自分の席は `seats` から自分の uid で引き当てる）
 *   2. `sng_results` を `ended_at` カーソルで引いて端末へ（自分の席が分かる。1. が空
 *      （このカラム追加前の試合）でもここから席は分かる）
 *   3. `sng_hands` を `created_at` カーソルで引いて端末へ（mySeat は 1./2. か、
 *      既に付いていればそれを使う。1. を優先する）
 *   4. `sng_hole_cards` を `created_at` カーソルで引いて、該当ハンドへ myCards をマージ
 *      （対応するハンド行がまだ無ければそのハンドは次回の同期で追いつく）
 *   5. 1〜4 の後、mySeat がまだ null のハンドを埋め直す
 *      （試合が終わる前にハンドだけ先に同期していた場合の後埋め）
 *
 * `historySync.ts`（Slumbot 版）と同じく、同時に呼ばれても 1 本に直列化する
 * （Stats を開いた同期とハンド終了時の同期が重ならないように）。
 */

import { fetchCurrentUserId, fetchGamesAfter } from '../supabase/sngGames';
import { fetchHandsAfter, fetchHoleCardsAfter } from '../supabase/sngHands';
import { fetchResultsAfter } from '../supabase/sngResults';
import {
  getHand,
  listGames,
  listHands,
  listResults,
  putGames,
  putHands,
  putResults,
  type SngGameLocal,
  type SngHandLocal,
  type SngResultLocal,
} from './historyStore';

const GAMES_CURSOR_KEY = 'icm.sng.games.cursor.v1';
const HANDS_CURSOR_KEY = 'icm.sng.hands.cursor.v1';
const HOLE_CURSOR_KEY = 'icm.sng.holecards.cursor.v1';
const RESULTS_CURSOR_KEY = 'icm.sng.results.cursor.v1';
const PAGE = 1000;

type Store = Pick<Storage, 'getItem' | 'setItem'>;

export interface SyncSngResult {
  readonly pulledGames: number;
  readonly pulledHands: number;
  readonly pulledResults: number;
  /** サーバに届かなかった（圏外・未ログイン等）。端末の履歴はそのまま。 */
  readonly offline: boolean;
}

function readCursor(store: Store | null, key: string): string | null {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeCursor(store: Store | null, key: string, v: string): void {
  try {
    store?.setItem(key, v);
  } catch {
    /* 保存領域が使えなくても次回引き直すだけ。 */
  }
}

let inFlight: Promise<SyncSngResult> | null = null;
let queued = false;

export function syncSng(store: Store | null): Promise<SyncSngResult> {
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
      r = {
        pulledGames: r.pulledGames + again.pulledGames,
        pulledHands: r.pulledHands + again.pulledHands,
        pulledResults: r.pulledResults + again.pulledResults,
        offline: again.offline,
      };
    }
    return r;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** ローカルに持っている成績から gameId → 自分の席。 */
async function resultSeatMap(): Promise<Map<string, number>> {
  const results = await listResults();
  const m = new Map<string, number>();
  for (const r of results) m.set(r.gameId, r.seat);
  return m;
}

/** ローカルに持っている試合の控えから gameId → 記録。 */
async function gameMap(): Promise<Map<string, SngGameLocal>> {
  const games = await listGames();
  return new Map(games.map((g) => [g.gameId, g]));
}

/** `sng_games.seats` から自分（uid）の席を引き当てる。uid 不明・未掲載なら null。 */
function mySeatFromGame(game: SngGameLocal | undefined, uid: string | null): number | null {
  if (!game || !uid) return null;
  return game.seats.find((s) => s.userId === uid)?.seat ?? null;
}

/** 席の決定: `sng_games.seats`（本人 uid 照合）→ `sng_results` の順で優先する。 */
function resolveMySeat(
  gameId: string,
  games: Map<string, SngGameLocal>,
  resultSeats: Map<string, number>,
  uid: string | null,
): number | null {
  return mySeatFromGame(games.get(gameId), uid) ?? resultSeats.get(gameId) ?? null;
}

async function runSync(store: Store | null): Promise<SyncSngResult> {
  let pulledGames = 0;
  let pulledResults = 0;
  let pulledHands = 0;

  // ---- 1. games（席の表示名・試合設定。自分の席の決定にも使う） ----
  let gamesCursor = readCursor(store, GAMES_CURSOR_KEY);
  for (;;) {
    const r = await fetchGamesAfter(gamesCursor, PAGE);
    if (!r.ok) return { pulledGames, pulledHands, pulledResults, offline: true };
    if (r.data.length === 0) break;
    const recs: SngGameLocal[] = r.data.map(({ rec }) => rec);
    await putGames(recs);
    pulledGames += recs.length;
    gamesCursor = r.data[r.data.length - 1]!.createdAt;
    writeCursor(store, GAMES_CURSOR_KEY, gamesCursor);
    if (r.data.length < PAGE) break;
  }

  // ---- 2. results（先に済ませて席を分かるようにする） ----
  let resultsCursor = readCursor(store, RESULTS_CURSOR_KEY);
  for (;;) {
    const r = await fetchResultsAfter(resultsCursor, PAGE);
    if (!r.ok) return { pulledGames, pulledHands, pulledResults, offline: true };
    if (r.data.length === 0) break;
    const recs: SngResultLocal[] = r.data.map(({ rec }) => rec);
    await putResults(recs);
    pulledResults += recs.length;
    resultsCursor = r.data[r.data.length - 1]!.endedAt;
    writeCursor(store, RESULTS_CURSOR_KEY, resultsCursor);
    if (r.data.length < PAGE) break;
  }

  const uid = await fetchCurrentUserId();
  const games = await gameMap();
  const resultSeats = await resultSeatMap();

  // ---- 3. hands ----
  let handsCursor = readCursor(store, HANDS_CURSOR_KEY);
  for (;;) {
    const r = await fetchHandsAfter(handsCursor, PAGE);
    if (!r.ok) return { pulledGames, pulledHands, pulledResults, offline: true };
    if (r.data.length === 0) break;
    const toPut: SngHandLocal[] = [];
    for (const { rec } of r.data) {
      const existing = await getHand(rec.gameId, rec.handNo);
      toPut.push({
        ...rec,
        mySeat: existing?.mySeat ?? resolveMySeat(rec.gameId, games, resultSeats, uid),
        myCards: existing?.myCards ?? null,
      });
    }
    await putHands(toPut);
    pulledHands += toPut.length;
    handsCursor = r.data[r.data.length - 1]!.createdAt;
    writeCursor(store, HANDS_CURSOR_KEY, handsCursor);
    if (r.data.length < PAGE) break;
  }

  // ---- 4. hole cards（自分の手札。対応するハンド行が無ければ今回はあきらめる） ----
  let holeCursor = readCursor(store, HOLE_CURSOR_KEY);
  for (;;) {
    const r = await fetchHoleCardsAfter(holeCursor, PAGE);
    if (!r.ok) return { pulledGames, pulledHands, pulledResults, offline: true };
    if (r.data.length === 0) break;
    for (const { rec } of r.data) {
      const existing = await getHand(rec.gameId, rec.handNo);
      if (!existing) continue;
      await putHands([
        {
          ...existing,
          myCards: rec.cards,
          mySeat: existing.mySeat ?? resolveMySeat(rec.gameId, games, resultSeats, uid),
        },
      ]);
    }
    holeCursor = r.data[r.data.length - 1]!.createdAt;
    writeCursor(store, HOLE_CURSOR_KEY, holeCursor);
    if (r.data.length < PAGE) break;
  }

  // ---- 5. 席の後埋め（試合終了前にハンドだけ同期していた分） ----
  if (games.size > 0 || resultSeats.size > 0) {
    const all = await listHands();
    const toFix: SngHandLocal[] = [];
    for (const h of all) {
      if (h.mySeat !== null) continue;
      const seat = resolveMySeat(h.gameId, games, resultSeats, uid);
      if (seat !== null) toFix.push({ ...h, mySeat: seat });
    }
    if (toFix.length > 0) await putHands(toFix);
  }

  return { pulledGames, pulledHands, pulledResults, offline: false };
}
