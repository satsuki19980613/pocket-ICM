/**
 * SIT & GO の Hand History / Stats 画面の共通フック（docs/SNG_DESIGN.md §5）。
 * `slumbot/useHuHands.ts` と同じ形にする（対称性で読みやすくするため）。
 *
 * 1. まず端末（IndexedDB）に持っている分を出す（圏外でも見える）
 * 2. サーバの控えと同期する（`syncSng`）。SIT & GO は書き込みがサーバーだけなので
 *    push は無く、引くだけで済む
 *
 * `games`（`sng_games` の控え）は相手の表示名・試合設定（人数・開始bb・構造・上昇間隔・
 * モード）の唯一の材料。古い試合（このカラム追加前）には無いので、呼び出し側は
 * `null`/該当行が見つからない場合のフォールバック表示を用意すること。
 */

import { useCallback, useEffect, useState } from 'react';

import { listGames, listHands, listResults, type SngGameLocal, type SngHandLocal, type SngResultLocal } from './historyStore';
import { syncSng } from './historySync';

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export interface SngHandsState {
  /** playedAt 昇順。null は読み込み中。 */
  readonly hands: SngHandLocal[] | null;
  /** endedAt 昇順。null は読み込み中。 */
  readonly results: SngResultLocal[] | null;
  /** endedAt 昇順。null は読み込み中。 */
  readonly games: SngGameLocal[] | null;
  /** 同期できなかった等の一言。 */
  readonly note: string | null;
  readonly reload: () => void;
}

export function useSngHands(): SngHandsState {
  const [hands, setHands] = useState<SngHandLocal[] | null>(null);
  const [results, setResults] = useState<SngResultLocal[] | null>(null);
  const [games, setGames] = useState<SngGameLocal[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [h, r, g] = await Promise.all([listHands(), listResults(), listGames()]);
        if (!alive) return;
        setHands(h);
        setResults(r);
        setGames(g);
      } catch {
        if (alive) setNote('この端末の履歴を読めませんでした。');
      }
      if (!alive) return;

      const sync = await syncSng(safeStorage());
      if (!alive) return;
      if (sync.offline) setNote('サーバの控えと同期できませんでした（この端末の履歴を表示しています）。');
      else setNote(null);
      if (sync.pulledHands > 0 || sync.pulledResults > 0 || sync.pulledGames > 0) {
        try {
          const [h, r, g] = await Promise.all([listHands(), listResults(), listGames()]);
          if (!alive) return;
          setHands(h);
          setResults(r);
          setGames(g);
        } catch {
          /* 直前に読めていれば表示は続ける。 */
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [tick]);

  return { hands, results, games, note, reload };
}
