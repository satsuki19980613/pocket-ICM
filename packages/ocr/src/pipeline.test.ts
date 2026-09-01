import { describe, it, expect } from 'vitest';
import { runOcrPipeline } from './pipeline.js';
import { reconstructSpot } from './spotReconstruction.js';
import type { RawReads, RawSeatRead, Occupancy, SeatAction, AnteScheme } from './types.js';

interface SeatSpec {
  id: string;
  hero?: boolean;
  button?: boolean;
  occupancy?: Occupancy;
  action?: SeatAction;
  stack: number;
  bet: number;
  conf?: number;
}

function seat(s: SeatSpec): RawSeatRead {
  const c = s.conf ?? 1;
  return {
    id: s.id,
    isHero: s.hero ?? false,
    isButton: s.button ?? false,
    occupancy: { value: s.occupancy ?? 'occupied', conf: c },
    action: { value: s.action ?? 'none', conf: c },
    stack: { value: s.stack, conf: c },
    bet: { value: s.bet, conf: c },
  };
}

function mkReads(o: {
  street?: string;
  sb?: number;
  bb?: number;
  ante?: { scheme: AnteScheme; amount: number };
  pot: number;
  hand?: string;
  handConf?: number;
  seats: SeatSpec[];
}): RawReads {
  const ante = o.ante ?? { scheme: 'none' as AnteScheme, amount: 0 };
  return {
    street: { value: o.street ?? 'プリフロップ', conf: 1 },
    blinds: { sb: { value: o.sb ?? 0.5, conf: 1 }, bb: { value: o.bb ?? 1, conf: 1 } },
    ante: { scheme: ante.scheme, amount: { value: ante.amount, conf: 1 } },
    pot: { value: o.pot, conf: 1 },
    heroHand: { value: o.hand ?? 'A5s', conf: o.handConf ?? 1 },
    seats: o.seats.map(seat),
  };
}

