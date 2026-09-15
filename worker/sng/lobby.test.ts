import { describe, expect, it } from 'vitest';

import { seatUser, unseatUser } from './lobby';

describe('seatUser', () => {
  it('未登録の userId を新しい roomId に登録する', () => {
    const r = seatUser({}, 'u1', 'sg_a');
    expect(r).toEqual({ ok: true, userRoom: { u1: 'sg_a' } });
  });

  it('同じ roomId への再登録は冪等（何も変わらない）', () => {
    const before = { u1: 'sg_a' };
    const r = seatUser(before, 'u1', 'sg_a');
    expect(r).toEqual({ ok: true, userRoom: before });
    if (r.ok) expect(r.userRoom).toBe(before); // 参照も変えない（再保存を避ける）
  });

  it('別の roomId に既に登録済みなら拒否し、その roomId を返す', () => {
    const r = seatUser({ u1: 'sg_a' }, 'u1', 'sg_b');
    expect(r).toEqual({ ok: false, roomId: 'sg_a' });
  });

  it('他の userId には影響しない', () => {
    const r = seatUser({ u2: 'sg_x' }, 'u1', 'sg_a');
    expect(r).toEqual({ ok: true, userRoom: { u2: 'sg_x', u1: 'sg_a' } });
  });
});

describe('unseatUser', () => {
  it('登録があれば外す', () => {
    const r = unseatUser({ u1: 'sg_a' }, 'u1');
    expect(r).toEqual({});
  });

  it('登録が無ければ何もしない（同じ参照を返す）', () => {
    const before = { u2: 'sg_x' };
    const r = unseatUser(before, 'u1');
    expect(r).toBe(before);
  });

  it('expectRoomId を渡すと、一致するときだけ外す', () => {
    const before = { u1: 'sg_a' };
    const noop = unseatUser(before, 'u1', 'sg_b'); // 既に別の部屋に移っていた
    expect(noop).toBe(before);
    const removed = unseatUser(before, 'u1', 'sg_a');
    expect(removed).toEqual({});
  });

  it('他の userId には影響しない', () => {
    const r = unseatUser({ u1: 'sg_a', u2: 'sg_b' }, 'u1');
    expect(r).toEqual({ u2: 'sg_b' });
  });
});
