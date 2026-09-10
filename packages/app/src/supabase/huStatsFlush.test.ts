/**
 * flushPending の同時実行まわり。
 *
 * 実バグの再発防止テスト: 対局中にランキングを開くと、ハンド終了時の flush と
 * ランキング読み込み時の flush が重なり、「送信前の同じ pending」を 2 回読んで
 * サーバに二重加算していた（さつきの並列テストで検出）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();

vi.mock('./client', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
  },
}));

const { addPending, flushPending, readPending, writePending } = await import('./huStats');

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

/** 呼ばれた RPC の引数から、送られたハンド数と収支の合計を出す。 */
function sent(): { hands: number; netChips: number } {
  return rpc.mock.calls.reduce(
    (acc, call) => {
      const a = call[1] as { p_hands: number; p_net_chips: number };
      return { hands: acc.hands + a.p_hands, netChips: acc.netChips + a.p_net_chips };
    },
    { hands: 0, netChips: 0 },
  );
}

describe('flushPending の同時実行', () => {
  beforeEach(() => {
    rpc.mockReset();
  });

  it('同時に呼ばれても二重に加算しない', async () => {
    const store = memoryStore();
    writePending(store, { hands: 3, netChips: -450 });

    // TS は「コールバック内での代入」を追えないので、初期値を no-op にして型を固定する。
    let release: () => void = () => {};
    rpc.mockImplementation(
      () =>
        new Promise<{ error: null }>((resolve) => {
          release = () => resolve({ error: null });
        }),
    );

    // 「ハンド終了の flush」と「ランキングを開いた flush」が重なる状況。
    const a = flushPending(store);
    const b = flushPending(store);
    await Promise.resolve();
    release();
    await Promise.all([a, b]);

    expect(sent()).toEqual({ hands: 3, netChips: -450 });
    expect(readPending(store)).toEqual({ hands: 0, netChips: 0 });
  });

  it('送信中に増えた分は、その送信のあとに続けて送られる', async () => {
    const store = memoryStore();
    writePending(store, { hands: 1, netChips: 400 });

    const releases: (() => void)[] = [];
    rpc.mockImplementation(
      () =>
        new Promise<{ error: null }>((resolve) => {
          releases.push(() => resolve({ error: null }));
        }),
    );

    const first = flushPending(store);
    await Promise.resolve();

    // 送信中に 1 ハンド終わった → 追加の flush 要求。
    writePending(store, addPending(readPending(store), -1500));
    void flushPending(store);

    releases[0]?.();
    await Promise.resolve();
    await Promise.resolve();
    releases[1]?.();
    await first;

    expect(sent()).toEqual({ hands: 2, netChips: 400 - 1500 });
    expect(readPending(store)).toEqual({ hands: 0, netChips: 0 });
  });

  it('送信に失敗したら端末に残したままにする（取りこぼさない）', async () => {
    const store = memoryStore();
    writePending(store, { hands: 2, netChips: -900 });
    rpc.mockResolvedValue({ error: { message: 'offline' } });

    await expect(flushPending(store)).resolves.toBe(false);
    expect(readPending(store)).toEqual({ hands: 2, netChips: -900 });
  });

  it('溜まっていなければ RPC を呼ばない', async () => {
    const store = memoryStore();
    rpc.mockResolvedValue({ error: null });
    await expect(flushPending(store)).resolves.toBe(true);
    expect(rpc).not.toHaveBeenCalled();
  });
});