describe('pipeline — 正常系（root spot 復元）', () => {
  it('5人・全席フレッシュ（hero UTG）', () => {
    // clockwiseFromButton(5) = [BU, SB, BB, UTG, CO]
    const r = runOcrPipeline(
      mkReads({
        pot: 1.5,
        seats: [
          { id: 'BU', button: true, stack: 15, bet: 0 },
          { id: 'SB', stack: 14.5, bet: 0.5 },
          { id: 'BB', stack: 14, bet: 1 },
          { id: 'UTG', hero: true, stack: 15, bet: 0 },
          { id: 'CO', stack: 15, bet: 0 },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    const st = r.state!;
    expect(st.playersLeft).toBe(5);
    expect(st.heroPos).toBe('UTG');
    // root: 全席 live、SB/BB のみ bet、各 full behind 15
    const byPos = Object.fromEntries(st.seats.map((s) => [s.pos, s]));
    expect(byPos['SB']!.bet).toBe(0.5);
    expect(byPos['SB']!.stack).toBeCloseTo(14.5);
    expect(byPos['BB']!.bet).toBe(1);
    expect(byPos['BB']!.stack).toBeCloseTo(14);
    expect(byPos['UTG']!.bet).toBe(0);
    expect(byPos['UTG']!.stack).toBe(15);
    expect(st.seats.every((s) => s.state === 'live')).toBe(true);
    expect(r.checksum!.ok).toBe(true);
  });

  it('シューブ＋フォールドが混在しても root に戻る（valid）', () => {
    // UTG フォールド、CO オールイン15、hero BU が直面
    const r = runOcrPipeline(
      mkReads({
        pot: 16.5,
        seats: [
          { id: 'BU', hero: true, button: true, stack: 15, bet: 0 },
          { id: 'SB', stack: 14.5, bet: 0.5 },
          { id: 'BB', stack: 14, bet: 1 },
          { id: 'UTG', action: 'fold', stack: 15, bet: 0 },
          { id: 'CO', action: 'allin', stack: 0, bet: 15 },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    const st = r.state!;
    expect(st.playersLeft).toBe(5);
    expect(st.heroPos).toBe('BU');
    const byPos = Object.fromEntries(st.seats.map((s) => [s.pos, s]));
    // シューブ CO は root で full 15 behind, bet 0, live
    expect(byPos['CO']!.stack).toBe(15);
    expect(byPos['CO']!.bet).toBe(0);
    expect(byPos['CO']!.state).toBe('live');
    // フォールド UTG も root で live・full behind
    expect(byPos['UTG']!.stack).toBe(15);
    expect(byPos['UTG']!.state).toBe('live');
    expect(r.checksum!.ok).toBe(true);
  });

  it('empty 席は playersLeft から除外される', () => {
    // 6 物理席中 2 empty → 4人
    const r = runOcrPipeline(
      mkReads({
        pot: 1.5,
        seats: [
          { id: 's0', button: true, stack: 20, bet: 0 },
          { id: 's1', occupancy: 'empty', stack: 0, bet: 0 },
          { id: 's2', stack: 19.5, bet: 0.5 },
          { id: 's3', stack: 19, bet: 1 },
          { id: 's4', hero: true, stack: 20, bet: 0 },
          { id: 's5', occupancy: 'empty', stack: 0, bet: 0 },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.state!.playersLeft).toBe(4);
    expect(r.state!.seats.length).toBe(4);
  });

  it('ante all を含む root（solver 入力に ante を素通し）', () => {
    const r = runOcrPipeline(
      mkReads({
        pot: 2.0, // 0.5+1 + 0.1*5
        ante: { scheme: 'all', amount: 0.1 },
        seats: [
          { id: 'BU', button: true, stack: 15, bet: 0 },
          { id: 'SB', stack: 14.5, bet: 0.5 },
          { id: 'BB', stack: 14, bet: 1 },
          { id: 'UTG', hero: true, stack: 15, bet: 0 },
          { id: 'CO', stack: 15, bet: 0 },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.state!.ante).toEqual({ scheme: 'all', amount: 0.1 });
    expect(r.checksum!.ok).toBe(true);
  });
});

describe('pipeline — 対象外検出（§6.5）', () => {
  it('リンプ（非ブラインド席が BB をコール）を弾く', () => {
    const r = runOcrPipeline(
      mkReads({
        pot: 3.5,
        seats: [
          { id: 'BU', button: true, action: 'call', stack: 14, bet: 1 }, // リンプ
          { id: 'SB', stack: 14.5, bet: 0.5 },
          { id: 'BB', stack: 14, bet: 1 },
          { id: 'UTG', hero: true, stack: 15, bet: 0 },
          { id: 'CO', stack: 15, bet: 0 },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.issues.join()).toMatch(/リンプ|レイズ|3bet/);
  });

  it('ミニレイズ（SB が非オールインで増額）を弾く', () => {
    const r = runOcrPipeline(
      mkReads({
        pot: 4,
        seats: [
          { id: 'BU', button: true, stack: 15, bet: 0 },
          { id: 'SB', action: 'raise', stack: 13, bet: 2.5 }, // レイズ
          { id: 'BB', stack: 14, bet: 1 },
          { id: 'UTG', hero: true, stack: 15, bet: 0 },
          { id: 'CO', stack: 15, bet: 0 },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.issues.join()).toMatch(/レイズ|3bet|リンプ/);
  });

  it('ウォーク（hero BB・全員フォールド）を no decision として弾く', () => {
    // 3人: clockwiseFromButton(3)=[BU,SB,BB]。BU/SB フォールド、hero BB
    const r = runOcrPipeline(
      mkReads({
        pot: 1.5,
        seats: [
          { id: 'BU', button: true, action: 'fold', stack: 15, bet: 0 },
          { id: 'SB', action: 'fold', stack: 14.5, bet: 0 },
          { id: 'BB', hero: true, stack: 14, bet: 1 },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.issues.join()).toMatch(/ウォーク|判断が存在しない/);
  });

  it('hero BB でもオールインに直面していれば通す', () => {
    const r = runOcrPipeline(
      mkReads({
        pot: 16.5,
        seats: [
          { id: 'BU', button: true, action: 'allin', stack: 0, bet: 15 },
          { id: 'SB', action: 'fold', stack: 14.5, bet: 0 },
          { id: 'BB', hero: true, stack: 14, bet: 1 },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.state!.heroPos).toBe('BB');
  });

  it('オールインを「コール」した席（カバー）は push/fold 有効（ラベル駆動の要）', () => {
    // 4人: CO オールイン10、BB がカバーしてコール（stack 残あり）、hero BU 直面
    // clockwiseFromButton(4) = [BU, SB, BB, CO]
    const r = runOcrPipeline(
      mkReads({
        pot: 21.5,
        seats: [
          { id: 'BU', hero: true, button: true, stack: 20, bet: 0 },
          { id: 'SB', action: 'fold', stack: 19.5, bet: 0 },
          { id: 'BB', action: 'call', stack: 10, bet: 10 }, // カバーしてコール（非オールイン）
          { id: 'CO', action: 'allin', stack: 0, bet: 10 },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    const byPos = Object.fromEntries(r.state!.seats.map((s) => [s.pos, s]));
    // BB は root で full behind 20（10 stack + 10 コール）→ blind 1 は rootBet 側、stack は 19
    expect(byPos['BB']!.stack).toBe(19);
    expect(byPos['BB']!.bet).toBe(1);
    expect(byPos['BB']!.stack + byPos['BB']!.bet).toBe(20);
    expect(byPos['CO']!.stack).toBe(10);
  });
});

describe('pipeline — gate（§6.3 #8）', () => {
  it('フロップ画面を弾く', () => {
    const r = runOcrPipeline(
      mkReads({
        street: 'フロップ',
        pot: 1.5,
        seats: [
          { id: 'SB', button: true, hero: true, stack: 14.5, bet: 0.5 },
          { id: 'BB', stack: 14, bet: 1 },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.issues.join()).toMatch(/プリフロップ|flop/i);
  });

  it('英語表記 preflop も通す', () => {
    const r = runOcrPipeline(
      mkReads({
        street: 'Pre-Flop',
        pot: 1.5,
        seats: [
          { id: 'SB', button: true, hero: true, stack: 14.5, bet: 0.5 },
          { id: 'BB', stack: 14, bet: 1 },
        ],
      }),
    );
    expect(r.ok).toBe(true);
  });
});

describe('pipeline — 信頼度・チェックサム（§6.3 / Plan 2-8）', () => {
  it('低信頼のスタックが Position keyed で強調される', () => {
    const r = runOcrPipeline(
      mkReads({
        pot: 1.5,
        seats: [
          { id: 'BU', button: true, stack: 15, bet: 0 },
          { id: 'SB', stack: 14.5, bet: 0.5 },
          { id: 'BB', stack: 14, bet: 1 },
          { id: 'UTG', hero: true, stack: 15, bet: 0, conf: 0.4 }, // 低信頼
          { id: 'CO', stack: 15, bet: 0 },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.lowConfidenceFields).toContain('UTG.stack');
    expect(r.lowConfidenceFields).toContain('UTG.bet');
  });

  it('ポット・チェックサム不一致で pot と各 bet が強調される', () => {
    const r = runOcrPipeline(
      mkReads({
        pot: 99, // 明らかに不一致
        seats: [
          { id: 'BU', button: true, stack: 15, bet: 0 },
          { id: 'SB', stack: 14.5, bet: 0.5 },
          { id: 'BB', stack: 14, bet: 1 },
          { id: 'UTG', hero: true, stack: 15, bet: 0 },
          { id: 'CO', stack: 15, bet: 0 },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.checksum!.ok).toBe(false);
    expect(r.lowConfidenceFields).toContain('pot');
    expect(r.lowConfidenceFields).toContain('SB.bet');
  });

  it('低信頼の手札が強調される', () => {
    const r = runOcrPipeline(
      mkReads({
        pot: 1.5,
        handConf: 0.3,
        seats: [
          { id: 'SB', button: true, hero: true, stack: 14.5, bet: 0.5 },
          { id: 'BB', stack: 14, bet: 1 },
        ],
      }),
    );
    expect(r.lowConfidenceFields).toContain('heroHand');
  });
});

describe('reconstructSpot — 直接', () => {
  it('ボタン検出漏れは issues を返す', () => {
    const recon = reconstructSpot(
      mkReads({
        pot: 1.5,
        seats: [
          { id: 'SB', hero: true, stack: 14.5, bet: 0.5 },
          { id: 'BB', stack: 14, bet: 1 },
        ],
      }),
    );
    expect(recon.ok).toBe(false);
    expect(recon.issues.join()).toMatch(/ボタン/);
  });
});
