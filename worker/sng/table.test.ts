import { describe, expect, it } from 'vitest';
import type { PlayerState, TableState } from '@oshihiki/sng';

import { normalizeState, shouldSeatCheckOnJoin, shouldUnseatOnLeave } from './table';

describe('shouldUnseatOnLeave', () => {
  it('waiting のまま（席が空くだけ）なら外す', () => {
    expect(shouldUnseatOnLeave('waiting')).toBe(true);
  });

  it('running のまま（left・戻れない）でも外す（2026-09-15 実機観察: 試合終了までロビーの' +
    '「参加中の部屋へ戻る」バナーが出続けた問題への対応）', () => {
    expect(shouldUnseatOnLeave('running')).toBe(true);
  });

  it('paused のままでも外す', () => {
    expect(shouldUnseatOnLeave('paused')).toBe(true);
  });

  it('finished（試合終了）は外さない（game_over の notifyLobbyRelease が部屋ごと片付けるため）', () => {
    expect(shouldUnseatOnLeave('finished')).toBe(false);
  });

  it('cancelled（取り消し）は外さない（同上）', () => {
    expect(shouldUnseatOnLeave('cancelled')).toBe(false);
  });
});

describe('shouldSeatCheckOnJoin', () => {
  it('waiting/running/paused では Lobby に確認・登録してよい', () => {
    expect(shouldSeatCheckOnJoin('waiting')).toBe(true);
    expect(shouldSeatCheckOnJoin('running')).toBe(true);
    expect(shouldSeatCheckOnJoin('paused')).toBe(true);
  });

  it('finished/cancelled では確認・登録してはいけない（二度と game_over が来ないので永久に解放されなくなる）', () => {
    expect(shouldSeatCheckOnJoin('finished')).toBe(false);
    expect(shouldSeatCheckOnJoin('cancelled')).toBe(false);
  });
});

/** avatarUrl を除いた最小限のプレイヤー（アイコン配線より前に保存された部屋を模す）。 */
function oldPlayer(userId: string): Omit<PlayerState, 'avatarUrl'> {
  return {
    userId,
    name: `P-${userId}`,
    seat: 0,
    stack: 20000,
    status: 'active',
    connected: true,
    timeBankMs: 30_000,
    autoCount: 0,
    place: null,
    pt: null,
  };
}

function baseState(players: readonly PlayerState[]): TableState {
  return {
    roomId: 'room-1',
    hostId: players[0]?.userId ?? 'u0',
    config: { players: 2, startBb: 100, speed: 'normal', levelMin: 3, mode: 'club' },
    status: 'waiting',
    createdAt: 0,
    startedAt: null,
    endedAt: null,
    players,
    hand: null,
    handNo: 0,
    prevSbSeat: null,
    prevBbSeat: null,
    seq: 0,
    wake: null,
  };
}

describe('normalizeState', () => {
  it('avatarUrl フィールドが無い古い部屋の状態（DO ストレージ由来）を読んでも落ちず、null に丸まる', () => {
    // ctx.storage.get<TableState> は型を被せるだけで実体を検証しないため、アイコン配線
    // より前に保存された部屋は実行時に avatarUrl が本当に存在しない（undefined）。
    // その状態をそのまま渡しても例外を投げないこと・avatarUrl が null になることを固定する。
    const oldState = baseState([oldPlayer('u0')] as unknown as PlayerState[]);
    const normalized = normalizeState(oldState);
    expect(normalized.players[0]!.avatarUrl).toBeNull();
  });

  it('avatarUrl が既に入っている（新しい部屋）ときはそのまま保つ', () => {
    const players: PlayerState[] = [{ ...oldPlayer('u0'), avatarUrl: 'https://x/storage/v1/object/public/avatars/u0/a.png' }];
    const normalized = normalizeState(baseState(players));
    expect(normalized.players[0]!.avatarUrl).toBe('https://x/storage/v1/object/public/avatars/u0/a.png');
  });

  it('avatarUrl が明示的に null（画像未設定）でも null のまま', () => {
    const players: PlayerState[] = [{ ...oldPlayer('u0'), avatarUrl: null }];
    const normalized = normalizeState(baseState(players));
    expect(normalized.players[0]!.avatarUrl).toBeNull();
  });

  it('複数人ぶんまとめて丸められる', () => {
    const oldState = baseState([oldPlayer('u0'), oldPlayer('u1')] as unknown as PlayerState[]);
    const normalized = normalizeState(oldState);
    expect(normalized.players.map((p) => p.avatarUrl)).toEqual([null, null]);
  });
});
