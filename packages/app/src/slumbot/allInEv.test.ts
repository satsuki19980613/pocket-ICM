import { describe, expect, it } from 'vitest';

import { evWinningsOf, withEv } from './allInEv';
import type { HuHandRecord } from './history';

function rec(over: Partial<HuHandRecord>): HuHandRecord {
  return {
    id: 'sb_abc123',
    playedAt: 0,
    heroSeat: 0,
    action: 'b200c/b19800c',
    heroCards: ['As', 'Ad'],
    botCards: ['Ks', 'Kd'],
    board: ['2c', '7h', '9s', 'Kh', '3d'],
    winnings: -20000,
    showdown: true,
    evWinnings: null,
    synced: false,
    ...over,
  };
}

describe('evWinningsOf', () => {
  it('フロップの捲り合い: その時点の勝率 × ポット − 出した額', () => {
    // AA vs KK、2-7-9 レインボー気味のフロップ。K が落ちて負けたが EV は大きくプラス。
    const ev = evWinningsOf(rec({}));
    expect(ev).toBeGreaterThan(14000);
    expect(ev).toBeLessThan(20000);
  });

  it('捲り合いの無いハンドは実収支そのもの', () => {
    expect(evWinningsOf(rec({ action: 'b200c/kb100f', winnings: 300, botCards: null, board: ['2c', '7h', '9s'] }))).toBe(300);
    // リバーのオールインは捲らない。
    expect(evWinningsOf(rec({ action: 'ck/kk/kk/b19900c', winnings: 20000 }))).toBe(20000);
  });

  it('プリフロップの捲り合いも厳密に出る（AA vs KK ≈ 82%）', () => {
    const ev = evWinningsOf(rec({ action: 'b20000c' }));
    // 0.82 × 40000 − 20000 ≈ 12800
    expect(ev).toBeGreaterThan(12000);
    expect(ev).toBeLessThan(13500);
  });

  it('相手の手札が無ければ実収支に倒す', () => {
    expect(evWinningsOf(rec({ botCards: null }))).toBe(-20000);
  });

  it('withEv は計算済みならそのまま', () => {
    const r = rec({ evWinnings: 123 });
    expect(withEv(r)).toBe(r);
    expect(withEv(rec({})).evWinnings).not.toBeNull();
  });
});
