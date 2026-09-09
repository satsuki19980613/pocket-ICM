import { describe, it, expect } from 'vitest';
import { buildReadout, type AnteScheme, type Occupancy, type RawReads, type RawSeatRead, type SeatAction } from '@oshihiki/ocr';
import { buildChipCheckNote, buildOcrReadoutView, buildSeatRow, formatBb } from './ocrReadoutView';

// readout.test.ts と同じ流儀の最小フィクスチャビルダー（buildReadout を経由し、
// 実データ契約とズレないようにする）。
interface SeatSpec {
  id: string;
  hero?: boolean;
  button?: boolean;
  occupancy?: Occupancy;
  action?: SeatAction;
  stack: number;
  stackConf?: number;
  bet: number;
  betConf?: number;
  occConf?: number;
  actionConf?: number;
}

function seat(s: SeatSpec): RawSeatRead {
  return {
    id: s.id,
    isHero: s.hero ?? false,
    isButton: s.button ?? false,
    occupancy: { value: s.occupancy ?? 'occupied', conf: s.occConf ?? 1 },
    action: { value: s.action ?? 'none', conf: s.actionConf ?? 1 },
    stack: { value: s.stack, conf: s.stackConf ?? 1 },
    bet: { value: s.bet, conf: s.betConf ?? 1 },
  };
}

function mkReads(o: {
  street?: string;
  streetConf?: number;
  sb?: number;
  bb?: number;
  ante?: { scheme: AnteScheme; amount: number; conf?: number };
  pot: number;
  potConf?: number;
  hand?: string;
  handConf?: number;
  displayMode?: 'bb' | 'chips';
  blindChips?: { sb: number; bb: number; ante: number; level: number };
  seats: SeatSpec[];
}): RawReads {
  const ante = o.ante ?? { scheme: 'none' as AnteScheme, amount: 0 };
  return {
    street: { value: o.street ?? 'プリフロップ', conf: o.streetConf ?? 1 },
    blinds: { sb: { value: o.sb ?? 0.5, conf: 1 }, bb: { value: o.bb ?? 1, conf: 1 } },
    ante: { scheme: ante.scheme, amount: { value: ante.amount, conf: ante.conf ?? 1 } },
    pot: { value: o.pot, conf: o.potConf ?? 1 },
    heroHand: { value: o.hand ?? 'A5s', conf: o.handConf ?? 1 },
    seats: o.seats.map(seat),
    ...(o.displayMode !== undefined ? { displayMode: o.displayMode } : {}),
    ...(o.blindChips !== undefined ? { blindChips: o.blindChips } : {}),
  };
}

describe('formatBb', () => {
  it('小数第1位固定で桁を揃える', () => {
    expect(formatBb(14.5)).toBe('14.5bb');
    expect(formatBb(20)).toBe('20.0bb');
    expect(formatBb(0)).toBe('0.0bb');
    expect(formatBb(1.25)).toBe('1.3bb'); // toFixed の丸め
  });
});

describe('buildSeatRow', () => {
  it('pos があればポジション、無ければ席 ID を posLabel に使う', () => {
    const reads = mkReads({
      pot: 1.5,
      seats: [
        { id: 's0', button: true, stack: 15, bet: 0 },
        { id: 's1', hero: true, stack: 14.5, bet: 0.5 },
      ],
    });
    const posById = new Map([['s0', 'BU']]);
    const r = buildReadout(reads, { posById });
    const rowWithPos = buildSeatRow(r.seats[0]!);
    const rowWithoutPos = buildSeatRow(r.seats[1]!);
    expect(rowWithPos.posLabel).toBe('BU');
    expect(rowWithoutPos.posLabel).toBe('s1');
  });

  it('bet===0 は betText が null（非表示）、bet>0 は BB 表記', () => {
    const reads = mkReads({
      pot: 1.5,
      seats: [
        { id: 's0', stack: 15, bet: 0 },
        { id: 's1', stack: 14.5, bet: 0.5 },
      ],
    });
    const r = buildReadout(reads);
    expect(buildSeatRow(r.seats[0]!).betText).toBeNull();
    expect(buildSeatRow(r.seats[1]!).betText).toBe('0.5bb');
  });

  it('行には % 表記（confPct）を持たせない・occupancy/action は表示しない', () => {
    // 情報過多の指摘を受け、SEATS 行はポジション・スタック・bet のみに絞った。
    // stack/bet の低信頼フラグ（low）だけは CHECK 強調用に残すが、数値の % は持たない。
    const reads = mkReads({
      pot: 1.5,
      seats: [{ id: 's0', stack: 15, bet: 0.5, stackConf: 0.5, betConf: 0.5 }],
    });
    const r = buildReadout(reads);
    const row = buildSeatRow(r.seats[0]!);
    expect(row).not.toHaveProperty('occupancyText');
    expect(row).not.toHaveProperty('actionText');
    expect(row).not.toHaveProperty('stackConfPct');
    expect(row).not.toHaveProperty('betConfPct');
    expect(row).not.toHaveProperty('occupancyConfPct');
    expect(row).not.toHaveProperty('actionConfPct');
  });

  it('低信頼判定は readout.seats[].low をそのまま使う（conf を再計算しない）', () => {
    const reads = mkReads({
      pot: 1.5,
      seats: [
        {
          id: 's0',
          stack: 15,
          bet: 0.5,
          stackConf: 0.5,
          betConf: 0.5,
          occConf: 0.5,
          actionConf: 0.5,
          action: 'allin',
        },
      ],
    });
    const r = buildReadout(reads);
    const row = buildSeatRow(r.seats[0]!);
    expect(row.stackLow).toBe(true);
    expect(row.betLow).toBe(true);
  });

  it('しきい値ちょうどは低信頼扱いしない', () => {
    const reads = mkReads({ pot: 1.5, seats: [{ id: 's0', stack: 15, bet: 0, stackConf: 0.8 }] });
    const r = buildReadout(reads); // 既定しきい値 0.8
    expect(buildSeatRow(r.seats[0]!).stackLow).toBe(false);
  });
});

