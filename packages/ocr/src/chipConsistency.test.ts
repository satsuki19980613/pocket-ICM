import { describe, it, expect } from 'vitest';
import { totalChipsOf } from '@oshihiki/core';
import { applyChipConsistency } from './chipConsistency.js';
import type { RawReads, RawSeatRead, Occupancy, SeatAction } from './types.js';

function seat(id: string, stack: number, conf = 0.9, occ: Occupancy = 'occupied', bet = 0, act: SeatAction = 'none'): RawSeatRead {
  return {
    id,
    isHero: id === 'BC',
    isButton: false,
    occupancy: { value: occ, conf: 0.9 },
    action: { value: act, conf: 0.9 },
    stack: { value: stack, conf },
    bet: { value: bet, conf: 0.9 },
  };
}

interface StackSpec { id: string; v: number; c?: number; bet?: number; act?: SeatAction }

/** bb960/ante240（別スピード・level=0）・5席のクラブマッチ RawReads。deadPot=2.75, totalTheory=93.75。 */
function reads(stacks: StackSpec[], withLevel = true, pot = 2.75): RawReads {
  return {
    street: { value: 'preflop', conf: 0.9 },
    blinds: { sb: { value: 0.5, conf: 0.9 }, bb: { value: 1, conf: 0.9 } },
    ante: { scheme: 'all', amount: { value: 0.25, conf: 0.9 } },
    pot: { value: pot, conf: 0.9 },
    heroHand: { value: '54o', conf: 0.9 },
    seats: stacks.map((s) => seat(s.id, s.v, s.c, 'occupied', s.bet ?? 0, s.act ?? 'none')),
    displayMode: 'bb',
    ...(withLevel ? { blindChips: { sb: 480, bb: 960, ante: 240, level: 0 } } : {}),
  };
}

const FIVE = ['UTG', 'CO', 'BU', 'SB', 'BB'];

/** bb780/ante200・3席（βテストで誤補正が出た実フレームの再現用）。deadPot=2.269, totalTheory=115.385。 */
function reads780(stacks: StackSpec[]): RawReads {
  return {
    street: { value: 'preflop', conf: 0.9 },
    blinds: { sb: { value: 0.5, conf: 0.9 }, bb: { value: 1, conf: 0.9 } },
    ante: { scheme: 'all', amount: { value: 200 / 780, conf: 0.9 } },
    pot: { value: 2.3, conf: 0.9 },
    heroHand: { value: '72o', conf: 0.9 },
    seats: stacks.map((s) => seat(s.id, s.v, s.c, 'occupied', s.bet ?? 0, s.act ?? 'none')),
    displayMode: 'bb',
    blindChips: { sb: 390, bb: 780, ante: 200, level: 0 },
  };
}

