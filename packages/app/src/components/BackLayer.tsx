import { useEffect, useRef, type MouseEvent } from 'react';

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

/**
 * モーダル背景（backdrop）の onClick を作る。背景そのもののクリックでだけ onClose を呼び、
 * ダイアログ内部からバブリングしてきたクリックはここで止める（以前ダイアログ側の onClick で
 * stopPropagation していたのと同じ効果。ダイアログ要素にマウス専用ハンドラを持たせずに済む）。
 * `stopSelf` を立てると背景クリック自体も親へ伝えない（親モーダルの backdrop まで閉じないように）。
 * キーボードでは各モーダルが `useBackLayer`（Esc／戻る）と ✕ ボタンで閉じられる。
 */
export function backdropClick(onClose: () => void, stopSelf = false): (e: MouseEvent) => void {
  return (e) => {
    if (e.target !== e.currentTarget) {
      e.stopPropagation();
      return;
    }
    if (stopSelf) e.stopPropagation();
    onClose();
  };
}