describe('buildChipCheckNote', () => {
  it('未適用/未定義なら null', () => {
    const reads = mkReads({ pot: 1, seats: [{ id: 's0', stack: 15, bet: 0 }] });
    expect(buildChipCheckNote(buildReadout(reads))).toBeNull();
    expect(buildChipCheckNote(buildReadout(reads, { chipCheck: { applied: false } }))).toBeNull();
  });

  it('適用時は補正席・note を含む文言を返す', () => {
    const reads = mkReads({ pot: 1, seats: [{ id: 's0', stack: 15, bet: 0 }] });
    const r = buildReadout(reads, {
      chipCheck: { applied: true, note: '総額が保存則に合うよう1席を復元', correctedSeatId: 'BB' },
    });
    const note = buildChipCheckNote(r);
    expect(note).toContain('総チップ保存チェックで補正しました');
    expect(note).toContain('BB');
    expect(note).toContain('総額が保存則に合うよう1席を復元');
  });

  it('note・補正席が無くても適用済みなら文言を返す', () => {
    const reads = mkReads({ pot: 1, seats: [{ id: 's0', stack: 15, bet: 0 }] });
    const r = buildReadout(reads, { chipCheck: { applied: true } });
    expect(buildChipCheckNote(r)).toBe('総チップ保存チェックで補正しました');
  });
});

describe('buildOcrReadoutView — 統合', () => {
  it('seats/issues/chipCheckNote をまとめて返す（header は無い）', () => {
    const reads = mkReads({
      street: 'preflop',
      pot: 2,
      seats: [
        { id: 's0', button: true, stack: 15, bet: 0 },
        { id: 's1', hero: true, stack: 14.5, bet: 0.5, action: 'allin' },
      ],
    });
    const r = buildReadout(reads, {
      issues: ['hero が BB で pot が未レイズです（ウォーク＝判断が存在しないため対象外）'],
      chipCheck: { applied: true, correctedSeatId: 's0' },
    });
    const view = buildOcrReadoutView(r);
    expect(view).not.toHaveProperty('header');
    expect(view.seats).toHaveLength(2);
    expect(view.seats[1]!.betText).toBe('0.5bb');
    expect(view.issues).toEqual(['hero が BB で pot が未レイズです（ウォーク＝判断が存在しないため対象外）']);
    expect(view.chipCheckNote).toContain('s0');
  });

  it('空席（occupancy===empty）の行は表示から除外する', () => {
    const reads = mkReads({
      pot: 1,
      seats: [
        { id: 's0', button: true, stack: 15, bet: 0, occupancy: 'occupied' },
        { id: 's1', stack: 0, bet: 0, occupancy: 'empty' },
        { id: 's2', hero: true, stack: 14.5, bet: 0.5, occupancy: 'occupied' },
      ],
    });
    const r = buildReadout(reads);
    const view = buildOcrReadoutView(r);
    expect(view.seats.map((s) => s.id)).toEqual(['s0', 's2']);
  });

  it('hero 席は occupancy===empty（誤読）でも残す', () => {
    // hero がどれか分からないと照合できないため、空席除外の例外として必ず残す。
    const reads = mkReads({
      pot: 1,
      seats: [
        { id: 's0', button: true, stack: 15, bet: 0, occupancy: 'occupied' },
        { id: 's1', hero: true, stack: 14.5, bet: 0.5, occupancy: 'empty' },
      ],
    });
    const r = buildReadout(reads);
    const view = buildOcrReadoutView(r);
    expect(view.seats.map((s) => s.id)).toEqual(['s0', 's1']);
    expect(view.seats[1]!.isHero).toBe(true);
  });

  it('失敗経路（席1件のみ・issues あり）でも例外を投げない', () => {
    const reads = mkReads({ street: 'flop', pot: 1, seats: [{ id: 's0', hero: true, stack: 14.5, bet: 0.5 }] });
    const r = buildReadout(reads, {
      issues: ['プリフロップの画面ではありません（検出: flop）。push/fold 判断はプリフロップのみ対象です'],
    });
    expect(() => buildOcrReadoutView(r)).not.toThrow();
    const view = buildOcrReadoutView(r);
    expect(view.seats).toHaveLength(1);
    expect(view.issues.length).toBe(1);
  });
});
