import { describe, expect, it, vi } from 'vitest';

import { createBackLayerStore } from './backLayers';

describe('createBackLayerStore', () => {
  it('登録した数を数える', () => {
    const s = createBackLayerStore();
    expect(s.getCount()).toBe(0);
    const a = s.register(() => {});
    s.register(() => {});
    expect(s.getCount()).toBe(2);
    s.unregister(a);
    expect(s.getCount()).toBe(1);
  });

  it('後から開いたものから閉じる（LIFO）', () => {
    const s = createBackLayerStore();
    const order: string[] = [];
    s.register(() => order.push('下'));
    const top = s.register(() => order.push('上'));
    expect(s.closeTop()).toBe(true);
    expect(order).toEqual(['上']);

    // 実際のコンポーネントは閉じたあと effect の後始末で解除する。
    s.unregister(top);
    expect(s.closeTop()).toBe(true);
    expect(order).toEqual(['上', '下']);
  });

  it('閉じるものが無ければ false', () => {
    const s = createBackLayerStore();
    expect(s.closeTop()).toBe(false);
  });

  it('数が変わったときだけ購読者に通知する', () => {
    const s = createBackLayerStore();
    const seen = vi.fn();
    const off = s.subscribe(seen);
    const id = s.register(() => {});
    expect(seen).toHaveBeenCalledTimes(1);
    s.unregister(id);
    expect(seen).toHaveBeenCalledTimes(2);
    s.unregister(id); // 二重解除は通知しない
    expect(seen).toHaveBeenCalledTimes(2);
    off();
    s.register(() => {});
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it('getCount は同じ値を返す間は参照が安定（useSyncExternalStore の無限ループ防止）', () => {
    const s = createBackLayerStore();
    expect(s.getCount()).toBe(s.getCount());
  });
});
