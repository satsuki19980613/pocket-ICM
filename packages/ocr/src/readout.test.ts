import { describe, it, expect } from 'vitest';
import { buildReadout } from './readout.js';
import type { AnteScheme, Occupancy, RawReads, RawSeatRead, SeatAction } from './types.js';

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
  ante?: { scheme: AnteScheme; amount: number };
  pot: number;
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
    ante: { scheme: ante.scheme, amount: { value: ante.amount, conf: 1 } },
    pot: { value: o.pot, conf: 1 },
    heroHand: { value: o.hand ?? 'A5s', conf: o.handConf ?? 1 },
    seats: o.seats.map(seat),
    ...(o.displayMode !== undefined ? { displayMode: o.displayMode } : {}),
    ...(o.blindChips !== undefined ? { blindChips: o.blindChips } : {}),
  };
}

describe('buildReadout — 基本の写経・席順', () => {
  it('RawReads.seats の順序をそのまま保つ', () => {
    const reads = mkReads({
      pot: 1.5,
      seats: [
        { id: 'CO', stack: 15, bet: 0 },
        { id: 'BU', button: true, stack: 15, bet: 0 },
        { id: 'SB', stack: 14.5, bet: 0.5 },
        { id: 'BB', hero: true, stack: 14, bet: 1 },
      ],
    });
    const r = buildReadout(reads);
    expect(r.seats.map((s) => s.id)).toEqual(['CO', 'BU', 'SB', 'BB']);
  });

  it('ヘッダ値（street/blinds/ante/pot/heroHand）を加工せずそのまま返す', () => {
    const reads = mkReads({
      street: 'プリフロップ',
      sb: 0.5,
      bb: 1,
      ante: { scheme: 'all', amount: 0.1 },
      pot: 2.0,
      hand: 'AKs',
      handConf: 0.42,
      seats: [
        { id: 'SB', button: true, hero: true, stack: 14.5, bet: 0.5 },
        { id: 'BB', stack: 14, bet: 1 },
      ],
    });
    const r = buildReadout(reads);
    expect(r.street).toEqual({ value: 'プリフロップ', conf: 1 });
    expect(r.blinds.sb).toEqual({ value: 0.5, conf: 1 });
    expect(r.blinds.bb).toEqual({ value: 1, conf: 1 });
    expect(r.ante).toEqual({ scheme: 'all', amount: { value: 0.1, conf: 1 } });
    expect(r.pot).toEqual({ value: 2.0, conf: 1 });
    expect(r.heroHand).toEqual({ value: 'AKs', conf: 0.42 });
  });

  it('displayMode / blindChips は存在するときだけ引き継ぐ', () => {
    const withBoth = buildReadout(
      mkReads({
        pot: 1.5,
        displayMode: 'chips',
        blindChips: { sb: 250, bb: 500, ante: 50, level: 3 },
        seats: [
          { id: 'SB', button: true, hero: true, stack: 14.5, bet: 0.5 },
          { id: 'BB', stack: 14, bet: 1 },
        ],
      }),
    );
    expect(withBoth.displayMode).toBe('chips');
    expect(withBoth.blindChips).toEqual({ sb: 250, bb: 500, ante: 50, level: 3 });

    const withNeither = buildReadout(
      mkReads({
        pot: 1.5,
        seats: [
          { id: 'SB', button: true, hero: true, stack: 14.5, bet: 0.5 },
          { id: 'BB', stack: 14, bet: 1 },
        ],
      }),
    );
    expect(withNeither.displayMode).toBeUndefined();
    expect(withNeither.blindChips).toBeUndefined();
  });
});

describe('buildReadout — pos 反映', () => {
  const reads = mkReads({
    pot: 1.5,
    seats: [
      { id: 's0', button: true, stack: 15, bet: 0 },
      { id: 's1', hero: true, stack: 14.5, bet: 0.5 },
    ],
  });

  it('posById を渡すと該当席に pos が付く', () => {
    const posById = new Map([
      ['s0', 'BU'],
      ['s1', 'SB'],
    ]);
    const r = buildReadout(reads, { posById });
    expect(r.seats.find((s) => s.id === 's0')?.pos).toBe('BU');
    expect(r.seats.find((s) => s.id === 's1')?.pos).toBe('SB');
  });

  it('posById が無ければ pos は undefined（gate 失敗・復元失敗でも呼べる契約）', () => {
    const r = buildReadout(reads);
    expect(r.seats.every((s) => s.pos === undefined)).toBe(true);
  });

  it('posById に一部の席しか無ければその席だけ pos が付く', () => {
    const posById = new Map([['s0', 'BU']]);
    const r = buildReadout(reads, { posById });
    expect(r.seats.find((s) => s.id === 's0')?.pos).toBe('BU');
    expect(r.seats.find((s) => s.id === 's1')?.pos).toBeUndefined();
  });
});

