/**
 * 「端末の戻るで閉じられる重なり（モーダル・シート・ピッカー）」の登録簿。
 *
 * 画面 state は App が持つが、モーダルの開閉は各コンポーネントのローカル state なので、
 * App からは重なりの数が見えない。そこで開いている重なりをこのストアに登録してもらい、
 * App は「画面の深さ＋重なりの数」を履歴の深さとして同期する（navHistory.ts）。
 * 戻るときは後から開いたものが先に閉じる（LIFO）。
 *
 * React に依存しないので node 環境の単体テストで検証できる。
 */

export interface BackLayerStore {
  /** 重なりを1つ登録する。戻り値は解除用のID。 */
  register(onClose: () => void): number;
  /** 登録を解除する（自前の×ボタンで閉じた場合など）。 */
  unregister(id: number): void;
  /** 開いている重なりの数。 */
  getCount(): number;
  /** 最後に開いた重なりを閉じる。閉じるものが無ければ false。 */
  closeTop(): boolean;
  /** 数の変化を購読する（useSyncExternalStore 用）。 */
  subscribe(listener: () => void): () => void;
}

export function createBackLayerStore(): BackLayerStore {
  let nextId = 1;
  let layers: { id: number; onClose: () => void }[] = [];
  const listeners = new Set<() => void>();

  function emit(): void {
    for (const l of listeners) l();
  }

  return {
    register(onClose: () => void): number {
      const id = nextId;
      nextId += 1;
      layers = [...layers, { id, onClose }];
      emit();
      return id;
    },

    unregister(id: number): void {
      const next = layers.filter((l) => l.id !== id);
      if (next.length === layers.length) return;
      layers = next;
      emit();
    },

    getCount(): number {
      return layers.length;
    },

    closeTop(): boolean {
      const top = layers[layers.length - 1];
      if (!top) return false;
      // 登録解除は閉じたコンポーネント側の effect cleanup に任せる（二重解除を避ける）。
      top.onClose();
      return true;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * アプリ全体で1つの登録簿。App は単一インスタンスなので Context を挟まず共有する
 * （モーダルは App の子孫としてしか描かれない）。
 */
export const backLayers: BackLayerStore = createBackLayerStore();
