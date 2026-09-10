import { describe, expect, it } from 'vitest';

import { ZERO_PENDING, addPending, readPending, writePending } from './huStats';

function memoryStore(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  } as unknown as Storage;
}

describe('未送信分の積み上げ', () => {
  it('1 ハンドずつ足せる（勝ちも負けも）', () => {
    let p = ZERO_PENDING;
    p = addPending(p, 400);
    p = addPending(p, -1500);
    p = addPending(p, 0);
    expect(p).toEqual({ hands: 3, netChips: -1100 });
  });

  it('保存して読み戻せる', () => {
    const store = memoryStore();
    writePending(store, { hands: 4, netChips: -250 });
    expect(readPending(store)).toEqual({ hands: 4, netChips: -250 });
  });

  it('未保存・壊れた値・ハンド数0 はゼロ扱い', () => {
    expect(readPending(null)).toEqual(ZERO_PENDING);
    expect(readPending(memoryStore())).toEqual(ZERO_PENDING);
    const broken = memoryStore();
    broken.setItem('icm.slumbot.pending.v1', 'not json');
    expect(readPending(broken)).toEqual(ZERO_PENDING);
    const zero = memoryStore();
    writePending(zero, { hands: 0, netChips: 900 });
    expect(readPending(zero)).toEqual(ZERO_PENDING);
  });

  it('保存できない環境でも例外にしない', () => {
    const dead = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    } as unknown as Storage;
    expect(() => writePending(dead, { hands: 1, netChips: 1 })).not.toThrow();
    expect(readPending(dead)).toEqual(ZERO_PENDING);
  });
});
