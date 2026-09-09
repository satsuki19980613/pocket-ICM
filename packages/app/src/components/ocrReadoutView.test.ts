import { describe, it, expect } from 'vitest';
import { buildReadout, type AnteScheme, type Occupancy, type RawReads, type RawSeatRead, type SeatAction } from '@oshihiki/ocr';
import {
  actionLabel,
  buildChipCheckNote,
  buildHeaderItems,
  buildOcrReadoutView,
  buildSeatRow,
  formatAmount,
  formatBb,
  formatConfPct,
  isLowConf,
  occupancyLabel,
  streetLabel,
} from './ocrReadoutView';

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

describe('formatConfPct', () => {
  it('0〜1 を % 表記に丸める', () => {
    expect(formatConfPct(1)).toBe('100%');
    expect(formatConfPct(0)).toBe('0%');
    expect(formatConfPct(0.864)).toBe('86%');
    expect(formatConfPct(0.795)).toBe('80%'); // Math.round の丸め規則
  });
});

describe('isLowConf', () => {
  it('conf < threshold のみ低信頼', () => {
    expect(isLowConf(0.79, 0.8)).toBe(true);
    expect(isLowConf(0.8, 0.8)).toBe(false); // ちょうどは低信頼扱いしない（buildReadout と同じ規則）
    expect(isLowConf(0.81, 0.8)).toBe(false);
  });
});

describe('formatAmount', () => {
  it('チップ表示の割り算で出る長い小数を読める桁に丸める', () => {
    // 実機フレーム（チップ表示）で ante が 0.25757575757575757 のまま出ていた回帰。
    expect(formatAmount(0.25757575757575757)).toBe('0.26');
    expect(formatAmount(0.5)).toBe('0.5');
    expect(formatAmount(1)).toBe('1');
    expect(formatAmount(0.25)).toBe('0.25');
  });

  it('数値でないときは — を返す', () => {
    expect(formatAmount(Number.NaN)).toBe('—');
  });
});

describe('formatBb', () => {
  it('小数第1位固定で桁を揃える', () => {
    expect(formatBb(14.5)).toBe('14.5bb');
    expect(formatBb(20)).toBe('20.0bb');
    expect(formatBb(0)).toBe('0.0bb');
    expect(formatBb(1.25)).toBe('1.3bb'); // toFixed の丸め
  });
});

describe('actionLabel / occupancyLabel', () => {
  it('SeatAction の全ケースを日本語化する（押し引きという語は使わない）', () => {
    expect(actionLabel('fold')).toBe('フォールド');
    expect(actionLabel('call')).toBe('コール');
    expect(actionLabel('raise')).toBe('レイズ');
    expect(actionLabel('allin')).toBe('オールイン');
    expect(actionLabel('check')).toBe('チェック');
    expect(actionLabel('none')).toBe('なし');
  });

  it('Occupancy を日本語化する', () => {
    expect(occupancyLabel('occupied')).toBe('配牌あり');
    expect(occupancyLabel('empty')).toBe('空席');
  });
});

describe('streetLabel', () => {
  it('英語トークン・日本語ラベルどちらも表示ラベルへ正規化する', () => {
    expect(streetLabel('preflop')).toBe('プリフロップ');
    expect(streetLabel('プリフロップ')).toBe('プリフロップ');
    expect(streetLabel('flop')).toBe('フロップ');
    expect(streetLabel('turn')).toBe('ターン');
    expect(streetLabel('river')).toBe('リバー');
  });

  it('分類できない値は classifyStreet が unknown に落とすので「不明」になる', () => {
    expect(streetLabel('謎')).toBe('不明');
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
    expect(row.occupancyLow).toBe(true);
    expect(row.actionLow).toBe(true);
    expect(row.actionText).toBe('オールイン');
    expect(row.stackConfPct).toBe('50%');
  });

  it('しきい値ちょうどは低信頼扱いしない', () => {
    const reads = mkReads({ pot: 1.5, seats: [{ id: 's0', stack: 15, bet: 0, stackConf: 0.8 }] });
    const r = buildReadout(reads); // 既定しきい値 0.8
    expect(buildSeatRow(r.seats[0]!).stackLow).toBe(false);
  });
});

