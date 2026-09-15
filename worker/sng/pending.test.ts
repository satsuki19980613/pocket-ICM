import { describe, expect, it } from 'vitest';

import type { SngGameResult } from '@oshihiki/sng';

import { PENDING_TTL_MS, dropExpired } from './pending';
import type { PendingWrite } from './pending';

const gameResult: SngGameResult = {
  gameId: 'sg_test00000001',
  hostId: 'user-1',
  config: { players: 2, startBb: 100, speed: 'normal', levelMin: 3, mode: 'club' },
  status: 'cancelled',
  startedAt: null,
  endedAt: 1_000,
  hands: 0,
  players: [],
};

function gameItem(queuedAt: number): PendingWrite {
  return { kind: 'game', result: gameResult, queuedAt };
}

describe('dropExpired', () => {
  it('TTL 以内のものは残す', () => {
    const now = 1_000_000;
    const items = [gameItem(now - 1000), gameItem(now - PENDING_TTL_MS + 1)];
    expect(dropExpired(items, now)).toHaveLength(2);
  });

  it('TTL を過ぎたものは捨てる', () => {
    const now = 1_000_000;
    const items = [gameItem(now - PENDING_TTL_MS - 1), gameItem(now - 10)];
    const result = dropExpired(items, now);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(items[1]);
  });

  it('ちょうど TTL は残す（境界）', () => {
    const now = 1_000_000;
    const items = [gameItem(now - PENDING_TTL_MS)];
    expect(dropExpired(items, now)).toHaveLength(1);
  });

  it('ttlMs を明示的に渡せる', () => {
    const now = 1_000_000;
    const items = [gameItem(now - 500)];
    expect(dropExpired(items, now, 100)).toHaveLength(0);
  });
});