describe('chipConsistency', () => {
  it('一致（合計=91.0）はそのまま consistent', () => {
    const r = reads([
      { id: 'UTG', v: 11.5 }, { id: 'CO', v: 31.9 }, { id: 'BU', v: 22.3 },
      { id: 'SB', v: 14.4 }, { id: 'BB', v: 10.9 },
    ]);
    const { reads: out, result } = applyChipConsistency(r);
    expect(result.mode).toBe('consistent');
    expect(result.totalBbTheory).toBeCloseTo(93.75, 2);
    expect(out.seats.map((s) => s.stack.value)).toEqual([11.5, 31.9, 22.3, 14.4, 10.9]);
  });

  it('回帰(β報告): 表示丸めぶんの差では補正しない（bb780・3席・73.5bb が 73.6bb に化けた件）', () => {
    // 実フレーム: SB 73.5 / BB 23.6 / BU(hero) 15.9、ante 200・BB 780。OCR は 3 席とも正しい。
    // 理論 115.385 に対し読み合計は 115.269（差 0.116）だが、これは各席の BB 表示が
    // 0.1 刻みへ丸められている残差（3 席で最大 ±0.15）で説明できる。誤読ではないので
    // 触ってはいけない。旧実装は固定しきい値 0.05 で「不一致」と判定し、最低信頼席
    // （SB）に +0.12 を足して 73.6bb にしていた。
    const r = reads780([
      { id: 'SB', v: 73.5, c: 0.7, bet: 0.5 },
      { id: 'BB', v: 23.6, c: 0.9, bet: 1 },
      { id: 'BC', v: 15.9, c: 0.9 },
    ]);
    const { reads: out, result } = applyChipConsistency(r);
    expect(result.mode).toBe('consistent');
    expect(result.correctedSeatId).toBeUndefined();
    expect(out.seats.map((s) => s.stack.value)).toEqual([73.5, 23.6, 15.9]);
  });

  it('許容幅は席数に比例する（3席=±0.20 / 5席=±0.30）', () => {
    // 3 席で差 0.25（帯 0.20 の外）なら従来どおり補正される＝緩めすぎていないことの確認。
    const r = reads780([
      { id: 'SB', v: 73.5 - 0.25, c: 0.3, bet: 0.5 },
      { id: 'BB', v: 23.6, c: 0.9, bet: 1 },
      { id: 'BC', v: 15.9, c: 0.9 },
    ]);
    const { result } = applyChipConsistency(r);
    expect(result.mode).toBe('adjust');
    expect(result.correctedSeatId).toBe('SB');
  });

  it('補正値は画面と同じ 0.1 刻みに載る', () => {
    const r = reads780([
      { id: 'SB', v: 73.5 - 0.44, c: 0.3, bet: 0.5 },
      { id: 'BB', v: 23.6, c: 0.9, bet: 1 },
      { id: 'BC', v: 15.9, c: 0.9 },
    ]);
    const { reads: out, result } = applyChipConsistency(r);
    expect(result.mode).toBe('adjust');
    const sb = out.seats.find((s) => s.id === 'SB')!;
    expect(Math.round(sb.stack.value * 10) / 10).toBe(sb.stack.value); // 0.1 の倍数
  });

  it('0.5低い誤読を最低信頼席で+0.5調整', () => {
    // SB を 13.9（正 14.4）・SB の conf を最低に。合計 90.5 → 理論 91.0 に 0.5 不足。
    const r = reads([
      { id: 'UTG', v: 11.5, c: 0.9 }, { id: 'CO', v: 31.9, c: 0.9 }, { id: 'BU', v: 22.3, c: 0.9 },
      { id: 'SB', v: 13.9, c: 0.3 }, { id: 'BB', v: 10.9, c: 0.9 },
    ]);
    const { reads: out, result } = applyChipConsistency(r);
    expect(result.mode).toBe('adjust');
    expect(result.correctedSeatId).toBe('SB');
    const sb = out.seats.find((s) => s.id === 'SB')!;
    expect(sb.stack.value).toBeCloseTo(14.4, 2);
    expect(sb.stack.conf).toBeLessThanOrEqual(0.5);
  });

  it('1席NaNは保存則から復元', () => {
    // BB を NaN に。他4席合計 80.1 + deadPot 2.75 = 82.85 → 復元 BB = 93.75-82.85 = 10.9。
    const r = reads([
      { id: 'UTG', v: 11.5 }, { id: 'CO', v: 31.9 }, { id: 'BU', v: 22.3 },
      { id: 'SB', v: 14.4 }, { id: 'BB', v: NaN },
    ]);
    const { reads: out, result } = applyChipConsistency(r);
    expect(result.mode).toBe('recover');
    expect(result.correctedSeatId).toBe('BB');
    const bb = out.seats.find((s) => s.id === 'BB')!;
    expect(bb.stack.value).toBeCloseTo(10.9, 2);
    expect(bb.stack.conf).toBeLessThan(0.5);
  });

  it('blindChips無し（非クラブマッチ扱い）は無効・不変', () => {
    const r = reads([{ id: 'UTG', v: 11.5 }, { id: 'BB', v: 10.9 }], false);
    const { reads: out, result } = applyChipConsistency(r);
    expect(result.mode).toBe('disabled');
    expect(result.applied).toBe(false);
    expect(out).toBe(r);
  });

  it('差が大きすぎる（6〜15%・モード不一致疑い）は触らない', () => {
    // 合計 81.6 + deadPot 2.75 = 84.35 / 理論 93.75 → 差 9.4（10.0%）。
    // 補正はしないが、棄却するほどではない帯（large-delta-skip）。
    const r = reads([
      { id: 'UTG', v: 11.5 }, { id: 'CO', v: 31.9 }, { id: 'BU', v: 22.3 },
      { id: 'SB', v: 14.4, c: 0.3 }, { id: 'BB', v: 1.5 },
    ]);
    const { reads: out, result } = applyChipConsistency(r);
    expect(result.mode).toBe('large-delta-skip');
    expect(out.seats.map((s) => s.stack.value)).toEqual([11.5, 31.9, 22.3, 14.4, 1.5]);
  });

  it('登録済みストラクチャに一致（level>0）なら総チップが合わなくても弾かない', () => {
    // さつき指示 2026-09-10: 公式表（通常/ゆっくり/もっとゆっくり）に当てはまるフレームは
    // 総チップ保存が成立しなくても棄却しない。チェックが無効化されるだけ（補正もしない）。
    const r = reads([
      { id: 'UTG', v: 5 }, { id: 'CO', v: 5 }, { id: 'BU', v: 5 },
      { id: 'SB', v: 5, c: 0.3 }, { id: 'BB', v: 5 },
    ]);
    const withLevel: RawReads = { ...r, blindChips: { sb: 480, bb: 960, ante: 240, level: 9 } };
    const { reads: out, result } = applyChipConsistency(withLevel);
    expect(result.mode).not.toBe('not-club-skip');
    expect(result.applied).toBe(false); // 補正もしない（差が大きすぎる）
    expect(out.seats.map((s) => s.stack.value)).toEqual([5, 5, 5, 5, 5]);
  });

  it('表に無い構造（level=0）で総チップと 15% 以上食い違えば not-club-skip（棄却させる）', () => {
    // 合計 25 + 2.75 = 27.75 / 理論 93.75 → 70% 乖離。別モードのスクショか重大誤読。
    const r = reads([
      { id: 'UTG', v: 5 }, { id: 'CO', v: 5 }, { id: 'BU', v: 5 },
      { id: 'SB', v: 5, c: 0.3 }, { id: 'BB', v: 5 },
    ]);
    const { reads: out, result } = applyChipConsistency(r);
    expect(result.mode).toBe('not-club-skip');
    expect(result.applied).toBe(false);
    expect(out.seats.map((s) => s.stack.value)).toEqual([5, 5, 5, 5, 5]);
  });

  // ---- Phase 4: オールイン ----
  // 5席・レベル9（anteBb=0.25, antePot=5×0.25=1.25）。CO オールイン bet=20, SB=0.5, BB=1.0。
  //   betSum=21.5, computedPot = 1.25+21.5 = 22.75。
  const allinFive = (pot: number, coBet = 20): RawReads =>
    reads([
      { id: 'UTG', v: 11.5 }, { id: 'CO', v: 0, c: 0.95, bet: coBet, act: 'allin' }, { id: 'BU', v: 22.3 },
      { id: 'SB', v: 14.4, bet: 0.5 }, { id: 'BB', v: 10.9, bet: 1.0 },
    ], true, pot);

  it('オールイン: 計算ポット＝OCR ポット → allin-consistent・計算値採用', () => {
    const r = allinFive(22.75);
    const { reads: out, result } = applyChipConsistency(r);
    expect(result.mode).toBe('allin-consistent');
    expect(result.applied).toBe(true);
    expect(result.potComputed).toBeCloseTo(22.75, 2);
    expect(out.pot.value).toBeCloseTo(22.75, 2); // 計算値をポットに採用
    // オールイン席スタック(0)・他スタックは触らない。
    expect(out.seats.map((s) => s.stack.value)).toEqual([11.5, 0, 22.3, 14.4, 10.9]);
  });

  it('オールイン: OCR ポット欠測 → 計算値で採用（allin-pot-computed）', () => {
    const r = allinFive(NaN);
    const { reads: out, result } = applyChipConsistency(r);
    expect(result.mode).toBe('allin-pot-computed');
    expect(out.pot.value).toBeCloseTo(22.75, 2);
  });

  it('オールイン: オールイン席のベット未読 → allin-unread-skip（不変）', () => {
    const r = allinFive(22.75, 0); // CO の bet=0（未読）
    const { reads: out, result } = applyChipConsistency(r);
    expect(result.mode).toBe('allin-unread-skip');
    expect(result.applied).toBe(false);
    expect(out).toBe(r);
  });

  it('オールイン: 計算ポット≪OCR ポット → ベット読み落とし疑いで OCR 保持', () => {
    const r = allinFive(30); // OCR が 30、計算は 22.75
    const { reads: out, result } = applyChipConsistency(r);
    expect(result.mode).toBe('allin-bet-underread');
    expect(result.applied).toBe(false);
    expect(out.pot.value).toBe(30); // OCR ポットを保持（過補正回避）
  });

  it('オールイン: 総チップ保存が成立すれば conserved フラグ true', () => {
    // stackSum を 71.0 に（+betSum21.5+antePot1.25 = 93.75 = theory）。
    const r = reads([
      { id: 'UTG', v: 11.5 }, { id: 'CO', v: 0, c: 0.95, bet: 20, act: 'allin' }, { id: 'BU', v: 22.3 },
      { id: 'SB', v: 14.4, bet: 0.5 }, { id: 'BB', v: 22.8, bet: 1.0 },
    ], true, 22.75);
    const { result } = applyChipConsistency(r);
    expect(result.conserved).toBe(true);
    expect(result.totalBbRead).toBeCloseTo(93.75, 2);
  });

  void FIVE;
});

