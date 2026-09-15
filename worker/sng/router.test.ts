import { describe, expect, it } from 'vitest';

import { ROOM_ID_RE } from '@oshihiki/sng';

import { genRoomId, tableRoomIdFromPath } from './router';

describe('genRoomId', () => {
  it('ROOM_ID_RE を満たす形を作る', () => {
    const id = genRoomId();
    expect(id).toMatch(ROOM_ID_RE);
    expect(id).toMatch(/^sg_[0-9a-z]{12}$/);
  });

  it('注入した乱数から決定的に作る', () => {
    // 0..35 の範囲の値だけを返す（棄却されない）フェイク乱数。
    const bytes = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    const id = genRoomId(() => new Uint8Array(bytes));
    expect(id).toBe(`sg_${bytes.map((b) => b.toString(36)).join('')}`);
  });

  it('216 以上のバイトは棄却して偏りを避ける', () => {
    // 最初のバッチは全部棄却される値、2 回目で採用される値。
    let call = 0;
    const rejectThenAccept = (n: number): Uint8Array => {
      call += 1;
      return call === 1 ? new Uint8Array(n).fill(255) : new Uint8Array(n).fill(0);
    };
    const id = genRoomId(rejectThenAccept);
    expect(id).toBe(`sg_${'0'.repeat(12)}`);
    expect(call).toBe(2);
  });

  it('衝突しにくい（1000 回生成して重複なし）', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) seen.add(genRoomId());
    expect(seen.size).toBe(1000);
  });
});

describe('tableRoomIdFromPath', () => {
  it('正しい形なら roomId を返す', () => {
    expect(tableRoomIdFromPath('/api/sng/table/sg_abc123def456')).toBe('sg_abc123def456');
  });

  it('prefix が違えば null', () => {
    expect(tableRoomIdFromPath('/api/sng/rooms')).toBeNull();
    expect(tableRoomIdFromPath('/api/sng/table')).toBeNull();
    expect(tableRoomIdFromPath('/api/sng/table/')).toBeNull();
  });

  it('roomId の形が ROOM_ID_RE に合わなければ null', () => {
    expect(tableRoomIdFromPath('/api/sng/table/short')).toBeNull();
    expect(tableRoomIdFromPath('/api/sng/table/sg_HASUPPER1234')).toBeNull();
    expect(tableRoomIdFromPath('/api/sng/table/no_prefix1234')).toBeNull();
  });
});