describe('buildHeaderItems', () => {
  it('ストリート/ブラインド・アンティ/ポット/heroハンドを組み立てる', () => {
    const reads = mkReads({
      street: 'preflop',
      sb: 0.5,
      bb: 1,
      ante: { scheme: 'all', amount: 0.1 },
      pot: 2.1,
      hand: 'AKs',
      seats: [{ id: 's0', stack: 15, bet: 0 }],
    });
    const r = buildReadout(reads);
    const items = buildHeaderItems(r);
    const byLabel = new Map(items.map((i) => [i.label, i]));
    expect(byLabel.get('ストリート')?.value).toBe('プリフロップ');
    expect(byLabel.get('ブラインド')?.value).toBe('0.5 / 1　ante 0.1bb (all)');
    expect(byLabel.get('ポット')?.value).toBe('2.1bb');
    expect(byLabel.get('heroハンド')?.value).toBe('AKs');
    // displayMode/blindChips/imageSize を渡していなければ出ない
    expect(byLabel.has('表示モード')).toBe(false);
    expect(byLabel.has('画像サイズ')).toBe(false);
  });

  it('アンティ無しは "なし"、blindChips があればレベル番号を併記', () => {
    const reads = mkReads({
      pot: 1,
      blindChips: { sb: 100, bb: 200, ante: 0, level: 4 },
      seats: [{ id: 's0', stack: 15, bet: 0 }],
    });
    const r = buildReadout(reads);
    const items = buildHeaderItems(r);
    const blinds = items.find((i) => i.label === 'ブラインド');
    expect(blinds?.value).toBe('0.5 / 1　ante なし　Lv.4');
  });

  it('displayMode / imageSize は渡したときだけ出る', () => {
    const reads = mkReads({ pot: 1, displayMode: 'chips', seats: [{ id: 's0', stack: 15, bet: 0 }] });
    const r = buildReadout(reads);
    const items = buildHeaderItems(r, { w: 1170, h: 2532 });
    const byLabel = new Map(items.map((i) => [i.label, i]));
    expect(byLabel.get('表示モード')?.value).toBe('チップ表示');
    expect(byLabel.get('画像サイズ')?.value).toBe('1170×2532');
  });

  it('conf<threshold の項目は low=true・confPct を持つ', () => {
    const reads = mkReads({ pot: 1, potConf: 0.4, seats: [{ id: 's0', stack: 15, bet: 0 }] });
    const r = buildReadout(reads);
    const pot = buildHeaderItems(r).find((i) => i.label === 'ポット');
    expect(pot?.low).toBe(true);
    expect(pot?.confPct).toBe('40%');
  });

  it('ブラインド行は複合項目のいずれかが低信頼なら low=true', () => {
    const reads = mkReads({
      pot: 1,
      ante: { scheme: 'all', amount: 0.1, conf: 0.3 },
      seats: [{ id: 's0', stack: 15, bet: 0 }],
    });
    const r = buildReadout(reads);
    const blinds = buildHeaderItems(r).find((i) => i.label === 'ブラインド');
    expect(blinds?.low).toBe(true);
    expect(blinds?.confPct).toBeUndefined(); // 複合項目は % を出さない
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
  it('header/seats/issues/chipCheckNote をまとめて返す', () => {
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
    const view = buildOcrReadoutView(r, { imageSize: { w: 1080, h: 2400 } });
    expect(view.seats).toHaveLength(2);
    expect(view.seats[1]!.actionText).toBe('オールイン');
    expect(view.issues).toEqual(['hero が BB で pot が未レイズです（ウォーク＝判断が存在しないため対象外）']);
    expect(view.chipCheckNote).toContain('s0');
    expect(view.header.find((h) => h.label === '画像サイズ')?.value).toBe('1080×2400');
  });

  it('失敗経路（席1件のみ・issues あり）でも例外を投げない', () => {
    const reads = mkReads({ street: 'flop', pot: 1, seats: [{ id: 's0', hero: true, stack: 14.5, bet: 0.5 }] });
    const r = buildReadout(reads, {
      issues: ['プリフロップの画面ではありません（検出: flop）。押し引きはプリフロップのみ対象です'],
    });
    expect(() => buildOcrReadoutView(r)).not.toThrow();
    const view = buildOcrReadoutView(r);
    expect(view.seats).toHaveLength(1);
    expect(view.issues.length).toBe(1);
  });
});
