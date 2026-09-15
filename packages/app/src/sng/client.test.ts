import { describe, expect, it, vi } from 'vitest';

import type { PublicTable, You } from '@oshihiki/sng';

import { TableClient, WS_OPEN, backoffDelayMs, type WebSocketFactory, type WebSocketLike } from './client';

/** テスト用の擬似 WebSocket。onopen/onmessage/onclose を手で発火できる。 */
class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(public readonly url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  /** テストから「サーバーが繋がった」ことにする。 */
  open(): void {
    this.readyState = WS_OPEN;
    this.onopen?.();
  }

  /** テストから「サーバーが切った」ことにする。 */
  serverClose(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  receive(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

function makeFactory(): { factory: WebSocketFactory; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  const factory: WebSocketFactory = (url) => {
    const s = new FakeSocket(url);
    sockets.push(s);
    return s;
  };
  return { factory, sockets };
}

const TOKEN = 'test-access-token-0123456789';

describe('TableClient', () => {
  it('接続すると最初のメッセージとして auth を送る', async () => {
    const { factory, sockets } = makeFactory();
    const client = new TableClient(
      { onSnapshot: () => {}, onHole: () => {}, onError: () => {}, onClosed: () => {} },
      { wsFactory: factory, getToken: async () => TOKEN, wsBase: () => 'ws://test' },
    );
    client.connectRoom('sg_abcdefgh');
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.url).toBe('ws://test/api/sng/table/sg_abcdefgh');

    sockets[0]!.open();
    // getToken は非同期なので、送信されるまで1マイクロタスク待つ。
    await Promise.resolve();
    await Promise.resolve();

    expect(sockets[0]!.sent).toHaveLength(1);
    expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({ t: 'auth', token: TOKEN });
    client.close();
  });

  it('seq が既知以下の snapshot は捨てる', async () => {
    const { factory, sockets } = makeFactory();
    const snapshots: number[] = [];
    const client = new TableClient(
      {
        onSnapshot: (_table, _you, seq) => snapshots.push(seq),
        onHole: () => {},
        onError: () => {},
        onClosed: () => {},
      },
      { wsFactory: factory, getToken: async () => TOKEN, wsBase: () => 'ws://test' },
    );
    client.connectRoom('sg_abcdefgh');
    sockets[0]!.open();
    await Promise.resolve();
    await Promise.resolve();

    const table = { roomId: 'sg_abcdefgh' } as unknown as PublicTable;
    const you: You = { userId: 'u1', seat: 0, hole: null };
    sockets[0]!.receive({ t: 'snapshot', seq: 3, serverTime: Date.now(), table, you });
    sockets[0]!.receive({ t: 'snapshot', seq: 2, serverTime: Date.now(), table, you }); // 古い→捨てる
    sockets[0]!.receive({ t: 'snapshot', seq: 3, serverTime: Date.now(), table, you }); // 同じ→捨てる
    sockets[0]!.receive({ t: 'snapshot', seq: 5, serverTime: Date.now(), table, you }); // 新しい→通す

    expect(snapshots).toEqual([3, 5]);
    client.close();
  });

  it('切断すると指数バックオフ（1,2,4,8 秒）で再接続する', () => {
    expect(backoffDelayMs(0)).toBe(1000);
    expect(backoffDelayMs(1)).toBe(2000);
    expect(backoffDelayMs(2)).toBe(4000);
    expect(backoffDelayMs(3)).toBe(8000);
    expect(backoffDelayMs(4)).toBe(8000); // 上限で頭打ち。
  });

  it('切断すると自動で再接続を試み、待ち時間は毎回倍になる（上限あり）', async () => {
    vi.useFakeTimers();
    try {
      const { factory, sockets } = makeFactory();
      const client = new TableClient(
        { onSnapshot: () => {}, onHole: () => {}, onError: () => {}, onClosed: () => {} },
        { wsFactory: factory, getToken: async () => null, wsBase: () => 'ws://test' },
      );
      client.connectRoom('sg_abcdefgh');
      expect(sockets).toHaveLength(1);

      sockets[0]!.open();
      sockets[0]!.serverClose(); // 予期しない切断 → 再接続を予約。

      expect(sockets).toHaveLength(1); // まだ即座には繋ぎ直さない。
      await vi.advanceTimersByTimeAsync(999);
      expect(sockets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(sockets).toHaveLength(2); // 1 秒後に1回目の再接続。

      sockets[1]!.serverClose();
      await vi.advanceTimersByTimeAsync(1999);
      expect(sockets).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(sockets).toHaveLength(3); // 2回目は2秒後。

      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('closed メッセージを受けたら以後は再接続しない', () => {
    vi.useFakeTimers();
    try {
      const { factory, sockets } = makeFactory();
      const client = new TableClient(
        { onSnapshot: () => {}, onHole: () => {}, onError: () => {}, onClosed: () => {} },
        { wsFactory: factory, getToken: async () => null, wsBase: () => 'ws://test' },
      );
      client.connectRoom('sg_abcdefgh');
      sockets[0]!.open();
      sockets[0]!.receive({ t: 'closed', reason: 'finished' });
      sockets[0]!.serverClose();

      vi.advanceTimersByTime(60_000);
      expect(sockets).toHaveLength(1); // closed の後は close イベントが来ても繋ぎ直さない。

      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('open 中でなければ send は黙って捨てる', () => {
    const { factory, sockets } = makeFactory();
    const client = new TableClient(
      { onSnapshot: () => {}, onHole: () => {}, onError: () => {}, onClosed: () => {} },
      { wsFactory: factory, getToken: async () => null, wsBase: () => 'ws://test' },
    );
    client.connectRoom('sg_abcdefgh');
    // まだ open していない（readyState=0）。
    client.send({ t: 'ping' });
    expect(sockets[0]!.sent).toHaveLength(0);

    sockets[0]!.open();
    client.send({ t: 'ping' });
    expect(sockets[0]!.sent).toHaveLength(1);
    client.close();
  });
});

describe('backoffDelayMs', () => {
  it('負の attempt も 0 扱いにする', () => {
    expect(backoffDelayMs(-1)).toBe(1000);
  });
});
