/**
 * 条件確認のポット欄（`potRowView`）のテスト。
 *
 * 実機 Pixel のスクショで、確認画面が「一致 (2.75bb)」と出し、ゲームの画面の 2.8 と
 * 食い違って見えた件（さつき指摘 2026-09-11）の再発防止。ゲームは小数第 2 位を四捨五入する。
 * あわせて、以前は計算値どうしを比べて常に「一致」だった照合が、本当に画面の値と比べることを固定する。
 */
import { describe, it, expect } from 'vitest';
import type { BoardState, Position } from '@oshihiki/core';
import type { OcrSeatReadout } from '@oshihiki/ocr';
import { potRowView, type PotReadout } from './confirmPot';

const ORDER: Position[][] = [
  [],
  [],
  ['SB', 'BB'],
  ['BU', 'SB', 'BB'],
  ['CO', 'BU', 'SB', 'BB'],
  ['UTG', 'CO', 'BU', 'SB', 'BB'],
  ['UTG', 'HJ', 'CO', 'BU', 'SB', 'BB'],
];

/** 配られた時点の局面（ブラインド 0.5/1・アンティ 0.25 全員）。ポットは整合する値。 */
function spot(players: number): BoardState {
  const seats = ORDER[players]!.map((pos) => ({
    pos,
    stack: 20,
    state: 'live' as const,
    bet: pos === 'SB' ? 0.5 : pos === 'BB' ? 1 : 0,
  }));
  return {
    street: 'preflop',
    blinds: { sb: 0.5, bb: 1 },
    ante: { scheme: 'all', amount: 0.25 },
    heroHand: 'JTs',
    playersLeft: players,
    seats,
    heroPos: ORDER[players]![0]!,
    pot: 1.5 + 0.25 * players,
  } as BoardState;
}

const rd = <T>(value: T) => ({ value, conf: 0.9 });

/** 読み取り結果（ポットと各席）。seats は [ポジション, 行動, ベット]。 */
function readout(pot: number, seats: readonly [string, string, number][] = []): PotReadout {
  return {
    pot: rd(pot),
    seats: seats.map(
      ([pos, action, bet], i) =>
        ({
          id: `s${i}`,
          pos,
          isHero: false,
          isButton: false,
          occupancy: rd('occupied'),
          action: rd(action),
          stack: rd(0),
          bet: rd(bet),
          low: [],
        }) as unknown as OcrSeatReadout,
    ),
  };
}

describe('potRowView', () => {
  it('実機 Pixel: 計算 2.75 はゲームと同じく 2.8 と表示し、画面の 2.8 と一致', () => {
    expect(potRowView(spot(5), readout(2.8))).toEqual({ text: '一致 (2.8bb)', ok: true });
  });

  it('人数を読み違えて計算がずれていれば不一致（常に一致にはしない）', () => {
    // 画面は 5 人卓の 2.8 だが、確認画面の局面が 6 人（計算 3.0）になっている。
    const v = potRowView(spot(6), readout(2.8));
    expect(v).toEqual({ text: '不一致（画面 2.8bb / 計算 3bb）', ok: false });
  });

  it('オールインがある局面: 上乗せ分を足して画面のポットと比べる（iPhone SE の 3 人卓）', () => {
    // BU が 29 BB オールイン。画面のポット 31.3 = 0.5 + 1 + 0.25×3 + 29 = 31.25（四捨五入）。
    const v = potRowView(spot(3), readout(31.3, [['BU', 'allin', 29], ['SB', 'none', 0.5], ['BB', 'none', 1]]));
    expect(v).toEqual({ text: '一致 (31.3bb)', ok: true });
  });

  it('一致したときは画面の値を出す（オールイン額が画面で丸め済みでも 0.1 ずれない）', () => {
    // 実測 115309: 3 人卓で BU が 9.6 BB オールイン（画面表示・本当はわずかに小さい）。
    // 計算 2.25 + 9.6 = 11.85 を丸め直すと 11.9 だが、ゲームの画面は 11.8。
    const v = potRowView(spot(3), readout(11.8, [['BU', 'allin', 9.6], ['SB', 'none', 0.5], ['BB', 'none', 1]]));
    expect(v).toEqual({ text: '一致 (11.8bb)', ok: true });
  });

  it('SB がオールインなら、SB のブラインド分は二重に足さない', () => {
    // HU: SB が 5.9 BB オールイン（うち 0.5 はブラインド）、BB 1。ポット 5.9 + 1 + 0.25×2 = 7.4。
    const v = potRowView(spot(2), readout(7.4, [['SB', 'allin', 5.9], ['BB', 'none', 1]]));
    expect(v).toEqual({ text: '一致 (7.4bb)', ok: true });
  });

  it('オールイン額が読めなければ照合できないと示す（一致とは言わない）', () => {
    const v = potRowView(spot(3), readout(31.3, [['BU', 'allin', NaN]]));
    expect(v.ok).toBe(false);
    expect(v.text).toMatch(/照合できません/);
  });

  it('手入力（読み取り結果が無い）なら、丸めた計算値で一致を示す', () => {
    expect(potRowView(spot(5))).toEqual({ text: '一致 (2.8bb)', ok: true });
  });

  it('局面そのものが矛盾していれば従来どおり差を出す', () => {
    const v = potRowView({ ...spot(5), pot: 9 }, readout(2.8));
    expect(v.ok).toBe(false);
    expect(v.text).toMatch(/^不一致 Δ=/);
  });

  it('末尾の .0 はゲームと同じく付けない', () => {
    expect(potRowView(spot(6), readout(3)).text).toBe('一致 (3bb)');
  });
});
