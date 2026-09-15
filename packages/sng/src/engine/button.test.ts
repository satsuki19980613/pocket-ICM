import { describe, expect, it } from 'vitest';

import type { PlayerState } from '../types';
import { computeButtonForHand } from './button';

function makePlayers(n: number, outSeats: readonly number[] = []): PlayerState[] {
  return Array.from({ length: n }, (_, seat) => ({
    userId: `u${seat}`,
    name: `P${seat}`,
    seat,
    stack: outSeats.includes(seat) ? 0 : 10000,
    status: outSeats.includes(seat) ? 'out' : 'active',
    connected: true,
    timeBankMs: 30_000,
    autoCount: 0,
    place: outSeats.includes(seat) ? 6 : null,
    pt: null,
  }));
}

describe('computeButtonForHand', () => {
  it('初回ハンド: forcedBtn から順に sb/bb（全員 live）', () => {
    const players = makePlayers(6);
    const r = computeButtonForHand(players, null, null, 2);
    expect(r).toEqual({ btn: 2, sbSeat: 3, bbSeat: 4 });
  });

  it('通常進行（誰も飛んでいない）: btn/sb/bb が 1 席ずつ時計回りに進む', () => {
    const players = makePlayers(6);
    // hand1: btn=0,sb=1,bb=2 だったとする。
    const r = computeButtonForHand(players, 1, 2);
    expect(r).toEqual({ btn: 1, sbSeat: 2, bbSeat: 3 });
  });

  it('デッドボタン: 前ハンドの BB 席が脱落しているとその席は dead SB（sbSeat=null）', () => {
    // 前ハンド sb=2, bb=3。席3が脱落。
    const players = makePlayers(6, [3]);
    const r = computeButtonForHand(players, 2, 3);
    // bb = nextLive(3) = 4。sb候補=prevBb=3だが dead → null。btn=prevSb=2。
    expect(r.btn).toBe(2);
    expect(r.sbSeat).toBeNull();
    expect(r.bbSeat).toBe(4);
  });

  it('デッドボタン: 前ハンドの SB 席が脱落しているとボタンが dead（btn は死んだ席番号のまま）', () => {
    // 前ハンド sb=2, bb=3。席2が脱落（sb 側）。
    const players = makePlayers(6, [2]);
    const r = computeButtonForHand(players, 2, 3);
    // bb = nextLive(3) = 4。sb候補=prevBb=3（live）→ sb=3。btn=prevSb=2（dead でも席番号はそのまま）。
    expect(r.btn).toBe(2);
    expect(r.sbSeat).toBe(3);
    expect(r.bbSeat).toBe(4);
  });

  it('複数席が飛んでいても bb は nextLive で正しくスキップする', () => {
    const players = makePlayers(6, [3, 4]);
    const r = computeButtonForHand(players, 2, 3);
    // bb = nextLive(3) → 4 は dead なので 5。
    expect(r.bbSeat).toBe(5);
    expect(r.sbSeat).toBeNull(); // prevBb=3 は dead。
    expect(r.btn).toBe(2);
  });

  it('HU（生存2人）: btn = sb。もう一方が bb', () => {
    const players = makePlayers(6, [0, 1, 2, 3]); // seat4,5 だけ live
    const r = computeButtonForHand(players, 4, 5);
    expect(r.bbSeat).toBe(4); // nextLive(5) → 4
    expect(r.sbSeat).toBe(5);
    expect(r.btn).toBe(5); // HU: btn=sb
  });

  it('HU の初回ハンド（players=2 設定）: forcedBtn 側が btn=sb、もう一方が bb', () => {
    const players = makePlayers(2);
    const r = computeButtonForHand(players, null, null, 1);
    expect(r).toEqual({ btn: 1, sbSeat: 1, bbSeat: 0 });
  });
});
