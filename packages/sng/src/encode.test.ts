import { describe, expect, it } from 'vitest';

import { decodeHand, encodeHand, type HandMeta } from './encode';
import type { SngHandRecord } from './types';

const meta: HandMeta = { gameId: 'sg_test', handNo: 5, playedAt: 1700000000000, sb: 100, bb: 200, ante: 25 };

function roundTrip(rec: SngHandRecord): void {
  const encoded = encodeHand(rec);
  const recMeta: HandMeta = {
    gameId: rec.gameId,
    handNo: rec.handNo,
    playedAt: rec.playedAt,
    sb: rec.sb,
    bb: rec.bb,
    ante: rec.ante,
  };
  const decoded = decodeHand(encoded, recMeta);
  expect(decoded).toEqual(rec);
}

describe('encode/decode v1 往復', () => {
  it('プリフロップで終了（fold のみ・ショーダウンなし）', () => {
    roundTrip({
      gameId: 'sg_test',
      handNo: 5,
      playedAt: meta.playedAt,
      level: 1,
      sb: 100,
      bb: 200,
      ante: 25,
      btn: 0,
      sbSeat: 1,
      bbSeat: 2,
      startStacks: [15000, 15000, 15000, 15000, 15000, 15000],
      shown: {},
      board: [],
      actions: [
        { seat: 3, kind: 'fold', betTo: 200, put: 0, auto: false, street: 0 },
        { seat: 4, kind: 'fold', betTo: 200, put: 0, auto: false, street: 0 },
        { seat: 5, kind: 'fold', betTo: 200, put: 0, auto: false, street: 0 },
        { seat: 0, kind: 'fold', betTo: 200, put: 0, auto: false, street: 0 },
        { seat: 1, kind: 'fold', betTo: 200, put: 0, auto: true, street: 0 },
      ],
      won: [0, 0, 200, 0, 0, 0],
      eliminated: [],
    });
  });

  it('全ストリート到達・ショーダウン公開あり・dead SB', () => {
    roundTrip({
      gameId: 'sg_test',
      handNo: 5,
      playedAt: meta.playedAt,
      level: 3,
      sb: 100,
      bb: 200,
      ante: 25,
      btn: 4,
      sbSeat: null,
      bbSeat: 0,
      startStacks: [12000, 8000, 0, 20000, 15000, 5000],
      shown: { 3: ['Ah', 'Kd'], 4: ['7s', '7c'] },
      board: ['2c', '9h', 'Td', 'Js', '3d'],
      actions: [
        { seat: 1, kind: 'call', betTo: 200, put: 200, auto: false, street: 0 },
        { seat: 3, kind: 'raise', betTo: 600, put: 600, auto: false, street: 0 },
        { seat: 4, kind: 'call', betTo: 600, put: 600, auto: false, street: 0 },
        { seat: 5, kind: 'fold', betTo: 600, put: 0, auto: false, street: 0 },
        { seat: 0, kind: 'call', betTo: 600, put: 400, auto: false, street: 0 },
        { seat: 1, kind: 'call', betTo: 600, put: 400, auto: false, street: 0 },
        { seat: 0, kind: 'check', betTo: 0, put: 0, auto: false, street: 1 },
        { seat: 1, kind: 'bet', betTo: 800, put: 800, auto: false, street: 1 },
        { seat: 3, kind: 'call', betTo: 800, put: 800, auto: false, street: 1 },
        { seat: 4, kind: 'call', betTo: 800, put: 800, auto: false, street: 1 },
        { seat: 0, kind: 'fold', betTo: 800, put: 0, auto: false, street: 1 },
        { seat: 1, kind: 'check', betTo: 0, put: 0, auto: false, street: 2 },
        { seat: 3, kind: 'check', betTo: 0, put: 0, auto: false, street: 2 },
        { seat: 4, kind: 'check', betTo: 0, put: 0, auto: false, street: 2 },
        { seat: 1, kind: 'allin', betTo: 7000, put: 7000, auto: false, street: 3 },
        { seat: 3, kind: 'call', betTo: 7000, put: 7000, auto: false, street: 3 },
        { seat: 4, kind: 'fold', betTo: 7000, put: 0, auto: false, street: 3 },
      ],
      won: [0, 0, 0, 16400, 0, 0],
      eliminated: [{ seat: 1, place: 5 }],
    });
  });

  it('プリフロップで全員オールイン→残りのボードは配られるがアクションは無し', () => {
    roundTrip({
      gameId: 'sg_test',
      handNo: 5,
      playedAt: meta.playedAt,
      level: 8,
      sb: 500,
      bb: 1000,
      ante: 200,
      btn: 0,
      sbSeat: 1,
      bbSeat: 2,
      startStacks: [3000, 4000, 5000, 0, 0, 0],
      shown: { 0: ['As', 'Ad'], 1: ['Kh', 'Kc'], 2: ['2h', '2d'] },
      board: ['4h', '5h', '6h', '7h', '8h'],
      actions: [{ seat: 0, kind: 'allin', betTo: 3000, put: 3000, auto: false, street: 0 }],
      won: [9000, 0, 0, 0, 0, 0],
      eliminated: [
        { seat: 1, place: 3 },
        { seat: 2, place: 2 },
      ],
    });
  });

  it('複数人が同一ハンドで脱落・E に複数エントリ', () => {
    roundTrip({
      gameId: 'sg_test',
      handNo: 5,
      playedAt: meta.playedAt,
      level: 10,
      sb: 1000,
      bb: 2000,
      ante: 500,
      btn: 1,
      sbSeat: 2,
      bbSeat: 3,
      startStacks: [10000, 0, 0, 0, 30000, 0],
      shown: { 0: ['Qs', 'Qd'], 2: ['Jh', 'Jc'], 3: ['5s', '5d'] },
      board: ['Qh', '9c', '2s', '4d', '6h'],
      actions: [
        { seat: 4, kind: 'fold', betTo: 2000, put: 0, auto: false, street: 0 },
        { seat: 0, kind: 'allin', betTo: 10000, put: 10000, auto: false, street: 0 },
      ],
      won: [30500, 0, 0, 0, 0, 0],
      eliminated: [
        { seat: 3, place: 4 },
        { seat: 2, place: 3 },
      ],
    });
  });

  it('自動処理フラグ（!）を保つ', () => {
    roundTrip({
      gameId: 'sg_test',
      handNo: 5,
      playedAt: meta.playedAt,
      level: 1,
      sb: 100,
      bb: 200,
      ante: 0,
      btn: 0,
      sbSeat: 1,
      bbSeat: 2,
      startStacks: [15000, 15000, 15000, 0, 0, 0],
      shown: {},
      board: [],
      actions: [
        { seat: 0, kind: 'fold', betTo: 200, put: 0, auto: true, street: 0 },
        { seat: 1, kind: 'fold', betTo: 200, put: 0, auto: true, street: 0 },
      ],
      won: [0, 0, 200, 0, 0, 0],
      eliminated: [],
    });
  });

  it('不正な文字列は null（バージョン不一致・フィールド数不足・壊れたトークン）', () => {
    expect(decodeHand('2|L1|B0,1,2|S1,2|C|D|A|W1,2|E', meta)).toBeNull();
    expect(decodeHand('1|L1|B0,1,2|S1,2', meta)).toBeNull();
    expect(decodeHand('1|X1|B0,1,2|S1,2|C|D|A|W1,2|E', meta)).toBeNull();
    expect(decodeHand('1|L1|B0,1,2|S1,2|C|D|A0z|W1,2|E', meta)).toBeNull();
    expect(decodeHand('not even close', meta)).toBeNull();
    expect(decodeHand('', meta)).toBeNull();
  });
});
