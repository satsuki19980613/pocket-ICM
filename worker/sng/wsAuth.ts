/**
 * WS 接続の「最初のメッセージは auth・5 秒で来なければ閉じる」を Lobby/Table で共用する部品。
 * docs/SNG_DESIGN.md §2。
 *
 * Hibernation API 下では `setTimeout` は生き残らない（DO が眠ると消える）ので、締切は
 * `ctx.storage` に置き、DO の Alarm（1本しか無い）で確認する。呼び出し側（table.ts/lobby.ts）が
 * 他の理由（エンジンの wake・DB 再送）で立てる alarm と同じ枠を取り合うので、両方の締切の
 * 最小値を alarm にセットするのは呼び出し側の責務（このファイルは締切の保存と掃除だけ）。
 */
import { AUTH_TIMEOUT_MS } from '@oshihiki/sng';

export interface ConnAttachment {
  readonly id: string;
  userId: string | null;
  name: string | null;
  authed: boolean;
}

const KEY = 'authDeadlines';

async function load(storage: DurableObjectStorage): Promise<Record<string, number>> {
  return (await storage.get<Record<string, number>>(KEY)) ?? {};
}

export async function addAuthDeadline(storage: DurableObjectStorage, connId: string, now: number): Promise<number> {
  const map = await load(storage);
  const deadline = now + AUTH_TIMEOUT_MS;
  map[connId] = deadline;
  await storage.put(KEY, map);
  return deadline;
}

export async function clearAuthDeadline(storage: DurableObjectStorage, connId: string): Promise<void> {
  const map = await load(storage);
  if (connId in map) {
    delete map[connId];
    await storage.put(KEY, map);
  }
}

export async function earliestAuthDeadline(storage: DurableObjectStorage): Promise<number | null> {
  const values = Object.values(await load(storage));
  return values.length > 0 ? Math.min(...values) : null;
}

/** 期限切れの接続 id を返し、ストレージからも消す。呼び出し側がそのソケットを閉じる。 */
export async function sweepExpired(storage: DurableObjectStorage, now: number): Promise<readonly string[]> {
  const map = await load(storage);
  const expired: string[] = [];
  for (const [id, at] of Object.entries(map)) {
    if (at <= now) {
      expired.push(id);
      delete map[id];
    }
  }
  if (expired.length > 0) await storage.put(KEY, map);
  return expired;
}

export function getAttachment(ws: WebSocket): ConnAttachment {
  try {
    const v = ws.deserializeAttachment() as ConnAttachment | null;
    return v ?? { id: '', userId: null, name: null, authed: false };
  } catch {
    return { id: '', userId: null, name: null, authed: false };
  }
}

export function send(ws: WebSocket, msg: unknown): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    /* 接続が閉じていれば黙って諦める */
  }
}
