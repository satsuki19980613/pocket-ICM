/**
 * Hand History / Stats 画面の共通フック（SPEC §7.4.6）。
 *
 * 1. まず端末（IndexedDB）の履歴を出す（圏外でも見える）
 * 2. サーバの控えと同期し、別端末で打った分が来ていれば差し替える
 * 3. EV 未計算のハンドがあれば 1 件ずつ（描画を止めないよう setTimeout で間を空けて）埋める
 */

import { useCallback, useEffect, useState } from 'react';

import { withEv } from './allInEv';
import type { HuHandRecord } from './history';
import { listHands, putHand } from './historyStore';
import { syncHands } from './historySync';

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export interface HuHandsState {
  /** playedAt 昇順。null は読み込み中。 */
  readonly hands: HuHandRecord[] | null;
  /** 同期できなかった等の一言。 */
  readonly note: string | null;
  readonly reload: () => void;
}

export function useHuHands(): HuHandsState {
  const [hands, setHands] = useState<HuHandRecord[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      let local: HuHandRecord[] = [];
      try {
        local = await listHands();
      } catch {
        if (alive) setNote('この端末の履歴を読めませんでした。');
      }
      if (!alive) return;
      setHands(local);

      const r = await syncHands(safeStorage());
      if (!alive) return;
      if (r.offline) setNote('サーバの控えと同期できませんでした（この端末の履歴を表示しています）。');
      else setNote(null);
      if (r.pulled > 0) {
        local = await listHands();
        if (!alive) return;
        setHands(local);
      }

      // EV の後埋め（捲り合いだけ。プリフロップの捲り合いは 1 件 0.3 秒ほど）。
      const missing = local.filter((h) => h.evWinnings === null);
      if (missing.length === 0) return;
      for (const h of missing) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (!alive) return;
        try {
          await putHand({ ...withEv(h), synced: false });
        } catch {
          /* 書けなくても表示は続ける（次回また埋める）。 */
        }
      }
      try {
        local = await listHands();
      } catch {
        return;
      }
      if (!alive) return;
      setHands(local);
      void syncHands(safeStorage());
    })();
    return () => {
      alive = false;
    };
  }, [tick]);

  return { hands, note, reload };
}
