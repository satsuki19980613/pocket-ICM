import { useEffect, useRef } from 'react';

import { backLayers } from '../backLayers';

/**
 * 開いている間だけ「端末の戻る／Esc で閉じられる重なり」として登録する。
 * モーダルは開いている間だけマウントされる作りなので、原則そのまま呼べばよい。
 * onClose は毎描画で差し替わってよい（最新のものを ref 経由で呼ぶ）。
 *
 * 実体（登録簿）は backLayers.ts、履歴との同期は App.tsx が担う。
 */
export function useBackLayer(onClose: () => void, active = true): void {
  const latest = useRef(onClose);
  latest.current = onClose;

  useEffect(() => {
    if (!active) return undefined;
    const id = backLayers.register(() => latest.current());
    return () => backLayers.unregister(id);
  }, [active]);
}
