/**
 * `TableClient`（sng/client.ts）を React に包む。docs/SNG_DESIGN.md §5（A3a 所有）。
 *
 * 卓（`SngRoom`）はこのフックだけを見ればよい: 最新のスナップショット（`table`/`you`）、
 * 直近に配られた自分の手札（`hole`）、直近のサーバーエラー、接続状態、送信関数、
 * サーバー時刻で補正した「今」を返す。`roomId` が変われば（または null になれば）
 * 古い接続を閉じて新しく繋ぎ直す。
 */

import { useEffect, useRef, useState } from 'react';

import type { ClientMsg, ErrorCode, PublicTable, You } from '@oshihiki/sng';

import { TableClient } from './client';

export interface TableErrorState {
  readonly code: ErrorCode;
  readonly message: string | undefined;
  readonly roomId: string | undefined;
}

export interface UseTableResult {
  readonly table: PublicTable | null;
  readonly you: You | null;
  /** 直近に配られた自分の手札（新しいハンドが始まれば呼び出し側で使い切ること）。 */
  readonly hole: readonly [string, string] | null;
  readonly error: TableErrorState | null;
  /** 部屋が終了した理由。以後この接続は閉じている。 */
  readonly closed: 'finished' | 'cancelled' | null;
  readonly connected: boolean;
  readonly send: (msg: ClientMsg) => void;
  /** サーバー時刻で補正した「今」（epoch ms）。手番の残り秒数の計算に使う。 */
  readonly serverNow: () => number;
}

export function useTable(roomId: string | null): UseTableResult {
  const clientRef = useRef<TableClient | null>(null);
  const [table, setTable] = useState<PublicTable | null>(null);
  const [you, setYou] = useState<You | null>(null);
  const [hole, setHole] = useState<readonly [string, string] | null>(null);
  const [error, setError] = useState<TableErrorState | null>(null);
  const [closed, setClosed] = useState<'finished' | 'cancelled' | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    setTable(null);
    setYou(null);
    setHole(null);
    setError(null);
    setClosed(null);
    setConnected(false);
    if (!roomId) {
      clientRef.current = null;
      return;
    }
    const client = new TableClient({
      onSnapshot: (t, y) => {
        setTable(t);
        setYou(y);
      },
      onHole: (_handNo, cards) => setHole(cards),
      onError: (code, message, rid) => setError({ code, message, roomId: rid }),
      onClosed: (reason) => setClosed(reason),
      onConnected: setConnected,
    });
    clientRef.current = client;
    client.connectRoom(roomId);
    return () => {
      client.close();
      if (clientRef.current === client) clientRef.current = null;
    };
  }, [roomId]);

  return {
    table,
    you,
    hole,
    error,
    closed,
    connected,
    send: (msg) => clientRef.current?.send(msg),
    serverNow: () => clientRef.current?.now() ?? Date.now(),
  };
}