describe('ゲームモードと総チップ（2026-09-12 の実機総当たりで発見した回帰）', () => {
  /** 未読 1 席（NaN）を含む 5 席。復元値は選択モードの総チップに直接依存する。 */
  const unread = () =>
    reads([
      { id: 'UTG', v: 11.5 }, { id: 'CO', v: 31.9 }, { id: 'BU', v: 22.3 },
      { id: 'SB', v: 14.4 }, { id: 'BB', v: NaN },
    ]);

  it('未読 1 席の復元は「モード依存でやった」印を返す（無警告で値が変わるのを防ぐ）', () => {
    const { result } = applyChipConsistency(unread(), totalChipsOf('club'));
    expect(result.mode).toBe('recover');
    expect(result.applied).toBe(true);
    expect(result.modeDependentRecovery).toBe(true);
  });

  it('復元値はモードで実際に変わる（だから印が要る）', () => {
    const pick = (total: number) => {
      const { reads: out, result } = applyChipConsistency(unread(), total);
      return { stack: out.seats.find((x) => x.id === 'BB')!.stack.value, mode: result.mode, mismatch: result.modeMismatch };
    };
    const club = pick(totalChipsOf('club')); // 総 93.75bb → 10.9
    const legend = pick(totalChipsOf('legend-avg')); // 総 125bb → 42.15
    expect(club.mode).toBe('recover');
    expect(legend.mode).toBe('recover');
    // **同じフレームなのに復元値が 4 倍近く違う**。これが無警告だったのが今回のバグ。
    expect(legend.stack).toBeGreaterThan(club.stack * 3);

    // 総チップ 90,000 の rank-4 は club と同値になる（総チップが衝突する設計どおり）。
    expect(pick(totalChipsOf('rank-4')).stack).toBe(club.stack);

    // 総チップが小さすぎて復元値が負になる場合は復元しない（既存の範囲ガードが効く）。
    const rank3 = pick(totalChipsOf('rank-3')); // 総 62.5bb < 読めた合計 82.85bb
    expect(rank3.mode).toBe('multi-unreadable-skip');
    expect(Number.isNaN(rank3.stack)).toBe(true);
    // 読めた席だけで rank-3 の総チップを 3 割超えている＝モード取り違えの疑いを立てる（2026-09-12 レビュー）。
    expect(rank3.mismatch).toBe(true);
    expect(club.mismatch).toBeUndefined();
  });

  it('全席読めているときは復元の印を立てない', () => {
    const r = reads([
      { id: 'UTG', v: 11.5 }, { id: 'CO', v: 31.9 }, { id: 'BU', v: 22.3 },
      { id: 'SB', v: 14.4 }, { id: 'BB', v: 10.9 },
    ]);
    const { result } = applyChipConsistency(r, totalChipsOf('club'));
    expect(result.modeDependentRecovery).toBeUndefined();
  });
});

describe('未読席の扱い（さつき指示 2026-09-12: 1席は補正・2席以上は修正を促す）', () => {
  const withUnread = (n: number) =>
    reads([
      { id: 'UTG', v: 11.5 }, { id: 'CO', v: 31.9 }, { id: 'BU', v: 22.3 },
      { id: 'SB', v: n >= 2 ? NaN : 14.4 }, { id: 'BB', v: NaN },
    ]);

  it('1 席だけ未読 → 合計から補正する', () => {
    const { reads: out, result } = applyChipConsistency(withUnread(1), totalChipsOf('club'));
    expect(result.mode).toBe('recover');
    expect(result.applied).toBe(true);
    expect(Number.isFinite(out.seats.find((s) => s.id === 'BB')!.stack.value)).toBe(true);
  });

  it('2 席以上が未読 → 補正しない（一意に解けないため）。値も書き換えない', () => {
    const input = withUnread(2);
    const { reads: out, result } = applyChipConsistency(input, totalChipsOf('club'));
    expect(result.mode).toBe('multi-unreadable-skip');
    expect(result.applied).toBe(false);
    // 読めた席の値は一切触らない。
    expect(out.seats.map((s) => s.stack.value)).toEqual(input.seats.map((s) => s.stack.value));
  });
});