describe('buildReadout — 低信頼判定（席ごとの low）', () => {
  it('既定しきい値 0.8 未満の項目が low に入る', () => {
    const reads = mkReads({
      pot: 1.5,
      seats: [
        { id: 'BU', button: true, hero: true, stack: 15, bet: 0, stackConf: 0.79, betConf: 1, occConf: 1, actionConf: 1 },
        { id: 'BB', stack: 14, bet: 1 },
      ],
    });
    const r = buildReadout(reads);
    expect(r.seats.find((s) => s.id === 'BU')?.low).toEqual(['stack']);
    expect(r.seats.find((s) => s.id === 'BB')?.low).toEqual([]);
  });

  it('しきい値ちょうどは低信頼扱いしない（conf < threshold のみ）', () => {
    const reads = mkReads({
      pot: 1.5,
      seats: [{ id: 'BU', button: true, hero: true, stack: 15, bet: 0, stackConf: 0.8 }, { id: 'BB', stack: 14, bet: 1 }],
    });
    const r = buildReadout(reads);
    expect(r.seats.find((s) => s.id === 'BU')?.low).toEqual([]);
  });

  it('threshold を渡すとそちらを使う（席の low・トップレベル threshold の両方）', () => {
    const reads = mkReads({
      pot: 1.5,
      seats: [
        { id: 'BU', button: true, hero: true, stack: 15, bet: 0, stackConf: 0.85 },
        { id: 'BB', stack: 14, bet: 1 },
      ],
    });
    const r = buildReadout(reads, { threshold: 0.9 });
    expect(r.threshold).toBe(0.9);
    expect(r.seats.find((s) => s.id === 'BU')?.low).toEqual(['stack']);
  });

  it('複数項目が低信頼なら全部 low に入る（occupancy/action/stack/bet）', () => {
    const reads = mkReads({
      pot: 1.5,
      seats: [
        {
          id: 'BU',
          button: true,
          hero: true,
          stack: 15,
          bet: 0,
          stackConf: 0.1,
          betConf: 0.1,
          occConf: 0.1,
          actionConf: 0.1,
        },
        { id: 'BB', stack: 14, bet: 1 },
      ],
    });
    const r = buildReadout(reads);
    expect(r.seats.find((s) => s.id === 'BU')?.low).toEqual(['occupancy', 'action', 'stack', 'bet']);
  });
});

describe('buildReadout — issues / issueCodes / lowConfidenceFields / chipCheck', () => {
  const base = mkReads({
    pot: 1.5,
    seats: [
      { id: 'SB', button: true, hero: true, stack: 14.5, bet: 0.5 },
      { id: 'BB', stack: 14, bet: 1 },
    ],
  });

  it('issues が無ければ issues=[] / issueCodes=[]', () => {
    const r = buildReadout(base);
    expect(r.issues).toEqual([]);
    expect(r.issueCodes).toEqual([]);
  });

  it('issues を渡すと issueCodes に分類結果が入る（メッセージ生成箇所は経由しない）', () => {
    const r = buildReadout(base, {
      issues: ['プリフロップの画面ではありません（検出: flop）。押し引きはプリフロップのみ対象です'],
    });
    expect(r.issues).toEqual(['プリフロップの画面ではありません（検出: flop）。押し引きはプリフロップのみ対象です']);
    expect(r.issueCodes).toEqual(['street_not_preflop']);
  });

  it('checksumOk=false で issueCodes に checksum_mismatch が足される', () => {
    const r = buildReadout(base, { checksumOk: false });
    expect(r.issueCodes).toEqual(['checksum_mismatch']);
  });

  it('lowConfidenceFields はそのまま引き継ぐ（pipeline の値と同一の契約）', () => {
    const r = buildReadout(base, { lowConfidenceFields: ['SB.stack', 'pot'] });
    expect(r.lowConfidenceFields).toEqual(['SB.stack', 'pot']);
  });

  it('lowConfidenceFields を渡さなければ空配列', () => {
    const r = buildReadout(base);
    expect(r.lowConfidenceFields).toEqual([]);
  });

  it('chipCheck を渡せばそのまま反映、渡さなければ undefined', () => {
    const withCheck = buildReadout(base, { chipCheck: { applied: true, note: 'recovered', correctedSeatId: 'BB' } });
    expect(withCheck.chipCheck).toEqual({ applied: true, note: 'recovered', correctedSeatId: 'BB' });
    const without = buildReadout(base);
    expect(without.chipCheck).toBeUndefined();
  });
});

describe('buildReadout — 純関数（reads を破壊しない）', () => {
  it('呼び出し前後で入力 RawReads が変化しない', () => {
    const reads = mkReads({
      pot: 1.5,
      ante: { scheme: 'bb', amount: 0.1 },
      seats: [
        { id: 'SB', button: true, hero: true, stack: 14.5, bet: 0.5, stackConf: 0.3 },
        { id: 'BB', stack: 14, bet: 1 },
      ],
    });
    const before = JSON.parse(JSON.stringify(reads));
    buildReadout(reads, {
      posById: new Map([['SB', 'SB']]),
      threshold: 0.9,
      issues: ['dummy'],
      lowConfidenceFields: ['SB.stack'],
      chipCheck: { applied: false },
    });
    expect(JSON.parse(JSON.stringify(reads))).toEqual(before);
  });

  it('失敗経路を模した最小入力（gate 失敗相当・座席1件のみ等）でも例外を投げず返す', () => {
    const reads = mkReads({
      street: 'フロップ',
      pot: 1.5,
      seats: [{ id: 'SB', hero: true, stack: 14.5, bet: 0.5 }],
    });
    expect(() =>
      buildReadout(reads, { issues: ['プリフロップの画面ではありません（検出: flop）。押し引きはプリフロップのみ対象です'] }),
    ).not.toThrow();
  });
});
